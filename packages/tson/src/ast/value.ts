import type { TokenForm } from '../lexer/token.js';

/**
 * `document = [id-directive] ws data-doc`, `data-doc = [schema-directive ws] data-value ws`
 * (§2.2, §7.4).
 *
 * `id` and `schema` are the header directives' raw URI arguments, uninterpreted. `root` is the
 * document's single value — itself an ordinary data value that may carry its own annotations
 * and type reference, but never a directive (§2.2: "Header directives are properties of the
 * document, not of the body's root value").
 *
 * Only data documents are representable here. A document whose header contains `!!meta` is a
 * *schema* document (§1.5, §2.2), which this type does not represent.
 */
export interface Document {
  readonly id?: string;
  readonly schema?: string;
  readonly root: DataValue;
}

/**
 * `data-value = *annotation [type-ref] core-value` (§2.3, §7.4) — zero or more annotations, an
 * optional type reference, and a core value. Occurs everywhere a value does: as the document
 * root, as a map key, and as the payload of a {@link ScopedValue}.
 *
 * `typeRef` is preserved verbatim, uninterpreted: resolving it against the built-in type
 * vocabulary or a declared schema is a later layer's job. A Class 1 processor "MUST preserve
 * type annotations it does not resolve" (§3.2).
 */
export interface DataValue {
  readonly annotations: readonly Annotation[];
  readonly typeRef?: string;
  readonly coreValue: CoreValue;
}

/**
 * `core-value = record / map / array / empty-brace / absent / token` (§2.3, §7.4).
 *
 * Structural only: no base type resolution (§4) happens at this layer, and none of the built-in
 * type vocabulary (§5) is interpreted — a {@link TokenValue} preserves a token's exact text and
 * form, deferring interpretation to a later layer (§1.2 principle 1: "Value interpretation is
 * deferred to base type resolution").
 *
 * The `kind` discriminant values (`record`, `map`, `array`, `empty-brace`, `absent`, `token`) are
 * the exact strings the conformance test suite's parser-layer vectors use for a core-value's own
 * `kind:` field.
 */
export type CoreValue = RecordValue | MapValue | ArrayValue | EmptyBrace | AbsentValue | TokenValue;

/**
 * `record = "{" ws field *( separator field ) ws "}"` (§2.5, §7.4).
 *
 * Field order is preserved and duplicates are *not* deduplicated here: "last value wins" for
 * duplicate field names is a resolver-layer rule (§2.5), and field-name identity
 * (NFC-normalized comparison) is likewise resolver-layer (§7.2.1). This is the structural layer
 * only — it faithfully preserves every field as written.
 */
export interface RecordValue {
  readonly kind: 'record';
  readonly fields: readonly RecordField[];
}

/** `field = field-name ws ":" ws scoped-value` (§2.5). `name` is the field-name token's decoded text. */
export interface RecordField {
  readonly name: string;
  readonly value: ScopedValue;
}

/**
 * `map = "{" ws map-entry *( separator map-entry ) ws "}"` (§2.6, §7.4).
 *
 * Entry order is preserved and duplicate keys are *not* deduplicated or even detected here:
 * "last value wins" and duplicate-key warnings are resolver-layer concerns (§2.6), and textual
 * key identity comparison requires NFC normalization this layer doesn't do.
 */
export interface MapValue {
  readonly kind: 'map';
  readonly entries: readonly MapEntry[];
}

/** `map-entry = data-value ws "=>" ws scoped-value` (§2.6). The key is a full data value, not just a token. */
export interface MapEntry {
  readonly key: DataValue;
  readonly value: ScopedValue;
}

/**
 * `array = "[" ws [ scoped-value *( separator scoped-value ) ] ws "]"` (§2.7, §7.4).
 *
 * Unlike `{}`, `[]` is unambiguously an empty array directly from the grammar (the whole element
 * sequence is optional) — no brace-disambiguation step is needed (§2.8 applies only to `{}`).
 */
export interface ArrayValue {
  readonly kind: 'array';
  readonly elements: readonly ScopedValue[];
}

/**
 * `empty-brace = "{" ws "}"` (§2.8).
 *
 * Deliberately its own {@link CoreValue} case, not resolved to an empty {@link RecordValue} or
 * {@link MapValue} here: the spec defers that choice to the resolver ("In the absence of
 * declared type information, an empty-brace resolves to an empty record. When a higher part
 * supplies an expected type, it resolves to the empty container of that type", §2.8) — a layer
 * this structural type doesn't have yet.
 */
export interface EmptyBrace {
  readonly kind: 'empty-brace';
}

/**
 * `absent = "_"` (§2.9): the explicitly-absent sentinel, distinct from any typed value including
 * base-type null.
 *
 * The spec forbids `_` in map-key position, but as a *resolver-layer* rule, not a grammar one
 * ("the map-entry production accepts any value in key position, and the resolver rejects absent
 * keys", §2.9). This structural type deliberately does not reject it here.
 */
export interface AbsentValue {
  readonly kind: 'absent';
}

/**
 * A leaf `token` core-value (§2.4, §7.4): `text` is the token's decoded content
 * (escape-processed, and whitespace-stripped for multi-line tokens), unresolved and
 * uninterpreted. `form` records which of the three token kinds produced it.
 */
export interface TokenValue {
  readonly kind: 'token';
  readonly text: string;
  readonly form: TokenForm;
}

/**
 * `annotation = "@" unquoted-token [ ":" data-value ]` (§3.1, §7.4).
 *
 * Preserved as ordered, uninterpreted metadata — a Class 1 processor "MUST preserve annotations
 * without validating them" (§3.1); interpretation is a schema-layer concern.
 */
export interface Annotation {
  readonly name: string;
  readonly value?: DataValue;
}

/**
 * `scoped-value = [ schema-directive ws ] data-value` (§2.3, §7.4): an optional
 * `!!schema:"..."` directive followed by a data value. Occurs in exactly three positions —
 * record field values, map entry values, and array elements.
 *
 * `schemaRef` is the directive's URI argument, preserved uninterpreted — a Class 1 processor
 * "does not act on `schema` bindings — it preserves them for the consuming application" (§3.3).
 */
export interface ScopedValue {
  readonly schemaRef?: string;
  readonly value: DataValue;
}
