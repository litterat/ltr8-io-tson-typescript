/**
 * Turns a {@link LinkedSchema} (`link/link.ts`'s own output -- every `!!import` merged, `subtypes`
 * populated, every reference validated) into a {@link CompiledSchema}: a whole-schema `name ->
 * TypeReader<Value>` table, built once, that a document is read against directly rather than by
 * re-walking the schema per value. That table, plus the two entry points that drive a whole
 * document through it ({@link readValue}/{@link validate}), are this module's whole public
 * surface -- Work package 17 (Part B, Wave 5).
 *
 * **What "compiling" means here.** Every leaf/container reader this module wires together
 * already exists (`reader/tree/*.ts`, Wave 4) or is a small, local extension of that same family
 * (`atomBuilder.ts`'s per-atom-family dispatch, `choiceReader.ts`'s `!type-ref` dispatch) -- this
 * module's own job is the piece `reader/tree/factory.ts` names as its own reason for being
 * "deliberately narrow" and stops short of: resolving an entry value's every
 * possible shape (not just the four `Product` ones `factory.ts` wires), and doing it once per
 * schema over the *whole* entry graph rather than once per definition handed in from outside --
 * cycles included, since a schema's own types routinely reference each other and one another's
 * fields.
 *
 * **Cycles are resolved by tying the knot, not by a two-pass schema walk.** `resolve` inserts a
 * placeholder `TypeReader` into the cache *before* building the real one, so a recursive
 * reference reached while that real reader is still under construction (a record whose own field
 * refers back to itself, directly or through an intermediate type) gets a working reader that
 * defers to the finished one the moment it exists -- the same shape a lazily-initialised mutual
 * reference takes in any language with closures, and the reason every reader in this stack is
 * built as a small factory function rather than eagerly evaluated data.
 *
 * **`compiler/` may not import `bind/`** (`eslint.config.js`'s own zone) -- everything here reads
 * into `tree/nodes.ts`'s `Value` model, never into an authored `Binding<T>`. A caller wanting
 * bound host objects instead builds its own whole-schema table the same way, over `reader/
 * bind.ts`'s readers; that table is a distinct piece of work this module does not attempt.
 */
import type { Task } from '../io/bytes.js';
import { fromBytes, runSync } from '../io/bytes.js';
import { TsonInternalError, TsonNotImplementedError, TsonReadError } from '../core/errors.js';
import type { Diagnostic, DiagnosticsReceiver, SchemaLocation } from '../core/diagnostic.js';
import { collector, throwing } from '../core/diagnostic.js';
import type { ByteInput } from '../io/bytes.js';
import type { NestingLimitOptions } from '../core/limits.js';
import { createDataStream } from '../stream/dataStream.js';
import { createReadContext } from '../reader/context.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import type { LinkedSchema } from '../link/link.js';
import type { Alias, Top, TypeExpr, TypeInline } from '../schema/meta/typedef.js';
import type { DeclaredType } from '../schema/meta/algebra.js';
import { choiceDisjoint, dependentOn, isParametric } from '../schema/meta/typedef.js';
import { isNamespaceType, namespaceAsMap } from '../schema/meta/namespaces.js';
import type {
  ArrayBody,
  ChoiceBody,
  MapBody,
  RecordBody,
  TupleBody,
} from '../schema/meta/bodies.js';
import { typeExprText } from '../schema/meta/bodies.js';
import type { Value } from '../tree/nodes.js';
import { recordTreeReader } from '../reader/tree/record.js';
import { dependentFieldReader } from '../reader/tree/dependent.js';
import { siblingType } from '../link/dependentFields.js';
import { mapTreeReader } from '../reader/tree/map.js';
import { arrayTreeReader } from '../reader/tree/array.js';
import { tupleTreeReader } from '../reader/tree/tuple.js';
import { skipDataValue, typeRefAhead } from '../reader/tree/grammar.js';
import { abandonedValue } from '../reader/tree/support.js';
import { choiceTreeReader } from './choiceReader.js';
import { buildAtomReader } from './atomBuilder.js';
import { isAtom } from './atomChecks.js';
import { guardSubsumption } from './subsumption.js';
import { terminalDefinition } from '../link/aliasChain.js';
import { isChoiceDisjoint } from '../link/disjointness.js';
import { externHopsOf } from '../link/externHops.js';
import { externBoundary, type ForeignReaders } from './externReader.js';
import { externVariantNames } from '../link/externAdmission.js';
import { fieldNameRule } from '../reader/tree/fieldNames.js';
import { DEFAULT_IDENTIFIER_POLICY, type IdentifierPolicy } from '../unicode/policy.js';

