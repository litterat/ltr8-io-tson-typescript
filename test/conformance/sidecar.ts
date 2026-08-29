import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import type { DataValue, ScopedValue } from '../../packages/tson/src/ast/value.js';

/**
 * Reduction from the generic {@link DataValue} tree our own parser produces over a sidecar's
 * bytes into the *typed*, per-layer sidecar shapes `schemas/<layer>-sidecar.tn` describe.
 *
 * **Dogfooding, per RUNNER.md rule 2**: a sidecar is parsed with the real Tier 3 parser
 * ({@link parseDocument}), never a shortcut. What follows is *reduction*, not a second parser: no
 * TSON syntax (tokens, escapes, brace disambiguation) is reinterpreted here, only the meaning of
 * a tree the real parser already built.
 *
 * **One parse function per layer, not one generic `Sidecar`.** The five schemas in `schemas/`
 * are five different shapes — `resolver-sidecar.tn` has no `error` outcome at all, and
 * `vocabulary-sidecar.tn`/`reader-sidecar.tn` both use a bare field named `value` for two
 * unrelated shapes (`atom_value` vs. `reader_value`). A single reducer would have to be told
 * which layer it was looking at to disambiguate that anyway, so this module states the five
 * shapes as five distinct types and five distinct parse functions instead, mirroring the
 * schemas file-for-file.
 *
 * **The outcome is a field group (Part 2 §5.11), not a flat `outcome:` field.** The sidecar
 * record carries exactly one of `valid: {…}` / `error: {…}` / `schema-document: _` as a member,
 * and that member's *name* is the outcome — there is no separate field that could disagree with
 * the payload beside it. {@link soleMember} is the one place that reads a group generically;
 * every other group in these schemas (`core_value`, `base_value`, `number_form`, `atom_value`,
 * `reader_value`, `reader_atom`) reduces through it too.
 */

/** The suite's four §8.1 error categories, asserted on an `outcome: error` vector. */
export type Category = 'lexer' | 'parser' | 'resolver' | 'validation';

/** The three outcomes a sidecar's outcome group may name. Not every layer uses all three. */
export type Outcome = 'valid' | 'error' | 'schema-document';

/**
 * A vector's declared non-UTF-8 encoding. Absent means UTF-8. Only `invalid-utf8` is fed to
 * an implementation and expected to fail there; `utf-16`/`utf-32` are skipped (§9.1 permits
 * them, but nothing here reads them).
 */
export type Encoding = 'invalid-utf8' | 'utf-16' | 'utf-32';

/** Fields every sidecar carries, whatever its layer or outcome (`sidecar-common.tn`'s `sidecar_common`). */
export interface CommonSidecarFields {
  /** The spec section this vector targets, e.g. `"§7.2.2"`. Metadata only, not load-bearing. */
  readonly spec: string;
  /** One line: what this vector exercises and why. */
  readonly description: string;
  /** Present only when the subject is not plain UTF-8. */
  readonly encoding?: Encoding;
  /** A short bundled-schema name (`bundled-ids.ts`) for the subject's own `!!meta` target. */
  readonly meta?: string;
  /** Short bundled-schema names for the subject's own `!!import` entries, in order. */
  readonly import?: readonly string[];
}

// ── Lexer layer ──────────────────────────────────────────────────────────────────────────────

/** One expected lexer token (lexer-layer `valid` vectors). */
export interface ExpectedToken {
  /** The spec's own token-stream grammar vocabulary (§7.3), not an implementation type name. */
  readonly kind:
    | 'single-line-token'
    | 'multi-line-token'
    | 'unquoted-token'
    | 'absent-token'
    | 'structural-delimiter'
    | 'map-arrow-token'
    | 'directive-token'
    | 'range-token'
    | 'special-token';
  /** The token's decoded text. */
  readonly text: string;
}

export interface LexerSidecar extends CommonSidecarFields {
  readonly outcome: 'valid' | 'error';
  /** Present iff `outcome === 'error'`. */
  readonly category?: Category;
  /** Present iff `outcome === 'valid'`: the expected token stream, in order, EOF excluded. */
  readonly tokens?: readonly ExpectedToken[];
}

// ── Parser layer ─────────────────────────────────────────────────────────────────────────────

/** A token's quoting form (parser-layer `core: { token: { form: …, text: … } }`). */
export type TokenForm = 'unquoted' | 'single-line' | 'multi-line';

