/**
 * {@link createDefinitionMetaReader} -- the compiled meta-schema reader `compiler/resolverTypes.ts`
 * declares as `DefinitionMetaReader` and nothing implemented: binds a constructor-application
 * body (`!enum [true false]`, `!integer_type { min: 1 }`) to the `schema.meta` `Top` value it
 * denotes, so `bindAtomInstance` (`compiler/definitionResolver.ts`) has something to call. Without
 * it, `meta.tn` and `core.tn` cannot resolve at all -- every `Instance`/atom-refinement they carry
 * stops at "no compiled reader for '!enum'" (see `bundled-schemas-resolve.test.ts`'s own history).
 *
 * **Deliberately outside `schema/meta`**, alongside `bindings.ts` -- the zone rule in
 * `eslint.config.js` reserves `schema/meta` for the value model alone, and this module needs both
 * `bind/` (`fromDataValue`, the read direction `bind/decode.ts` provides) and `compiler/`'s own
 * `DefinitionMetaReader`/`DefinitionGetter` shapes.
 *
 * **Two things a bind-level `RecordBinding` alone cannot answer**, both resolved here by
 * consulting the *governing meta's own resolved `TypeDefinition`* for a constructor name --
 * exactly the structure-namespace lookup `deps.metaDefinitions` already threads through
 * `definitionResolver.ts` -- and handed to `bind/decode.ts` as a {@link RecordFieldsProvider}:
 *
 * 1. **§5.6's single-required-field positional form.** `!binary BASE64` and `!enum [true false]`
 *    write the constructor's one field's value directly rather than as a braced record, and this
 *    is general over every `record`-shaped position, not only a top-level constructor application
 *    -- a `type_ref`-typed field (`type: int32`) is *itself* written positionally almost always
 *    (§8.1: "canonical output MUST use the bare token whenever `arguments` is absent"). Which
 *    field a given constructor fills positionally depends on its own `record_field.state`
 *    (`REQUIRED`, with no default or fixed value) -- information a `Binding` never carries
 *    (`FieldSlot.required` is a *write*-direction flag, `combinators.ts`'s own `field()`/
 *    `optional()` set it from the host type's own optionality, not from `FieldState`).
 * 2. **`REQUIRED_DEFAULT`/`REQUIRED_FIXED` field defaulting.** `[T]` desugars to
 *    `!array { element_type: T }` alone (`desugar.ts`'s own array-sugar rewrite) -- `unordered`,
 *    `unique_items` and `state` are the *kernel's* own declared defaults
 *    (`array => ~product & { unordered: boolean ~ false ... }`, meta-kernel.tn), not something the
 *    wire ever restates, and the same is true one level down (`record_field.state ~ REQUIRED`).
 *    `bind/decode.ts`'s own "absent and empty are the same list" rule already covers a missing
 *    `ArrayBinding`/`MapBinding`-shaped field; every other missing `REQUIRED_DEFAULT`/
 *    `REQUIRED_FIXED` scalar field needs its default token here, from the governing meta's own
 *    `RecordField.value`.
 *
 * **Two distinct sources feed the one `RecordFieldsProvider`** {@link createDefinitionMetaReader}
 * builds, because a nested `record`-shaped field's own constructor name is not recoverable from
 * its `Binding` (a `RecordBinding` carries no name back to the wire vocabulary), but is fixed and
 * known for the handful of `schema/bindings.ts` bindings this module's own callers can reach: the
 * *top-level* binding (`metaBindings.get(type)`, keyed by the real `type` this call was invoked
 * with -- the only way to tell `!array {...}` from `!set {...}` apart, since both share one
 * `arrayBodyBinding` object) and a small closed table of *nested* "supporting record" bindings
 * (`type_ref`, `record_field`, `tuple_element`, `field_group`, `integer_size`) that never alias
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
import {
  fieldGroupBinding,
  integerSizeBinding,
  metaBindings,
  recordFieldBinding,
  tokenFormToWire,
  tupleElementBinding,
  typeRefBinding,
} from './bindings.js';
import type { RecordBody, RecordField } from './meta/bodies.js';
import type { Top, TypeDefinition } from './meta/typedef.js';

// -------------------------------------------------------------------------------------------
// The atom decoder for the closed meta-kernel/meta vocabulary
// -------------------------------------------------------------------------------------------

/**
 * Decodes an atom leaf of the *meta-kernel's own* closed vocabulary (`token`, `text`, `boolean`,
 * `integer`, `value`, and the six enum-shaped constraint atoms `type_kind`/`field_state`/
 * `element_state`/`complex_component`/`ieee_format`/`binary_encoding`). Deliberately narrow:
 * this is not a general-purpose `atom/` replacement, only what a schema *source* document's own
 * constructor-application bodies ever carry -- min/max bounds, size bits, enum members, boolean
 * flags. `base/`'s own number grammar and base-type resolution do the real parsing (§4, §7.6); no
 * regex, per `CLAUDE.md`'s own rule for the number grammar.
 */
