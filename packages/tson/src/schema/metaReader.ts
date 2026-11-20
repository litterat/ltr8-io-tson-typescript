/**
 * {@link createDefinitionMetaReader} -- the compiled meta-schema reader `compiler/resolverTypes.ts`
 * declares as `DefinitionMetaReader` and nothing implemented: binds a constructor-application
 * body (`!enum [true false]`, `!integer_type { min: 1 }`) to the `schema.meta` `Top` value it
 * denotes, so `bindAtomInstance` (`compiler/definitionResolver.ts`) has something to call. Without
 * it, `meta.tn` and `core.tn` cannot resolve at all -- every `Instance`/atom-refinement they carry
 * stops at "no compiled reader for '!enum'" (see `bundled-schemas-resolve.test.ts`'s own history).
 *
 * **A meta layer's own constructors.** One IS-A the kernel's `namespace` has maps for values, which
 * no binding describes: its payload is read into the generic value model by
 * `schema/namespaceReader.ts` (§4.1). One refining a constructor of the kernel's or meta.tn's
 * vocabulary (`text_enum => enum_type ^ { name_type?: = text_identifier }`) builds that
 * constructor's body, read through its binding with the refinement's own fields' defaults.
 *
 * **Deliberately outside `schema/meta`**, alongside `bindings.ts` -- the zone rule in
 * `eslint.config.js` reserves `schema/meta` for the value model alone, and this module needs both
 * `bind/` (`fromDataValue`, the read direction `bind/decode.ts` provides) and `compiler/`'s own
 * `DefinitionMetaReader`/`DefinitionGetter` shapes.
 *
 * **Two things a bind-level `RecordBinding` alone cannot answer**, both resolved here by
 * consulting the *governing meta's own resolved entry* for a constructor name --
 * exactly the structure-namespace lookup `deps.metaDefinitions` already threads through
 * `definitionResolver.ts` -- and handed to `bind/decode.ts` as a {@link RecordFieldsProvider}:
 *
 * 1. **§5.6's single-required-field positional form.** `!binary BASE64` and `!enum [true false]`
 *    write the constructor's one field's value directly rather than as a braced record, and this
 *    is general over every `record`-shaped position, not only a top-level constructor application
 *    -- a `type_ref`-typed field (`type: int32`) is *itself* written positionally almost always
 *    (§8.1: "canonical output MUST use the bare token whenever `arguments` is absent"). Which
 *    field a given constructor fills positionally depends on its own `record_field.optional`
 *    (`false`, an unmarked name, whatever its modifier) -- information a `Binding` never carries
 *    (`FieldSlot.required` is a *write*-direction flag, `combinators.ts`'s own `field()`/
 *    `optional()` set it from the host type's own optionality, not from the field's own marks).
 * 2. **Injected field defaulting.** `[T]` desugars to `!array { element_type: T }` alone
 *    (`desugar.ts`'s own array-sugar rewrite) -- `ordered`, `unique_items` and `voidable` are the
 *    *kernel's* own declared defaults (`array => product & { ordered?: boolean ~ true ... }`,
 *    meta-kernel.tn), not something the wire ever restates, and the same is true one level down
 *    (`record_field.optional`/`voidable` `~ false`, `role ~ FREE`). `bind/decode.ts`'s own
 *    "absent and empty are the same list" rule already covers a missing `ArrayBinding`/
 *    `MapBinding`-shaped field; every other missing field whose `role` is not `FREE` needs its
 *    default token here, from the governing meta's own `RecordField.value`.
 *
 * **Two distinct sources feed the one `RecordFieldsProvider`** {@link createDefinitionMetaReader}
 * builds, because a nested `record`-shaped field's own constructor name is not recoverable from
 * its `Binding` (a `RecordBinding` carries no name back to the wire vocabulary), but is fixed and
 * known for the handful of `schema/bindings.ts` bindings this module's own callers can reach: the
 * *top-level* binding (`metaBindings.get(type)`, keyed by the real `type` this call was invoked
 * with -- the only way to tell `!array {...}` from `!set {...}` apart, since both share one
 * `arrayBodyBinding` object) and a small closed table of *nested* "supporting record" bindings
 * (`type_ref`, `record_field`, `tuple_element`, `field_group`, `integer_size`, `type_chain`) that never alias
 * another wire name the way `array`/`set` do.
 */