/** An expected annotation on an expected data-value (parser layer). */
export interface ExpectedAnnotation {
  readonly name: string;
  /** Absent (`_`) for a valueless annotation. */
  readonly value?: ExpectedDataValue;
}

/** An expected core-value (parser layer): one member of the `core_value` field group. */
export type ExpectedCoreValue =
  | { readonly kind: 'token'; readonly form: TokenForm; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'empty-brace' }
  | { readonly kind: 'record'; readonly fields: readonly ExpectedRecordField[] }
  | { readonly kind: 'map'; readonly entries: readonly ExpectedMapEntry[] }
  | { readonly kind: 'array'; readonly elements: readonly ExpectedScopedValue[] };

/** An expected record field (parser layer). */
export interface ExpectedRecordField {
  readonly name: string;
  readonly value: ExpectedScopedValue;
}

/** An expected map entry (parser layer). */
export interface ExpectedMapEntry {
  readonly key: ExpectedDataValue;
  readonly value: ExpectedScopedValue;
}

/** An expected scoped-value: a field/array-element/map-value's own `!!schema` plus its value. */
export interface ExpectedScopedValue {
  /** Absent (`_`) unless this position carries its own `!!schema` directive. */
  readonly schemaRef?: string;
  readonly value: ExpectedDataValue;
}

/** An expected data-value: annotations, an optional type-ref, and a core-value (parser layer). */
export interface ExpectedDataValue {
  readonly annotations: readonly ExpectedAnnotation[];
  /** Absent (`_`) when the value carries no type-ref. */
  readonly typeRef?: string;
  readonly core: ExpectedCoreValue;
}

/** The expected parse tree of a `valid` parser-layer vector (`schemas/parser-sidecar.tn`). */
export interface ExpectedDocument {
  /** Absent (`_`) unless the document carries its own `!!id`. */
  readonly id?: string;
  /** Absent (`_`) unless the document carries its own `!!schema`. */
  readonly schema?: string;
  readonly root: ExpectedDataValue;
}

export interface ParserSidecar extends CommonSidecarFields {
  readonly outcome: 'valid' | 'error' | 'schema-document';
  /** Present iff `outcome === 'error'`. */
  readonly category?: Category;
  /** Present iff `outcome === 'valid'`. */
  readonly document?: ExpectedDocument;
}

// ── Resolver layer ───────────────────────────────────────────────────────────────────────────

/** `+`/`-`, as captured on a resolved number's sign (resolver layer). */
export type NumberSign = 'plus' | 'minus';

/** A based-integer's radix (resolver layer). */
export type BasedIntegerRadix = 'hex' | 'octal' | 'binary';

/**
 * Which of the number grammar's four forms a token matched, and its components (§7.6):
 * one member of the `number_form` field group. Identification only — no bound host numeric type.
 */
export type ExpectedNumberForm =
  | { readonly shape: 'integer'; readonly sign?: NumberSign; readonly digits: string }
  | {
      readonly shape: 'based-integer';
      readonly sign?: NumberSign;
      readonly radix: BasedIntegerRadix;
      readonly digits: string;
    }
  | {
      readonly shape: 'float';
      readonly sign?: NumberSign;
      readonly integerPart?: string;
      readonly fractionDigits?: string;
      readonly exponent?: { readonly sign?: NumberSign; readonly digits: string };
    }
  | {
      readonly shape: 'special-value';
      readonly sign?: NumberSign;
      readonly kind: 'nan' | 'infinity';
    };

/**
 * The expected result of base type resolution (§4) on a resolver-layer vector's bare token: one
 * member of the `base_value` field group.
 */
export type ExpectedBaseValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number'; readonly form: ExpectedNumberForm };

/**
 * §4 never rejects a token, so this layer has one outcome and no `category` — a group of one
 * member is not a group (§5.11's two-member minimum), and `resolver-sidecar.tn` states `valid`
 * as a plain REQUIRED field rather than a group.
 */
export interface ResolverSidecar extends CommonSidecarFields {
  readonly outcome: 'valid';
  readonly baseValue: ExpectedBaseValue;
}

// ── Vocabulary layer ─────────────────────────────────────────────────────────────────────────

/**
 * A vocabulary-layer `value`: one member of the `atom_value` field group, host-representation-
 * neutral per the suite README:
 *
 * - `decimal`/`hex`/`rational`/`text`: a plain string (a decimal, a hex dump of raw bytes, a
 *   `"numerator/denominator"`, or the value's own canonical text — see `vocabulary-sidecar.tn`'s
 *   own doc for which atoms use which).
 * - `complex`: `{ real, imaginary }`, each an exact decimal string.
 * - `duration`: `{ period, clock }`, each an independently-parseable ISO 8601 substring.
 */
