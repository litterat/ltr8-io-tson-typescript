import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import type { DataValue, ScopedValue } from '../../packages/tson/src/ast/value.js';

/** The suite's four §8.1 error categories, asserted on an `outcome: error` vector. */
export type Category = 'lexer' | 'parser' | 'resolver' | 'validation';

/** A sidecar's `outcome` field. `schema-document` is parser-layer only. */
export type Outcome = 'valid' | 'error' | 'schema-document';

/**
 * A vector's declared non-UTF-8 encoding. Absent means UTF-8. Only `invalid-utf8` is fed to
 * an implementation and expected to fail there; `utf-16`/`utf-32` are skipped (§9.1 permits
 * them, but nothing here reads them).
 */
export type Encoding = 'invalid-utf8' | 'utf-16' | 'utf-32';

/** One expected lexer token (lexer-layer `valid` vectors). */
export interface ExpectedToken {
  /** The spec's own token-stream grammar vocabulary (§7.3), not an implementation type name. */
  readonly kind:
    | 'single-line-token'
    | 'multi-line-token'
    | 'unquoted-token'
    | 'structural-delimiter'
    | 'absent-token'
    | 'map-arrow-token'
    | 'directive-token'
    | 'range-token'
    | 'special-token';
  /** The token's decoded text. */
  readonly text: string;
}

/** A token's quoting form (parser-layer `core: { kind: token, ... }`). */
export type TokenForm = 'unquoted' | 'single-line' | 'multi-line';

/** An expected annotation on an expected data-value (parser layer). */
export interface ExpectedAnnotation {
  readonly name: string;
  /** Absent (`_`) for a valueless annotation. */
  readonly value?: ExpectedDataValue;
}

/** An expected core-value (parser layer), discriminated by `kind` per §7.4. */
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

/** `+`/`-`, as captured on a resolved number's sign (resolver layer). */
export type NumberSign = 'plus' | 'minus';

/** A based-integer's radix (resolver layer). */
export type BasedIntegerRadix = 'hex' | 'octal' | 'binary';

/**
 * Which of the number grammar's four forms a token matched, and its components (§7.6).
 * Identification only — no bound host numeric type.
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

/** The expected result of base type resolution (§4) on a resolver-layer vector's bare token. */
export type ExpectedBaseValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number'; readonly form: ExpectedNumberForm };

/**
 * A vocabulary-layer `value`. Host-representation-neutral per the suite README:
 *
 * - Most families: a plain decimal string, compared as arbitrary-precision decimal.
 * - `rational`: a `"numerator/denominator"` string.
 * - `complex`: `{ real, imaginary }`, each an exact decimal string.
 * - The binary family (`base64`/`base64url`/`base32`/`hex`) and `ipv6`: a plain hex string
 *   of the decoded/raw bytes.
 * - `duration`: `{ period, clock }`, each an independently-parseable ISO 8601 substring.
 * - Everything else host-value-as-text (`text`, `uri`, `ipv4`, `cidr4`/`cidr6`, `mac`, `email`,
 *   the temporal family, `uuid`): the plain string itself.
 */
export type ExpectedVocabularyValue =
  | string
  | { readonly real: string; readonly imaginary: string }
  | { readonly period: string; readonly clock: string };

/**
 * A parsed conformance-vector sidecar: the common fields every layer shares, plus the
 * per-layer payload fields, present only for the layer that vector belongs to.
 *
 * See the test-suite README ("The sidecar format") for the full field-by-field contract this
 * type transcribes.
 */
export interface Sidecar {
  /** The spec section this vector targets, e.g. `"§7.2.2"`. Metadata only, not load-bearing. */
  readonly spec: string;
  /** One line: what this vector exercises and why. */
  readonly description: string;
  readonly outcome: Outcome;
  /** Present iff `outcome === 'error'`. One of the spec's four §8.1 categories. */
  readonly category?: Category;
  /** Present only when the subject is not plain UTF-8. */
  readonly encoding?: Encoding;
  /** A short bundled-schema name (see `bundled-ids.ts`) for the subject's own `!!meta` target. */
  readonly meta?: string;
  /** Short bundled-schema names for the subject's own `!!import` entries, in order. */
  readonly import?: readonly string[];