// ── CompiledSchema ───────────────────────────────────────────────────────────────────────────

/**
 * A schema, compiled: every entry's own reader, built once and cached, plus the {@link
 * LinkedSchema} it was built from -- kept on the surface because a caller reporting a schema-side
 * problem (`SchemaLocation.schemaId`, an entry's `annotations`, ...) needs the resolved model
 * itself, not just what reads against it.
 */
export interface CompiledSchema {
  readonly linked: LinkedSchema;
  /**
   * The compiled reader for the entry named `name` in this schema's own merged namespace
   * (§2.2.3 -- local and imported entries alike). Built lazily, on first request, and cached
   * from then on; every recursive/cyclic reference reached while building one is resolved
   * through the same lazily-tied cache, so asking for the same name twice, directly or via a
   * cycle, always returns the identical reader.
   *
   * Throws {@link TsonInternalError} when `name` names no entry at all -- {@link LinkedSchema}'s
   * own contract is that {@link linkSchema}'s reference validation already rejected any reference
   * that does not resolve, so a caller reaching this with an unresolved name is asking this
   * schema a question its own linking already answered "no" to, not presenting a document
   * problem. Throws {@link TsonNotImplementedError} for a well-formed entry this compiler has no
   * reader for yet (a parametric record, or a value entry named where a type is expected).
   *
   * Given a type written in place (§4.2), the reader of its body, built where it stands and cached by
   * identity, named by its spelling.
   */
  reader(type: string | TypeExpr): TypeReader<Value>;
}

/** `name`'s own {@link SchemaLocation} within `schema` -- its origin schema id (§2.2.3: local or imported, `LinkedSchema.origins` says which) and an RFC 6901 pointer naming it directly, plus its source position when the entry carries one. */
function locationOf(schema: LinkedSchema, name: string): SchemaLocation {
  const position = schema.facts.get(name)?.position;
  const schemaId = schema.origins.get(name) ?? schema.id;
  return {
    schemaId,
    pointer: `/${name}`,
    ...(position === undefined ? {} : { position }),
  };
}

// One runtime guard per shape, so each branch below narrows `Top` on its own.
function isRecordBody(body: Top): body is RecordBody {
  return body.kind === 'record';
}
function isMapBody(body: Top): body is MapBody {
  return body.kind === 'map';
}
function isArrayBody(body: Top): body is ArrayBody {
  return body.kind === 'array';
}
function isTupleBody(body: Top): body is TupleBody {
  return body.kind === 'tuple';
}
function isChoiceBody(body: Top): body is ChoiceBody {
  return body.kind === 'choice';
}
function isAlias(body: Top): body is Alias {
  return body.kind === 'alias';
}
function isDeclared(body: Top): body is DeclaredType {
  return body.kind === 'declared_type';
}

/** {@link compile}'s own dependencies. */
export interface CompileDeps {
  /**
   * [TSON-DATA] §8.2's name-hygiene policy over a value of an identifier family: a name wherever
   * it stands, so the per-name mechanisms reach it under the family's own profile, and the keys of
   * a map keyed by one and the elements of a set of them are look-alike scopes (§11.4). Defaults
   * to {@link DEFAULT_IDENTIFIER_POLICY}. Stated once per compile, as a relaxation is a code decision
   * and never ambient.
   */
  readonly identifierPolicy?: IdentifierPolicy;
  /**
   * Whether a value at a reference over a constructor must be a member of it (§4.2, §5.12): the name of a type
   * built with the constructor, in the closure the schema was linked over. Defaults to `true`, a data document's
   * names resolving there. A reader that reads values whose names resolve in another schema -- an annotation
   * written in a schema document, read through the compiled reader of the schema declaring the annotation --
   * judges the spelling alone, and the schema holding the name judges the member when it links.
   */
  readonly judgesReferenceMembers?: boolean;
  /**
   * The linked schema of a canonical identity, where a value read through an extern reaches an entry that neither
   * the extern's foreign schema nor the one its target lands in holds, and is read in the schema declaring it
   * (§7.9). Omitted, such a value reports `NOT_IMPLEMENTED`. The foreign schemas an extern names need nothing: the
   * link holds them.
   */
  readonly foreignSchema?: (identity: string) => LinkedSchema | undefined;
}