import type { DataValue } from '../ast/value.js';
import { TsonMissingBindingError, TsonReadError } from '../core/errors.js';
import type { Diagnostic } from '../core/diagnostic.js';
import {
  fromDataValue,
  type AtomDecoder,
  type RecordFieldPolicy,
  type RecordFieldsProvider,
} from '../bind/decode.js';
import type { RecordBinding } from '../bind/binding.js';
import type { DefinitionGetter, DefinitionMetaReader } from '../compiler/resolverTypes.js';
import { tryParseNumber } from '../base/numberGrammar.js';
import { toExactInteger } from '../base/numberNarrowing.js';
import { resolveBaseType, type BaseToken } from '../base/baseTypeResolver.js';
import { readFullDate, readFullTime } from '../atom/temporal/rfc3339.js';
import { referenceOfWire } from './referenceAtoms.js';
import {
  arrayBodyBinding,
  applyBodyBinding,
  choiceBodyBinding,
  dependentBodyBinding,
  enumBodyBinding,
  fieldGroupBinding,
  integerSizeBinding,
  mapBodyBinding,
  metaBindings,
  namespaceBodyBinding,
  paramBinding,
  recordBodyBinding,
  recordFieldBinding,
  refBodyBinding,
  tokenFormToWire,
  tupleBodyBinding,
  tupleElementBinding,
  typeChainBinding,
} from './bindings.js';
import { NUMERIC_MAP, kernelName, metaName } from './meta/kernel.js';
import {
  fieldOmission,
  groupViolations,
  isGroupMember,
  namedFields,
  type NamedField,
  type RecordBody,
  type RecordField,
} from './meta/bodies.js';
import type { Top } from './meta/typedef.js';
import { inheritedBindingName } from './inheritedBinding.js';

// -------------------------------------------------------------------------------------------
// The atom decoder for the closed meta-kernel/meta vocabulary
// -------------------------------------------------------------------------------------------

/** The largest `numeric.count` (§5.5): 2^63 - 1, so every implementation holds a count in a native type. */
const COUNT_MAX = (1n << 63n) - 1n;

/**
 * Decodes an atom leaf of the *meta-kernel's own* closed vocabulary (`identifier`, `token`,
 * `text`, `boolean`, `integer`, `value`, `date`, `time`, `datetime`, `scope_kind`, and the other
 * enum-shaped constraint atoms -- `field_role`, `record_extension_type`,
 * `normalization`, `identifier_base`, `complex_component`, `ieee_format`, `bytes_encoding`). Deliberately narrow: this
 * is not a general-purpose `atom/`
 * replacement, only what a schema *source* document's own constructor-application bodies ever
 * carry -- min/max bounds, size bits, enum members, boolean flags, and the temporal bound facets.
 * Every one of those bounds is `value`-typed in `spec/m/meta.tn` (`( min: value | exclusive_min:
 * value )?` on `date_type`, `time_type`, `datetime_type`, `duration_type` and `period_type`
 * alike), so §5.2's rule governs each the same way: the token is read under the atom the position
 * stands for, once that atom is in scope, and the result is stored. `base/`'s own number grammar
 * does the real parsing for the numeric
 * `value` case (§4, §7.6); `atom/temporal/rfc3339.ts`'s hand-written grammar does it for
 * `date`/`time`/`datetime`, the same parser every document-level `!date`/`!time`/`!datetime`
 * token goes through -- no regex, per `CLAUDE.md`'s own rule.
 */
