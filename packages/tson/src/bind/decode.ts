/**
 * `fromDataValue`/`fromCoreValue` -- the read direction `encode.ts`'s own top comment says does
 * not exist yet: a bound host value in reverse, turning the structural AST (`ast/`) back into
 * whatever host type a {@link Binding} describes, without ever routing through a schema-compiled
 * reader or the event stream. This is what lets a data-value be bound back into a `schema/meta`
 * value through a `Binding` -- the read half of `PORT-PLAN.md`'s "a `Binding` is bidirectional by
 * construction" -- for exactly the position `encode.ts` already occupies on the write side:
 * `compiler/`'s own `import/no-restricted-paths` zone still forbids it from reaching this module,
 * so a caller that needs both (`schema/`, which carries no such restriction) is the one place they
 * meet.
 *
 * **Depends on `ast/` and `bind/` only** -- no `atom/`, no lexer, no compiler, mirroring
 * `encode.ts`'s own boundary exactly and for the same reason: an atom leaf's wire text needs
 * interpreting to the precision `atom/`'s own parsers give (int128 overflow, RFC 3339 date
 * validity, ...), and that is exactly the responsibility this module must not reach for.
 * {@link AtomDecoder} is the seam a caller who *does* have `atom/`/`base/` in scope plugs in; the
 * built-in default is intentionally the minimal thing this layer can do on its own -- see
 * {@link defaultAtomDecoder}. {@link RecordFieldsProvider} is the equivalent seam for a
 * `record`-shaped position -- see its own doc.
 *
 * **This is not the suspendable reader stack.** `reader/` (`ReadContext`/`TypeReader`) pulls
 * `TsonEvent`s one at a time off a possibly-incomplete `EventSource` and is `Task`-shaped for
 * exactly that reason (`reader/contracts.ts`'s own top comment). This module instead consumes an
 * already-fully-parsed {@link DataValue}/{@link CoreValue} -- the Tier 3 AST `compiler/dataParser.ts`
 * and `compiler/schemaParser.ts` already produce whole, in memory, before either module returns --
 * so there is nothing left to starve on and no `Task` to return. The two are complementary, not
 * competing: a schema *source* document's own constructor-application bodies (`!enum [true false]`,
 * read back into a `schema.meta` `Top` by `schema/metaReader.ts`) are exactly this shape, where a
 * schema-*governed* reader building a compiled reader stack over live application data is the
 * suspendable one.
 */
import type {
  ArrayValue,
  CoreValue,
  DataValue,
  MapEntry,
  RecordField,
  TokenValue,
} from '../ast/value.js';
import { TsonReadError } from '../core/errors.js';
import type { Diagnostic, DiagnosticCode } from '../core/diagnostic.js';
import type { Annotations } from '../annotations/index.js';
import type { AtomBinding, Binding, BindingRef, RecordBinding } from './binding.js';

/**
 * Converts a wire {@link TokenValue} at an {@link AtomBinding} leaf to its host value. Consulted
 * by both {@link fromDataValue} and {@link fromCoreValue} for every atom position they reach; a
 * caller that owns `atom/`'s real per-type parsers (or, for the closed meta-kernel vocabulary,
 * `base/`'s base-type resolution) passes one that delegates to them, getting exact conformance
 * (overflow checks, RFC-grade validation) at every atom leaf without this module ever importing
 * either.
 */
export type AtomDecoder = (binding: AtomBinding<unknown>, wire: TokenValue) => unknown;

/**
 * The default {@link AtomDecoder}, used when a caller supplies none: the token's own text,
 * unconverted. Correct only for a `Binding<string>` atom leaf reading its wire text as-is; every
 * other host type (a `boolean`, a `bigint`, a structured temporal/network/decimal value) needs a
 * real {@link AtomDecoder} from a caller that has `atom/`/`base/` in scope, exactly as
 * `encode.ts`'s `defaultAtomEncoder` is correct only for its own narrow default case.
 */
function defaultAtomDecoder(_binding: AtomBinding<unknown>, wire: TokenValue): unknown {
  return wire.text;
}

