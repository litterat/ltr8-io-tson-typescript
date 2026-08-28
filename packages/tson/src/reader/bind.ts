/**
 * Object-binding mode's own reader: {@link bindReader} adapts a {@link Binding} descriptor
 * (`bind/binding.ts`, authored -- never derived, per that file's own top comment) into a
 * {@link TypeReader} that pulls {@link TsonEvent}s straight off a {@link ReadContext}. The port of
 * `tson-compiler/reader`'s `*BindReader`/`*AbstractReader` family
 * (`RecordBindReader`/`ArrayBindReader`/`MapBindReader`/`TupleBindReader`/`VariantBindReader`,
 * and the `RecordAbstractReader`/`ArrayAbstractReader`/`MapAbstractReader`/`TupleAbstractReader`
 * base classes they share with the tree-mode siblings this package does not build).
 *
 * **No schema in view, by design.** A `Binding` is authored independently of any schema
 * (`PORT-PLAN.md`, architectural decision 2) and carries none of the five-member `FieldState`
 * vocabulary (§5.2), `ElementState` (§5.3), or the size/uniqueness facets `ArrayBody`/`MapBody`
 * declare -- those are `schema/meta` questions, and `bind/strictness.ts`'s `checkBinding` already
 * answers the one such question a `Binding` alone can be checked against (does it cover its
 * record type's fields). What is left for *this* module is exactly what a `Binding` alone can
 * decide while reading: which wire shape a `kind` expects, whether a field's own slot is
 * `required`, and whether a name the wire states has a slot at all. `FieldSlot.required` is the
 * only presence axis a `Binding` carries, so "missing required" and "missing optional" are the
 * whole of what this module can tell apart -- a default/fixed value, and §5.11's field-group
 * counting, are compiled-reader concerns for the schema-aware layer built on top of this one.
 *
 * **Records are closed under their type regardless ([TSON-SCHEMA] §7.2).** A field name with no
 * matching {@link FieldSlot} is always `UNRECOGNIZED_FIELD` -- not a configurable strictness knob.
 * The Java reference's own `RecordAbstractReader` states this as a MUST, and the `strict` flag on
 * its `RecordBindReader` is a different question entirely: whether the *binding itself* fully
 * covers its schema type, checked once when the reader is built, already ported as
 * `bind/strictness.ts`'s `checkBinding`. Nothing here is lenient about an unknown wire field.
 *
 * **Object-binding mode is all-or-nothing** (the Java reference's own `ConstructionGuard`): a
 * position whose read reported anything is not assembled from partial data. Under a fail-fast
 * {@link DiagnosticsReceiver}, {@link ReadContext.report} throws and control never returns here;
 * under a collecting one, a constructing reader (record/tuple/array/map) hands back `undefined`
 * cast to its own `T` rather than a value built from a document already known to be wrong -- see
 * {@link abandonedValue}'s own doc for why this, and not `null`, is this port's answer to a
 * question Java's universally-nullable object types never had to ask.
 *
 * **Descent uses {@link ReadContext.field}/{@link ReadContext.index}, never
 * {@link ReadContext.schemaField}/{@link ReadContext.inRecord}/{@link ReadContext.underDeclaration}.**
 * Those three exist to keep a schema pointer in step with the data path; a `Binding`-only read has
 * no schema pointer to keep in step, so establishing one here would be fiction. A schema-aware
 * compiled reader (a later work package) is expected to wrap the {@link TypeReader} this module
 * builds, anchoring the schema location itself before delegating down into it.
 */

import type { Annotations } from '../annotations/index.js';
import { inferPositionalField } from '../bind/decode.js';
import { EMPTY_ANNOTATIONS } from '../annotations/index.js';
import type {
  Annotation,
  CoreValue,
  DataValue,
  MapEntry,
  RecordField,
  ScopedValue,
} from '../ast/value.js';
import type { AtomToken } from '../atom/contract.js';
import type {
  AnnotatedBinding,
  ArrayBinding,
  AtomBinding,
  Binding,
  BindingRef,
  BridgeBinding,
  MapBinding,
  RecordBinding,
  TupleBinding,
  VariantBinding,
} from '../bind/binding.js';
import { TsonAtomTypeError, TsonInternalError, TsonReadError } from '../core/errors.js';
import { nestingLimitExpectation, nestingLimitMessage } from '../core/limits.js';
import type { Position } from '../core/position.js';
import type { Task } from '../io/bytes.js';
import type { TsonEvent } from '../stream/event.js';
import { lookingAhead, nestingLimitOf } from './context.js';
import type { ReadContext, TypeReader } from './contracts.js';

