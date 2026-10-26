/**
 * The network atoms [TSON-DATA] §5.5 adds beside the address families: `hostname`, `host` and
 * `media_type`. Each is a string-class atom whose value is its canonical text -- two values are
 * one exactly when their canonical texts are equal -- and each module also exports the richer
 * value (the name's A-label form, the address's octets, the media type's parameters) for the
 * callers that need it, such as the identity rules of §2.2.1.
 *
 * - {@link parseHostname}: `hostname_type` (RFC 5890-5893; facet `allow_idn`).
 * - {@link parseHost}: `host_type` (RFC 3987's `ihost`, profiled to DNS).
 * - {@link parseMediaType}: `media_type_type` (RFC 6838, RFC 9110 §8.3.1; facets
 *   `allow_parameters`, `types`, `suffixes`).
 *
 * Each `parse*` function takes the token's decoded text, the constructor's facets where it has
 * any, and the type's name for error reporting, and throws `TsonAtomParseError` for a token
 * outside the family's grammar and `TsonAtomValidationError` for a well-formed one outside a facet
 * (§5.2). Each `create*Parser` wraps its function as the `AtomType<string>` the vocabulary and the
 * schema compiler hold.
 */

export { createHostParser, formatIpv6Rfc5952, parseHost, parseHostText } from './host.js';
export type { HostAddressValue, HostValue } from './host.js';
export { createHostnameParser, parseHostName, parseHostname } from './hostName.js';
export type { HostnameFacets, HostnameValue, Syntax } from './hostName.js';
export { createMediaTypeParser, parseMediaType, parseMediaTypeText } from './mediaType.js';
export type { MediaTypeFacets, MediaTypeValue } from './mediaType.js';