/**
 * Builds `name`'s own reader from its resolved value, dispatching on the value's shape. `resolve` is the whole-schema `name -> reader` lookup this
 * function's own children (a record field, an array element, a choice variant, ...) are built
 * against -- passed down rather than closed over directly by this function so `resolve` alone
 * owns the cycle-breaking cache.
 */
function buildReader(
  schema: LinkedSchema,
  name: string,
  definition: Top,
  resolve: (type: string | TypeExpr) => TypeReader<Value>,
  policy: IdentifierPolicy,
  judgesMembers: boolean,
  foreign: ForeignReaders,
  inPlace = false,
): TypeReader<Value> {
  const body = definition;
  // Whether `typeName` is an identifier family (§8.3 followed to its constructor): a name wherever
  // a value of it stands, so a scope of them meets skeleton distinctness when the policy asks.
  const isNameType = (typeName: string): boolean => {
    if (!policy.skeletonDistinctness) return false;
    const terminalBody = terminalDefinition(typeName, (n) => schema.entries.get(n));
    return terminalBody?.kind === 'identifier_type';
  };
  const location = (): SchemaLocation => locationOf(schema, name);
  // A type written in place is a member of nothing and named by no tag (§4.2, §7.2): it admits no tag at all.
  const guard = (
    built: TypeReader<Value>,
    fieldNameForm?: Parameters<typeof guardSubsumption>[5],
  ) =>
    inPlace
      ? guardInPlace(name, definition, built, schema.entries)
      : guardSubsumption(name, definition, built, schema.entries, resolve, fieldNameForm);

  if (isParametric(body)) {
    // A parametric record is no type a position names (§5.10): its applications are.
    throw new TsonNotImplementedError(
      `'${name}' is a parametric record and has no reader of its own -- apply it (§5.10) before reading against it`,
    );
  }

  // §7.2's subsumption rule -- a value's own `!type-ref` must be admitted by the position's
  // declared type -- applied at every position it governs (every `Atom`/`Product` body) rather
  // than only where a record happens to declare subtypes; see `subsumption.ts`'s own doc for which
  // kinds it deliberately leaves alone (`choice`, `reference`, `scoped`).
  // §4.1: a namespace type is a map type keyed by names, and a value of it is the map its facets
  // describe -- a record's `fields` is its `field_map`, which is no namespace.
  if (isNamespaceType(body)) {
    const built = mapTreeReader(
      name,
      name,
      namespaceAsMap(body),
      resolve,
      location(),
      isNameType(body.keyType.name),
    );
    return guard(built);
  }
  if (isRecordBody(body)) {
    const fieldNames = fieldNameRule(schema.nameTypes.get(name));
    const built = recordTreeReader(
      name,
      name,
      body,
      (field) => {
        const on = dependentOn(field.type);
        if (on === undefined) return resolve(field.type);
        const lookup = (entry: string): Top | undefined => schema.entries.get(entry);
        const sibling = body.fields.entries.get(on);
        return dependentFieldReader(
          name,
          field.name,
          on,
          sibling === undefined ? undefined : siblingType(sibling, lookup),
          lookup,
          resolve,
        );
      },
      location(),
      fieldNames,
      policy,
    );
    return guard(built, fieldNames.form);
  }
  if (isArrayBody(body)) {
    const built = arrayTreeReader(
      name,
      name,
      body,
      resolve,
      location(),
      body.uniqueItems && body.elementType.kind !== 'inline' && isNameType(body.elementType.name),
    );
    return guard(built);
  }
  if (isMapBody(body)) {
    const built = mapTreeReader(
      name,
      name,
      body,
      resolve,
      location(),
      isNameType(body.keyType.name),
    );
    return guard(built);
  }
  if (isTupleBody(body)) {
    const built = tupleTreeReader(name, name, body, resolve, location());
    return guard(built);
  }
  if (isChoiceBody(body)) {
    // A choice in place carries no derived `disjoint` of its own: it is derived here, as the linker derives a
    // declared one's (§5.4).
    const hops = externHopsOf(schema);
    const disjoint =
      choiceDisjoint(definition) ?? isChoiceDisjoint(body.variants, schema.entries, hops);
    // A tag at a choice names a variant (§5.4, §7.2), so a choice in place takes tags as a declared one does.
    return choiceTreeReader(name, name, body, resolve, location(), disjoint, schema.entries, {
      hops,
      externVariants: (variant) => externVariantNames(schema, variant),
    });
  }
  if (isAlias(body)) {
    // A closed alias reads exactly as its target does (§8.3) -- no framing of its own to add, so
    // this is pure indirection through the same lazily-tied cache `resolve` already provides
    // (safe even when the alias and its target form part of a cycle).
    return resolve(body.target.name);
  }
  if (isDeclared(body)) {
    return buildDeclaredReader(name, schema.entries, resolve);
  }
  if (isAtom(body)) {
    const enumForm = schema.enumForms.get(name);
    const built = buildAtomReader(name, body, {
      identifierPolicy: policy,
      judgesKindMembers: judgesMembers,
      ...(enumForm === undefined ? {} : { enumForm }),
    });
    return guard(built);
  }
  if (body.kind === 'incomplete') {
    // No type, so nothing is read against it (§5.5). A schema naming one at a type position is refused when it
    // links; what reaches this is a data tag naming it, the document's mistake.
    const schemaLocation = location();
    return {
      *read(ctx: ReadContext): Task<Value> {
        const at = ctx.underDeclaration(schemaLocation);
        at.report(
          'TYPE_MISMATCH',
          `'${name}' is an incomplete '${body.head}' with [${body.absent.join(', ')}] absent, not a type, so ` +
            'nothing is read against it -- tag the value with a type its schema declares by completing it (§5.5)',
          'a type, not an incomplete entry',
          `!${name}`,
        );
        yield* skipDataValue(at);
        return abandonedValue();
      },
    };
  }
  if (body.kind === 'extern') {
    // The boundary between this scope and the foreign schema's (§7.9).
    const boundary = externBoundary(schema, name, location(), foreign);
    if (boundary !== undefined) return boundary;
  }
  if (body.kind === 'apply') {
    throw new TsonNotImplementedError(
      `'${name}' is an application of a parametric record no resolution closed, and has no reader (§5.10)`,
    );
  }
  // A value entry, an incomplete entry, an extern or a dependent type named where a type is expected -- a
  // resolver error checked at schema load, so reaching it here through an already-linked schema means
  // something upstream let it through; reported as this module's own gap rather than silently misread.
  throw new TsonNotImplementedError(
    `'${name}' (a '${body.kind}' entry) is not a data type a value is read against, and has no compiled reader`,
  );
}

