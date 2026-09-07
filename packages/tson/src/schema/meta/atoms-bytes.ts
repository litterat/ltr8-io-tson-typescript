/**
 * The octet-sequence atom family's resolved constraint vocabulary (§9): `bytes_type`, the only
 * binary type there is.
 */

/**
 * meta.tn's `bytes_encoding` enum (§9) — the RFC 4648 base encodings a text-class encoding may
 * spell a `bytes` value in. HEX is §8's base16. A spelling is not a kind of value: the same
 * octets are `"3q2+7w=="`, `"deadbeef"` and `"3WV37Q======"`, and `"abcd"` is well-formed hex
 * *and* well-formed base64 decoding to different octets — which is why a text reader must be
 * told which alphabet is in force.
 */
export type BytesEncoding = 'BASE64' | 'BASE64URL' | 'BASE32' | 'HEX';

/**
 * meta.tn's `bytes_type` constructor's own vocabulary, resolved (§9) — the octet sequence, and
 * the only binary type there is. Instance is `bytes` in core.
 *
 * **The value is the octets, and every facet is over octets.** Equality, identity, content
 * addressing and the length bounds all are — `length: 32` is a 32-byte digest whether it
 * arrives as 64 hex characters, 44 base64 characters, or 32 raw bytes — so a round trip through
 * any encoding preserves the value.
 *
 * **`encoding` is a selector (§5.7), and it is not refinable.** It picks which alphabet the
 * text class of encodings spells the octets in and never changes what two values compare as —
 * every octet string is writable in every one of RFC 4648's alphabets, so a refinement that
 * only respells would claim an IS-A carrying no narrowing, and a hex-spelled document would not
 * be readable at a base64 position. That is why the alphabet is a facet and there are no spelled
 * sibling types: another alphabet is another **instance** of this constructor —
 * `hexdigest => !bytes_type { encoding: HEX  length: 4 }` —
 * never a refinement of one, and refining for *length* alone inherits the alphabet
 * (`sha256 => !bytes ^ { length: 32 }` is a base64 sha256). Defaults to `BASE64` (§4, padded),
 * so a `bytes` position is base64 in every text encoding and core declares no spelled subtypes.
 *
 * A facet rather than an annotation because a container element has no annotation position:
 * `[hexdigest]` works only if the element's own type carries the alphabet.
 *
 * No `spec` field, unlike every other `atom_specification`-composed family in this package:
 * RFC 4648 governs spellings, not octets, so this constructor composes with `atom` directly.
 *
 * Also an {@link Atom} variant: `bytes => !bytes_type { encoding: BASE64 }` is a
 * constructor-application instance (§5.5) whose resolved body is this shape with every length
 * facet absent.
 */
export interface BytesType {
  readonly kind: 'bytes_type';
  readonly encoding: BytesEncoding;
  readonly length?: bigint;
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
}
