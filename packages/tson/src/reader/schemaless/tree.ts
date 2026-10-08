/**
 * Reads a TSON data document into a `tree/nodes.ts` {@link Value} tree with **no schema in
 * scope** -- the port of `reader/SchemalessTreeReader.java`, the schemaless (Class 1) tree-
 * producing peer of `reader/bind.ts`'s `bindReader` (which produces authored host objects
 * instead). Like Jackson's `readTree`: the wire structure is the source of truth. Leaves are
 * typed by §4 base resolution (`bigint`/`TsonDecimal`/`number`/`boolean`/`string`), or by
 * `vocabulary.ts`'s built-in atom table when a leaf carries a type-ref for one (`!uuid`, `!date`,
 * ...); a container carries its own wire type-ref (`!person`) when present, uninterpreted.
 *
 * **This is the module `CLAUDE.md`'s "must not pull the compiler in" constraint is actually
 * about.** Every import below terminates in `atom/`, `base/`, `tree/`, `stream/`, `core/` or this
 * reader's own siblings -- nothing here, transitively, reaches `compiler/`, `link/`, `schema/
 * meta`'s registry half, or `resolver/`; `vocabulary.ts` builds every atom from a hand-authored
 * constraints literal (mirroring `spec/m/core.tn`'s own text) rather than by resolving anything.
 * That is what makes this reader usable from `@ltr8/tson`'s default entry in a browser that never
 * loads a schema compiler at all.
 *
 * **Streams the event source directly** (an {@link EventSource} via {@link ReadContext}), the
 * same way `reader/bind.ts` does -- building nodes as events arrive, never materializing an
 * intermediate `DataValue` AST first. Since a tree materializes the whole document anyway, the
 * point isn't a bounded working set, but avoiding a second representation and staying consistent
 * with the rest of the read stack (and, per `Task`'s own contract, never holding more than one
 * open container's worth of stack frame per nesting level).
 *
 * **Schemaless, so:** an array is always an {@link ArrayNode} (the grammar has no array/tuple
 * distinction -- only a schema-driven read produces a {@link TupleNode}), and `{}` resolves to an
 * empty {@link RecordNode} (§2.8 leaves this to the resolver; a tree with no schema picks
 * record, matching `SchemalessTreeReader.java`'s own choice).
 *
 * **Type-refs are checked** by `typeRefCheck.ts`'s rules: a built-in name must sit on a token and
 * that token must satisfy the atom; any other name links to nothing and is `UNKNOWN_TYPE_REF`.
 * {@link SchemalessTreeReaderOptions.preserveUnknownTypeRefs} opts out of that last rule for a
 * caller who wants the wire back as authored.
 *
 * **Every problem goes through `ctx.report`**, so the read's own `DiagnosticsReceiver` decides
 * its fate exactly as it does for the schema-driven readers: fail-fast throws at the first
 * problem, a collecting one gathers them all. **Reporting never abandons the value here** --
 * unlike a schema-governed tree/bind read (`reader/tree/support.ts`'s own `abandonedValue`), this
 * reader keeps building: the node is still constructed and its children are still read, so one
 * pass finds everything, and a leaf whose atom rejected the token stands as an {@link AbsentNode}
 * rather than aborting the container around it. It is the facade above this reader that decides
 * whether that tree ever reaches a caller: `facade/tree.ts`'s own `validate` withholds `value`
 * for the whole document whenever anything was reported, whatever layer raised it -- so this
 * placeholder reaches a caller only through a lower-level entry point that manages its own
 * `ReadContext` directly, never through `validate`/`readTree`.
 *
 * **Wire annotations are captured** onto each node's own `annotations`, at every position §3.1
 * permits one: the root value, a record field's value, an array element, either side of a map
 * entry, and recursively an annotation's own value -- read the same structural way `reader/
 * bind.ts`'s own `readStructuralAnnotations` reads them (deliberately duplicated rather than
 * imported; see that module's own note on why: sub-agents share no context, and this is a
 * two-line structural rule with nothing library-specific in it). A record field *name* never
 * carries any (§2.5 forbids annotations before a field name). Nothing checks an annotation's own
 * *name*: with no governing schema there is no type to resolve it against (§3.1's Class 1
 * treatment).
 */