/**
 * A reader for a type written in place (§4.2, §7.2): it has no name, so a value at its position carries no tag,
 * whatever the tag names -- a declared type of the same shape included, nothing being IS-A a type in place -- and
 * an abstract record in place has no direct instance and no member, so no value is one of it.
 */
function guardInPlace(
  displayName: string,
  definition: Top,
  built: TypeReader<Value>,
  entries: ReadonlyMap<string, Top>,
): TypeReader<Value> {
  function* refuse(
    ctx: ReadContext,
    message: string,
    expected: string,
    found: string,
    code: 'TYPE_MISMATCH' | 'UNKNOWN_TYPE_REF' = 'TYPE_MISMATCH',
  ): Task<Value> {
    ctx.report(code, message, expected, found);
    yield* skipDataValue(ctx);
    return abandonedValue();
  }
  return {
    *read(ctx: ReadContext): Task<Value> {
      const tag = yield* typeRefAhead(ctx);
      if (tag !== undefined && !entries.has(tag)) {
        // §7.2's two steps: a tag naming nothing in the namespace fails the first, before admission is asked.
        return yield* refuse(
          ctx,
          `'!${tag}' does not resolve in the governing schema's namespace (§7.2) -- a type written in place ` +
            'admits no tag at all',
          'a value with no tag',
          `!${tag}`,
          'UNKNOWN_TYPE_REF',
        );
      }
      if (tag !== undefined) {
        return yield* refuse(
          ctx,
          `'${displayName}' is a type written in place, which has no name, so no tag names it and nothing ` +
            `is IS-A it: '!${tag}' is refused here (§4.2, §7.2)`,
          'a value with no tag',
          `!${tag}`,
        );
      }
      if (definition.kind === 'record' && definition.extension === 'ABSTRACT') {
        return yield* refuse(
          ctx,
          `'${displayName}' is an abstract record written in place: it has no direct instances and no ` +
            'member, so no value is one of it (§4.2, §5.2)',
          'no value',
          'a value',
        );
      }
      return untagged(yield* built.read(ctx));
    },
  };
}

