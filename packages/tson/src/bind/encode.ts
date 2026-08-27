/**
 * `toCoreValue`/`toDataValue` -- a bound host value, converted to the structural AST (`ast/`)
 * without ever routing through a writer or the compiler. This is what breaks the Java reference's
 * compiler-to-bind circularity (`DefinitionResolver` holds a `TsonObjectWriter` because §5.6's
 * chained atom refinement must merge on the wire record before binding, which is why the writers
 * cannot leave `tson-compiler`). A {@link Binding} is bidirectional by construction, so this
 * module exposes the wire-record side directly: the resolver merges on the {@link CoreValue}/
 * {@link DataValue} this produces, and the text round-trip through a writer is gone.
 *
 * **Depends on `ast/` and `bind/` only** -- no `atom/`, no emitter, no compiler. That is the
 * whole point of the module (`CLAUDE.md`'s bind/compiler zone), and it is also why an
 * {@link AtomBinding} leaf cannot be formatted here to the precision `atom/`'s own writers give
 * a runtime host value (a `Date`, a `TsonDecimal`, ...): that formatting is exactly the
 * responsibility this module must not reach for. {@link AtomEncoder} is the seam a caller who
 * *does* have `atom/` in scope plugs in; the built-in default is intentionally the minimal thing
 * this layer can do on its own -- see {@link defaultAtomEncoder}.
 */
import type {
  Annotation,
  ArrayValue,
  CoreValue,
  DataValue,
  MapEntry,
  MapValue,
  RecordField,
  RecordValue,
  ScopedValue,
  TokenValue,
} from '../ast/value.js';
import type { TokenForm } from '../lexer/token.js';
import { TsonWriteError } from '../core/errors.js';
import type { AtomBinding, Binding, BindingRef } from './binding.js';

/**
 * Converts an {@link AtomBinding} leaf's host value to a wire {@link TokenValue}. Consulted by
 * both {@link toCoreValue} and {@link toDataValue} for every atom position they reach; a caller
 * that owns `atom/`'s real per-type writers passes one that delegates to them, getting exact
 * wire formatting (quoting, escaping, base-type-specific text) at every atom leaf without this
 * module ever importing `atom/` itself.
 */
export type AtomEncoder = (binding: AtomBinding<unknown>, value: unknown) => TokenValue;

/**
 * The default {@link AtomEncoder}, used when a caller supplies none: `String(value)`, unquoted.
 *
 * Correct for exactly the values this module's own stated use case produces -- §5.6's chained
 * atom refinement merge operates on schema-level constraint values (booleans, numbers, short
 * unquoted identifiers such as a `members`/selector token), for which plain unquoted text is
 * the wire form. It is *not* a general-purpose atom writer: a runtime host value that needs
 * quoting, escaping, or base-type-specific formatting (free text containing structural
 * characters, a binary encoding, a temporal value) needs a real {@link AtomEncoder} from a
 * caller that has `atom/` in scope.
 */
function defaultAtomEncoder(_binding: AtomBinding<unknown>, value: unknown): TokenValue {
  const form: TokenForm = 'unquoted';
  return { kind: 'token', text: String(value), form };
}

/** Resolves a {@link BindingRef} past any number of {@link LazyBinding} hops. */
function resolveRef<T>(ref: BindingRef<T>): Exclude<Binding<T>, { readonly kind: 'lazy' }> {
  let current: Binding<T> = ref;
  while (current.kind === 'lazy') current = current.get();
  return current;
}

function dataValueOf(coreValue: CoreValue): DataValue {
  return { annotations: [], coreValue };
}

function scopedValueOf<T>(binding: BindingRef<T>, value: T, encodeAtom: AtomEncoder): ScopedValue {
  return { value: toDataValue(binding, value, encodeAtom) };
}

/**
 * Converts a bound host value to a {@link DataValue} -- a {@link CoreValue} plus whatever framing
 * (`*annotation`, `!type-ref`) this position's binding contributes.
 *
 * This is the fully-faithful entry point: unlike {@link toCoreValue}, it can represent an
 * {@link AnnotatedBinding}'s wire-format annotations (§3.1) and a {@link VariantBinding} member's
 * discriminating type-ref (§3.2) at the one AST level that has room for them -- neither has a
 * `CoreValue`-shaped analogue, since annotations and a type-ref frame a `data-value`, they are not
 * part of the `core-value` inside it (§2.3). Every child position this module composes (a record
 * field's value, an array/tuple element, a map entry's key or value) goes through this function,
 * not {@link toCoreValue} directly, so a nested `variant`/`annotated` binding is captured
 * correctly wherever it occurs.
 */