import {
  TsonAtomTypeError,
  TsonInternalError,
  TsonNameHygieneRefusedError,
} from '../../core/errors.js';
import {
  maxNestingDepthOf,
  nestingLimitRefusal,
  type NestingLimitOptions,
} from '../../core/limits.js';
import type { Task } from '../../io/bytes.js';
import type { TokenEvent, TsonEvent } from '../../stream/event.js';
import type { AtomType } from '../../atom/contract.js';
import { resolveBaseType, type BaseValue } from '../../base/baseTypeResolver.js';
import { toExactDecimal, toExactInteger } from '../../base/numberNarrowing.js';
import type { NumberForm } from '../../base/numberGrammar.js';
import type { Annotation, Annotations } from '../../annotations/index.js';
import { EMPTY_ANNOTATIONS } from '../../annotations/index.js';
import type {
  CoreValue,
  DataValue,
  MapEntry as AstMapEntry,
  RecordField,
  ScopedValue,
} from '../../ast/value.js';
import type { AtomValue, MapEntry as TreeMapEntry, Value } from '../../tree/nodes.js';
import { absentNode, arrayNode, atomNode, mapNode, recordNode } from '../../tree/nodes.js';
import { diagnosticCodeForMechanism } from '../../core/diagnostic.js';
import { toNfc } from '../../unicode/nfc.js';
import {
  DEFAULT_IDENTIFIER_POLICY,
  DEFAULT_TOKEN_POLICY,
  nameHygieneRefusal,
  tokenHygieneRefusal,
  type IdentifierPolicy,
  type ScriptPolicy,
} from '../../unicode/policy.js';
import { firstConfusableCollision } from '../../unicode/skeleton.js';
import { UTS39_VERSION } from '../../unicode/uts39.js';
import {
  dateTimeInstantSeconds,
  decimalIdentityKey,
  deepEqual,
  isPlainDateTime,
  isPlainTime,
  isTsonDecimal,
  timeOfDayWrapped,
} from '../tree/equality.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import { lookupBuiltinAtom } from './vocabulary.js';
import { reportAtomViolation, reportNotScalar, reportUnknownTypeRef } from './typeRefCheck.js';

export interface SchemalessTreeReaderOptions extends NestingLimitOptions {
  /**
   * Keeps a type-ref naming no built-in type on the node without reporting it -- §5.1's
   * uninterpreted marker, carried all the way to the tree. For reading the wire form of a
   * document whose own `!!schema` defines those names but is deliberately not in scope, or for
   * round-tripping through a tree writer. Defaults to `false` -- see `typeRefCheck.ts`'s own note
   * on why reporting, not silence, is the default.
   */
  readonly preserveUnknownTypeRefs?: boolean;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy. Every identifier position at this layer reads from it,
   * in one walk: each record's own field names (§8.2's one Part 1 scope, checked once per record
   * after its fields are read -- see {@link reportNameHygiene}), and every type-ref/annotation
   * name as it is pulled off the event stream (checked once each -- see `checkIdentifierHygiene`
   * in this module). All three positions are `identifier` (§2.5, §7.7), so all three meet all
   * three mechanisms; the scope a record's field names form is what mechanism 1 additionally
   * needs. Defaults to {@link DEFAULT_IDENTIFIER_POLICY} -- mechanism
   * 3 at Highly Restrictive over the whole name -- matching §8.2's own defaults. Relaxing any of
   * the three is this field's job (`unicode/policy.ts`'s own `with*` functions build a relaxed
   * value); §8.2 forbids relaxing one silently, e.g. from an environment variable, which is
   * exactly what passing a policy explicitly here is not.
   */
  readonly identifierPolicy?: IdentifierPolicy;
  /**
   * [TSON-DATA] §8.2's "Values" paragraph: the policy applied to every token this reader decodes
   * as a value -- a record field's value, an array element, a map key or its value, and (nested,
   * recursively) an annotation's own value. Defaults to {@link DEFAULT_TOKEN_POLICY}, Unrestricted,
   * so an ordinary read scans nothing. Distinct from {@link identifierPolicy}: a value has no
   * identifier profile and no scope to be distinct within, so only the restricted-script rule
   * (mechanism 3) ever applies here -- see `unicode/policy.ts`'s own {@link ScriptPolicy} doc.
   *
   * **Never checked against a field name, type-ref, or annotation name.** Those are `identifier`
   * positions governed by {@link identifierPolicy} alone (`checkIdentifierHygiene`,
   * {@link reportNameHygiene}); this field governs the positions that are not names at all. The
   * pinned Java reference checks both surfaces together at its own event-source layer, where the
   * four text-bearing event kinds are not yet told apart (`ScriptPolicyEventSource`'s own doc); this
   * reader already dispatches on event kind before either check runs, so the two surfaces are kept
   * separate here rather than merged incidentally.
   */
  readonly tokenPolicy?: ScriptPolicy;
}

/**
 * Builds a {@link TypeReader} that reads one position with no schema in scope -- the whole of
 * this module's public surface. Reads exactly one `data-value` (§2.3) at `ctx`'s cursor; whole-
 * document framing (consuming the leading `document-start`, and pulling *past* the root value so
 * a lazy {@link EventSource} actually checks for trailing content) is a facade's job, one layer up
 * -- see `reader/contracts.ts`'s own note on why that framing isn't `TypeReader`'s to do.
 */