/**
 * `value` carrying no tag: a type written in place is no entry, so a tree's tag names none (§4.2), and a written
 * value read at its position states no `!type-ref` a re-read could resolve.
 */
function untagged(value: Value): Value {
  // An abandoned read is carried as `undefined` (`abandonedValue`), and stays so.
  const read = value as (Value & { readonly typeRef?: string }) | undefined;
  if (read?.typeRef === undefined) return value;
  const { typeRef: _tag, ...rest } = read;
  void _tag;
  return rest;
}

/**
 * The kernel's `meta.declared_type` instance, resolved (§7.8): the open sum over the closure, in which the
 * value names its own type. A value carrying a `!type-ref` is read as the type it names in the namespace of
 * the schema being compiled -- `entries`, resolved through the same `resolve` every other dispatch in this
 * schema uses; a value carrying none names no type and is a validation error, there being nothing at an
 * open position for a type to be inferred from.
 *
 * Tree mode only (bind mode is a separate work package over the same {@link DeclaredType}).
 */
function buildDeclaredReader(
  displayName: string,
  entries: ReadonlyMap<string, Top>,
  resolve: (type: string | TypeExpr) => TypeReader<Value>,
): TypeReader<Value> {
  function* abandon(ctx: ReadContext): Task<Value> {
    yield* skipDataValue(ctx);
    return abandonedValue();
  }

  /** §7.8's "the discriminant is required": an open position has nothing to infer a type from. */
  function* missingTypeRef(ctx: ReadContext): Task<Value> {
    ctx.report(
      'VALIDATION_ERROR',
      `'${displayName}' is a declared position -- the value names its own type, so it requires an ` +
        'explicit type annotation (!typeName)',
      "a type annotation naming the value's own type",
      'no type annotation',
    );
    return yield* abandon(ctx);
  }

  function* readDeclared(ctx: ReadContext): Task<Value> {
    const typeRef = yield* typeRefAhead(ctx);
    if (typeRef === undefined) {
      return yield* missingTypeRef(ctx);
    }
    if (!entries.has(typeRef)) {
      ctx.report(
        'UNKNOWN_TYPE',
        `'${typeRef}' is not a type this schema declares or imports, and '${displayName}' ` +
          "resolves a value's own type name there (§2.2.3)",
        'a type declared by the governing schema',
        typeRef,
      );
      return yield* abandon(ctx);
    }
    return yield* resolve(typeRef).read(ctx);
  }

  return {
    read: (ctx: ReadContext): Task<Value> => readDeclared(ctx),
  };
}

/**
 * Builds a {@link CompiledSchema} for `schema` -- see this module's own top note for what
 * compiling means and how cycles resolve.
 */
export function compile(schema: LinkedSchema, deps: CompileDeps = {}): CompiledSchema {
  return compileWith(schema, deps, new Map());
}

/**
 * {@link compile}, each foreign schema a value is read in compiled once for the whole compile and whatever it
 * reaches, in its mode (§7.9): `foreignCompiles` is shared by every schema this compile reaches through an extern.
 */
