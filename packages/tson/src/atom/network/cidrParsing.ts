/**
 * The CIDR mechanics `cidr4.ts` and `cidr6.ts` share -- the port of `atom/CidrParsing.java`:
 * prefix-length grammar, the family-range and host-bits rules, and the `minPrefix`/`maxPrefix`
 * facets. Neither family owns them -- unlike `ipv4.ts`'s `parseIpv4Octets`, which `ipv6.ts`
 * genuinely reaches into because RFC 4291 §2.2 embeds the IPv4 grammar -- so they sit here
 * rather than on one of the two parsers with the other reaching across for them.
 *
 * **The split between a parse failure and a validation failure is §5.5's own, not a choice made
 * here**: "A token that does not match the named format is a resolver error; a CIDR prefix
 * length outside the address family's range is a validation error, as is an address whose host
 * bits are nonzero under the stated prefix length." So a malformed prefix is a
 * {@link TsonAtomParseError} (thrown by `cidr4.ts`/`cidr6.ts` themselves, not here) and an
 * out-of-range one is a {@link TsonAtomValidationError} (thrown by {@link validateNetwork}),
 * even though both concern the same handful of characters.
 */

import { TsonAtomValidationError } from '../../core/errors.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

/**
 * The largest prefix length any family admits is 128, so a prefix is one to three digits. A
 * longer run is a shape failure rather than an out-of-range value -- the line has to fall
 * somewhere, and putting it at the widest spelling either family can use keeps every plausible
 * authoring slip (`/33` on IPv4, `/129` on IPv6) inside §5.5's validation category, where the
 * spec puts it.
 */
const MAX_PREFIX_DIGITS = 3;

/**
 * The decimal prefix length after the `/`, or `undefined` if `text` is not one. A leading zero is
 * rejected for the same reason `ipv4.ts`'s `dec-octet` rejects it: `/8` and `/08` would otherwise
 * be two spellings of one network, the confusable-input class strictness exists to shut down.
 */
export function tryParsePrefixLength(text: string): number | undefined {
  if (text.length === 0 || text.length > MAX_PREFIX_DIGITS) return undefined;
  if (text.length > 1 && text.charCodeAt(0) === ASCII_ZERO) return undefined;
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < ASCII_ZERO || code > ASCII_NINE) return undefined;
    value = value * 10 + (code - ASCII_ZERO);
  }
  return value;
}

/** Bit-at-a-time rather than byte-masked: at most 128 iterations, and no boundary case to get wrong. */
function hostBitsAreZero(address: Uint8Array, prefixLength: number): boolean {
  const totalBits = address.length * 8;
  for (let bit = prefixLength; bit < totalBits; bit++) {
    // `bit / 8` is always a valid index into `address` (bit < totalBits = address.length * 8), so
    // a genuinely out-of-range read never happens; `?? 0` only satisfies the type checker.
    const byte = address.at(Math.floor(bit / 8)) ?? 0;
    const mask = 0x80 >> (bit % 8);
    if ((byte & mask) !== 0) return false;
  }
  return true;
}

/**
 * §5.5's two validation rules plus `cidr4_type`/`cidr6_type`'s own prefix facets, in that order:
 * the family range first (a prefix the family cannot express makes the host-bits question
 * meaningless), then host bits, then the schema's own narrowing.
 */
export function validateNetwork(
  typeRef: string,
  text: string,
  address: Uint8Array,
  prefixLength: number,
  minPrefix: number | undefined,
  maxPrefix: number | undefined,
): void {
  const addressBits = address.length * 8;
  if (prefixLength > addressBits) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, outside the family range 0-${String(addressBits)}`,
      `>= 0 and <= ${String(addressBits)}`,
    );
  }
  if (!hostBitsAreZero(address, prefixLength)) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has nonzero host bits under prefix length ${String(prefixLength)} -- the value ` +
        `is a network, so every bit beyond the prefix must be zero`,
      'zero host bits beyond the prefix',
    );
  }
  if (minPrefix !== undefined && prefixLength < minPrefix) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, less than the minimum ${String(minPrefix)}`,
      `>= ${String(minPrefix)}`,
    );
  }
  if (maxPrefix !== undefined && prefixLength > maxPrefix) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, more than the maximum ${String(maxPrefix)}`,
      `<= ${String(maxPrefix)}`,
    );
  }
}