export function toDataValue<T>(
  binding: BindingRef<T>,
  value: T,
  encodeAtom: AtomEncoder = defaultAtomEncoder,
): DataValue {
  const resolved = resolveRef(binding);
  if (resolved.kind === 'annotated') {
    const inner = resolveRef(resolved.value);
    const innerValue = resolved.unwrap(value);
    const withFraming = toDataValue(inner, innerValue, encodeAtom);
    const annotations: readonly Annotation[] = resolved.annotationsOf(value).values;
    return { ...withFraming, annotations };
  }
  if (resolved.kind === 'variant') {
    const member = resolved.memberFor(value);
    if (member === undefined) {
      throw new TsonWriteError('value matches no member of this variant binding');
    }
    const withFraming = toDataValue(member.binding, value, encodeAtom);
    return { ...withFraming, typeRef: member.wireName };
  }
  if (resolved.kind === 'bridge') {
    // Recurse through toDataValue, not toCoreValue. A bridge is transparent: it converts the host
    // value and contributes no framing of its own, so whatever framing its wire binding
    // contributes is the framing of this position. Falling through to the toCoreValue path below
    // would discard it, because toCoreValue has no DataValue to put a type-ref or annotations on
    // — a bridge over a variant would silently lose the member's discriminating type-ref.
    return toDataValue(resolved.wire, resolved.toWire(value), encodeAtom);
  }
  return dataValueOf(toCoreValue(resolved, value, encodeAtom));
}

/**
 * Converts a bound host value to a bare {@link CoreValue} -- the structural shape alone, with no
 * annotation or type-ref framing (§2.3's `core-value`, not `data-value`).
 *
 * Every composite case (`record`/`tuple`/`array`/`map`) builds its children through {@link
 * toDataValue}, so a child bound through `variant`/`annotated` still carries its own framing
 * correctly at the {@link ScopedValue}/{@link DataValue} position that holds it -- only *this*
 * position's own framing is unrepresentable, because `CoreValue` has nowhere to put it. Calling
 * this directly with a `variant` or `annotated` binding still returns a value (the chosen
 * member's/unwrapped value's own core-value), it just drops that framing at the top; use {@link
 * toDataValue} when the framing matters, which is every position but the document root's own
 * call site handles separately.
 */
export function toCoreValue<T>(
  binding: BindingRef<T>,
  value: T,
  encodeAtom: AtomEncoder = defaultAtomEncoder,
): CoreValue {
  const resolved = resolveRef(binding);
  switch (resolved.kind) {
    case 'atom':
      return encodeAtom(resolved, value);

    case 'record': {
      const fields: RecordField[] = [];
      for (const slot of resolved.fields) {
        if (slot.unbound) continue;
        if (!slot.isPresent(value)) continue;
        fields.push({
          name: slot.wireName,
          value: scopedValueOf(slot.binding, slot.get(value), encodeAtom),
        });
      }
      const record: RecordValue = { kind: 'record', fields };
      return record;
    }

    case 'tuple': {
      const elements = resolved.elements.map((slot) =>
        scopedValueOf(slot.binding, slot.get(value), encodeAtom),
      );
      const array: ArrayValue = { kind: 'array', elements };
      return array;
    }

    case 'array': {
      const element = resolved.element;
      const elements: ScopedValue[] = [];
      for (const item of resolved.read(value)) {
        elements.push(scopedValueOf(element, item, encodeAtom));
      }
      const array: ArrayValue = { kind: 'array', elements };
      return array;
    }

    case 'map': {
      const keyBinding = resolved.key;
      const valueBinding = resolved.value;
      const entries: MapEntry[] = [];
      for (const [k, v] of resolved.read(value)) {
        entries.push({
          key: toDataValue(keyBinding, k, encodeAtom),
          value: scopedValueOf(valueBinding, v, encodeAtom),
        });
      }
      const map: MapValue = { kind: 'map', entries };
      return map;
    }

    case 'variant': {
      const member = resolved.memberFor(value);
      if (member === undefined) {
        throw new TsonWriteError('value matches no member of this variant binding');
      }
      return toCoreValue(member.binding, value, encodeAtom);
    }

    case 'bridge':
      return toCoreValue(resolved.wire, resolved.toWire(value), encodeAtom);

    case 'annotated':
      return toCoreValue(resolved.value, resolved.unwrap(value), encodeAtom);
  }
}