export const metaAtomDecoder: AtomDecoder = (binding, wire) => {
  switch (binding.wireType) {
    case 'token':
    case 'identifier':
      return { text: wire.text, form: wire.form };

    case 'text':
      return wire.text;

    // `meta.type_ref` and every `meta.ref`, a position that names something (§4.2, §5.12): the wire token is
    // the qualified name, whatever its form.
    case 'type_ref':
      return referenceOfWire(wire.text, wire.form);

    case 'boolean':
      if (wire.text === 'true') return true;
      if (wire.text === 'false') return false;
      throw readError(`expected 'true' or 'false', found '${wire.text}'`);

    case 'integer': {
      const form = tryParseNumber(wire.text);
      if (form === undefined || (form.kind !== 'integer' && form.kind !== 'based-integer')) {
        throw readError(`expected an integer literal, found '${wire.text}'`);
      }
      return toExactInteger(form);
    }

    // `numeric.count` (§5.5): a non-negative integer no larger than the signed 64-bit maximum.
    case 'count': {
      const form = tryParseNumber(wire.text);
      if (form === undefined || (form.kind !== 'integer' && form.kind !== 'based-integer')) {
        throw readError(`expected an integer literal, found '${wire.text}'`);
      }
      const count = toExactInteger(form);
      if (count < 0n || count > COUNT_MAX) {
        throw readError(
          `'${wire.text}' is no count: a count is an integer from 0 to ${String(COUNT_MAX)}, the signed 64-bit range (§5.5)`,
        );
      }
      return count;
    }

    case 'value':
      return decodeBaseValue(wire);

    // `date_type.min`/`.max` (`schema/bindings.ts`'s `calendarDateBinding`) read the token
    // directly as `CalendarDate` -- no bridge, since the two shapes already agree field for
    // field.
    case 'date': {
      const parsed = readFullDate(wire.text, 0);
      if (parsed?.next !== wire.text.length) {
        throw readError(`expected an RFC 3339 full-date, found '${wire.text}'`);
      }
      return parsed.value;
    }

    // `time_type.min`/`.max` (`offsetTimeBinding`) bridge this shape into `OffsetTime`; the
    // decoder's own job stops at the RFC 3339 `full-time` grammar.
    case 'time': {
      const parsed = readFullTime(wire.text, 0);
      if (parsed === undefined) {
        throw readError(`expected an RFC 3339 full-time, found '${wire.text}'`);
      }
      return {
        hour: parsed.hour,
        minute: parsed.minute,
        second: parsed.second,
        nanosecond: parsed.nanosecond,
        offset: { totalMinutes: parsed.offsetMinutes },
      };
    }

    // `datetime_type.min`/`.max` (`offsetDateTimeBinding`) -- `full-date "T" full-time`, the
    // same two-primitive composition `atom/temporal/datetime.ts` itself uses.
    case 'datetime': {
      const text = wire.text;
      const datePart = readFullDate(text, 0);
      if (datePart === undefined) {
        throw readError(`expected an RFC 3339 date-time, found '${text}'`);
      }
      const separator = text.charCodeAt(datePart.next);
      if (separator !== 0x54 /* 'T' */ && separator !== 0x74 /* 't' */) {
        throw readError(`expected an RFC 3339 date-time, found '${text}'`);
      }
      const timePart = readFullTime(text, datePart.next + 1);
      if (timePart === undefined) {
        throw readError(`expected an RFC 3339 date-time, found '${text}'`);
      }
      return {
        date: datePart.value,
        time: {
          hour: timePart.hour,
          minute: timePart.minute,
          second: timePart.second,
          nanosecond: timePart.nanosecond,
          offset: { totalMinutes: timePart.offsetMinutes },
        },
      };
    }

    // The remaining meta-kernel/meta atoms are all closed enumerations (`scope_kind`,
    // `field_role`, `record_extension_type`, `normalization`, `identifier_base`,
    // `complex_component`, `ieee_format`, `bytes_encoding`): every member is written as its own
    // bare unquoted name, so the token's own text already is the host value -- `schema/meta`'s
    // corresponding types are plain string-literal unions.
    default:
      return wire.text;
  }
};