function compileWith(
  schema: LinkedSchema,
  deps: CompileDeps,
  foreignCompiles: Map<LinkedSchema, CompiledSchema>,
): CompiledSchema {
  const readerOf = (linked: LinkedSchema, name: string): TypeReader<Value> => {
    let compiled = linked === schema ? self : foreignCompiles.get(linked);
    if (compiled === undefined) {
      compiled = compileWith(linked, deps, foreignCompiles);
      foreignCompiles.set(linked, compiled);
    }
    // Deferred to the read: a foreign schema's reader may reach back through its own externs.
    const within = compiled;
    return { read: (ctx) => within.reader(name).read(ctx) };
  };
  const foreign: ForeignReaders = {
    reader: readerOf,
    readerIn(identity, name) {
      const linked = deps.foreignSchema?.(identity);
      return linked === undefined ? undefined : readerOf(linked, name);
    },
  };
  const cache = new Map<string, TypeReader<Value>>();
  const inPlace = new WeakMap<TypeInline, TypeReader<Value>>();
  const policy = deps.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;
  const judgesMembers = deps.judgesReferenceMembers ?? true;

  function resolve(type: string | TypeExpr): TypeReader<Value> {
    if (typeof type !== 'string') {
      if (type.kind !== 'inline') return resolve(type.name);
      const held = inPlace.get(type);
      if (held !== undefined) return held;
      // A type written in place names nothing that could reach back to it, so no knot is tied here: what it
      // names is resolved through the cache.
      const built = buildReader(
        schema,
        typeExprText(type),
        type.of,
        resolve,
        policy,
        judgesMembers,
        foreign,
        true,
      );
      inPlace.set(type, built);
      return built;
    }
    const name = type;
    const cached = cache.get(name);
    if (cached !== undefined) return cached;

    const definition = schema.entries.get(name);
    if (definition === undefined) {
      // `LinkedSchema`'s own contract: `linkSchema`'s reference validation already rejected any
      // reference that does not resolve within this schema's merged namespace, so a name that
      // reaches here unresolved is a caller asking this schema a question linking already
      // answered "no" to, not a document problem to diagnose.
      throw new TsonInternalError(
        `compiling '${name}': no such entry in this schema's own linked namespace -- linkSchema's own reference validation should have caught this before compilation ever ran`,
      );
    }

    // Tie the knot: install a placeholder before building the real reader, so a cycle reached
    // while `buildReader` is still running -- a record whose own field refers back to `name`,
    // directly or through an intermediate type -- resolves to a reader that works once
    // `box.inner` is set, rather than recursing into `resolve` forever. See this module's own top
    // note. A one-property box, not a bare `let`, because the box's own identity (not its
    // property's) is what the closure below needs to stay fixed while its content changes.
    const box: { inner?: TypeReader<Value> } = {};
    const placeholder: TypeReader<Value> = {
      *read(ctx: ReadContext): Task<Value> {
        if (box.inner === undefined) {
          throw new TsonInternalError(
            `'${name}' was read from before its own compiled reader finished construction -- ` +
              'this indicates a reader eagerly invoking another mid-build rather than deferring ' +
              'the call into its own read() closure, which every reader in this stack does',
          );
        }
        return yield* box.inner.read(ctx);
      },
    };
    cache.set(name, placeholder);
    const inner = buildReader(schema, name, definition, resolve, policy, judgesMembers, foreign);
    box.inner = inner;
    cache.set(name, inner); // supersede the placeholder for every caller from here on
    return inner;
  }

  const self: CompiledSchema = {
    linked: schema,
    reader: resolve,
  };
  return self;
}

// ── Whole-document reading ──────────────────────────────────────────────────────────────────