  /** Lexer layer, `valid` vectors: the expected token stream, EOF excluded. */
  readonly tokens?: readonly ExpectedToken[];
  /** Parser layer, `valid` vectors: the expected parse tree. */
  readonly document?: ExpectedDocument;
  /** Resolver layer, `valid` vectors: the expected base-type-resolution result. */
  readonly baseValue?: ExpectedBaseValue;
  /** Vocabulary layer: the annotation name selecting the built-in atom under test. */
  readonly typeRef?: string;
  /** Vocabulary layer, `valid` vectors: the atom's accepted value. See {@link ExpectedVocabularyValue}. */
  readonly value?: ExpectedVocabularyValue;
}

/**
 * Parses a sidecar's raw bytes into a typed {@link Sidecar}.
 *
 * **This is the one seam in the conformance harness that dogfoods our own parser** — the
 * suite's README requires an implementation to parse its sidecars with its own lexer/parser
 * rather than a shortcut, since a sidecar is itself TSON, deliberately, to exercise the very
 * thing under test. This runs the real Tier 3 parser ({@link parseDocument}) over `raw` and
 * then *reduces* the resulting generic {@link DataValue} tree into a typed {@link Sidecar} by
 * looking up each expected field by name — the sidecar's own record field names (`type-ref`,
 * `base-value`, `schema-ref`, …) are exactly this module's field names, kebab-cased. This is
 * reduction, not a second parser: no TSON syntax (tokens, escapes, brace disambiguation) is
 * reinterpreted here, only the meaning of a tree the real parser already built.
 *
 * A sidecar the real parser cannot read at all (malformed TSON) throws from
 * {@link parseDocument} itself, surfacing as a genuine parser failure rather than a silently
 * wrong `Sidecar`. A sidecar that parses but does not match the expected sidecar shape
 * (missing field, wrong core-value kind) throws a descriptive `Error` from the helpers below.
 */
