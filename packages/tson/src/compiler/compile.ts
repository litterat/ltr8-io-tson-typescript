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
 * "deliberately narrow" and stops short of: resolving a {@link TypeDefinition.body}'s every
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
import type { SchemaRef } from '../stream/event.js';
import type { LinkedSchema } from '../link/link.js';
import { canonicalizeIdentity } from '../link/identity.js';
import type { Reference, Scoped, Top, TypeDefinition } from '../schema/meta/typedef.js';
import { choiceDisjoint, isTemplateBody, typeKind } from '../schema/meta/typedef.js';
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
import { resolvesToScoped, terminalDefinition } from '../link/referenceChain.js';
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
  const definition = schema.entries.get(name);
  const schemaId = schema.origins.get(name) ?? schema.id;
  return {
    schemaId,
    pointer: `/${name}`,
    ...(definition?.position === undefined ? {} : { position: definition.position }),
  };
}

// `Top`'s own union mixes closed literal-`kind` members (`RecordBody`, `Reference`, ...) with one
// open one (`Data.kind: string`) -- a plain `switch (body.kind)` cannot exclude `Data` from any
// case's own narrowing (TypeScript has no literal to rule out against an open `string`), so every
// branch here is its own runtime type guard instead, exactly the pattern `reader/tree/factory.ts`
// already uses for its four `Product` cases (`isRecordBody`, ...) -- duplicated rather than
// imported, since that module's own guards are private to it.
function isRecordBody(body: Top): body is RecordBody {
  return 'kind' in body && body.kind === 'record';
}
function isMapBody(body: Top): body is MapBody {
  return 'kind' in body && body.kind === 'map';
}
function isArrayBody(body: Top): body is ArrayBody {
  return 'kind' in body && body.kind === 'array';
}
function isTupleBody(body: Top): body is TupleBody {
  return 'kind' in body && body.kind === 'tuple';
}
function isChoiceBody(body: Top): body is ChoiceBody {
  return 'kind' in body && body.kind === 'choice';
}
function isReference(body: Top): body is Reference {
  return 'kind' in body && body.kind === 'reference';
}
function isScoped(body: Top): body is Scoped {
  return 'kind' in body && body.kind === 'scoped';
}

/**
 * How a compile reaches a schema a document names *inside itself* -- §7.8's scope push, where an
 * EXTERN value carries its own `!!schema` and the type it names has to be resolved and compiled
 * before that value can be read.
 *
 * **Read-time, unlike every other name a compile resolves.** A compiled reader's children are
 * wired as real references at compile time, because the schema being compiled names all of them.
 * Which foreign schema an EXTERN value pushes is the *document's* choice, so it cannot be known
 * until the value arrives; what can be fixed in advance is where to look. `compile`'s own {@link
 * CompileDeps.foreignSchemas} hands this lookup to every compile it performs (§10.1's ordinary
 * library), so a scope push resolves through the schema registry the caller already holds --
 * `config.ts`'s own `Tson.compile` is what actually supplies one.
 *
 * A lookup rather than a fetch: `undefined` means this compile has no way to obtain `uri` at all
 * (never registered, and nothing here fetches -- see `config.ts`'s own top note on why schema
 * resolution never fetches), which is a fact about this deployment, never a verdict on the
 * document that named it.
 */
export type ForeignSchemas = (uri: string) => LinkedSchema | undefined;

/** {@link compile}'s own dependencies -- currently the one seam a `scoped` position needs (§7.8). */
export interface CompileDeps {
  readonly foreignSchemas?: ForeignSchemas;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy over a value of an identifier family: a name wherever
   * it stands, so the per-name mechanisms reach it under the family's own profile, and the keys of
   * a map keyed by one and the elements of a set of them are look-alike scopes (§11.4). Defaults
   * to {@link DEFAULT_IDENTIFIER_POLICY}. Stated once per compile, as a relaxation is a code decision
   * and never ambient.
   */
  readonly identifierPolicy?: IdentifierPolicy;
}

/**
 * Builds `name`'s own reader from its resolved {@link TypeDefinition}, dispatching on {@link
 * TypeDefinition.body}'s shape. `resolve` is the whole-schema `name -> reader` lookup this
 * function's own children (a record field, an array element, a choice variant, ...) are built
 * against -- passed down rather than closed over directly by this function so `resolve` alone
 * owns the cycle-breaking cache. `compileForeign` is threaded through to a `scoped` body alone
 * (§7.8); every other branch ignores it.
 */
