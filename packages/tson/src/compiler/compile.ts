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
import type { Alias, Top } from '../schema/meta/typedef.js';
import type { DeclaredType } from '../schema/meta/algebra.js';
import { choiceDisjoint, entryKind, isFamilyBase, isTemplateBody } from '../schema/meta/typedef.js';
import { isNamespaceType, namespaceMapOf } from '../schema/meta/namespaces.js';
import type {
  ArrayBody,
  ChoiceBody,
  MapBody,
  RecordBody,
  TupleBody,
} from '../schema/meta/bodies.js';
import type { Value } from '../tree/nodes.js';
import { recordTreeReader } from '../reader/tree/record.js';
import { mapTreeReader } from '../reader/tree/map.js';
import { arrayTreeReader } from '../reader/tree/array.js';
import { tupleTreeReader } from '../reader/tree/tuple.js';
import { skipDataValue, typeRefAhead } from '../reader/tree/grammar.js';
import { abandonedValue } from '../reader/tree/support.js';
import { choiceTreeReader } from './choiceReader.js';
import { buildAtomReader } from './atomBuilder.js';
import { isAtom } from './atomChecks.js';
import { guardSubsumption } from './subsumption.js';
import { terminalDefinition } from '../link/referenceChain.js';
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
   * reader for yet (an unmaterialised `TemplateBody`, or a `DATA`-kind entry named where a type
   * is expected) -- see this module's own top note and `atomBuilder.ts`'s for the two atom-level
   * cases (every one of those is fully covered).
   */
  reader(name: string): TypeReader<Value>;
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