export type ExpectedVocabularyValue =
  | string
  | { readonly real: string; readonly imaginary: string }
  | { readonly period: string; readonly clock: string };

export interface VocabularySidecar extends CommonSidecarFields {
  readonly outcome: 'valid' | 'error';
  /** Present iff `outcome === 'error'`. */
  readonly category?: Category;
  /** REQUIRED at this layer (unlike every other per-layer field): both outcomes need it. */
  readonly typeRef: string;
  /** Present iff `outcome === 'valid'`. */
  readonly value?: ExpectedVocabularyValue;
}

// ── Reader layer ─────────────────────────────────────────────────────────────────────────────

/** One field of an expected reader-layer record, after §2.5's uniqueness rule. */
export interface ExpectedReaderField {
  readonly name: string;
  readonly value: ExpectedReaderValue;
}

/** One entry of an expected reader-layer map, after §2.6's key-identity rule. */
export interface ExpectedReaderEntry {
  readonly key: ExpectedReaderValue;
  readonly value: ExpectedReaderValue;
}

/**
 * A leaf, named by the base type §4 resolved it to: one member of the `reader_atom` field group.
 * `number` is a decimal string compared **by decoded value, not spelling** (§4.3 leaves the host
 * type an implementation concern) — {@link ../reader.js}'s `assertReaderValueMatches` is what
 * applies that comparison; this type only carries the sidecar's own text.
 */
export type ExpectedReaderAtom =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number'; readonly text: string };

/**
 * One value of the tree a schemaless read produces (`reader-sidecar.tn`'s `reader_value` field
 * group): a `record`/`map`/`array`/`atom`/`absent`, no annotations, no `!!schema`-scoped values —
 * §2.5/§2.6 duplicates already resolved, §2.8's empty brace already resolved to an empty record.
 */
export type ExpectedReaderValue =
  | { readonly kind: 'record'; readonly fields: readonly ExpectedReaderField[] }
  | { readonly kind: 'map'; readonly entries: readonly ExpectedReaderEntry[] }
  | { readonly kind: 'array'; readonly elements: readonly ExpectedReaderValue[] }
  | { readonly kind: 'atom'; readonly atom: ExpectedReaderAtom }
  | { readonly kind: 'absent' };

export interface ReaderSidecar extends CommonSidecarFields {
  readonly outcome: 'valid' | 'error';
  /** Present iff `outcome === 'error'`. Always `resolver` at this layer (see `reader-sidecar.tn`). */
  readonly category?: Category;
  /** Present iff `outcome === 'valid'`. */
  readonly value?: ExpectedReaderValue;
}

// ── Shared low-level reduction helpers: generic DataValue -> named field lookup ─────────────
//
// The sidecar body is itself an ordinary, untyped TSON record tree. These helpers walk that
// generic tree by field name to recover the meaning a sidecar author encoded in it — reduction,
// not a second parser (see this module's own top note).

/** The record fields of `dv`'s core-value, keyed by field name, `!!schema` directives dropped. */
function recordFields(dv: DataValue, what: string): Map<string, DataValue> {
  const core = dv.coreValue;
  if (core.kind !== 'record') {
    throw new Error(`expected a record for ${what}, got core-value kind '${core.kind}'`);
  }
  const map = new Map<string, DataValue>();
  for (const field of core.fields) {
    map.set(field.name, field.value.value);
  }
  return map;
}

/** The elements of `dv`'s core-value, which must be an array. */
function arrayElements(dv: DataValue, what: string): readonly ScopedValue[] {
  const core = dv.coreValue;
  if (core.kind !== 'array') {
    throw new Error(`expected an array for ${what}, got core-value kind '${core.kind}'`);
  }
  return core.elements;
}

/** `dv`'s decoded token text — quoted or unquoted, form is not distinguished here. */
function tokenText(dv: DataValue, what: string): string {
  const core = dv.coreValue;
  if (core.kind !== 'token') {
    throw new Error(`expected a token for ${what}, got core-value kind '${core.kind}'`);
  }
  return core.text;
}

/** Whether `dv`'s core-value is the absent sentinel `_`. */
function isAbsent(dv: DataValue): boolean {
  return dv.coreValue.kind === 'absent';
}