/**
 * What a caller who knows `binding`'s own *schema* field states (`§5.2`'s `FieldState`) offers a
 * `record`-shaped decode -- deliberately opaque to this module, which knows only `RecordBinding`
 * shapes and nothing of `FieldState`/`RecordField` (see this file's own top comment on the
 * `ast/`+`bind/`-only boundary). `schema/metaReader.ts` is the one caller today: `type_ref`'s own
 * `name` is `REQUIRED` with no default, so it names `positionalField`; `record_field.state`
 * defaults to `REQUIRED` when the wire omits it, so `defaultFor('state')` hands back that default
 * re-spelled as a `DataValue`.
 */
export interface RecordFieldPolicy {
  /** The wire name of the one field a non-record value fills positionally (§5.6), or `undefined` if none/ambiguous for this binding. */
  readonly positionalField?: string;
  /** A default/fixed value for `wireName` when the wire record omits it, or `undefined` when there is none. */
  defaultFor(wireName: string): DataValue | undefined;
}

/**
 * Looks up a {@link RecordFieldPolicy} for one `record`-kind {@link RecordBinding}, keyed by the
 * binding's own identity -- every position bound through the *same* `RecordBinding` object (e.g.
 * every `type_ref`-typed field in `schema/bindings.ts`, all sharing one `typeRefBinding`) shares
 * one policy, since it is a fact about the *type*, not the position. Passed through every
 * recursive {@link fromDataValue}/{@link fromCoreValue} call unchanged, so a nested `record`
 * position -- a field's own field, an array element, a map entry -- gets the same policy lookup a
 * top-level one does. `undefined` (no provider at all, or the provider returning `undefined` for
 * this particular binding) falls back to {@link fromCoreValue}'s own self-contained heuristic --
 * see its own doc.
 */
export type RecordFieldsProvider = (
  binding: RecordBinding<unknown>,
) => RecordFieldPolicy | undefined;

/** Resolves a {@link BindingRef} past any number of {@link LazyBinding} hops -- identical to `encode.ts`'s own private helper. */
function resolveRef<T>(ref: BindingRef<T>): Exclude<Binding<T>, { readonly kind: 'lazy' }> {
  let current: Binding<T> = ref;
  while (current.kind === 'lazy') current = current.get();
  return current;
}

/** Builds a minimal {@link Diagnostic} for a {@link TsonReadError} this module raises -- no path/position tracking here (see this file's own top comment: there is no `ReadContext` at this layer), just enough for a caller to classify and report the failure. */
function readError(code: DiagnosticCode, message: string): TsonReadError {
  const diagnostic: Diagnostic = { code, message };
  return new TsonReadError(diagnostic);
}

/** `value`'s own fields as a plain list, treating `{}` as the empty record `§2.8` resolves it to at a record-typed position. */
function recordFieldsOf(value: CoreValue): readonly RecordField[] | undefined {
  if (value.kind === 'empty-brace') return [];
  if (value.kind === 'record') return value.fields;
  return undefined;
}

/** `value`'s own entries as a plain list, treating `{}` as the empty map `§2.8` resolves it to at a map-typed position. */
function mapEntriesOf(value: CoreValue): readonly MapEntry[] {
  if (value.kind === 'empty-brace') return [];
  if (value.kind === 'map') return value.entries;
  throw readError('TYPE_MISMATCH', `expected a map (or '{}'), found a ${value.kind}`);
}

function tokenOf(value: CoreValue, wireType: string): TokenValue {
  if (value.kind !== 'token') {
    throw readError(
      'TYPE_MISMATCH',
      `expected a token for atom '${wireType}', found a ${value.kind}`,
    );
  }
  return value;
}

/**
 * §5.6's positional form with no {@link RecordFieldPolicy} to consult: the one field, if any,
 * that is both bind-required and not itself collection-shaped ({@link ArrayBinding}/
 * {@link MapBinding} already default to empty when absent, so they are never the field a bare
 * value must fill); when every field is collection-shaped (a record with exactly one field, all
 * of it a list -- `enum_body.members`), that sole field is the fallback. Correct for the closed
 * meta-kernel vocabulary this module was built against (`type_ref.name`, `binary_type.encoding`,
 * `enum_body.members`) without knowing a single `FieldState`; ambiguous elsewhere, in which case
 * this returns `undefined` and positional form is refused.
 */
export function inferPositionalField<
  F extends {
    readonly wireName: string;
    readonly required: boolean;
    readonly unbound?: boolean;
    readonly binding: BindingRef<unknown>;
  },