/**
 * Reads one whole document against `compiled`'s own entry `rootName`: consumes the leading
 * `document-start` event, reads the root value through `compiled.reader(rootName)`, then consumes
 * `document-end` -- the whole-document framing {@link TypeReader} itself deliberately does not own
 * (`reader/contracts.ts`'s own note on why), supplied here because nothing upstream of Wave 6's
 * front door does yet. A `document-end` that is not what the cursor finds on (content the root
 * read left unconsumed) is reported through `receiver` rather than thrown past it, so a collecting
 * read still reports everything the root value itself found.
 *
 * **The {@link Value} this function returns is not by itself the all-or-nothing verdict.** A root
 * read that reported anything internally returns `abandonedValue()`'s sentinel
 * (`reader/tree/support.ts`), but a root read that built a real tree cleanly and *then* left
 * trailing content still returns that real tree, with the trailing-content diagnostic reported
 * alongside it -- {@link validate} is what applies the document-wide check (every diagnostic this
 * call reported, not only the root reader's own) and withholds `ValidationResult.value` for either
 * case alike.
 *
 * `Task`-returning, per `CLAUDE.md`'s own suspension rule: `input` may be a chunked, real byte
 * source as readily as a complete in-memory one, and this function starves exactly where the
 * event stream underneath it does. {@link validate} is the synchronous convenience wrapper for
 * already-complete input.
 */
export function* readValue(
  compiled: CompiledSchema,
  rootName: string,
  input: ByteInput,
  receiver: DiagnosticsReceiver,
  options?: NestingLimitOptions,
): Task<Value> {
  const events = createDataStream(input);
  const ctx = createReadContext(events, receiver, options);
  const start = yield* ctx.next();
  if (start.kind !== 'document-start') {
    throw new TsonInternalError(
      `expected the event stream to open with 'document-start', found '${start.kind}' -- this is an event-stream invariant, not a document problem`,
    );
  }
  const reader = compiled.reader(rootName);
  const value = yield* reader.read(ctx);
  const end = yield* ctx.next();
  if (end.kind !== 'document-end') {
    ctx.report(
      'VALIDATION_ERROR',
      `the document carries content after its root value, which a '${rootName}'-governed read did not consume`,
      'end of document',
      end.kind,
    );
  }
  return value;
}

/**
 * Everything one {@link validate} call found: every {@link Diagnostic} raised, in report order,
 * and the tree {@link readValue} built -- **only when `diagnostics` is empty**. A read is
 * all-or-nothing (mirroring the reference implementation's `ConstructionGuard`/
 * `CountingReceiver`): every diagnostic is still reported, in one pass, but a document that
 * reported anything -- a token-policy refusal the stream itself raised, a construction failure
 * deep in the tree, or the trailing-content check {@link readValue} makes after the root read
 * returns -- yields no value, because a tree whose placeholder for a refused value is the same
 * node as a real void one cannot say which of its parts to trust. `value` is `undefined` rather
 * than a placeholder `Value` for exactly that reason; see `reader/tree/support.ts`'s own
 * `abandonedValue` for the mechanism every constructing reader in this stack already uses to
 * reach this point.
 */
export interface ValidationResult {
  readonly value?: Value;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Validates `bytes` as a whole document against `compiled`'s own entry `rootName`, collecting
 * every problem rather than stopping at the first -- the synchronous convenience wrapper over
 * {@link readValue} for input that is already complete in memory. A caller streaming chunked
 * input, or wanting fail-fast (`core/diagnostic.ts`'s own {@link throwing}) instead of collection,
 * drives {@link readValue} directly.
 */
export function validate(
  compiled: CompiledSchema,
  rootName: string,
  bytes: Uint8Array,
): ValidationResult {
  const diagnostics = collector();
  const value = runSync(readValue(compiled, rootName, fromBytes(bytes), diagnostics));
  // The document-level counting checkpoint (`CountingReceiver`): every route a problem can take,
  // not only whatever `value` itself came back as -- see `ValidationResult`'s own doc.
  return diagnostics.diagnostics.length === 0
    ? { value, diagnostics: diagnostics.diagnostics }
    : { diagnostics: diagnostics.diagnostics };
}

/**
 * Reads `bytes` as a whole document against `compiled`'s own entry `rootName`, throwing {@link
 * TsonReadError} at the first problem rather than collecting -- the fail-fast counterpart to
 * {@link validate}, for a caller that wants a value or an exception rather than a diagnostic list.
 */
export function read(compiled: CompiledSchema, rootName: string, bytes: Uint8Array): Value {
  return runSync(
    readValue(
      compiled,
      rootName,
      fromBytes(bytes),
      throwing((d) => new TsonReadError(d)),
    ),
  );
}