function requireField(fields: Map<string, DataValue>, name: string, context: string): DataValue {
  const dv = fields.get(name);
  if (dv === undefined) {
    throw new Error(`${context}: missing required field '${name}'`);
  }
  return dv;
}

function requiredText(fields: Map<string, DataValue>, name: string, context: string): string {
  return tokenText(requireField(fields, name, context), `${context}.${name}`);
}

/** `fields.get(name)`'s token text, or `undefined` when the field is missing or `_`. */
function optionalText(fields: Map<string, DataValue>, name: string): string | undefined {
  const dv = fields.get(name);
  if (dv === undefined || isAbsent(dv)) return undefined;
  return tokenText(dv, name);
}

function boolText(dv: DataValue, what: string): boolean {
  const t = tokenText(dv, what);
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw new Error(`expected the bare token 'true' or 'false' for ${what}, got '${t}'`);
}

/**
 * A REQUIRED field group (§5.11): exactly one of `candidates` is present among `fields`, and its
 * name *is* the thing the group states (an outcome, a core-value kind, a base-value kind, …).
 * Every group in these five schemas reduces through this one function.
 */
function soleMember(
  fields: Map<string, DataValue>,
  candidates: readonly string[],
  context: string,
): { readonly name: string; readonly value: DataValue } {
  const present = candidates.filter((name) => fields.has(name));
  const [name] = present;
  if (name === undefined || present.length !== 1) {
    throw new Error(
      `${context}: expected exactly one of (${candidates.join(', ')}), found ` +
        (present.length === 0 ? 'none' : present.join(', ')),
    );
  }
  const value = fields.get(name);
  if (value === undefined) {
    throw new Error(`${context}: internal error -- '${name}' reported present but not found`);
  }
  return { name, value };
}

const CATEGORIES: readonly Category[] = ['lexer', 'parser', 'resolver', 'validation'];

function toCategory(text: string, context: string): Category {
  if ((CATEGORIES as readonly string[]).includes(text)) {
    return text as Category;
  }
  throw new Error(
    `${context}: unknown §8.1 category '${text}', expected one of (${CATEGORIES.join(', ')})`,
  );
}

/** Parses `raw` with the real Tier 3 parser and returns its root record's fields. */
function parseSidecarBody(raw: Uint8Array): Map<string, DataValue> {
  const { document } = runSync(parseDocument(fromBytes(raw)));
  return recordFields(document.root, 'sidecar body');
}