// ---------------------------------------------------------------------------------------------
// The atom seam
// ---------------------------------------------------------------------------------------------

/**
 * Converts an already-consumed {@link AtomToken} at an {@link AtomBinding} leaf to its host value.
 * Mirrors `bind/decode.ts`'s `AtomDecoder` exactly, for the same reason: an atom leaf's precise
 * parsing (overflow checks, RFC-grade validation) belongs to `atom/`/`base/`, and this module
 * must not import either -- a caller that owns them passes a reader that delegates.
 *
 * May throw {@link TsonAtomParseError}/{@link TsonAtomValidationError}; {@link bindReader} catches
 * both (their common base, {@link TsonAtomTypeError}) and reports `ATOM_CONSTRAINT_VIOLATION`
 * rather than letting either escape, exactly as the Java reference's own `AtomTypeReader` does for
 * `AtomTypeException`.
 */
export type AtomReader = (binding: AtomBinding<unknown>, token: AtomToken) => unknown;

/**
 * The default {@link AtomReader}: the token's own text, unconverted. Correct only for a
 * `Binding<string>` atom leaf, exactly as `bind/decode.ts`'s `defaultAtomDecoder` is -- a caller
 * reading any other host type at an atom leaf supplies a real one.
 */
export function defaultAtomReader(_binding: AtomBinding<unknown>, token: AtomToken): unknown {
  return token.text;
}