export function schemalessTreeReader(options: SchemalessTreeReaderOptions = {}): TypeReader<Value> {
  const preserve = options.preserveUnknownTypeRefs ?? false;
  const limit = maxNestingDepthOf(options);
  const identifierPolicy = options.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;
  const tokenPolicy = options.tokenPolicy ?? DEFAULT_TOKEN_POLICY;
  return {
    read: (ctx: ReadContext): Task<Value> =>
      readNode(ctx, preserve, limit, identifierPolicy, tokenPolicy, 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Structural annotation/type-ref framing -- this module's own copy of `reader/bind.ts`'s
// `readStructuralAnnotations`/`readStructuralDataValue`/`readStructuralCoreValue`/
// `readStructuralScopedValue`, deliberately duplicated (see this file's own top note) and adapted
// to hand back an `Annotations` directly rather than a bare `readonly Annotation[]`.
// ---------------------------------------------------------------------------------------------

function* readStructuralAnnotations(
  ctx: ReadContext,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth = 0,
): Task<Annotations> {
  const first = yield* ctx.peek();
  if (first.kind !== 'annotation-start') {
    return EMPTY_ANNOTATIONS;
  }
  const values: Annotation[] = [];
  for (;;) {
    const start = yield* ctx.peek();
    if (start.kind !== 'annotation-start') break;
    yield* ctx.next();
    checkIdentifierHygiene(ctx, start.name, identifierPolicy);
    let value: DataValue | undefined;
    const afterStart = yield* ctx.peek();
    if (afterStart.kind !== 'annotation-end') {
      // One level deeper: an annotation's value is a data value, so `@a:@a:@a:...` is a real
      // descent even though it opens no brace or bracket, and it is the one this stack has no
      // path step to count (§9.1). Unbounded, it exhausted the host stack out of `readTree`.
      value = yield* readStructuralDataValue(ctx, limit, identifierPolicy, tokenPolicy, depth + 1);
    }
    yield* ctx.next(); // annotation-end
    values.push(value === undefined ? { name: start.name } : { name: start.name, value });
  }
  return { values };
}

function* readStructuralDataValue(
  ctx: ReadContext,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth = 0,
): Task<DataValue> {
  if (depth >= limit) {
    throw nestingLimitRefusal(limit, ctx.position());
  }
  const annotations = yield* readStructuralAnnotations(
    ctx,
    limit,
    identifierPolicy,
    tokenPolicy,
    depth,
  );
  const typeRef = yield* readTypeRefName(ctx, identifierPolicy);
  const coreValue = yield* readStructuralCoreValue(
    ctx,
    limit,
    identifierPolicy,
    tokenPolicy,
    depth,
  );
  return {
    annotations: annotations.values,
    ...(typeRef !== undefined ? { typeRef } : {}),
    coreValue,
  };
}

function* readStructuralScopedValue(
  ctx: ReadContext,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<ScopedValue> {
  const peeked = yield* ctx.peek();
  let schemaRef: string | undefined;
  if (peeked.kind === 'schema-ref') {
    yield* ctx.next();
    schemaRef = peeked.uri;
  }
  const value = yield* readStructuralDataValue(ctx, limit, identifierPolicy, tokenPolicy, depth);
  return { ...(schemaRef !== undefined ? { schemaRef } : {}), value };
}

function* readStructuralCoreValue(
  ctx: ReadContext,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<CoreValue> {
  const e = yield* ctx.next();
  switch (e.kind) {
    case 'record-start': {
      const fields: RecordField[] = [];
      while ((yield* ctx.peek()).kind !== 'record-end') {
        const fieldName = yield* ctx.next();
        if (fieldName.kind !== 'field-name') {
          throw new TsonInternalError(`expected field-name, got '${fieldName.kind}'`);
        }
        const value = yield* readStructuralScopedValue(
          ctx,
          limit,
          identifierPolicy,
          tokenPolicy,
          depth + 1,
        );
        fields.push({ name: fieldName.name, value });
      }
      yield* ctx.next(); // record-end
      return { kind: 'record', fields };
    }
    case 'map-start': {
      const entries: AstMapEntry[] = [];
      while ((yield* ctx.peek()).kind !== 'map-end') {
        const key = yield* readStructuralDataValue(
          ctx,
          limit,
          identifierPolicy,
          tokenPolicy,
          depth + 1,
        );
        const arrow = yield* ctx.next();
        if (arrow.kind !== 'map-arrow') {
          throw new TsonInternalError(`expected map-arrow, got '${arrow.kind}'`);
        }
        const value = yield* readStructuralScopedValue(
          ctx,
          limit,
          identifierPolicy,
          tokenPolicy,
          depth + 1,
        );
        entries.push({ key, value });
      }
      yield* ctx.next(); // map-end
      return { kind: 'map', entries };
    }
    case 'array-start': {
      const elements: ScopedValue[] = [];
      while ((yield* ctx.peek()).kind !== 'array-end') {
        elements.push(
          yield* readStructuralScopedValue(ctx, limit, identifierPolicy, tokenPolicy, depth + 1),
        );
      }
      yield* ctx.next(); // array-end
      return { kind: 'array', elements };
    }
    case 'token':
      checkTokenHygiene(ctx, e.text, tokenPolicy);
      return { kind: 'token', text: e.text, form: e.form };
    case 'absent':
      return { kind: 'absent' };
    case 'empty-brace':
      return { kind: 'empty-brace' };
    default:
      throw new TsonInternalError(`unexpected event while reading a core-value: '${e.kind}'`);
  }
}

/**
 * Consumes an optional leading `type-ref` (§3.2), returning its name -- the second half of a
 * data-value's `annotation* type-ref?` framing, kept (not discarded) because both the node's own
 * `typeRef` and `checkTypeRef`'s dispatch need it. Checks the name against `identifierPolicy` via
 * {@link checkIdentifierHygiene} the moment it is consumed -- this function, together with
 * {@link readStructuralAnnotations}, is the whole of where this reader ever pulls a `type-ref` or
 * `annotation-start` event, so between the two of them every such name in the document is judged
 * exactly once.
 */
function* readTypeRefName(
  ctx: ReadContext,
  identifierPolicy: IdentifierPolicy,
): Task<string | undefined> {
  const peeked = yield* ctx.peek();
  if (peeked.kind !== 'type-ref') return undefined;
  yield* ctx.next();
  checkIdentifierHygiene(ctx, peeked.name, identifierPolicy);
  return peeked.name;
}

/**
 * [TSON-DATA] §8.2's restricted-character and restricted-script rules (mechanisms 2 and 3) over
 * one type-ref or annotation name -- the `identifier` position §7.4 marks (§7.6: `type-ref = "!"
 * identifier`, `annotation = "@" identifier`), checked the moment this reader consumes the event
 * that carries it.
 *
 * **Mechanism 1 (skeleton distinctness) cannot apply here and none is disabled to get that**:
 * it is a relation over a scope, and a lone name has no scope to be distinct within
 * (`unicode/skeleton.ts`'s own note). Calling {@link nameHygieneRefusal} with a single-element
 * name array already cannot produce a `'skeleton-distinctness'` result -- collision detection
 * needs two names -- so passing `identifierPolicy` through unmodified still checks only mechanisms 2
 * and 3, with no extra flag to thread or override.
 *
 * Ports the reference implementation's `DefaultTsonReadContext.checkNameHygiene`
 * (`tson-compiler/.../DefaultTsonReadContext.java`), which runs this same pair of rules on every
 * freshly-pulled `TypeRef`/`AnnotationStart` event and *never* on one replayed from a rewound
 * lookahead, so one name is judged exactly once even across a dispatcher that peeks past
 * annotations to decide what to read next. **This reader has no lookahead of its own** -- unlike
 * `reader/bind.ts`'s variant dispatch, nothing in this module ever calls `reader/contracts.ts`'s
 * `lookingAhead`, so every `ctx.next()` this file issues consumes a genuinely fresh event and
 * this function is reached from exactly the two sites that ever consume a `type-ref` or
 * `annotation-start` event ({@link readTypeRefName}, {@link readStructuralAnnotations}) --
 * exactly-once falls out of never replaying at all, rather than needing a fresh-vs-replayed
 * branch the way the reference implementation's shared, lookahead-capable context does.
 */
function checkIdentifierHygiene(
  ctx: ReadContext,
  name: string,
  identifierPolicy: IdentifierPolicy,
): void {
  const refusal = nameHygieneRefusal([name], identifierPolicy);
  if (refusal === undefined) return;
  const message =
    `the name '${name}' is refused under [TSON-DATA] §8.2's name-hygiene policy: ` + refusal.detail;
  try {
    ctx.report(
      diagnosticCodeForMechanism(refusal.mechanism),
      message,
      'a name this processor will accept',
      `'${name}'`,
    );
  } catch (thrown) {
    throw new TsonNameHygieneRefusedError(message, {
      mechanism: refusal.mechanism,
      names: refusal.names,
      uts39Version: UTS39_VERSION,
      cause: thrown,
    });
  }
}

/**
 * [TSON-DATA] §8.2's "Values" paragraph, over `text` -- the decoded text of one token this reader
 * has just pulled off the stream, before anything below this point (an atom parser, §4 base
 * resolution) has looked at it. Checked at every site this module ever consumes a `token` event
 * ({@link readNode}'s own leaf case, and {@link readStructuralCoreValue}'s, for a value nested
 * inside an annotation), so a token is judged exactly once regardless of which of the two pulled
 * it -- the same never-replayed guarantee {@link checkIdentifierHygiene} relies on, since neither
 * function's caller ever rewinds past a `token` event either.
 *
 * **Restricted-script only.** {@link tokenHygieneRefusal} can return only that one rule -- see its
 * own doc and `unicode/policy.ts`'s {@link ScriptPolicy} doc for why mechanisms 1 and 2 have
 * nothing to check on a value.
 *
 * Reported/thrown exactly the way {@link checkIdentifierHygiene} is -- see that function's own
 * note, and {@link reportNameHygiene}'s, on why a fail-fast refusal here surfaces as
 * {@link TsonNameHygieneRefusedError} rather than {@link TsonReadError}.
 */
function checkTokenHygiene(ctx: ReadContext, text: string, tokenPolicy: ScriptPolicy): void {
  const detail = tokenHygieneRefusal(text, tokenPolicy);
  if (detail === undefined) return;
  const message = `the token '${text}' is refused under [TSON-DATA] §8.2's "Values" token policy: ${detail}`;
  try {
    ctx.report(
      diagnosticCodeForMechanism('restriction-level'),
      message,
      'a token this processor will accept',
      `'${text}'`,
    );
  } catch (thrown) {
    throw new TsonNameHygieneRefusedError(message, {
      mechanism: 'restriction-level',
      names: [text],
      uts39Version: UTS39_VERSION,
      cause: thrown,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Type-ref dispatch -- `typeRefCheck.ts`'s rules 1 and 3, applied to this value's own wire
// type-ref before its core-value shape is inspected.
// ---------------------------------------------------------------------------------------------

interface BuiltinAtomMatch {
  readonly name: string;
  readonly atom: AtomType<unknown>;
}

/**
 * Applies `typeRefCheck.ts`'s rules to this value's own type-ref, returning the built-in atom
 * that should decode it -- `undefined` when there is no type-ref, when the name isn't a built-in,
 * or when a built-in name sits on a container (all three reported unless preserved, and all
 * three then read structurally, so a collecting read still descends into whatever was actually
 * written).
 */
function checkTypeRef(
  ctx: ReadContext,
  typeRefName: string | undefined,
  core: TsonEvent,
  preserveUnknownTypeRefs: boolean,
): BuiltinAtomMatch | undefined {
  if (typeRefName === undefined) return undefined;
  const atom = lookupBuiltinAtom(typeRefName);
  if (atom === undefined) {
    if (!preserveUnknownTypeRefs) {
      reportUnknownTypeRef(ctx, typeRefName);
    }
    return undefined;
  }
  if (core.kind !== 'token') {
    reportNotScalar(ctx, typeRefName, core);
    return undefined;
  }
  return { name: typeRefName, atom };
}

// ---------------------------------------------------------------------------------------------
// The recursive reader
// ---------------------------------------------------------------------------------------------

/** Reads one data-value: its leading annotations and optional type-ref (§2.3), then its core-value. */
function* readNode(
  ctx: ReadContext,
  preserve: boolean,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<Value> {
  if (depth >= limit) {
    // Thrown, not reported-and-recovered, even under a collecting receiver. A nesting bound is a
    // resource limit rather than a finding about one value: everything below this point is
    // unreachable, so there is nothing further to collect. Recovering by skipping would also
    // reintroduce the very problem — skipCoreValue recurses too, so on a 100,000-deep document it
    // overflows the stack while discarding what the guard just refused to read.
    throw nestingLimitRefusal(limit, ctx.position());
  }
  const annotations = yield* readStructuralAnnotations(ctx, limit, identifierPolicy, tokenPolicy);
  const typeRefName = yield* readTypeRefName(ctx, identifierPolicy);
  const peeked = yield* ctx.peek();
  const match = checkTypeRef(ctx, typeRefName, peeked, preserve);
  switch (peeked.kind) {
    case 'record-start':
      return yield* readRecord(
        ctx,
        typeRefName,
        annotations,
        preserve,
        limit,
        identifierPolicy,
        tokenPolicy,
        depth,
      );
    case 'map-start':
      return yield* readMap(
        ctx,
        typeRefName,
        annotations,
        preserve,
        limit,
        identifierPolicy,
        tokenPolicy,
        depth,
      );
    case 'array-start':
      return yield* readArray(
        ctx,
        typeRefName,
        annotations,
        preserve,
        limit,
        identifierPolicy,
        tokenPolicy,
        depth,
      );
    case 'empty-brace':
      yield* ctx.next();
      return recordNode(new Map(), typeRefName, annotations);
    case 'absent':
      yield* ctx.next();
      return absentNode(typeRefName, annotations);
    case 'token':
      yield* ctx.next();
      checkTokenHygiene(ctx, peeked.text, tokenPolicy);
      return leaf(ctx, peeked, typeRefName, match, annotations);
    default:
      throw new TsonInternalError(`unexpected event where a value was expected: '${peeked.kind}'`);
  }
}

/**
 * A field name stated twice is reported (`DUPLICATE_FIELD`, §2.5) and its value still overwrites
 * the earlier one -- last-value-wins, which `Map.set` applies anyway. §2.5's MUST NOT is Part 1's
 * and needs no schema to see, so it holds on this path exactly as it does under a compiled one.
 */
function* readRecord(
  ctx: ReadContext,
  typeRefName: string | undefined,
  annotations: Annotations,
  preserve: boolean,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<Value> {
  yield* ctx.next(); // record-start
  const fields = new Map<string, Value>();
  for (;;) {
    const next = yield* ctx.peek();
    if (next.kind === 'record-end') break;
    const fieldNameEvent = yield* ctx.next();
    if (fieldNameEvent.kind !== 'field-name') {
      throw new TsonInternalError(`expected field-name, got '${fieldNameEvent.kind}'`);
    }
    const beforeValue = yield* ctx.peek();
    if (beforeValue.kind === 'schema-ref') {
      yield* ctx.next();
    }
    // §2.5 settles identity on the NFC form of the decoded name, so the two spellings of one
    // character are one field however each was written, and the map is keyed on that form.
    const fieldName = toNfc(fieldNameEvent.name);
    if (fields.has(fieldName)) {
      ctx
        .field(fieldName)
        .report(
          'DUPLICATE_FIELD',
          `duplicate field '${fieldName}' -- a record states each field at most once ` +
            `(§2.5), and the repeat states a value for nothing`,
          'each field stated once',
          `'${fieldName}' stated again`,
        );
    }
    const value = yield* readNode(
      ctx.field(fieldName),
      preserve,
      limit,
      identifierPolicy,
      tokenPolicy,
      depth + 1,
    );
    fields.set(fieldName, value);
  }
  yield* ctx.next(); // record-end
  reportNameHygiene(ctx, fields.keys(), identifierPolicy);
  return recordNode(fields, typeRefName, annotations);
}

/**
 * [TSON-DATA] §8.2's name-hygiene check over `fieldNames` -- one record's own field names, §8.2's
 * one Part 1 scope ("At this layer there is one: the field names of one record"). Run once per
 * record, after every field has been read (§2.5's duplicate-field check above already ran per
 * occurrence as fields arrived; this is the different rule that two *distinct* names read alike,
 * and mechanism 1 needs the whole set collected before it can see a collision at all).
 *
 * **All three mechanisms, in that order.** A field name is an `identifier` (§2.5, §7.7), so §8.2's
 * "Names and scopes" paragraph reaches it exactly as it reaches a declared name: "a schemaless
 * record's field names meet all three mechanisms exactly as a declared name does; there is one
 * walk, and no position is policed differently by conformance class". Mechanisms 2 and 3 are
 * per-name and judge each field name on its own; mechanism 1 is a relation over the scope and
 * needs the whole set. The per-name pass runs first because that is the order the mechanisms
 * decide in -- a within-word mixed-script homograph is refused by mechanism 3 before mechanism 1
 * has a pair to compare it against, and reporting the collision instead would name the wrong
 * rule.
 *
 * **A refusal is a fifth outcome, not one of §8.1's four error categories** -- reported through
 * `ctx.report` so a *collecting* read gets the ordinary `Diagnostic` shape (path, position, the
 * its own §8.2 refusal code) in its list exactly like every other finding, but a *fail-fast*
 * read must not surface it as {@link TsonReadError}: that class is what a caller (a conformance
 * runner among them) tests to recognise §8.1's resolver category, and a policy refusal is
 * explicitly not one. `ctx.report` synchronously throws only when its receiver is fail-fast
 * (`core/diagnostic.ts`'s own `throwing`), and only as a direct consequence of the `report` call
 * this function just made -- so any throw caught here is that conversion, and re-thrown as
 * {@link TsonNameHygieneRefusedError} (with the intermediate `TsonReadError` attached as `cause`)
 * instead of left to escape as-is. A collecting receiver never throws, so this function returns
 * normally for it, exactly as every other `ctx.report` call site in this module does.
 */
function reportNameHygiene(
  ctx: ReadContext,
  fieldNames: Iterable<string>,
  identifierPolicy: IdentifierPolicy,
): void {
  const names = [...fieldNames];
  for (const name of names) {
    const refusal = nameHygieneRefusal([name], identifierPolicy);
    if (refusal === undefined) continue;
    const perName =
      `the field name '${name}' is refused under [TSON-DATA] §8.2's name-hygiene policy: ` +
      refusal.detail;
    try {
      ctx
        .field(name)
        .report(
          diagnosticCodeForMechanism(refusal.mechanism),
          perName,
          'a field name this processor will accept',
          `'${name}'`,
        );
    } catch (thrown) {
      throw new TsonNameHygieneRefusedError(perName, {
        mechanism: refusal.mechanism,
        names: refusal.names,
        uts39Version: UTS39_VERSION,
        cause: thrown,
      });
    }
  }
  if (!identifierPolicy.skeletonDistinctness) return;
  const collision = firstConfusableCollision(names);
  if (collision === undefined) return;
  // §8.2 "on detection": reported at the second occurrence's position, in the manner of §2.6's
  // duplicate-key diagnostic.
  const at = collision.second;
  const message =
    `this record's field names are refused under [TSON-DATA] §8.2's name-hygiene policy: ` +
    `'${collision.second}' is confusable with '${collision.first}' -- the two are different ` +
    `names that read alike (UTS #39 skeleton), so one of them must be renamed`;
  try {
    ctx
      .field(at)
      .report(
        diagnosticCodeForMechanism('skeleton-distinctness'),
        message,
        'field names §8.2 can tell apart',
        `'${at}'`,
      );
  } catch (thrown) {
    throw new TsonNameHygieneRefusedError(message, {
      mechanism: 'skeleton-distinctness',
      names: [collision.first, collision.second],
      uts39Version: UTS39_VERSION,
      cause: thrown,
    });
  }
}

function* readArray(
  ctx: ReadContext,
  typeRefName: string | undefined,
  annotations: Annotations,
  preserve: boolean,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<Value> {
  yield* ctx.next(); // array-start
  const elements: Value[] = [];
  for (;;) {
    const next = yield* ctx.peek();
    if (next.kind === 'array-end') break;
    if (next.kind === 'schema-ref') {
      yield* ctx.next();
    }
    elements.push(
      yield* readNode(
        ctx.index(elements.length),
        preserve,
        limit,
        identifierPolicy,
        tokenPolicy,
        depth + 1,
      ),
    );
  }
  yield* ctx.next(); // array-end
  return arrayNode(elements, typeRefName, annotations);
}

/**
 * A map entry's *value* is scoped one segment deeper, keyed by the key's own text (§2.6 allows
 * any data-value as a key; one that isn't a plain scalar has no useful segment and becomes `?`).
 * The key itself is read at the map's own path -- it is not inside the entry it identifies, and
 * it has to be read before its segment can be known.
 */
function* readMap(
  ctx: ReadContext,
  typeRefName: string | undefined,
  annotations: Annotations,
  preserve: boolean,
  limit: number,
  identifierPolicy: IdentifierPolicy,
  tokenPolicy: ScriptPolicy,
  depth: number,
): Task<Value> {
  yield* ctx.next(); // map-start
  const entries: TreeMapEntry[] = [];
  // Bucketed by a structural digest rather than scanned linearly. A flat list with a deep
  // comparison per candidate is quadratic in the entry count with an expensive constant, and a
  // map's size is attacker-chosen: measured at n=16000 it cost 5.1 s against the record path's
  // 0.45 s, and tripled per doubling where the record path doubled. deepEqual still decides
  // within a bucket, so a digest collision costs a comparison and can never report a false
  // duplicate.
  const seen = new Map<string, unknown[]>();
  for (;;) {
    const next = yield* ctx.peek();
    if (next.kind === 'map-end') break;
    const key = yield* readNode(ctx, preserve, limit, identifierPolicy, tokenPolicy, depth + 1);
    if (key.kind === 'absent') {
      // §2.9: the void sentinel states that a position carries no value, and a map key is a
      // position that must. The map-entry production admits any value in key position, so this
      // is the reader's to refuse -- no grammar rule and no schema can see it first.
      ctx.report(
        'ABSENT_MAP_KEY',
        `a map key is the void sentinel -- '_' states that a position carries no value (§2.9), ` +
          `and an entry with no key states an entry for nothing`,
        'a key',
        'the void sentinel',
      );
    }
    const identity = keyIdentity(key);
    const digest = identityDigest(identity);
    const bucket = seen.get(digest);
    if (bucket?.some((s) => deepEqual(s, identity)) === true) {
      // §2.6, the map half of readRecord's duplicate-field rule.
      ctx.report(
        'DUPLICATE_MAP_KEY',
        `duplicate key '${keySegment(key)}' -- a map states each key at most once (§2.6), and ` +
          `the repeat states an entry for nothing`,
        'each key stated once',
        `'${keySegment(key)}' stated again`,
      );
    } else {
      if (bucket === undefined) {
        seen.set(digest, [identity]);
      } else {
        bucket.push(identity);
      }
    }
    yield* ctx.next(); // map-arrow
    const beforeValue = yield* ctx.peek();
    if (beforeValue.kind === 'schema-ref') {
      yield* ctx.next();
    }
    const value = yield* readNode(
      ctx.field(keySegment(key)),
      preserve,
      limit,
      identifierPolicy,
      tokenPolicy,
      depth + 1,
    );
    entries.push({ key, value });
  }
  yield* ctx.next(); // map-end
  return mapNode(entries, typeRefName, annotations);
}

/**
 * A token leaf, decoded by the built-in atom `checkTypeRef` matched, else by §4 base resolution.
 *
 * The only no-value outcome is a token the atom rejected: reporting never abandons the
 * surrounding value, and the diagnostic -- not the placeholder -- carries what went wrong. A
 * token base resolution reaches always narrows to a real value (§4.5 is total over three
 * classes); `null` is an ordinary string here, exactly as it is at every other unquoted-token
 * position (§4.4).
 */
function leaf(
  ctx: ReadContext,
  token: TokenEvent,
  typeRefName: string | undefined,
  match: BuiltinAtomMatch | undefined,
  annotations: Annotations,
): Value {
  if (match !== undefined) {
    try {
      const value = match.atom.read({ text: token.text, form: token.form });
      return atomNode(value as AtomValue, typeRefName, annotations);
    } catch (error) {
      if (error instanceof TsonAtomTypeError) {
        reportAtomViolation(ctx, match.name, error, token.text);
        return absentNode(typeRefName, annotations);
      }
      throw error;
    }
  }
  const narrowed = narrowBaseValue(resolveBaseType({ text: token.text, form: token.form }));
  return atomNode(narrowed, typeRefName, annotations);
}

/** §4's base type resolution narrowed to the natural host value each {@link BaseValue} variant implies -- this module's own copy of the Java reference's `ValueParser.narrow`. Total: every {@link BaseValue} kind narrows to a real {@link AtomValue}. */
function narrowBaseValue(value: BaseValue): AtomValue {
  switch (value.kind) {
    case 'boolean':
      return value.value;
    case 'string':
      return value.text;
    case 'number':
      return narrowNumberForm(value.form);
  }
}

/** `NumberForm` narrowed the way an untyped `value` position always narrows: exact `bigint` for an integer/based-integer, exact {@link TsonDecimal} for a float, and a `number` for the two special forms (`.nan`/`.inf`), which have no exact intermediate. */
function narrowNumberForm(form: NumberForm): AtomValue {
  switch (form.kind) {
    case 'special-value':
      return form.special === 'nan' ? NaN : form.sign === 'minus' ? -Infinity : Infinity;
    case 'integer':
    case 'based-integer':
      return toExactInteger(form);
    case 'float':
      return toExactDecimal(form);
  }
}

// ---------------------------------------------------------------------------------------------
// Map key identity (§2.6) -- what `readMap`'s duplicate check compares: a key's structure and
// decoded values, with every node's type-ref and annotations stripped. Neither is part of the
// key §2.6 compares -- it asks for "the same NFC-normalized string after escape processing" for a
// scalar and "the same structure with textually identical elements at every position" for a
// compound one, and a leading `!text` or `@doc` is in neither.
// ---------------------------------------------------------------------------------------------

/** A unique stand-in for the void sentinel `_` as a key identity -- distinct from every real decoded value, including the string `"null"` (quoted or not: base resolution's own `StringValue`, §4.4). */
const ABSENT_KEY_IDENTITY: unique symbol = Symbol('tson-schemaless-absent-key');

/**
 * The value {@link deepEqual}-comparable identity of `node`, for duplicate-key detection. Equates
 * on the *decoded* value rather than the source text, per §2.6: "a processor that decodes values
 * compares decoded values" -- so `0xFF` and `255` are one key here, matching what base
 * resolution's own `bigint` equality would give regardless.
 */
/**
 * A structural digest of a {@link keyIdentity} value, used only to bucket duplicate-key
 * candidates. Equal identities must produce equal digests; unequal ones may collide, and
 * `deepEqual` settles those, so a collision costs a comparison rather than correctness.
 *
 * Type-tagged throughout, so `1` and `"1"` do not share a bucket needlessly, and record fields
 * are sorted so two records differing only in field order still meet for comparison.
 *
 * **A decimal, a `!time` or a `!datetime` is digested by its normalised identity, not its raw
 * fields** (`reader/tree/equality.ts`'s own note on why: scale is a spelling, and a time/datetime
 * compares as an instant, §2.6, §5.4). Bucketing these by raw field shape would let two keys
 * `deepEqual` already treats as equal (`1.5` / `1.50`, or two offsets naming one instant) land in
 * different buckets and never reach the `deepEqual` compare below at all -- the one place this
 * module's own "equal identities must produce equal digests" invariant would otherwise be false.
 */
function identityDigest(value: unknown): string {
  if (value === null) return 'z';
  switch (typeof value) {
    case 'bigint':
      return `n${value.toString()}`;
    case 'number':
      return `d${String(value)}`;
    case 'string':
      return `s${value}`;
    case 'boolean':
      return `b${String(value)}`;
    case 'undefined':
      return 'u';
    case 'symbol':
      // `ABSENT_KEY_IDENTITY` is the one symbol `keyIdentity` ever produces -- a fixed tag is
      // enough, and the `'unscaled' in value` shape checks below cannot even run on a symbol.
      return 'y';
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `a[${value.map(identityDigest).join(',')}]`;
  }
  if (value instanceof Map) {
    return `m{${[...value.entries()]
      .map(([k, v]) => `${String(k)}=${identityDigest(v)}`)
      .sort()
      .join(',')}}`;
  }
  const record = value as Record<string, unknown>;
  if (isTsonDecimal(record)) {
    return `x${decimalIdentityKey(record)}`;
  }
  if (isPlainDateTime(record)) {
    return `dt${String(dateTimeInstantSeconds(record))}.${String(record.time.nanosecond)}`;
  }
  if (isPlainTime(record)) {
    return `tm${String(timeOfDayWrapped(record))}.${String(record.nanosecond)}`;
  }
  // A host atom value (a UUID, an address, and every other structured atom with no separate
  // identity rule). Own enumerable properties only, sorted, which is the same surface a
  // structural comparison walks.
  return `o{${Object.entries(record)
    .map(([k, v]) => `${k}=${identityDigest(v)}`)
    .sort()
    .join(',')}}`;
}

function keyIdentity(node: Value): unknown {
  switch (node.kind) {
    case 'atom':
      // §2.6 asks for "the same NFC-normalized string after escape processing" for a scalar; a
      // decoded atom that is not text carries no spelling for normalization to reach.
      return typeof node.value === 'string' ? toNfc(node.value) : node.value;
    case 'array':
      return node.elements.map(keyIdentity);
    case 'record': {
      const identity = new Map<string, unknown>();
      for (const [name, value] of node.fields) {
        identity.set(toNfc(name), keyIdentity(value));
      }
      return identity;
    }
    case 'map':
      return node.entries.map((entry) => [keyIdentity(entry.key), keyIdentity(entry.value)]);
    case 'absent':
      return ABSENT_KEY_IDENTITY;
    case 'tuple':
    case 'missing':
      throw new TsonInternalError(
        `unexpected '${node.kind}' node in a schemaless read's own key identity -- schemaless reading never produces one`,
      );
  }
}

/** A map key's own path segment: its scalar text, or `?` for a key with no single text form. */
function keySegment(node: Value): string {
  if (node.kind !== 'atom') return '?';
  const value = node.value;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      // A structured atom value (temporal/network/binary/exact-numeric) has no single text form
      // of its own at this layer -- the diagnostic still names the value's kind via `describeEvent`
      // elsewhere; here the path segment falls back the same way a non-atom key already does.
      return '?';
  }
}
