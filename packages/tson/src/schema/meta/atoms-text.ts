/**
 * The text-shaped atom families' resolved constraint vocabularies (§5.5, §5.7, §9): `text`,
 * `identifier`, `regex`, `uri`, `iri`, `email`, and `uuid`.
 */

/**
 * The form a text value is put into before any facet or comparison judges it (§5.5, §7.2.1): the
 * kernel's `normalization` enum, a facet of every text family. `NONE` leaves the token's text as
 * written; `NFC`, `NFKC` and `NFKC_CASEFOLD` are the Unicode normalization forms (UAX #15; the last
 * adds the NFKC case fold); `ASCII_CASEFOLD` folds A-Z only. No comparison goes below NFC.
 */
export type Normalization = 'NONE' | 'NFC' | 'NFKC' | 'NFKC_CASEFOLD' | 'ASCII_CASEFOLD';

/**
 * The Unicode property an identifier profile's Start or Continue set is drawn from (§7.7): the
 * kernel's `identifier_base`. `XID` is `XID_Start`/`XID_Continue`, `ID` is `ID_Start`/`ID_Continue`,
 * and `NONE` draws nothing, leaving the set to the profile's own additions.
 */
export type IdentifierBase = 'XID' | 'ID' | 'NONE';

/**
 * The meta-kernel's `text_type` constructor — the Unicode code point sequence type every
 * other text-shaped atom composes with (§5.5, §5.7).
 *
 * `pattern` is the regex's own source text, not a compiled pattern object: kept a pure,
 * hashable/equatable value like every other field here, and consistent with the kernel's
 * own modelling — `regex_type` composes with `text_type`, i.e. a `regex` value IS-A piece of
 * text, so the natural representation of a pattern constraint is text too. A reader
 * compiles it at validation time rather than storing a compiled form.
 *
 * `length` is an exact length — both a floor and a ceiling at once — alongside the ordinary
 * `minLength`/`maxLength` bounds. All three count Unicode code points, and are `bigint`
 * because the kernel's own `min_length`/`max_length`/`length` are typed `non_negative_integer`.
 *
 * `normalization` is the form a value is put into before the facets judge it (§5.5); it defaults
 * to `NONE` and is fixed where a text family is constructed (§5.7).
 *
 * Also an {@link Atom} variant: `text => !text_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every optional field absent.
 */
export interface TextType {
  readonly kind: 'text_type';
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly normalization: Normalization;
}

/**
 * The meta-kernel's `identifier_type` constructor (§5.5, §7.7): `text_type & atom_specification &
 * { ... }` — a UAX #31 identifier profile as data, with `text_type`'s facets applied inside it.
 *
 * The profile is built from `start` and `continue` (the Unicode property each set is drawn from)
 * and `startAdd`, `continueAdd`, `medial` and `exclude` (each the set of code points its text
 * holds). `normalization` defaults to `NFC` here: the profile judges the value, which is the text
 * put into that form. `spec` is pinned to UAX #31. The profile facets and `normalization` are fixed
 * where an identifier family is constructed (§5.7).
 *
 * Every field is flat, mirroring the resolved shape rather than the composition that produced it
 * (§5.8). `identifier => !identifier_type { continue_add: "-" }` is an instance whose resolved body
 * is `start: XID`, `continue: XID`, `continueAdd: "-"`, `normalization: NFC`.
 */
export interface IdentifierType {
  readonly kind: 'identifier_type';
  readonly spec: string;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly normalization: Normalization;
  readonly start: IdentifierBase;
  readonly continue: IdentifierBase;
  readonly startAdd?: string;
  readonly continueAdd?: string;
  readonly medial?: string;
  readonly exclude?: string;
}

/**
 * The meta-kernel's `regex_type` constructor (§5.7: `regex_type => text_type &
 * atom_specification & { normalization: = NONE  spec: = "https://www.rfc-editor.org/rfc/rfc9485" }`)
 * — `text_type`'s length and pattern facets plus `atom_specification`'s `spec`, pinned to RFC 9485,
 * the I-Regexp specification.
 *
 * **Every field is flat, mirroring the resolved shape rather than the composition that
 * produced it** — composition always flattens (§5.8), so an instance's wire record carries
 * `minLength`/`maxLength`/`length`/`pattern`/`spec` side by side, with no sub-record. `spec`
 * is a bare string, not a richer URI type, matching every other externally-cited-document
 * field in this package. `normalization` is fixed to `NONE`: putting a pattern into another
 * form changes what it matches.
 *
 * Also an {@link Atom} variant: `regex => !regex_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and every other
 * optional field absent.
 */
export interface RegexType {
  readonly kind: 'regex_type';
  readonly spec: string;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly normalization: Normalization;
}

/**
 * The meta's `uri_type` constructor (§5.5's `uri` atom): `text_type`'s length and pattern
 * facets, `atom_specification`'s `spec` pinned to RFC 3986, and its own `schemes`,
 * `allowRelative` and `allowFragment` facets.
 *
 * `schemes` is a set of scheme names, compared with ASCII case folded; `allowRelative` and
 * `allowFragment` default to `true` and narrow as permissions (§5.7). `normalization` is fixed to
 * `NONE`. Every field is flat, for the same reason {@link RegexType}'s are (§5.8).
 */
export interface UriType {
  readonly kind: 'uri_type';
  readonly spec: string;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly schemes?: readonly string[];
  readonly allowRelative: boolean;
  readonly allowFragment: boolean;
  readonly normalization: Normalization;
}

/**
 * The meta-kernel's `iri_type` constructor (§5.5): {@link UriType}'s facets with `spec` pinned to
 * RFC 3987, admitting characters beyond US-ASCII. The kernel's `iri => !iri_type { allow_relative:
 * false }` types `atom_specification.spec`; meta's `schema_identity` is a second instance.
 */
export interface IriType {
  readonly kind: 'iri_type';
  readonly spec: string;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly schemes?: readonly string[];
  readonly allowRelative: boolean;
  readonly allowFragment: boolean;
  readonly normalization: Normalization;
}

/**
 * meta.tn's `email_type` constructor (RFC 5322), composing `text_type`'s `minLength`/
 * `maxLength`/`length`/`pattern` — {@link RegexType}'s exact twin, declared by the identical
 * composition and differing only in which document `spec` is fixed to. `normalization` is fixed to
 * `NONE`.
 *
 * Also an {@link Atom} variant: `email => !email_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and every other
 * optional field absent.
 */
export interface EmailType {
  readonly kind: 'email_type';
  readonly spec: string;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
  readonly normalization: Normalization;
}

/**
 * The meta-kernel's `uuid_type` constructor (§5.5's `uuid` atom, RFC 9562). `version`
 * selects a generation scheme (a selector, not an ordered bound — version 7 is not
 * "narrower" than version 4, it is a different value set), and is `bigint` because the
 * kernel's own field is typed `non_negative_integer`.
 *
 * Also an {@link Atom} variant: `uuid => !uuid_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `version` absent.
 */
export interface UuidType {
  readonly kind: 'uuid_type';
  readonly version?: bigint;
}