/** A `value`-carried token narrowed to a plain host value, by the same three-class reading §4 states — the last resort for a meta-schema facet no declared atom stands behind, never a fallback under a schema, where §4.1 does not reach. */
function decodeBaseValue(wire: BaseToken): unknown {
  const base = resolveBaseType(wire);
  switch (base.kind) {
    case 'boolean':
      return base.value;
    case 'string':
      return base.text;
    case 'number':
      return base.form.kind === 'integer' || base.form.kind === 'based-integer'
        ? toExactInteger(base.form)
        : wire.text;
  }
}

function readError(message: string): TsonReadError {
  const diagnostic: Diagnostic = { code: 'TYPE_MISMATCH', message };
  return new TsonReadError(diagnostic);
}

// -------------------------------------------------------------------------------------------
// Turning a constructor's own resolved fields into a RecordFieldPolicy
// -------------------------------------------------------------------------------------------

/** `def`'s own `RecordBody`, or `undefined` when `def` is unknown or not record-shaped. */
function recordBodyOf(value: Top | undefined): RecordBody | undefined {
  return value?.kind === 'record' ? value : undefined;
}

function singleRequiredField(fields: readonly NamedField[]): string | undefined {
  const required = fields.filter((f) => !f.optional);
  return required.length === 1 ? required[0]?.name : undefined;
}

function defaultAsDataValue(field: RecordField, memberOfGroup: boolean): DataValue | undefined {
  if (fieldOmission(field, memberOfGroup) !== 'INJECTED' || field.value === undefined) {
    return undefined;
  }
  return {
    annotations: [],
    coreValue: { kind: 'token', text: field.value.text, form: tokenFormToWire[field.value.form] },
  };
}

/** Builds the {@link RecordFieldPolicy} `def`'s own resolved fields describe, or `undefined` when `def` is unknown/not record-shaped -- {@link fromCoreValue} then falls back to its own self-contained heuristic. */
function policyFor(value: Top | undefined): RecordFieldPolicy | undefined {
  const body = recordBodyOf(value);
  if (body === undefined) return undefined;
  const { fields, groups } = body;
  const positionalField = singleRequiredField(namedFields(body));
  return {
    ...(positionalField === undefined ? {} : { positionalField }),
    defaultFor: (wireName) => {
      const field = fields.entries.get(wireName);
      return field === undefined
        ? undefined
        : defaultAsDataValue(field, isGroupMember(groups, wireName));
    },
  };
}

/**
 * The closed set of `schema/bindings.ts` "supporting record" bindings that can appear as a
 * *nested* field position -- never as `metaBindings`' own top-level dispatch target under more
 * than one name, unlike `arrayBodyBinding` (`array`/`set`) -- so each maps unambiguously to one
 * kernel type name, resolvable through the same structure namespace as any top-level constructor.
 */
const NESTED_BINDING_NAMES: ReadonlyMap<RecordBinding<unknown>, string> = new Map<
  RecordBinding<unknown>,
  string
>([
  [recordFieldBinding, metaName('record_field')],
  [tupleElementBinding, metaName('tuple_element')],
  [fieldGroupBinding, metaName('field_group')],
  [integerSizeBinding, kernelName(NUMERIC_MAP, 'integer_size')],
  [typeChainBinding, metaName('type_chain')],
  [paramBinding, metaName('param')],
  // The bodies a type written in place holds, `{ of: !meta.array { ... } }`, each read with its constructor's
  // defaults.
  [recordBodyBinding, metaName('record')],
  [arrayBodyBinding, metaName('array')],
  [mapBodyBinding, metaName('map')],
  [namespaceBodyBinding, metaName('namespace')],
  [tupleBodyBinding, metaName('tuple')],
  [choiceBodyBinding, metaName('choice')],
  [enumBodyBinding, metaName('enum_type')],
  [refBodyBinding, metaName('ref')],
  [applyBodyBinding, metaName('apply')],
  [dependentBodyBinding, metaName('dependent')],
]);

// -------------------------------------------------------------------------------------------
// The reader itself
// -------------------------------------------------------------------------------------------