function buildReader(
  schema: LinkedSchema,
  name: string,
  definition: TypeDefinition,
  resolve: (name: string) => TypeReader<Value>,
  compileForeign: (uri: string) => CompiledSchema | undefined,
  foreignSchemasConfigured: boolean,
  policy: IdentifierPolicy,
): TypeReader<Value> {
  const body = definition.body;
  // Whether `typeName` is an identifier family (§8.3 followed to its constructor): a name wherever
  // a value of it stands, so a scope of them meets skeleton distinctness when the policy asks.
  const isNameType = (typeName: string): boolean => {
    if (!policy.skeletonDistinctness) return false;
    const terminalBody = terminalDefinition(typeName, (n) => schema.entries.get(n))?.body;
    return (
      terminalBody !== undefined &&
      'kind' in terminalBody &&
      terminalBody.kind === 'identifier_type'
    );
  };
  const location = (): SchemaLocation => locationOf(schema, name);
  // §7.8's typed-position restriction, derived structurally: whether `typeName` resolves (§8.3)
  // to a `scoped` instance at all -- a container consults this to decide whether a nested
  // `!!schema` may stand at that position (`reader/tree/grammar.ts`'s own
  // `refuseUnscopedSchemaRef`); which cell it lands in is `buildScopedReader`'s own concern.
  const isScopedType = (typeName: string): boolean =>
    resolvesToScoped(typeName, (n) => schema.entries.get(n));

  if (!('kind' in body)) {
    // §5.10: a record-bodied template is a family base and MAY be named bare at a type position --
    // dispatching exactly as an ABSTRACT record's own position does, over its instantiations, and
    // never reading the held body (there is nothing of its own to read: a value at such a position
    // is always a value of some member, never of the template itself). Every other open shape
    // (reference, container, constructor-application, atom template) is no type at all and has no
    // reader to build.
    if (isTemplateBody(body) && body.extension !== undefined) {
      // `guardSubsumption` never invokes this, zero discriminators or many: it either reports a
      // validation error, refuses a tag naming the base, or dispatches to a subtype's/member's
      // own reader -- so there is no "own" record to read and none to build here.
      const neverRead: TypeReader<Value> = {
        read(): Task<Value> {
          throw new TsonInternalError(
            `'${name}': a template family base has no reader of its own -- this should be unreachable`,
          );
        },
      };
      return guardSubsumption(name, definition, neverRead, schema.entries, resolve);
    }
    // An open (parameterised) entry that is no type at all was named directly rather than through
    // a closed application -- §5.10's materialisation should have produced a closed entry for
    // every use site before linking; naming this declaration itself has no reader of its own.
    throw new TsonNotImplementedError(
      `'${name}' declares type parameters and has no reader of its own -- apply it (§5.10) before reading against it`,
    );
  }

  // §7.2's subsumption rule -- a value's own `!type-ref` must be admitted by the position's
  // declared type -- applied at every position it governs (every `Atom`/`Product` body) rather
  // than only where a record happens to declare subtypes; see `subsumption.ts`'s own doc for which
  // kinds it deliberately leaves alone (`choice`, `reference`, `scoped`).
  if (isRecordBody(body)) {
    const built = recordTreeReader(
      name,
      name,
      body,
      (field) => resolve(field.type.name),
      location(),
      isScopedType,
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isArrayBody(body)) {
    const built = arrayTreeReader(
      name,
      name,
      body,
      resolve,
      location(),
      isScopedType,
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
      isScopedType,
      isNameType(body.keyType.name),
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isTupleBody(body)) {
    const built = tupleTreeReader(name, name, body, resolve, location(), isScopedType);
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
      schema.textEnums,
    );
  }
  if (isReference(body)) {
    // A closed alias reads exactly as its target does (§8.3) -- no framing of its own to add, so
    // this is pure indirection through the same lazily-tied cache `resolve` already provides
    // (safe even when the alias and its target form part of a cycle).
    return resolve(body.target.name);
  }
  if (isScoped(body)) {
    return buildScopedReader(
      name,
      schema.entries,
      body,
      resolve,
      compileForeign,
      foreignSchemasConfigured,
    );
  }
  if (isAtom(body)) {
    const enumForm = schema.enumForms.get(name);
    const built = buildAtomReader(name, body, {
      identifierPolicy: policy,
      ...(enumForm === undefined ? {} : { enumForm }),
    });
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  // A `DATA`-kind entry (meta-schema vocabulary, not a data type, §4.1) named where a type is
  // expected -- `typedef.ts`'s own doc calls this "a resolver error checked at schema load", so
  // reaching it here through an already-linked schema means something upstream let it through;
  // reported as this module's own gap rather than silently misread as a type.
  throw new TsonNotImplementedError(
    `'${name}' (kind ${typeKind(definition, (n) => schema.entries.get(n))}) is not a data type -- ` +
      'it describes meta-schema vocabulary, not a value, and has no compiled reader',
  );
}

/**
 * meta.tn's `scoped` constructor's own vocabulary, resolved (§7.8): the open sum, in which the
 * value names its own type and the instance names the namespaces that name may be resolved in.
 * One reader for every instance -- core's `declared`, `extern` and `dynamic`, and every narrowing
 * `extern_of`/`extern_type` materialises -- because what separates them is two constraint values,
 * `body.scope`/`body.schemas`, and not a shape.
 *
 * **The value's own shape picks the cell** (§7.8's "data rule"): a value carrying a nested
 * `!!schema` is EXTERN; a value carrying a `!type-ref` alone is LOCAL; a value carrying neither
 * names no type and is a validation error, there being nothing at an open position for a type to
 * be inferred from. A cell `body.scope` does not hold refuses the value it would have taken --
 * `declared` (`[LOCAL]`) refuses a pushed scope, `extern` (`[EXTERN]`) refuses its absence, both
 * from this one reader.
 *
 * **LOCAL is fixed at compile time and EXTERN is not.** This entry belongs to exactly one schema,
 * so "the governing namespace" is `entries`, resolved through the same `resolve` every other
 * dispatch in this schema uses. Which foreign schema an EXTERN value names is the document's
 * choice, so it is looked up as the value arrives, through `compileForeign` -- the ordinary
 * library (§10.1), so a schema nothing would supply is one of §8.1's five schema-fetch codes and
 * never a verdict on the document.
 *
 * **The scope pops by returning.** There is no scope stack: the reader for the foreign type is
 * the foreign schema's own compiled reader, wired to that schema's own entries, so everything
 * below the pushed value resolves there by construction and everything after it resolves here
 * again -- and per the reference implementation's own note, nothing here threads this schema's
 * own declaration into the EXTERN read: the foreign reader offers its own declaration on entry
 * like every other reader, so a diagnostic from inside the pushed value already names the schema
 * that judged it.
 *
 * Tree mode only (bind mode is a separate work package over the same {@link Scoped}): the value
 * read against the foreign schema is returned exactly as that schema's own reader produced it --
 * the wire URI that governed it is not itself retained on the returned {@link Value}.
 */
function buildScopedReader(
  displayName: string,
  entries: ReadonlyMap<string, TypeDefinition>,
  body: Scoped,
  resolve: (name: string) => TypeReader<Value>,
  compileForeign: (uri: string) => CompiledSchema | undefined,
  foreignSchemasConfigured: boolean,
): TypeReader<Value> {
  // `body.schemas`, keyed by canonical identity ([TSON-DATA] §2.2.1) -- absent (an empty map, this
  // package's own absent-equals-empty convention) means "any foreign schema".
  const admittedSchemas = new Map<string, readonly string[]>();
  if (body.schemas !== undefined) {
    for (const [uri, types] of body.schemas) {
      admittedSchemas.set(canonicalizeIdentity(uri), types);
    }
  }
  const admittedSchemaNames = (): string => [...admittedSchemas.keys()].join(', ');

  function* abandon(ctx: ReadContext): Task<Value> {
    yield* skipDataValue(ctx);
    return abandonedValue();
  }

  /** §7.8's "the discriminant is required": an open position has nothing to infer a type from. */
  function* missingTypeRef(ctx: ReadContext): Task<Value> {
    ctx.report(
      'VALIDATION_ERROR',
      `'${displayName}' is a scoped type -- the value names its own type, so it requires an ` +
        'explicit type annotation (!typeName)',
      "a type annotation naming the value's own type",
      'no type annotation',
    );
    return yield* abandon(ctx);
  }

  /** A value naming a type in the governing namespace -- no directive, so the type-ref is the whole of what the value says about itself. */
  function* readLocal(ctx: ReadContext): Task<Value> {
    if (!body.scope.includes('LOCAL')) {
      ctx.report(
        'VALIDATION_ERROR',
        `'${displayName}' takes a value from a foreign schema, so the value must open a scope ` +
          "with its own '!!schema' naming the schema its type comes from (§7.8)",
        "a value prefixed by '!!schema'",
        'no !!schema',
      );
      return yield* abandon(ctx);
    }
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

  /** §7.8's scope push: the directive names the schema, the value's own type-ref names the type within it, and the foreign schema's compiled reader validates the value in full. */
  function* readExtern(ctx: ReadContext, ref: SchemaRef): Task<Value> {
    yield* ctx.next(); // the directive, whose scope is this value and nothing after it
    if (!body.scope.includes('EXTERN')) {
      ctx.report(
        'VALIDATION_ERROR',
        `'${displayName}' takes a type this schema declares or imports, so a value here cannot ` +
          `open a scope onto '${ref.uri}' (§7.8)`,
        "a value carrying no '!!schema'",
        ref.uri,
      );
      return yield* abandon(ctx);
    }
    // Absent `schemas` is "any foreign schema"; present, it is a closed set, matched by canonical
    // identity so a pinned key and an unpinned directive are one schema (§2.2.1) -- the pin itself
    // is `compileForeign`'s own loader's to verify, exactly as for any other schema reference.
    const identity = canonicalizeIdentity(ref.uri);
    if (admittedSchemas.size > 0 && !admittedSchemas.has(identity)) {
      ctx.report(
        'VALIDATION_ERROR',
        `'${displayName}' admits values from ${admittedSchemaNames()}, and '${ref.uri}' is not one of them`,
        `one of ${admittedSchemaNames()}`,
        ref.uri,
      );
      return yield* abandon(ctx);
    }
    const typeRef = yield* typeRefAhead(ctx);
    if (typeRef === undefined) {
      return yield* missingTypeRef(ctx);
    }
    const admittedTypes = admittedSchemas.get(identity);
    if (
      admittedTypes !== undefined &&
      admittedTypes.length > 0 &&
      !admittedTypes.includes(typeRef)
    ) {
      const typeNames = admittedTypes.join(', ');
      ctx.report(
        'VALIDATION_ERROR',
        `'${displayName}' admits ${typeNames} from '${ref.uri}', and '${typeRef}' is not one of them`,
        `one of ${typeNames}`,
        typeRef,
      );
      return yield* abandon(ctx);
    }
    const foreign = compileForeign(ref.uri);
    if (foreign === undefined) {
      ctx.report(
        foreignSchemasConfigured ? 'SCHEMA_NOT_FOUND' : 'SCHEMA_NOT_PERMITTED',
        foreignSchemasConfigured
          ? `'${ref.uri}' is not registered on this instance -- register (or preload) it before ` +
              'reading a value that opens a scope onto it (§7.8, §10.1)'
          : `this read has no foreign-schema lookup configured, so the scope onto '${ref.uri}' ` +
              'cannot be resolved (§7.8) -- read through a Tson facade, whose registry supplies one',
        'a schema that can be obtained',
        ref.uri,
      );
      return yield* abandon(ctx);
    }
    if (!foreign.linked.entries.has(typeRef)) {
      ctx.report(
        'UNKNOWN_TYPE',
        `'${typeRef}' is not a type '${ref.uri}' declares or imports`,
        [...foreign.linked.entries.keys()].join(' | '),
        typeRef,
      );
      return yield* abandon(ctx);
    }
    return yield* foreign.reader(typeRef).read(ctx);
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const peeked = yield* ctx.peek();
      return peeked.kind === 'schema-ref' ? yield* readExtern(ctx, peeked) : yield* readLocal(ctx);
    },
  };
}

/**
 * Builds a {@link CompiledSchema} for `schema` -- see this module's own top note for what
 * compiling means and how cycles resolve. `deps.foreignSchemas`, when supplied, is what every
 * `scoped` position's own reader (§7.8) looks a document-named schema up through; each distinct
 * URI a read actually pushes is resolved and compiled once per `compile` call and cached from
 * then on, so a document naming the same foreign schema many times compiles it once.
 */
export function compile(schema: LinkedSchema, deps: CompileDeps = {}): CompiledSchema {
  const cache = new Map<string, TypeReader<Value>>();
  const policy = deps.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;
  const foreignCompiled = new Map<string, CompiledSchema>();

  function compileForeign(uri: string): CompiledSchema | undefined {
    const identity = canonicalizeIdentity(uri);
    const cached = foreignCompiled.get(identity);
    if (cached !== undefined) return cached;
    const linked = deps.foreignSchemas?.(uri);
    if (linked === undefined) return undefined;
    const compiled = compile(linked, deps);
    foreignCompiled.set(identity, compiled);
    return compiled;
  }

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
    const inner = buildReader(
      schema,
      name,
      definition,
      resolve,
      compileForeign,
      deps.foreignSchemas !== undefined,
      policy,
    );
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
 * node as a real absent one cannot say which of its parts to trust. `value` is `undefined` rather
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