export interface BindReaderOptions {
  /** Defaults to {@link defaultAtomReader}. */
  readonly readAtom?: AtomReader;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Builds a {@link TypeReader} that reads one position governed by `binding` -- the whole of this
 * module's public surface. `Infer<typeof binding>` and this reader's own `T` are the same type
 * parameter throughout the call graph below, never separately asserted: every internal helper is
 * generic in the same `T` the `Binding` member it handles carries, so the type a binding reads and
 * the type it infers can never drift apart without a compile error.
 */
export function bindReader<T>(
  binding: BindingRef<T>,
  options: BindReaderOptions = {},
): TypeReader<T> {
  const readAtom = options.readAtom ?? defaultAtomReader;
  return {
    read: (ctx: ReadContext): Task<T> => readBound(binding, ctx, readAtom),
  };
}

// ---------------------------------------------------------------------------------------------
// Abandoned construction -- the TypeScript answer to the Java reference's `ConstructionGuard`
// ---------------------------------------------------------------------------------------------

/**
 * What a constructing reader (record/tuple/array/map) hands back when {@link ReadContext.reported}
 * grew while it was building this position's value -- the port of `ConstructionGuard`'s policy
 * ("a value whose read reported anything is not assembled, and binds to `null` instead"), adapted
 * to a language where not every `T` admits `null`.
 *
 * Java's `DataClass<T>` is always reference-typed, so `null` is a value of every `T` that language
 * has. TypeScript's `T` can be a primitive, a literal union, or any other type that excludes
 * `undefined` -- there is no value this module can manufacture that is honestly a `T` when the
 * document was invalid. `undefined` cast through `unknown` is what this port uses instead, and it
 * carries the same caller obligation Java's `null` already did: under a fail-fast
 * {@link DiagnosticsReceiver} this code path is never reached at all (`report` throws first), and
 * under a collecting one, a caller must check {@link ReadContext.reported} around the read -- the
 * same `before`/`after` idiom `ReadContext.reported`'s own doc describes -- rather than trust a
 * returned value that might be this placeholder.
 */
function abandonedValue(): unknown {
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// resolveRef -- past any number of LazyBinding hops, identical in spirit to `bind/decode.ts`'s
// and `bind/encode.ts`'s own private helpers of the same name.
// ---------------------------------------------------------------------------------------------

function resolveRef<T>(ref: BindingRef<T>): Exclude<Binding<T>, { readonly kind: 'lazy' }> {
  let current: Binding<T> = ref;
  while (current.kind === 'lazy') current = current.get();
  return current;
}

// ---------------------------------------------------------------------------------------------
// The recursive dispatcher
// ---------------------------------------------------------------------------------------------

function* readBound<T>(ref: BindingRef<T>, ctx: ReadContext, readAtom: AtomReader): Task<T> {
  const resolved = resolveRef(ref);
  switch (resolved.kind) {
    case 'atom':
      return yield* readAtomLeaf(resolved, ctx, readAtom);
    case 'record':
      return yield* readRecord(resolved, ctx, readAtom);
    case 'tuple':
      return yield* readTuple(resolved, ctx, readAtom);
    case 'array':
      return yield* readArray(resolved, ctx, readAtom);
    case 'map':
      return yield* readMap(resolved, ctx, readAtom);
    case 'variant':
      return yield* readVariant(resolved, ctx, readAtom);
    case 'annotated':
      return yield* readAnnotated(resolved, ctx, readAtom);
    case 'bridge':
      return yield* readBridge(resolved, ctx, readAtom);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared event-stream grammar helpers -- this module's own copy of the Java reference's
// `EventSkip`, deliberately duplicated rather than imported from wherever a sibling work package
// (tree/schemaless readers) builds an equivalent: sub-agents share no context, and every one of
// these is a two-line structural rule with nothing library-specific in it.
// ---------------------------------------------------------------------------------------------

/** Consumes and discards every leading annotation (§3.1), stopping at whatever follows. */
function* skipAnnotations(ctx: ReadContext): Task<void> {
  for (;;) {
    const peeked = yield* ctx.peek();
    if (peeked.kind !== 'annotation-start') return;
    yield* ctx.next();
    const inner = yield* ctx.peek();
    if (inner.kind !== 'annotation-end') {
      yield* skipDataValue(ctx);
    }
    yield* ctx.next(); // annotation-end
  }
}

/** Consumes an optional type-ref (§3.2), discarding it uninterpreted; returns its name if present. */
function* skipTypeRef(ctx: ReadContext): Task<string | undefined> {
  const peeked = yield* ctx.peek();
  if (peeked.kind !== 'type-ref') return undefined;
  yield* ctx.next();
  return peeked.name;
}

/** `*annotation [type-ref]` (§2.3), both halves discarded -- every non-{@link readVariant} reader's own framing step. */
function* skipAnnotationsAndTypeRef(ctx: ReadContext): Task<void> {
  yield* skipAnnotations(ctx);
  yield* skipTypeRef(ctx);
}

/** Discards `[schema-directive] data-value` (§2.3) -- a record field, map entry, or array/tuple element this reader has nowhere to put. */
function* skipScopedValue(ctx: ReadContext): Task<void> {
  const peeked = yield* ctx.peek();
  if (peeked.kind === 'schema-ref') yield* ctx.next();
  yield* skipDataValue(ctx);
}

/** Discards one whole `data-value`: framing, then one core-value. */
function* skipDataValue(ctx: ReadContext): Task<void> {
  yield* skipAnnotationsAndTypeRef(ctx);
  yield* skipCoreValue(ctx);
}

/** Discards one core-value whose first event has only been peeked, not yet consumed -- the shape every "this wasn't what I expected" branch below is in. */
function* skipCoreValue(ctx: ReadContext): Task<void> {
  const e = yield* ctx.next();
  switch (e.kind) {
    case 'record-start':
      while ((yield* ctx.peek()).kind !== 'record-end') {
        yield* ctx.next(); // field-name
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // record-end
      return;
    case 'map-start':
      while ((yield* ctx.peek()).kind !== 'map-end') {
        yield* skipDataValue(ctx); // key
        yield* ctx.next(); // map-arrow
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // map-end
      return;
    case 'array-start':
      while ((yield* ctx.peek()).kind !== 'array-end') {
        yield* skipScopedValue(ctx);
      }
      yield* ctx.next(); // array-end
      return;
    case 'token':
    case 'absent':
    case 'empty-brace':
      return; // leaf, already consumed
    default:
      throw new TsonInternalError(`unexpected event while skipping a core-value: '${e.kind}'`);
  }
}

/** A core-value's shape as a word, for a `TYPE_MISMATCH`'s `actual` -- this module's own copy of the Java reference's `TypeRefCheck.describe`. */
function describeEvent(e: TsonEvent): string {
  switch (e.kind) {
    case 'record-start':
      return 'a record';
    case 'map-start':
      return 'a map';
    case 'array-start':
      return 'an array';
    case 'empty-brace':
      return '{}';
    case 'absent':
      return "the absent sentinel '_'";
    case 'token':
      return `a token ('${e.text}')`;
    default:
      return e.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// Structural annotation capture -- no schema is ever in view at this layer (this file's own top
// comment), so an annotation's own value is always read the way a Class 1 processor with no
// schema reads anything: structurally, preserved rather than interpreted (§1.5, §3.1). This is
// this module's own minimal version of what the Java reference's `AnnotationCapture` falls back
// to as `AnnotationTypes.UNVALIDATED` when no governing schema resolves an annotation's type --
// the only case this layer can ever be in, so it is the only case implemented.
// ---------------------------------------------------------------------------------------------

function* readStructuralAnnotations(
  ctx: ReadContext,
  limit: number,
  depth = 0,
): Task<readonly Annotation[]> {
  const out: Annotation[] = [];
  for (;;) {
    const peeked = yield* ctx.peek();
    if (peeked.kind !== 'annotation-start') return out;
    yield* ctx.next();
    let value: DataValue | undefined;
    const afterStart = yield* ctx.peek();
    if (afterStart.kind !== 'annotation-end') {
      // One level deeper: an annotation's value is a data value, so `@a:@a:@a:...` is a real
      // descent even though it opens no brace or bracket, and it is the one this stack has no
      // path step to count (§9.1). Unbounded, it exhausted the host stack out of `readTree`.
      value = yield* readStructuralDataValue(ctx, limit, depth + 1);
    }
    yield* ctx.next(); // annotation-end
    out.push({ name: peeked.name, ...(value !== undefined ? { value } : {}) });
  }
}

function* readStructuralDataValue(ctx: ReadContext, limit: number, depth = 0): Task<DataValue> {
  if (depth >= limit) {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: nestingLimitMessage(limit),
      path: ctx.path(),
      expected: nestingLimitExpectation(limit),
      actual: 'deeper',
    });
  }
  const annotations = yield* readStructuralAnnotations(ctx, limit, depth);
  let typeRef: string | undefined;
  const peeked = yield* ctx.peek();
  if (peeked.kind === 'type-ref') {
    yield* ctx.next();
    typeRef = peeked.name;
  }
  const coreValue = yield* readStructuralCoreValue(ctx, limit, depth);
  return { annotations, ...(typeRef !== undefined ? { typeRef } : {}), coreValue };
}

function* readStructuralScopedValue(
  ctx: ReadContext,
  limit: number,
  depth: number,
): Task<ScopedValue> {
  const peeked = yield* ctx.peek();
  let schemaRef: string | undefined;
  if (peeked.kind === 'schema-ref') {
    yield* ctx.next();
    schemaRef = peeked.uri;
  }
  const value = yield* readStructuralDataValue(ctx, limit, depth);
  return { ...(schemaRef !== undefined ? { schemaRef } : {}), value };
}

function* readStructuralCoreValue(ctx: ReadContext, limit: number, depth: number): Task<CoreValue> {
  const e = yield* ctx.next();
  switch (e.kind) {
    case 'record-start': {
      const fields: RecordField[] = [];
      while ((yield* ctx.peek()).kind !== 'record-end') {
        const fieldName = yield* ctx.next();
        if (fieldName.kind !== 'field-name') {
          throw new TsonInternalError(`expected field-name, got '${fieldName.kind}'`);
        }
        const value = yield* readStructuralScopedValue(ctx, limit, depth + 1);
        fields.push({ name: fieldName.name, value });
      }
      yield* ctx.next(); // record-end
      return { kind: 'record', fields };
    }
    case 'map-start': {
      const entries: MapEntry[] = [];
      while ((yield* ctx.peek()).kind !== 'map-end') {
        const key = yield* readStructuralDataValue(ctx, limit, depth + 1);
        const arrow = yield* ctx.next();
        if (arrow.kind !== 'map-arrow') {
          throw new TsonInternalError(`expected map-arrow, got '${arrow.kind}'`);
        }
        const value = yield* readStructuralScopedValue(ctx, limit, depth + 1);
        entries.push({ key, value });
      }
      yield* ctx.next(); // map-end
      return { kind: 'map', entries };
    }
    case 'array-start': {
      const elements: ScopedValue[] = [];
      while ((yield* ctx.peek()).kind !== 'array-end') {
        elements.push(yield* readStructuralScopedValue(ctx, limit, depth + 1));
      }
      yield* ctx.next(); // array-end
      return { kind: 'array', elements };
    }
    case 'token':
      return { kind: 'token', text: e.text, form: e.form };
    case 'absent':
      return { kind: 'absent' };
    case 'empty-brace':
      return { kind: 'empty-brace' };
    default:
      throw new TsonInternalError(`unexpected event while reading a core-value: '${e.kind}'`);
  }
}

// ---------------------------------------------------------------------------------------------
// Atom (§5)
// ---------------------------------------------------------------------------------------------

function* readAtomLeaf<T>(
  binding: AtomBinding<T>,
  ctx: ReadContext,
  readAtom: AtomReader,
): Task<T> {
  yield* skipAnnotationsAndTypeRef(ctx);
  const e = yield* ctx.peek();
  if (e.kind !== 'token') {
    ctx.report(
      'TYPE_MISMATCH',
      `expected a token for '${binding.wireType}', found ${describeEvent(e)}`,
      `a token for ${binding.wireType}`,
      describeEvent(e),
    );
    yield* skipCoreValue(ctx);
    return abandonedValue() as T;
  }
  yield* ctx.next();
  const token: AtomToken = { text: e.text, form: e.form };
  try {
    return readAtom(binding, token) as T;
  } catch (err) {
    if (err instanceof TsonAtomTypeError) {
      ctx.report(
        'ATOM_CONSTRAINT_VIOLATION',
        `'${binding.wireType}': ${err.message}`,
        err.expected,
        e.text,
      );
      return abandonedValue() as T;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Record (§2.5)
// ---------------------------------------------------------------------------------------------

function* readRecord<T>(
  binding: RecordBinding<T>,
  ctx: ReadContext,
  readAtom: AtomReader,
): Task<T> {
  // Hoisted ahead of the shape check, matching the Java reference: the base's own framing
  // consumption then finds nothing left. Captured, not discarded, only when this record declares
  // an annotationsCarrier -- see FieldSlot.unbound's own doc.
  let annotations: Annotations = EMPTY_ANNOTATIONS;
  if (binding.annotationsCarrier !== undefined) {
    const values = yield* readStructuralAnnotations(ctx, nestingLimitOf(ctx));
    annotations = values.length === 0 ? EMPTY_ANNOTATIONS : { values };
  } else {
    yield* skipAnnotations(ctx);
  }
  yield* skipTypeRef(ctx);

  const peeked = yield* ctx.peek();
  const anchor = peeked.position;
  const positionalField = inferPositionalField(binding.fields);

  const values = new Array<unknown>(binding.fields.length);
  const seen = new Array<boolean>(binding.fields.length).fill(false);

  if (peeked.kind === 'record-start') {
    yield* ctx.next();
    const mark = ctx.reported();
    for (;;) {
      const next = yield* ctx.peek();
      if (next.kind === 'record-end') break;
      const fieldNameEvent = yield* ctx.next();
      if (fieldNameEvent.kind !== 'field-name') {
        throw new TsonInternalError(`expected field-name, got '${fieldNameEvent.kind}'`);
      }
      const slot = binding.byWireName.get(fieldNameEvent.name);
      if (slot === undefined) {
        const declared = [...binding.byWireName.keys()].join(' | ');
        ctx
          .field(fieldNameEvent.name)
          .report(
            'UNRECOGNIZED_FIELD',
            `unknown field '${fieldNameEvent.name}' -- a record is closed under its type (§7.2), whose fields are (${declared})`,
            declared,
            fieldNameEvent.name,
          );
        yield* skipScopedValue(ctx);
        continue;
      }
      if (seen[slot.index] === true) {
        ctx
          .field(fieldNameEvent.name)
          .report(
            'DUPLICATE_FIELD',
            `duplicate field '${fieldNameEvent.name}' -- a record states each field at most once (§2.5)`,
            'each field stated once',
            `'${fieldNameEvent.name}' stated again`,
          );
      }
      const fieldCtx = ctx.field(fieldNameEvent.name);
      const beforeValue = yield* ctx.peek();
      if (beforeValue.kind === 'schema-ref') {
        yield* ctx.next();
      }
      const valuePeek = yield* ctx.peek();
      if (valuePeek.kind === 'absent') {
        yield* ctx.next();
        if (slot.required) {
          fieldCtx.report(
            'FIELD_REQUIRED',
            `missing required field '${fieldNameEvent.name}'`,
            `a value for '${fieldNameEvent.name}'`,
            '(absent)',
          );
        }
      } else {
        values[slot.index] = yield* readBound(slot.binding, fieldCtx, readAtom);
      }
      seen[slot.index] = true;
    }
    yield* ctx.next(); // record-end
    fillMissingFields(binding, values, seen, ctx, anchor);
    if (ctx.reported() > mark) return abandonedValue() as T;
    return finishRecord(binding, values, seen, annotations);
  }
  if (peeked.kind === 'empty-brace') {
    yield* ctx.next();
    const mark = ctx.reported();
    fillMissingFields(binding, values, seen, ctx, anchor);
    if (ctx.reported() > mark) return abandonedValue() as T;
    return finishRecord(binding, values, seen, annotations);
  }
  if (positionalField !== undefined) {
    const mark = ctx.reported();
    const fieldCtx = ctx.field(positionalField.wireName);
    values[positionalField.index] = yield* readBound(positionalField.binding, fieldCtx, readAtom);
    seen[positionalField.index] = true;
    fillMissingFields(binding, values, seen, ctx, anchor);
    if (ctx.reported() > mark) return abandonedValue() as T;
    return finishRecord(binding, values, seen, annotations);
  }
  ctx.report(
    'TYPE_MISMATCH',
    `expected a record for this position, found ${describeEvent(peeked)}`,
    'a record',
    describeEvent(peeked),
  );
  yield* skipCoreValue(ctx);
  return abandonedValue() as T;
}

/**
 * Every declared field {@link readRecord}'s own field loop never saw: `REQUIRED` reports
 * `FIELD_REQUIRED`, unless the slot's own binding resolves to {@link ArrayBinding}/
 * {@link MapBinding}, which defaults to empty instead (`CLAUDE.md`'s "absent and empty are the
 * same list"). `OPTIONAL` and `unbound` are left untouched.
 *
 * Ordinary sync code, not `Task`-returning: every step here is a pure computation or a
 * {@link ReadContext.report} call, and `report` itself is sync (it either throws or returns,
 * never suspends) -- nothing in this function ever pulls an event.
 */
function fillMissingFields<T>(
  binding: RecordBinding<T>,
  values: unknown[],
  seen: boolean[],
  ctx: ReadContext,
  anchor: Position | undefined,
): void {
  for (const slot of binding.fields) {
    if (slot.unbound || seen[slot.index] === true) continue;
    if (!slot.required) continue;
    const slotBinding = resolveRef(slot.binding);
    if (slotBinding.kind === 'array' || slotBinding.kind === 'map') {
      values[slot.index] = slotBinding.construct([]);
      seen[slot.index] = true;
      continue;
    }
    ctx
      .withPosition(anchor)
      .field(slot.wireName)
      .report(
        'FIELD_REQUIRED',
        `missing required field '${slot.wireName}'`,
        `a value for '${slot.wireName}'`,
        '(absent)',
      );
  }
}

function finishRecord<T>(
  binding: RecordBinding<T>,
  values: unknown[],
  seen: boolean[],
  annotations: Annotations,
): T {
  if (binding.annotationsCarrier !== undefined) {
    values[binding.annotationsCarrier.index] = annotations;
  }
  if (binding.mutable) {
    if (binding.create === undefined) {
      throw new TsonInternalError("a mutable RecordBinding must supply 'create'");
    }
    const host = binding.create();
    for (const slot of binding.fields) {
      const hasValue =
        slot === binding.annotationsCarrier || (!slot.unbound && seen[slot.index] === true);
      if (!hasValue) continue;
      if (slot.set === undefined) {
        throw new TsonInternalError(
          `a mutable RecordBinding's field slot '${slot.wireName}' must supply 'set'`,
        );
      }
      slot.set(host, values[slot.index]);
    }
    return host;
  }
  return binding.construct(values);
}

// ---------------------------------------------------------------------------------------------
// Tuple (§2.7, §5.3's per-position shape without its ElementState -- see this file's own top
// comment)
// ---------------------------------------------------------------------------------------------

function* readTuple<T>(binding: TupleBinding<T>, ctx: ReadContext, readAtom: AtomReader): Task<T> {
  yield* skipAnnotationsAndTypeRef(ctx);
  const peeked = yield* ctx.peek();
  if (peeked.kind !== 'array-start') {
    ctx.report(
      'TYPE_MISMATCH',
      `expected a tuple (array-shaped) for this position, found ${describeEvent(peeked)}`,
      'a tuple (array-shaped)',
      describeEvent(peeked),
    );
    yield* skipCoreValue(ctx);
    return abandonedValue() as T;
  }
  yield* ctx.next();
  const mark = ctx.reported();
  const arity = binding.elements.length;
  const values = new Array<unknown>(arity);
  let index = 0;
  let reportedExtra = false;
  for (;;) {
    const next = yield* ctx.peek();
    if (next.kind === 'array-end') break;
    if (next.kind === 'schema-ref') {
      yield* ctx.next();
    }
    if (index >= arity) {
      if (!reportedExtra) {
        ctx.report(
          'WRONG_ARITY',
          `expected ${String(arity)} elements, found more than ${String(arity)}`,
          `${String(arity)} elements`,
          `more than ${String(arity)}`,
        );
        reportedExtra = true;
      }
      yield* skipDataValue(ctx);
      index++;
      continue;
    }
    const slot = binding.elements[index];
    if (slot === undefined) {
      throw new TsonInternalError('tuple slot index out of range');
    }
    values[index] = yield* readBound(slot.binding, ctx.index(index), readAtom);
    index++;
  }
  yield* ctx.next(); // array-end
  if (index < arity) {
    ctx.report(
      'WRONG_ARITY',
      `expected ${String(arity)} elements, found only ${String(index)}`,
      `${String(arity)} elements`,
      String(index),
    );
  }
  if (ctx.reported() > mark) return abandonedValue() as T;
  return binding.construct(values);
}

// ---------------------------------------------------------------------------------------------
// Array (§2.7) -- no ElementState, no min_items/max_items/unique_items: ArrayBinding carries none
// of §5's ArrayBody facets, so none of that validation happens at this layer. See this file's own
// top comment.
// ---------------------------------------------------------------------------------------------

function* readArray<T>(binding: ArrayBinding<T>, ctx: ReadContext, readAtom: AtomReader): Task<T> {
  yield* skipAnnotationsAndTypeRef(ctx);
  const peeked = yield* ctx.peek();
  if (peeked.kind === 'array-start') {
    yield* ctx.next();
    const mark = ctx.reported();
    const values: unknown[] = [];
    let index = 0;
    for (;;) {
      const next = yield* ctx.peek();
      if (next.kind === 'array-end') break;
      if (next.kind === 'schema-ref') {
        yield* ctx.next();
      }
      values.push(yield* readBound(binding.element, ctx.index(index), readAtom));
      index++;
    }
    yield* ctx.next(); // array-end
    if (ctx.reported() > mark) return abandonedValue() as T;
    return binding.construct(values);
  }
  if (peeked.kind === 'empty-brace') {
    yield* ctx.next();
    return binding.construct([]);
  }
  ctx.report(
    'TYPE_MISMATCH',
    `expected an array (or '{}') for this position, found ${describeEvent(peeked)}`,
    'an array',
    describeEvent(peeked),
  );
  yield* skipCoreValue(ctx);
  return abandonedValue() as T;
}

// ---------------------------------------------------------------------------------------------
// Map (§2.6) -- no min_items/max_items: MapBinding carries none of §5's MapBody facets either.
// ---------------------------------------------------------------------------------------------

function isPrimitiveKey(value: unknown): value is string | number | boolean | bigint {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint';
}

function* readMap<T>(binding: MapBinding<T>, ctx: ReadContext, readAtom: AtomReader): Task<T> {
  yield* skipAnnotationsAndTypeRef(ctx);
  const peeked = yield* ctx.peek();
  if (peeked.kind === 'map-start') {
    yield* ctx.next();
    const mark = ctx.reported();
    const entries: (readonly [unknown, unknown])[] = [];
    // Duplicate-key detection compares decoded *primitive* keys only (§2.6: "a processor that
    // decodes values compares decoded values"). A Binding gives this module no equality over an
    // arbitrary object-shaped host key the way Java's universal Object#equals does, so a repeated
    // object-shaped key is not flagged here -- a real, documented divergence; see this package's
    // final report.
    const seenKeys = new Set<string | number | boolean | bigint>();
    for (;;) {
      const keyPeek = yield* ctx.peek();
      if (keyPeek.kind === 'map-end') break;
      if (keyPeek.kind === 'absent') {
        yield* ctx.next();
        ctx.report(
          'TYPE_MISMATCH',
          "the absent sentinel '_' must not appear as a map key (§2.9)",
          'a real map key, never the absent sentinel',
          '_',
        );
        yield* ctx.next(); // map-arrow
        yield* skipScopedValue(ctx);
        continue;
      }
      const keySegment = keyPeek.kind === 'token' ? keyPeek.text : '?';
      const keyCtx = ctx.field(keySegment);
      const beforeKey = ctx.reported();
      const key = yield* readBound(binding.key, keyCtx, readAtom);
      if (ctx.reported() === beforeKey && isPrimitiveKey(key)) {
        if (seenKeys.has(key)) {
          keyCtx.report(
            'DUPLICATE_MAP_KEY',
            `duplicate key '${keySegment}' -- a map states each key at most once (§2.6)`,
            'each key stated once',
            `'${keySegment}' stated again`,
          );
        } else {
          seenKeys.add(key);
        }
      }
      const arrow = yield* ctx.next();
      if (arrow.kind !== 'map-arrow') {
        throw new TsonInternalError(`expected map-arrow, got '${arrow.kind}'`);
      }
      const beforeValue = yield* ctx.peek();
      if (beforeValue.kind === 'schema-ref') {
        yield* ctx.next();
      }
      const value = yield* readBound(binding.value, keyCtx, readAtom);
      entries.push([key, value]);
    }
    yield* ctx.next(); // map-end
    if (ctx.reported() > mark) return abandonedValue() as T;
    return binding.construct(entries);
  }
  if (peeked.kind === 'empty-brace') {
    yield* ctx.next();
    return binding.construct([]);
  }
  ctx.report(
    'TYPE_MISMATCH',
    `expected a map (or '{}') for this position, found ${describeEvent(peeked)}`,
    'a map',
    describeEvent(peeked),
  );
  yield* skipCoreValue(ctx);
  return abandonedValue() as T;
}

// ---------------------------------------------------------------------------------------------
// Variant (§3.2's !type-ref dispatch)
// ---------------------------------------------------------------------------------------------

/**
 * Whether reading `ref` begins by consuming the value's *own* leading annotation run -- true only
 * for {@link AnnotatedBinding}, which is the one binding that keeps those annotations rather than
 * discarding them as framing, and for a {@link BridgeBinding} wrapping one.
 *
 * An annotated binding nested deeper (a record field's own binding, say) does not count: it reads
 * that field's annotations, not this value's.
 */
function keepsLeadingAnnotations(ref: BindingRef<unknown>): boolean {
  const resolved = resolveRef(ref);
  if (resolved.kind === 'annotated') return true;
  if (resolved.kind === 'bridge') return keepsLeadingAnnotations(resolved.wire);
  return false;
}

function* readVariant<T>(
  binding: VariantBinding<T>,
  ctx: ReadContext,
  readAtom: AtomReader,
): Task<T> {
  // §3.2's dispatch has to reach the `!type-ref`, which sits behind a run of annotations of any
  // length (`data-value = *annotation [type-ref] core-value`).
  //
  // **Consumed outright when no member would keep them.** Every reader except `readAnnotated`
  // treats a value's leading annotations as framing and discards them, so for a variant whose
  // members all do that, skipping the run here and never replaying it is indistinguishable from
  // skipping it one call later -- and it means the run is walked once, with nothing retained.
  // Replaying costs a buffer that grows with the annotation run rather than with nesting depth,
  // which is exactly the shape `CLAUDE.md` says this stack does not have.
  //
  // **Looked ahead and rewound only when a member really would keep them**, because there the
  // member's own reader must see the whole data-value exactly as it would if nothing had
  // dispatched to it first (`binding.ts`'s own doc on read direction).
  const replay = binding.members.some((member) => keepsLeadingAnnotations(member.binding));
  let typeRefName: string | undefined;
  if (replay) {
    typeRefName = yield* lookingAhead(ctx, function* (aheadCtx): Task<string | undefined> {
      yield* skipAnnotations(aheadCtx);
      const peeked = yield* aheadCtx.peek();
      return peeked.kind === 'type-ref' ? peeked.name : undefined;
    });
  } else {
    yield* skipAnnotations(ctx);
    const peeked = yield* ctx.peek();
    typeRefName = peeked.kind === 'type-ref' ? peeked.name : undefined;
  }
  // What is left of the value on the error paths below: the whole data-value when the annotations
  // were rewound, the core-value alone when they were consumed.
  const skipRest = replay ? skipDataValue : skipRemainingValue;
  const names = binding.members.map((m) => m.wireName).join('/');
  if (typeRefName === undefined) {
    ctx.report(
      'UNKNOWN_TYPE_REF',
      `a '${names}' value needs its own !type-ref to say which member it is`,
      `a !type-ref naming one of (${names})`,
      '(none)',
    );
    yield* skipRest(ctx);
    return abandonedValue() as T;
  }
  const member = binding.members.find((m) => m.wireName === typeRefName);
  if (member === undefined) {
    ctx.report(
      'UNKNOWN_TYPE_REF',
      `'!${typeRefName}' names no member of this variant (${names})`,
      `one of (${names})`,
      `!${typeRefName}`,
    );
    yield* skipRest(ctx);
    return abandonedValue() as T;
  }
  return (yield* readBound(member.binding, ctx, readAtom)) as T;
}

/** `[type-ref] core-value` -- what a data-value is once its annotations have already been consumed. */
function* skipRemainingValue(ctx: ReadContext): Task<void> {
  yield* skipTypeRef(ctx);
  yield* skipCoreValue(ctx);
}

// ---------------------------------------------------------------------------------------------
// Annotated (§3.1 boxed as a value)
// ---------------------------------------------------------------------------------------------

function* readAnnotated<T>(
  binding: AnnotatedBinding<T>,
  ctx: ReadContext,
  readAtom: AtomReader,
): Task<T> {
  const values = yield* readStructuralAnnotations(ctx, nestingLimitOf(ctx));
  const annotations: Annotations = values.length === 0 ? EMPTY_ANNOTATIONS : { values };
  const inner = yield* readBound(binding.value, ctx, readAtom);
  return binding.construct(inner, annotations);
}

// ---------------------------------------------------------------------------------------------
// Bridge -- transparent: contributes no framing of its own, reads straight through its wire
// binding.
// ---------------------------------------------------------------------------------------------

function* readBridge<T, D>(
  binding: BridgeBinding<T, D>,
  ctx: ReadContext,
  readAtom: AtomReader,
): Task<T> {
  const wire = yield* readBound(binding.wire, ctx, readAtom);
  return binding.fromWire(wire);
}