function toCommonFields(fields: Map<string, DataValue>): CommonSidecarFields {
  const spec = requiredText(fields, 'spec', 'sidecar');
  const description = requiredText(fields, 'description', 'sidecar');
  const encoding = optionalText(fields, 'encoding') as Encoding | undefined;
  const meta = optionalText(fields, 'meta');
  const importField = fields.get('import');
  const importNames =
    importField === undefined
      ? undefined
      : arrayElements(importField, 'import').map((el) => tokenText(el.value, 'import entry'));
  return {
    spec,
    description,
    ...(encoding !== undefined ? { encoding } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(importNames !== undefined ? { import: importNames } : {}),
  };
}

// ── Parser-layer: ExpectedDocument ───────────────────────────────────────────────────────────

const CORE_VALUE_KINDS = ['token', 'record', 'map', 'array', 'absent', 'empty-brace'] as const;

function toExpectedToken(dv: DataValue): ExpectedToken {
  const fields = recordFields(dv, 'lexer token');
  return {
    kind: requiredText(fields, 'kind', 'lexer token') as ExpectedToken['kind'],
    text: requiredText(fields, 'text', 'lexer token'),
  };
}

function toExpectedDocument(dv: DataValue): ExpectedDocument {
  const fields = recordFields(dv, 'document');
  const id = optionalText(fields, 'id');
  const schema = optionalText(fields, 'schema');
  const root = toExpectedDataValue(requireField(fields, 'root', 'document'));
  return {
    ...(id !== undefined ? { id } : {}),
    ...(schema !== undefined ? { schema } : {}),
    root,
  };
}

function toExpectedDataValue(dv: DataValue): ExpectedDataValue {
  const fields = recordFields(dv, 'data-value');
  const annotations = arrayElements(
    requireField(fields, 'annotations', 'data-value'),
    'annotations',
  ).map((el) => toExpectedAnnotation(el.value));
  const typeRef = optionalText(fields, 'type-ref');
  const core = toExpectedCoreValue(requireField(fields, 'core', 'data-value'));
  return {
    annotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
    core,
  };
}

function toExpectedAnnotation(dv: DataValue): ExpectedAnnotation {
  const fields = recordFields(dv, 'annotation');
  const name = requiredText(fields, 'name', 'annotation');
  const valueField = requireField(fields, 'value', 'annotation');
  const value = isAbsent(valueField) ? undefined : toExpectedDataValue(valueField);
  return {
    name,
    ...(value !== undefined ? { value } : {}),
  };
}

function toExpectedScopedValue(dv: DataValue): ExpectedScopedValue {
  const fields = recordFields(dv, 'scoped-value');
  const schemaRef = optionalText(fields, 'schema-ref');
  const value = toExpectedDataValue(requireField(fields, 'value', 'scoped-value'));
  return {
    ...(schemaRef !== undefined ? { schemaRef } : {}),
    value,
  };
}

function toExpectedRecordField(dv: DataValue): ExpectedRecordField {
  const fields = recordFields(dv, 'record field');
  return {
    name: requiredText(fields, 'name', 'record field'),
    value: toExpectedScopedValue(requireField(fields, 'value', 'record field')),
  };
}

function toExpectedMapEntry(dv: DataValue): ExpectedMapEntry {
  const fields = recordFields(dv, 'map entry');
  return {
    key: toExpectedDataValue(requireField(fields, 'key', 'map entry')),
    value: toExpectedScopedValue(requireField(fields, 'value', 'map entry')),
  };
}

/**
 * `dv` is a `core_value` field group: a record carrying exactly one member named `token`,
 * `record`, `map`, `array`, `absent` or `empty-brace` (`parser-sidecar.tn`'s own `core_value`).
 */
function toExpectedCoreValue(dv: DataValue): ExpectedCoreValue {
  const fields = recordFields(dv, 'core-value');
  const { name: kind, value: payload } = soleMember(fields, CORE_VALUE_KINDS, 'core-value');
  switch (kind) {
    case 'token': {
      const payloadFields = recordFields(payload, 'core-value.token');
      return {
        kind: 'token',
        form: requiredText(payloadFields, 'form', 'core-value.token') as TokenForm,
        text: requiredText(payloadFields, 'text', 'core-value.token'),
      };
    }
    case 'absent':
      return { kind: 'absent' };
    case 'empty-brace':
      return { kind: 'empty-brace' };
    case 'record': {
      const payloadFields = recordFields(payload, 'core-value.record');
      return {
        kind: 'record',
        fields: arrayElements(
          requireField(payloadFields, 'fields', 'core-value.record'),
          'fields',
        ).map((el) => toExpectedRecordField(el.value)),
      };
    }
    case 'map': {
      const payloadFields = recordFields(payload, 'core-value.map');
      return {
        kind: 'map',
        entries: arrayElements(
          requireField(payloadFields, 'entries', 'core-value.map'),
          'entries',
        ).map((el) => toExpectedMapEntry(el.value)),
      };
    }
    case 'array': {
      const payloadFields = recordFields(payload, 'core-value.array');
      return {
        kind: 'array',
        elements: arrayElements(
          requireField(payloadFields, 'elements', 'core-value.array'),
          'elements',
        ).map((el) => toExpectedScopedValue(el.value)),
      };
    }
    default:
      throw new Error(`unknown core-value kind '${kind}'`);
  }
}

// ── Resolver-layer: ExpectedBaseValue ────────────────────────────────────────────────────────

const BASE_VALUE_KINDS = ['null', 'boolean', 'string', 'number'] as const;
const NUMBER_FORM_SHAPES = ['integer', 'based-integer', 'float', 'special-value'] as const;

/** `dv` is a `base_value` field group (`resolver-sidecar.tn`). */
function toExpectedBaseValue(dv: DataValue): ExpectedBaseValue {
  const fields = recordFields(dv, 'base-value');
  const { name: kind, value: payload } = soleMember(fields, BASE_VALUE_KINDS, 'base-value');
  switch (kind) {
    case 'null':
      return { kind: 'null' };
    case 'boolean':
      return { kind: 'boolean', value: boolText(payload, 'base-value.boolean') };
    case 'string': {
      const payloadFields = recordFields(payload, 'base-value.string');
      return { kind: 'string', text: requiredText(payloadFields, 'text', 'base-value.string') };
    }
    case 'number':
      return { kind: 'number', form: toExpectedNumberForm(payload) };
    default:
      throw new Error(`unknown base-value kind '${kind}'`);
  }
}

/** `dv` is a `number_form` field group (`resolver-sidecar.tn`). */
function toExpectedNumberForm(dv: DataValue): ExpectedNumberForm {
  const fields = recordFields(dv, 'number-form');
  const { name: shape, value: payload } = soleMember(fields, NUMBER_FORM_SHAPES, 'number-form');
  const payloadFields = recordFields(payload, `number-form.${shape}`);
  const sign = optionalText(payloadFields, 'sign') as NumberSign | undefined;
  switch (shape) {
    case 'integer':
      return {
        shape: 'integer',
        ...(sign !== undefined ? { sign } : {}),
        digits: requiredText(payloadFields, 'digits', 'number-form.integer'),
      };
    case 'based-integer':
      return {
        shape: 'based-integer',
        ...(sign !== undefined ? { sign } : {}),
        radix: requiredText(
          payloadFields,
          'radix',
          'number-form.based-integer',
        ) as BasedIntegerRadix,
        digits: requiredText(payloadFields, 'digits', 'number-form.based-integer'),
      };
    case 'float': {
      const integerPart = optionalText(payloadFields, 'integer-part');
      const fractionDigits = optionalText(payloadFields, 'fraction-digits');
      const exponentField = payloadFields.get('exponent');
      const exponent =
        exponentField === undefined || isAbsent(exponentField)
          ? undefined
          : toExponent(exponentField);
      return {
        shape: 'float',
        ...(sign !== undefined ? { sign } : {}),
        ...(integerPart !== undefined ? { integerPart } : {}),
        ...(fractionDigits !== undefined ? { fractionDigits } : {}),
        ...(exponent !== undefined ? { exponent } : {}),
      };
    }
    case 'special-value':
      return {
        shape: 'special-value',
        ...(sign !== undefined ? { sign } : {}),
        kind: requiredText(payloadFields, 'kind', 'number-form.special-value') as
          'nan' | 'infinity',
      };
    default:
      throw new Error(`unknown number-form shape '${shape}'`);
  }
}

function toExponent(dv: DataValue): { readonly sign?: NumberSign; readonly digits: string } {
  const fields = recordFields(dv, 'exponent');
  const sign = optionalText(fields, 'sign') as NumberSign | undefined;
  return {
    ...(sign !== undefined ? { sign } : {}),
    digits: requiredText(fields, 'digits', 'exponent'),
  };
}

// ── Vocabulary-layer: ExpectedVocabularyValue ────────────────────────────────────────────────

const ATOM_VALUE_KINDS = ['decimal', 'hex', 'rational', 'text', 'complex', 'duration'] as const;

/** `dv` is an `atom_value` field group (`vocabulary-sidecar.tn`). */
function toExpectedVocabularyValue(dv: DataValue): ExpectedVocabularyValue {
  const fields = recordFields(dv, 'vocabulary value');
  const { name: kind, value: payload } = soleMember(fields, ATOM_VALUE_KINDS, 'vocabulary value');
  switch (kind) {
    case 'decimal':
    case 'hex':
    case 'rational':
    case 'text':
      return tokenText(payload, `vocabulary value.${kind}`);
    case 'complex': {
      const payloadFields = recordFields(payload, 'vocabulary value.complex');
      return {
        real: requiredText(payloadFields, 'real', 'vocabulary value.complex'),
        imaginary: requiredText(payloadFields, 'imaginary', 'vocabulary value.complex'),
      };
    }
    case 'duration': {
      const payloadFields = recordFields(payload, 'vocabulary value.duration');
      return {
        period: requiredText(payloadFields, 'period', 'vocabulary value.duration'),
        clock: requiredText(payloadFields, 'clock', 'vocabulary value.duration'),
      };
    }
    default:
      throw new Error(`unknown vocabulary value kind '${kind}'`);
  }
}

// ── Reader-layer: ExpectedReaderValue ────────────────────────────────────────────────────────

const READER_VALUE_KINDS = ['record', 'map', 'array', 'atom', 'absent'] as const;
const READER_ATOM_KINDS = ['boolean', 'string', 'number'] as const;

function toExpectedReaderField(dv: DataValue): ExpectedReaderField {
  const fields = recordFields(dv, 'reader field');
  return {
    name: requiredText(fields, 'name', 'reader field'),
    value: toExpectedReaderValue(requireField(fields, 'value', 'reader field')),
  };
}

function toExpectedReaderEntry(dv: DataValue): ExpectedReaderEntry {
  const fields = recordFields(dv, 'reader entry');
  return {
    key: toExpectedReaderValue(requireField(fields, 'key', 'reader entry')),
    value: toExpectedReaderValue(requireField(fields, 'value', 'reader entry')),
  };
}

function toExpectedReaderAtom(dv: DataValue): ExpectedReaderAtom {
  const fields = recordFields(dv, 'reader atom');
  const { name: kind, value: payload } = soleMember(fields, READER_ATOM_KINDS, 'reader atom');
  switch (kind) {
    case 'boolean':
      return { kind: 'boolean', value: boolText(payload, 'reader atom.boolean') };
    case 'string':
      return { kind: 'string', text: tokenText(payload, 'reader atom.string') };
    case 'number':
      return { kind: 'number', text: tokenText(payload, 'reader atom.number') };
    default:
      throw new Error(`unknown reader atom kind '${kind}'`);
  }
}

/** `dv` is a `reader_value` field group (`reader-sidecar.tn`). */
function toExpectedReaderValue(dv: DataValue): ExpectedReaderValue {
  const fields = recordFields(dv, 'reader value');
  const { name: kind, value: payload } = soleMember(fields, READER_VALUE_KINDS, 'reader value');
  switch (kind) {
    case 'record': {
      const payloadFields = recordFields(payload, 'reader value.record');
      return {
        kind: 'record',
        fields: arrayElements(
          requireField(payloadFields, 'fields', 'reader value.record'),
          'fields',
        ).map((el) => toExpectedReaderField(el.value)),
      };
    }
    case 'map': {
      const payloadFields = recordFields(payload, 'reader value.map');
      return {
        kind: 'map',
        entries: arrayElements(
          requireField(payloadFields, 'entries', 'reader value.map'),
          'entries',
        ).map((el) => toExpectedReaderEntry(el.value)),
      };
    }
    case 'array': {
      const payloadFields = recordFields(payload, 'reader value.array');
      return {
        kind: 'array',
        elements: arrayElements(
          requireField(payloadFields, 'elements', 'reader value.array'),
          'elements',
        ).map((el) => toExpectedReaderValue(el.value)),
      };
    }
    case 'atom':
      return { kind: 'atom', atom: toExpectedReaderAtom(payload) };
    case 'absent':
      return { kind: 'absent' };
    default:
      throw new Error(`unknown reader value kind '${kind}'`);
  }
}

// ── Public per-layer parse functions ─────────────────────────────────────────────────────────

const OUTCOME_KINDS = ['valid', 'error', 'schema-document'] as const;

/**
 * A sidecar record's outcome group, reduced generically: the present member's name plus its
 * payload {@link DataValue}. Every per-layer parser below calls this once, then reads whatever
 * fields *that layer's* payload shape carries.
 */
function outcomeMember<O extends Outcome>(
  fields: Map<string, DataValue>,
  candidates: readonly O[],
): { readonly outcome: O; readonly payload: DataValue } {
  const { name, value } = soleMember(fields, candidates, 'sidecar outcome');
  return { outcome: name as O, payload: value };
}

/** Parses a lexer-layer sidecar (`schemas/lexer-sidecar.tn`). */
export function parseLexerSidecar(raw: Uint8Array): LexerSidecar {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  const { outcome, payload } = outcomeMember(fields, ['valid', 'error']);
  if (outcome === 'error') {
    const payloadFields = recordFields(payload, 'lexer sidecar.error');
    return {
      ...common,
      outcome,
      category: toCategory(
        requiredText(payloadFields, 'category', 'lexer sidecar.error'),
        'lexer sidecar.error',
      ),
    };
  }
  const payloadFields = recordFields(payload, 'lexer sidecar.valid');
  const tokens = arrayElements(
    requireField(payloadFields, 'tokens', 'lexer sidecar.valid'),
    'tokens',
  ).map((el) => toExpectedToken(el.value));
  return { ...common, outcome, tokens };
}

/** Parses a parser-layer sidecar (`schemas/parser-sidecar.tn`). */
export function parseParserSidecar(raw: Uint8Array): ParserSidecar {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  const { outcome, payload } = outcomeMember(fields, ['valid', 'error', 'schema-document']);
  if (outcome === 'schema-document') {
    return { ...common, outcome };
  }
  if (outcome === 'error') {
    const payloadFields = recordFields(payload, 'parser sidecar.error');
    return {
      ...common,
      outcome,
      category: toCategory(
        requiredText(payloadFields, 'category', 'parser sidecar.error'),
        'parser sidecar.error',
      ),
    };
  }
  const payloadFields = recordFields(payload, 'parser sidecar.valid');
  const document = toExpectedDocument(
    requireField(payloadFields, 'document', 'parser sidecar.valid'),
  );
  return { ...common, outcome, document };
}

/** Parses a resolver-layer sidecar (`schemas/resolver-sidecar.tn`). No `error` outcome exists. */
export function parseResolverSidecar(raw: Uint8Array): ResolverSidecar {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  // §4 never rejects a token: `valid` is a plain REQUIRED field here, not a group.
  const validField = requireField(fields, 'valid', 'resolver sidecar');
  const payloadFields = recordFields(validField, 'resolver sidecar.valid');
  const baseValue = toExpectedBaseValue(
    requireField(payloadFields, 'base-value', 'resolver sidecar.valid'),
  );
  return { ...common, outcome: 'valid', baseValue };
}

/** Parses a vocabulary-layer sidecar (`schemas/vocabulary-sidecar.tn`). */
export function parseVocabularySidecar(raw: Uint8Array): VocabularySidecar {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  const typeRef = requiredText(fields, 'type-ref', 'vocabulary sidecar');
  const { outcome, payload } = outcomeMember(fields, ['valid', 'error']);
  if (outcome === 'error') {
    const payloadFields = recordFields(payload, 'vocabulary sidecar.error');
    return {
      ...common,
      outcome,
      typeRef,
      category: toCategory(
        requiredText(payloadFields, 'category', 'vocabulary sidecar.error'),
        'vocabulary sidecar.error',
      ),
    };
  }
  const payloadFields = recordFields(payload, 'vocabulary sidecar.valid');
  const value = toExpectedVocabularyValue(
    requireField(payloadFields, 'value', 'vocabulary sidecar.valid'),
  );
  return { ...common, outcome, typeRef, value };
}

/** Parses a reader-layer sidecar (`schemas/reader-sidecar.tn`). */
export function parseReaderSidecar(raw: Uint8Array): ReaderSidecar {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  const { outcome, payload } = outcomeMember(fields, ['valid', 'error']);
  if (outcome === 'error') {
    const payloadFields = recordFields(payload, 'reader sidecar.error');
    return {
      ...common,
      outcome,
      category: toCategory(
        requiredText(payloadFields, 'category', 'reader sidecar.error'),
        'reader sidecar.error',
      ),
    };
  }
  const payloadFields = recordFields(payload, 'reader sidecar.valid');
  const value = toExpectedReaderValue(requireField(payloadFields, 'value', 'reader sidecar.valid'));
  return { ...common, outcome, value };
}

// ── Cross-layer summary (used by discovery and the write/ round-trip harness) ───────────────

/** The handful of common facts a caller needs before it knows (or cares) which layer a sidecar belongs to. */
export interface SidecarSummary {
  readonly outcome: Outcome;
  readonly encoding?: Encoding;
  readonly meta?: string;
  readonly import?: readonly string[];
}

/**
 * Reads just {@link SidecarSummary} — the outcome and the two common fields a caller filters on
 * before dispatching to a layer-specific parser, or (`write-conformance-roundtrip.test.ts`)
 * without ever needing to know the layer at all. Still a real parse of the whole sidecar (rule 2
 * applies here too); it just doesn't reduce the layer-specific payload.
 *
 * Presence, not group membership, decides the outcome: at every layer but the resolver's,
 * `valid`/`error`/`schema-document` is a REQUIRED field group and exactly one is present; at the
 * resolver layer `valid` is a plain REQUIRED field (`parseResolverSidecar`'s own note) and the
 * other two never occur at all. A direct presence check is correct either way.
 */
export function peekSidecarSummary(raw: Uint8Array): SidecarSummary {
  const fields = parseSidecarBody(raw);
  const common = toCommonFields(fields);
  const present = OUTCOME_KINDS.filter((name) => fields.has(name));
  const [outcome] = present;
  if (outcome === undefined || present.length !== 1) {
    throw new Error(
      `sidecar outcome: expected exactly one of (${OUTCOME_KINDS.join(', ')}), found ` +
        (present.length === 0 ? 'none' : present.join(', ')),
    );
  }
  return {
    outcome,
    ...(common.encoding !== undefined ? { encoding: common.encoding } : {}),
    ...(common.meta !== undefined ? { meta: common.meta } : {}),
    ...(common.import !== undefined ? { import: common.import } : {}),
  };
}