>(fields: readonly F[]): F | undefined {
  // Two exclusions, and both are load-bearing. An `unbound` slot never receives wire data at all,
  // so it can never be the field a bare value fills. A collection-shaped field already defaults to
  // empty when absent ("absent and empty list are the same"), so a bare value is never meant for
  // one either.
  //
  // This is exported and shared rather than reimplemented: `reader/bind.ts` had its own copy that
  // kept the unbound exclusion and dropped the collection one, so the same Binding read through
  // the two paths could infer two different fields.
  const bindable = fields.filter((f) => f.unbound !== true);
  const candidates = bindable.filter((f) => {
    if (!f.required) return false;
    const kind = resolveRef(f.binding).kind;
    return kind !== 'array' && kind !== 'map';
  });
  if (candidates.length === 1) return candidates[0];
  // A record whose every field is collection-shaped (`enum_body.members`) falls back to its sole
  // field.
  if (bindable.length === 1) return bindable[0];
  return undefined;
}

/**
 * Converts a {@link DataValue} back to a bound host value -- the read counterpart of
 * `encode.ts`'s {@link toDataValue}. Interprets the value's own framing (`§3.1`'s annotations,
 * `§3.2`'s `!type-ref`) wherever a {@link Binding} gives that framing meaning: an
 * {@link AnnotatedBinding} position reads its wire annotations back into the host box;
 * a {@link VariantBinding} position dispatches on `value.typeRef` to pick its member, the wire's
 * own answer to "which member is this" (`binding.ts`'s own doc: "a wire value's own `!type-ref`
 * ... already says which member is present"). Every other binding kind ignores this position's
 * own framing -- it is not theirs to interpret -- and reads only `value.coreValue`.
 *
 * `fieldsFor` is passed through unchanged to every recursive call -- see
 * {@link RecordFieldsProvider}'s own doc.
 */
export function fromDataValue<T>(
  binding: BindingRef<T>,
  value: DataValue,
  decodeAtom: AtomDecoder = defaultAtomDecoder,
  fieldsFor?: RecordFieldsProvider,
): T {
  const resolved = resolveRef(binding);
  if (resolved.kind === 'annotated') {
    const inner = fromDataValue(resolved.value, value, decodeAtom, fieldsFor);
    const annotations: Annotations = { values: value.annotations };
    return resolved.construct(inner, annotations);
  }
  if (resolved.kind === 'variant') {
    if (value.typeRef === undefined) {
      throw readError(
        'UNKNOWN_TYPE_REF',
        `a '${resolved.members.map((m) => m.wireName).join('/')}' value needs its own !type-ref to say which member it is`,
      );
    }
    const member = resolved.members.find((m) => m.wireName === value.typeRef);
    if (member === undefined) {
      throw readError('UNKNOWN_TYPE_REF', `'!${value.typeRef}' names no member of this variant`);
    }
    return fromDataValue(member.binding, value, decodeAtom, fieldsFor) as T;
  }
  if (resolved.kind === 'bridge') {
    return resolved.fromWire(fromDataValue(resolved.wire, value, decodeAtom, fieldsFor));
  }
  return fromCoreValue(resolved, value.coreValue, decodeAtom, fieldsFor);
}

/**
 * Converts a bare {@link CoreValue} back to a bound host value -- the read counterpart of
 * `encode.ts`'s {@link toCoreValue}. No framing to interpret at this position (`§2.3`'s
 * `core-value`, not `data-value`): a {@link VariantBinding} or {@link AnnotatedBinding} passed
 * here has nowhere to read its own discriminant/annotations from, which is an authoring error in
 * the caller -- use {@link fromDataValue} for any position where that framing might matter, which
 * is every position but a caller already holding a bare `CoreValue` with nothing above it.
 *
 * **A `record`-shaped position with no wire record framing at all** (a bare token, array, ...)
 * takes §5.6's positional form: `fieldsFor?.(resolved).positionalField` when a
 * {@link RecordFieldsProvider} names one, else {@link inferPositionalField}'s own self-contained
 * fallback.
 *
 * **A bind-required field absent from the wire record** tries, in order: `fieldsFor`'s own
 * {@link RecordFieldPolicy.defaultFor} (a schema `REQUIRED_DEFAULT`/`REQUIRED_FIXED` value); the
 * empty collection, when the field's own binding resolves to {@link ArrayBinding}/
 * {@link MapBinding} (`CLAUDE.md`'s "absent and empty are the same list"); otherwise a
 * {@link TsonReadError} -- a scalar/atom field genuinely has nothing left to default to.
 */