// One runtime guard per shape, so each branch below narrows `Top` on its own -- the held template
// body carries no `kind` to switch on.
function isRecordBody(body: Top): body is RecordBody {
  return !isTemplateBody(body) && body.kind === 'record';
}
function isMapBody(body: Top): body is MapBody {
  return !isTemplateBody(body) && body.kind === 'map';
}
function isArrayBody(body: Top): body is ArrayBody {
  return !isTemplateBody(body) && body.kind === 'array';
}
function isTupleBody(body: Top): body is TupleBody {
  return !isTemplateBody(body) && body.kind === 'tuple';
}
function isChoiceBody(body: Top): body is ChoiceBody {
  return !isTemplateBody(body) && body.kind === 'choice';
}
function isAlias(body: Top): body is Alias {
  return !isTemplateBody(body) && body.kind === 'alias';
}
function isDeclared(body: Top): body is DeclaredType {
  return !isTemplateBody(body) && body.kind === 'declared_type';
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
  resolve: (name: string) => TypeReader<Value>,
  policy: IdentifierPolicy,
  judgesMembers: boolean,
): TypeReader<Value> {
  const body = definition;
  // Whether `typeName` is an identifier family (§8.3 followed to its constructor): a name wherever
  // a value of it stands, so a scope of them meets skeleton distinctness when the policy asks.
  const isNameType = (typeName: string): boolean => {
    if (!policy.skeletonDistinctness) return false;
    const terminalBody = terminalDefinition(typeName, (n) => schema.entries.get(n));
    return (
      terminalBody !== undefined &&
      !isTemplateBody(terminalBody) &&
      terminalBody.kind === 'identifier_type'
    );
  };
  const location = (): SchemaLocation => locationOf(schema, name);

  // §5.10: a record template is a family base and MAY be named bare at a type position --
  // dispatching exactly as an ABSTRACT record's own position does, over its members, and never
  // reading the template itself (a value at such a position is always a value of some member).
  if (isFamilyBase(body)) {
    // `guardSubsumption` never invokes this, zero discriminators or many: it either reports a
    // validation error, refuses a tag naming the base, or dispatches to a subtype's/member's own
    // reader -- so there is no "own" record to read and none to build here.
    const neverRead: TypeReader<Value> = {
      read(): Task<Value> {
        throw new TsonInternalError(
          `'${name}': a template family base has no reader of its own -- this should be unreachable`,
        );
      },
    };
    return guardSubsumption(name, definition, neverRead, schema.entries, resolve);
  }
  if (isTemplateBody(body)) {
    // An open entry that is no type at all (reference, container, constructor-application, atom
    // template) was named directly rather than through a closed application -- §5.10's
    // materialisation should have produced a closed entry for every use site before linking;
    // naming this declaration itself has no reader of its own.
    throw new TsonNotImplementedError(
      `'${name}' declares type parameters and has no reader of its own -- apply it (§5.10) before reading against it`,
    );
  }

  // §7.2's subsumption rule -- a value's own `!type-ref` must be admitted by the position's
  // declared type -- applied at every position it governs (every `Atom`/`Product` body) rather
  // than only where a record happens to declare subtypes; see `subsumption.ts`'s own doc for which
  // kinds it deliberately leaves alone (`choice`, `reference`, `scoped`).
  // §4.1: a namespace type is a map type keyed by names, and a value of it is the map its facets
  // describe -- a record's `fields` is its `field_map`, which is no namespace.
  const namespaceMap = isNamespaceType(body) ? namespaceMapOf(body) : undefined;
  if (namespaceMap !== undefined) {
    const map: MapBody = {
      kind: 'map',
      keyType: { name: namespaceMap.keyType, arguments: [], annotations: [] },
      valueType: { name: namespaceMap.valueType, arguments: [], annotations: [] },
      voidable: false,
      ordered: namespaceMap.ordered,
    };
    const built = mapTreeReader(
      name,
      name,
      map,
      resolve,
      location(),
      isNameType(namespaceMap.keyType),
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isRecordBody(body)) {
    const fieldNames = fieldNameRule(schema.nameTypes.get(name));
    const built = recordTreeReader(
      name,
      name,
      body,
      (field) =>
        field.type.kind === 'sibling'
          ? dependentFieldReader(name, field.type.field)
          : resolve(field.type.name),
      location(),
      fieldNames,
      policy,
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve, fieldNames.form);
  }
  if (isArrayBody(body)) {
    const built = arrayTreeReader(
      name,
      name,
      body,
      resolve,
      location(),
      body.uniqueItems && isNameType(body.elementType.name),
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve);
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
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isTupleBody(body)) {
    const built = tupleTreeReader(name, name, body, resolve, location());
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isChoiceBody(body)) {
    return choiceTreeReader(
      name,
      name,
      body,
      resolve,
      location(),
      choiceDisjoint(definition) === true,
      schema.entries,
    );
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
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  // A namespace value (a meta layer's own vocabulary, a value and never a type, §4.1) named where a
  // type is expected -- a resolver error checked at schema load, so reaching it here through an
  // already-linked schema means something upstream let it through; reported as this module's own
  // gap rather than silently misread as a type.
  throw new TsonNotImplementedError(
    `'${name}' (kind ${entryKind(definition)}) is not a data type -- it is a value of a meta ` +
      "layer's vocabulary, not a type, and has no compiled reader",
  );
}

/**
 * A dependent field's reader (§5.2): its type is the one each instance's sibling value names, which
 * this reader cannot know before the record has read the sibling. Reading one is not built yet, so a read
 * that reaches one reports that.
 */
function dependentFieldReader(record: string, sibling: string): TypeReader<Value> {
  return {
    read: () => {
      throw new TsonNotImplementedError(
        `'${record}' has a dependent field typed by its sibling '${sibling}!' (§5.2), which a compiled ` +
          'reader does not read yet',
      );
    },
  };
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
  resolve: (name: string) => TypeReader<Value>,
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
  const cache = new Map<string, TypeReader<Value>>();
  const policy = deps.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;
  const judgesMembers = deps.judgesReferenceMembers ?? true;

  function resolve(name: string): TypeReader<Value> {
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
    const inner = buildReader(schema, name, definition, resolve, policy, judgesMembers);
    box.inner = inner;
    cache.set(name, inner); // supersede the placeholder for every caller from here on
    return inner;
  }

  return {
    linked: schema,
    reader: resolve,
  };
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
