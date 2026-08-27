import { TsonNotImplementedError } from '../../packages/tson/src/core/errors.js';

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
 * **This is the one seam in the conformance harness that dogfoods our own parser, and our
 * own parser does not exist yet.** The suite's README requires an implementation to parse
 * its sidecars with its own lexer/parser rather than a shortcut — a sidecar is itself TSON,
 * deliberately, to exercise the very thing under test. Until Part 1 (the lexer, structural
 * parser, and base type resolver) lands, this function throws {@link TsonNotImplementedError}
 * unconditionally, which is why every conformance vector currently reports as failing rather
 * than skipped.
 *
 * This seam is replaced by a real call into the Part 1 parser as that work package lands.
 * **Do not reimplement sidecar parsing independently here** (e.g. with a hand-rolled regex or
 * ad hoc scanner) — that would be exactly the second, divergent parser the suite's own README
 * warns dogfooding is meant to avoid.
 */
export function parseSidecar(_raw: Uint8Array): Sidecar {
  throw new TsonNotImplementedError(
    'sidecar parsing requires the real TSON lexer/parser (Part 1), which is not implemented yet',
  );
}