export const metaAtomDecoder: AtomDecoder = (binding, wire) => {
  switch (binding.wireType) {
    case 'token':
      return { text: wire.text, form: wire.form };

    case 'text':
      return wire.text;

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

    case 'value':
      return decodeBaseValue(wire);

    // The remaining meta-kernel/meta atoms are all closed enumerations (`type_kind`,
    // `field_state`, `element_state`, `complex_component`, `ieee_format`, `binary_encoding`):
    // every member is written as its own bare unquoted name, so the token's own text already
    // is the host value -- `schema/meta`'s corresponding types are plain string-literal unions.
    default:
      return wire.text;
  }
};

/** §4's base-type resolution (null/boolean/number/string), narrowed to a plain host value for meta-kernel's own `value` escape hatch. */
function decodeBaseValue(wire: BaseToken): unknown {
  const base = resolveBaseType(wire);
  switch (base.kind) {
    case 'null':
      return null;
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

/** `def`'s own `RecordBody.fields`, or `undefined` when `def` is unknown or not record-shaped. */
function recordFieldsOf(def: TypeDefinition | undefined): readonly RecordField[] | undefined {
  if (def === undefined) return undefined;
  const body: Top = def.body;
  // `TemplateBody` carries no `kind` tag at all (see `typedef.ts`'s own doc) -- membership must
  // be checked before narrowing, exactly as `bind/strictness.ts`'s own `checkBinding` does.
  if (!('kind' in body) || body.kind !== 'record') return undefined;
  // `Data.kind` is a plain `string` (a meta-schema's own constructor name), not a literal, so the
  // check above narrows to `RecordBody | Data` rather than `RecordBody` alone -- the same
  // narrowing gap `bind/strictness.ts`'s own `checkBinding` documents and casts past.
  return (body as RecordBody).fields;
}

/** The one field name §5.6 lets a bare (non-record) value fill: the constructor's single `REQUIRED` field, if it has exactly one. */
function singleRequiredField(fields: readonly RecordField[]): string | undefined {
  const required = fields.filter((f) => f.state === 'REQUIRED');
  return required.length === 1 ? required[0]?.name : undefined;
}

/** A default/fixed `RecordField.value` re-spelled as the wire `DataValue` it denotes, via `bindings.ts`'s own form map. */
function defaultAsDataValue(field: RecordField): DataValue | undefined {
  if (
    (field.state !== 'REQUIRED_DEFAULT' && field.state !== 'REQUIRED_FIXED') ||
    field.value === undefined
  ) {
    return undefined;
  }
  return {
    annotations: [],
    coreValue: { kind: 'token', text: field.value.text, form: tokenFormToWire[field.value.form] },
  };
}

/** Builds the {@link RecordFieldPolicy} `def`'s own resolved fields describe, or `undefined` when `def` is unknown/not record-shaped -- {@link fromCoreValue} then falls back to its own self-contained heuristic. */
function policyFor(def: TypeDefinition | undefined): RecordFieldPolicy | undefined {
  const fields = recordFieldsOf(def);
  if (fields === undefined) return undefined;
  const positionalField = singleRequiredField(fields);
  return {
    ...(positionalField === undefined ? {} : { positionalField }),
    defaultFor: (wireName) => {
      const field = fields.find((f) => f.name === wireName);
      return field === undefined ? undefined : defaultAsDataValue(field);
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
  [typeRefBinding, 'type_ref'],
  [recordFieldBinding, 'record_field'],
  [tupleElementBinding, 'tuple_element'],
  [fieldGroupBinding, 'field_group'],
  [integerSizeBinding, 'integer_size'],
]);

// -------------------------------------------------------------------------------------------
// The reader itself
// -------------------------------------------------------------------------------------------

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
    const binding = metaBindings.get(type);
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
    return fromDataValue(binding, value, decodeAtom, fieldsFor) as Top;
  };
}
