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
import type { LinkedSchema } from '../link/link.js';
import type {
  Extern,
  Reference,
  Top,
  TypeDefinition,
  UnknownType,
} from '../schema/meta/typedef.js';
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
import { schemalessTreeReader } from '../reader/schemaless/tree.js';
import { choiceTreeReader } from './choiceReader.js';
import { buildAtomReader } from './atomBuilder.js';
import { isAtom } from './atomChecks.js';
import { guardSubsumption } from './subsumption.js';

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
   * reader for yet (`extern`, an unmaterialised `TemplateBody`, or a `DATA`-kind entry named
   * where a type is expected) -- see this module's own top note and `atomBuilder.ts`'s for the
   * two atom-level cases (`unit`'s unnamed instances aside, every one of those is fully covered).
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
function isUnknownType(body: Top): body is UnknownType {
  return 'kind' in body && body.kind === 'unknown_type';
}
function isExtern(body: Top): body is Extern {
  return 'kind' in body && body.kind === 'extern';
}

/**
 * Builds `name`'s own reader from its resolved {@link TypeDefinition}, dispatching on {@link
 * TypeDefinition.body}'s shape. `resolve` is the whole-schema `name -> reader` lookup this
 * function's own children (a record field, an array element, a choice variant, ...) are built
 * against -- passed down rather than closed over directly by this function so `resolve` alone
 * owns the cycle-breaking cache.
 */
function buildReader(
  schema: LinkedSchema,
  name: string,
  definition: TypeDefinition,
  resolve: (name: string) => TypeReader<Value>,
): TypeReader<Value> {
  const body = definition.body;
  const location = (): SchemaLocation => locationOf(schema, name);

  if (!('kind' in body)) {
    // A `TemplateBody` reaching compilation at all means an open (parameterised) entry was named
    // directly rather than through a closed application -- §5.10's materialisation should have
    // produced a closed entry for every use site before linking; naming the open declaration
    // itself has no reader of its own to build.
    throw new TsonNotImplementedError(
      `'${name}' declares type parameters and has no reader of its own -- apply it (§5.10) before reading against it`,
    );
  }

  // §7.2's subsumption rule -- a value's own `!type-ref` must be admitted by the position's
  // declared type -- applied at every position it governs (every `Atom`/`Product` body) rather
  // than only where a record happens to declare subtypes; see `subsumption.ts`'s own doc for which
  // kinds it deliberately leaves alone (`choice`, `reference`, `extern`, `unknown`).
  if (isRecordBody(body)) {
    const built = recordTreeReader(
      name,
      name,
      body,
      (field) => resolve(field.type.name),
      location(),
    );
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isArrayBody(body)) {
    const built = arrayTreeReader(name, name, body, resolve, location());
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  if (isMapBody(body)) {
    const built = mapTreeReader(name, name, body, resolve, location());
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
      definition.disjoint === true,
      schema.entries,
    );
  }
  if (isReference(body)) {
    // A closed alias reads exactly as its target does (§8.3) -- no framing of its own to add, so
    // this is pure indirection through the same lazily-tied cache `resolve` already provides
    // (safe even when the alias and its target form part of a cycle).
    return resolve(body.target.name);
  }
  if (isUnknownType(body)) {
    // `unknown` (§4.2): "the universe of types," accepting any well-formed value of any type --
    // exactly `reader/schemaless/tree.ts`'s own no-schema-in-scope contract, reused rather than
    // restated. Every import this pulls in terminates in `atom/`/`base/`/`tree/`/`stream/`/
    // `core/` (that module's own top note), so this stays clear of `compiler/`'s `bind/` zone.
    return schemalessTreeReader();
  }
  if (isExtern(body)) {
    // meta.tn's own `extern` (a reference into a separately-governed schema, §7.8): "no compiled
    // reader exists for this constructor, a documented gap in the reference implementation"
    // (`typedef.ts`'s own doc on `Extern`) -- carried over unchanged rather than closed here,
    // since closing it means resolving a second schema library this module is never handed.
    throw new TsonNotImplementedError(
      `'${name}' is an 'extern' reference into a separately-governed schema (§7.8) -- no compiled reader exists for this constructor yet`,
    );
  }
  if (isAtom(body)) {
    const built = buildAtomReader(name, body);
    return guardSubsumption(name, definition, built, schema.entries, resolve);
  }
  // A `DATA`-kind entry (meta-schema vocabulary, not a data type, §4.1) named where a type is
  // expected -- `typedef.ts`'s own doc calls this "a resolver error checked at schema load", so
  // reaching it here through an already-linked schema means something upstream let it through;
  // reported as this module's own gap rather than silently misread as a type.
  throw new TsonNotImplementedError(
    `'${name}' (kind ${definition.kind}) is not a data type -- it describes meta-schema vocabulary, not a value, and has no compiled reader`,
  );
}

/** Builds a {@link CompiledSchema} for `schema` -- see this module's own top note for what compiling means and how cycles resolve. */
export function compile(schema: LinkedSchema): CompiledSchema {
  const cache = new Map<string, TypeReader<Value>>();

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
    const inner = buildReader(schema, name, definition, resolve);
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
 * read still gets everything the root value itself found.
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

/** Everything one {@link validate} call found: the tree {@link readValue} built (best-effort past any reported problem, per every reader in this stack's own "reporting never abandons the value" rule) and every {@link Diagnostic} raised along the way, in report order. Empty `diagnostics` means the document conforms. */
export interface ValidationResult {
  readonly value: Value;
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
  return { value, diagnostics: diagnostics.diagnostics };
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