export function parseSidecar(raw: Uint8Array): Sidecar {
  const { document } = runSync(parseDocument(fromBytes(raw)));
  const fields = recordFields(document.root, 'sidecar body');

  const spec = requiredText(fields, 'spec', 'sidecar');
  const description = requiredText(fields, 'description', 'sidecar');
  const outcome = requiredText(fields, 'outcome', 'sidecar') as Outcome;
  const category = optionalText(fields, 'category') as Category | undefined;
  const encoding = optionalText(fields, 'encoding') as Encoding | undefined;
  const meta = optionalText(fields, 'meta');

  const importField = fields.get('import');
  const importNames =
    importField === undefined
      ? undefined
      : arrayElements(importField, 'import').map((el) => tokenText(el.value, 'import entry'));

  const tokensField = fields.get('tokens');
  const tokens =
    tokensField === undefined
      ? undefined
      : arrayElements(tokensField, 'tokens').map((el) => toExpectedToken(el.value));

  const documentField = fields.get('document');
  const expectedDocument =
    documentField === undefined ? undefined : toExpectedDocument(documentField);

  const baseValueField = fields.get('base-value');
  const baseValue = baseValueField === undefined ? undefined : toExpectedBaseValue(baseValueField);

  const typeRef = optionalText(fields, 'type-ref');

  const valueField = fields.get('value');
  const value = valueField === undefined ? undefined : toExpectedVocabularyValue(valueField);

  return {
    spec,
    description,
    outcome,
    ...(category !== undefined ? { category } : {}),
    ...(encoding !== undefined ? { encoding } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(importNames !== undefined ? { import: importNames } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(expectedDocument !== undefined ? { document: expectedDocument } : {}),
    ...(baseValue !== undefined ? { baseValue } : {}),
    ...(typeRef !== undefined ? { typeRef } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

// ── Reduction helpers: generic DataValue -> named field lookup ──────────────────────────────
//
// The sidecar body is itself an ordinary, untyped TSON record tree (Wave 2's schema binding
// for `schemas/*-sidecar.tn` doesn't exist yet, and isn't what this work package ports —
// per CLAUDE.md, dogfooding means running our own lexer/parser/structural-parser over the
// bytes, not schema-validating against them). These helpers walk that generic tree by field
// name to recover the meaning a sidecar author encoded in it.

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

// ── Parser-layer: ExpectedDocument ───────────────────────────────────────────────────────────

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

function toExpectedCoreValue(dv: DataValue): ExpectedCoreValue {
  const fields = recordFields(dv, 'core-value');
  const kind = requiredText(fields, 'kind', 'core-value');
  switch (kind) {
    case 'token':
      return {
        kind: 'token',
        form: requiredText(fields, 'form', 'core-value') as TokenForm,
        text: requiredText(fields, 'text', 'core-value'),
      };
    case 'absent':
      return { kind: 'absent' };
    case 'empty-brace':
      return { kind: 'empty-brace' };
    case 'record':
      return {
        kind: 'record',
        fields: arrayElements(requireField(fields, 'fields', 'core-value'), 'fields').map((el) =>
          toExpectedRecordField(el.value),
        ),
      };
    case 'map':
      return {
        kind: 'map',
        entries: arrayElements(requireField(fields, 'entries', 'core-value'), 'entries').map((el) =>
          toExpectedMapEntry(el.value),
        ),
      };
    case 'array':
      return {
        kind: 'array',
        elements: arrayElements(requireField(fields, 'elements', 'core-value'), 'elements').map(
          (el) => toExpectedScopedValue(el.value),
        ),
      };
    default:
      throw new Error(`unknown core-value kind '${kind}'`);
  }
}

// ── Resolver-layer: ExpectedBaseValue ────────────────────────────────────────────────────────

function toExpectedBaseValue(dv: DataValue): ExpectedBaseValue {
  const fields = recordFields(dv, 'base-value');
  const kind = requiredText(fields, 'kind', 'base-value');
  switch (kind) {
    case 'null':
      return { kind: 'null' };
    case 'boolean':
      return {
        kind: 'boolean',
        value: boolText(requireField(fields, 'value', 'base-value'), 'base-value.value'),
      };
    case 'string':
      return { kind: 'string', text: requiredText(fields, 'text', 'base-value') };
    case 'number':
      return {
        kind: 'number',
        form: toExpectedNumberForm(requireField(fields, 'form', 'base-value')),
      };
    default:
      throw new Error(`unknown base-value kind '${kind}'`);
  }
}

function toExpectedNumberForm(dv: DataValue): ExpectedNumberForm {
  const fields = recordFields(dv, 'number-form');
  const shape = requiredText(fields, 'shape', 'number-form');
  const sign = optionalText(fields, 'sign') as NumberSign | undefined;
  switch (shape) {
    case 'integer':
      return {
        shape: 'integer',
        ...(sign !== undefined ? { sign } : {}),
        digits: requiredText(fields, 'digits', 'number-form'),
      };
    case 'based-integer':
      return {
        shape: 'based-integer',
        ...(sign !== undefined ? { sign } : {}),
        radix: requiredText(fields, 'radix', 'number-form') as BasedIntegerRadix,
        digits: requiredText(fields, 'digits', 'number-form'),
      };
    case 'float': {
      const integerPart = optionalText(fields, 'integer-part');
      const fractionDigits = optionalText(fields, 'fraction-digits');
      const exponentField = fields.get('exponent');
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
        kind: requiredText(fields, 'kind', 'number-form') as 'nan' | 'infinity',
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

function toExpectedVocabularyValue(dv: DataValue): ExpectedVocabularyValue {
  const core = dv.coreValue;
  if (core.kind === 'token') {
    return core.text;
  }
  if (core.kind === 'record') {
    const fields = new Map<string, DataValue>();
    for (const field of core.fields) fields.set(field.name, field.value.value);
    if (fields.has('real') && fields.has('imaginary')) {
      return {
        real: requiredText(fields, 'real', 'vocabulary value'),
        imaginary: requiredText(fields, 'imaginary', 'vocabulary value'),
      };
    }
    if (fields.has('period') && fields.has('clock')) {
      return {
        period: requiredText(fields, 'period', 'vocabulary value'),
        clock: requiredText(fields, 'clock', 'vocabulary value'),
      };
    }
  }
  throw new Error(`unrecognized vocabulary value shape: core-value kind '${core.kind}'`);
}
