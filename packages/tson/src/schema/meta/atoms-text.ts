/**
 * The text-shaped atom families' resolved constraint vocabularies (§5.3, §5.5, §5.7, §9):
 * `text`, `binary` (the four RFC 4648 encodings), `regex`, `uri`, `email`, and `uuid`.
 */

/**
 * The meta-kernel's `text_type` constructor — the Unicode code point sequence type every
 * other text-shaped atom composes with (§5.7).
 *
 * `pattern` is the regex's own source text, not a compiled pattern object: kept a pure,
 * hashable/equatable value like every other field here, and consistent with the kernel's
 * own modelling — `regex_type` composes with `text_type`, i.e. a `regex` value IS-A piece of
 * text, so the natural representation of a pattern constraint is text too. A reader
 * compiles it at validation time rather than storing a compiled form.
 *
 * `length` is an exact length — both a floor and a ceiling at once — alongside the ordinary
 * `minLength`/`maxLength` bounds.
 *
 * Also an {@link Atom} variant: `text => !text_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface TextType {
  readonly kind: 'text_type';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly length?: number;
  readonly pattern?: string;
}

/**
 * `binary`'s `binary_encoding` selector (§5.3) — RFC 4648's four encodings, each also a
 * built-in annotation name (`!base64`, and so on).
 */
export type BinaryEncoding = 'BASE64' | 'BASE64URL' | 'BASE32' | 'HEX';

/**
 * meta.tn's `binary` constructor (§5.3's four binary atoms, RFC 4648) — one shape, not one
 * per encoding: `binary`'s only field beyond the RFC pin is `encoding: binary_encoding`, a
 * closed four-value selector, exactly the same shape as {@link IntegerType.size} or
 * {@link FloatType.format} — a single constructor parameterised by one of its own fields,
 * not four different constructors.
 *
 * Named `BinaryType` here despite meta.tn's constructor being spelled `binary`, not
 * `binary_type` like every other constructor in this family — the odd one out, faithfully
 * carried over from the reference implementation's own naming.
 *
 * `minLength`/`maxLength` are modelled for structural fidelity (meta.tn defines them on the
 * constructor) though no built-in instance sets either.
 *
 * Also an {@link Atom} variant: `base64 => !binary BASE64` and its three siblings are
 * constructor-application instances (§5.5) whose resolved bodies are this shape with the
 * matching `encoding` and no length bounds.
 */
export interface BinaryType {
  readonly kind: 'binary';
  readonly encoding: BinaryEncoding;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/**
 * The meta-kernel's `regex_type` constructor (§5.7: `regex_type => ~text_type &
 * atom_specification & { spec: = "https://www.rfc-editor.org/rfc/rfc9485" }`) — `text_type`'s
 * length and pattern facets plus `atom_specification`'s `spec`, pinned to RFC 9485, the
 * I-Regexp specification.
 *
 * **Every field is flat, mirroring the resolved shape rather than the composition that
 * produced it** — composition always flattens (§5.8), so an instance's wire record carries
 * `minLength`/`maxLength`/`length`/`pattern`/`spec` side by side, with no sub-record. `spec`
 * is a bare string, not a richer URI type, matching every other externally-cited-document
 * field in this package.
 *
 * Also an {@link Atom} variant: `regex => !regex_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and every other
 * field absent.
 */
export interface RegexType {
  readonly kind: 'regex_type';
  readonly spec: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly length?: number;
  readonly pattern?: string;
}

/**
 * The meta-kernel's `uri_type` constructor (§5.5's `uri` atom): `text_type`'s length and
 * pattern facets, `atom_specification`'s `spec` pinned to RFC 3986, and its own `scheme`
 * field.
 *
 * Every field is flat, for the same reason {@link RegexType}'s are (composition always
 * flattens, §5.8). `spec` is a bare string, not a richer URI type, even though it holds one
 * — the value arrives untyped off the wire.
 *
 * Also an {@link Atom} variant: `uri => !uri_type {}` is a constructor-application instance
 * (§5.5) whose resolved body is this shape with `spec` pinned and every other field absent.
 */
export interface UriType {
  readonly kind: 'uri_type';
  readonly spec: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly length?: number;
  readonly pattern?: string;
  readonly scheme?: string;
}

/**
 * meta.tn's `email_type` constructor (RFC 5322), composing `text_type`'s `minLength`/
 * `maxLength`/`length`/`pattern` — {@link RegexType}'s exact twin, declared by the identical
 * composition and differing only in which document `spec` is fixed to.
 *
 * Also an {@link Atom} variant: `email => !email_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and every other
 * field absent.
 */
export interface EmailType {
  readonly kind: 'email_type';
  readonly spec: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly length?: number;
  readonly pattern?: string;
}

/**
 * The meta-kernel's `uuid_type` constructor (§5.5's `uuid` atom, RFC 9562). `version`
 * selects a generation scheme (a selector, not an ordered bound — version 7 is not
 * "narrower" than version 4, it is a different value set).
 *
 * Also an {@link Atom} variant: `uuid => !uuid_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `version` absent.
 */
export interface UuidType {
  readonly kind: 'uuid_type';
  readonly version?: number;
}