/**
 * A constructor's own field groups bind what its body may write (§5.11): `integer_type`'s
 * `( min | exclusive_min )?` admits at most one option, so a body writing both is no instance of the
 * constructor. Only a second chosen option is refused here -- a group's other refusals (a missing member, an
 * unchosen required group) are judged where the body is completed against the constructor's defaults.
 */
function refuseSeveralOptions(def: Top | undefined, value: DataValue, type: string): void {
  const body = recordBodyOf(def);
  const core = value.coreValue;
  if (body === undefined || core.kind !== 'record') return;
  const written = new Set(core.fields.map((f) => f.name));
  for (const group of body.groups) {
    for (const violation of groupViolations(group, (member) => written.has(member))) {
      if (violation.kind !== 'SEVERAL_CHOSEN') continue;
      const named = violation.options.map((i) => (group.members[i] ?? []).join(', '));
      const message = `'${type}' admits one option of a field group (§5.11), and the body writes ${named.join(' and ')}`;
      throw new TsonReadError({ code: 'FIELD_GROUP', message });
    }
  }
}

/**
 * A field the constructor pins (`voidable?: = false` on `meta.namespace`) may be restated at its pinned value and
 * at no other (§5.2, §5.7): a pin is the constructor's statement, which no construction or refinement moves. A pin
 * on a token is compared by its text; a structured pin is left to the binding, which keeps nothing for it.
 */
function refuseMovedPins(def: Top | undefined, value: DataValue, type: string): void {
  const body = recordBodyOf(def);
  const core = value.coreValue;
  if (body === undefined || core.kind !== 'record') return;
  for (const written of core.fields) {
    const declared = body.fields.entries.get(written.name);
    if (declared?.role !== 'FIXED' || declared.value === undefined) continue;
    const token = written.value.coreValue;
    if (token.kind !== 'token' || token.text === declared.value.text) continue;
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message:
        `'${written.name}' is fixed at ${declared.value.text} by '${type}', and the body writes ${token.text} -- ` +
        'a pinned field is restated at its pinned value or left alone (§5.2, §5.7)',
    });
  }
}

/**
 * Builds a {@link DefinitionMetaReader} governed by `lookupConstructorDef` -- the same structure
 * namespace a caller already threads through `DefinitionResolverDeps.metaDefinitions`/
 * `SchemaResolverDeps.metaDefinitions` (`resolverTypes.ts`'s own `DefinitionGetter`), passed here
 * too so this reader's {@link RecordFieldsProvider} can answer both of this module's own top
 * comment's questions for every `record`-shaped position `fromDataValue` reaches, top-level
 * constructor and nested supporting record alike.
 */
export function createDefinitionMetaReader(
  lookupConstructorDef: DefinitionGetter,
  decodeAtom: AtomDecoder = metaAtomDecoder,
): DefinitionMetaReader {
  return (type, value) => {
    const binding =
      metaBindings.get(type) ??
      metaBindings.get(
        inheritedBindingName(
          type,
          lookupConstructorDef,
          (n) => metaBindings.get(n) !== undefined,
        ) ?? type,
      );
    if (binding === undefined) {
      throw new TsonMissingBindingError(
        `no binding registered for constructor '!${type}' in schema/bindings.ts's metaBindings`,
      );
    }
    // `binding` is never itself `'lazy'` -- every `metaBindings` entry is a plain record/unit
    // binding (`bindings.ts`'s own `metaBindings` table), so no `resolveRef` hop is needed to
    // compare identity against what `fromDataValue` resolves down to.
    const fieldsFor: RecordFieldsProvider = (resolved) => {
      if (resolved === binding) return policyFor(lookupConstructorDef(type));
      const nestedName = NESTED_BINDING_NAMES.get(resolved);
      return nestedName === undefined ? undefined : policyFor(lookupConstructorDef(nestedName));
    };
    const constructor = lookupConstructorDef(type);
    refuseSeveralOptions(constructor, value, type);
    refuseMovedPins(constructor, value, type);
    return fromDataValue(binding, value, decodeAtom, fieldsFor) as Top;
  };
}