export function fromCoreValue<T>(
  binding: BindingRef<T>,
  value: CoreValue,
  decodeAtom: AtomDecoder = defaultAtomDecoder,
  fieldsFor?: RecordFieldsProvider,
): T {
  const resolved = resolveRef(binding);
  switch (resolved.kind) {
    case 'atom':
      return decodeAtom(resolved, tokenOf(value, resolved.wireType)) as T;

    case 'record': {
      const policy = fieldsFor?.(resolved);
      let fields = recordFieldsOf(value);
      if (fields === undefined) {
        const positionalField =
          policy?.positionalField ?? inferPositionalField(resolved.fields)?.wireName;
        if (positionalField === undefined) {
          throw readError(
            'TYPE_MISMATCH',
            `expected a record (or '{}'), found a ${value.kind}, and no single-REQUIRED-field ` +
              'positional form (§5.6) applies here',
          );
        }
        fields = [
          { name: positionalField, value: { value: { annotations: [], coreValue: value } } },
        ];
      }
      const byName = new Map(fields.map((f) => [f.name, f] as const));
      const slots: unknown[] = new Array(resolved.fields.length);
      for (const field of fields) {
        const slot = resolved.byWireName.get(field.name);
        if (slot === undefined) {
          throw readError('UNRECOGNIZED_FIELD', `'${field.name}' is not a field of this record`);
        }
        slots[slot.index] = fromDataValue(slot.binding, field.value.value, decodeAtom, fieldsFor);
      }
      for (const slot of resolved.fields) {
        if (slot.unbound || byName.has(slot.wireName)) continue;
        if (!slot.required) continue; // OPTIONAL: leave the slot undefined
        const fallback = policy?.defaultFor(slot.wireName);
        if (fallback !== undefined) {
          slots[slot.index] = fromDataValue(slot.binding, fallback, decodeAtom, fieldsFor);
          continue;
        }
        const slotBinding = resolveRef(slot.binding);
        if (slotBinding.kind === 'array' || slotBinding.kind === 'map') {
          slots[slot.index] = slotBinding.construct([]);
        } else {
          throw readError('FIELD_REQUIRED', `missing required field '${slot.wireName}'`);
        }
      }
      return resolved.construct(slots);
    }

    case 'tuple': {
      if (value.kind !== 'array') {
        throw readError('TYPE_MISMATCH', `expected an array for a tuple, found a ${value.kind}`);
      }
      if (value.elements.length !== resolved.elements.length) {
        throw readError(
          'WRONG_ARITY',
          `expected ${String(resolved.elements.length)} elements, found ${String(value.elements.length)}`,
        );
      }
      const elements = value.elements;
      const values = resolved.elements.map((slot, i) => {
        const element = elements.at(i);
        if (element === undefined) {
          throw readError('WRONG_ARITY', `no element at index ${String(i)}`);
        }
        return fromDataValue(slot.binding, element.value, decodeAtom, fieldsFor);
      });
      return resolved.construct(values);
    }

    case 'array': {
      const elements: ArrayValue['elements'] | undefined =
        value.kind === 'empty-brace' ? [] : value.kind === 'array' ? value.elements : undefined;
      if (elements === undefined) {
        throw readError('TYPE_MISMATCH', `expected an array (or '{}'), found a ${value.kind}`);
      }
      const values = elements.map((el) =>
        fromDataValue(resolved.element, el.value, decodeAtom, fieldsFor),
      );
      return resolved.construct(values);
    }

    case 'map': {
      const entries = mapEntriesOf(value).map(
        (e) =>
          [
            fromDataValue(resolved.key, e.key, decodeAtom, fieldsFor),
            fromDataValue(resolved.value, e.value.value, decodeAtom, fieldsFor),
          ] as const,
      );
      return resolved.construct(entries);
    }

    case 'variant':
      throw readError(
        'TYPE_MISMATCH',
        'a variant position needs its own !type-ref to dispatch on -- read it via fromDataValue, not fromCoreValue',
      );

    case 'bridge':
      return resolved.fromWire(fromCoreValue(resolved.wire, value, decodeAtom, fieldsFor));

    case 'annotated':
      throw readError(
        'TYPE_MISMATCH',
        'an annotated position needs its own wire annotations -- read it via fromDataValue, not fromCoreValue',
      );
  }
}
