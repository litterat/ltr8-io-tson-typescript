/**
 * Parses and validates against meta-kernel's `ipv6_type` constructor (§5.5's `!ipv6` atom, RFC
 * 4291 §2.2's text representation) -- the port of `atom/Ipv6Parser.java`.
 *
 * **Parses the full RFC 4291 §2.2 grammar itself, for the same reason `ipv4.ts` does.** Handing
 * the token's text to a host parser -- if this port had one, which it does not -- would
 * reintroduce `ipv4.ts`'s exact leniency gap through the back door: §2.2's grammar includes an
 * alternative form for the last 32 bits, `x:x:x:x:x:x:d.d.d.d`, embedding an IPv4 dotted-quad
 * tail. This module parses the 8-group preferred form, at most one `::` run-of-zeros
 * compression, and that optional dotted-quad tail -- checked against {@link parseIpv4Octets}'s
 * own strict `dec-octet` grammar, reused whole rather than copied -- and builds the 16-byte
 * result directly.
 *
 * **Unlike `ipv4.ts`'s decimal octets, a hex group's own leading zeros are fine.** RFC 4291
 * §2.2 defines a group as "one to four hexadecimal digits" -- a digit-*count* restriction, not a
 * leading-zero prohibition the way RFC 3986's decimal `dec-octet` has one -- so
 * `"0000:0000:0000:0000:0000:0000:0000:0001"` is exactly as valid as `"::1"`, just not the
 * canonical spelling (RFC 5952 governs canonical *output*, not input acceptance).
 *
 * **Zone identifiers (`%eth0`, RFC 4007) need no special-case rejection.** `%` is simply not in
 * this grammar's character set at all, so a zone suffix fails as an ordinary malformed group --
 * matching core.tn's own exclusion of them from the `!ipv6` contract.
 *
 * This port has no JDK-style `InetAddress` type-downcast quirk to route around
 * (`Ipv6Parser.java`'s own `Inet6Address.getByAddress` note): {@link Ipv6Address} always carries
 * its 16 bytes directly, with no separate 4-vs-16-byte host type for a value to be silently
 * reinterpreted as.
 *
 * `within`/`excluding` are not modeled, for the reason `ipv4.ts`'s own TSDoc gives.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { Ipv6Type } from '../../schema/meta/atoms-network.js';
import type { Ipv6Address } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { parseIpv4Octets } from './ipv4.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_F = 0x46;
const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_F = 0x66;
const GROUP_COUNT = 8;
const MAX_GROUP_DIGITS = 4;

function isHexDigitCode(code: number): boolean {
  return (
    (code >= ASCII_ZERO && code <= ASCII_NINE) ||
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_F) ||
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_F)
  );
}

/** `1*4HEXDIG` (RFC 4291 §2.2's `h16`): 1-4 hex digits, no leading-zero restriction. */
function parseHexGroup(group: string): number | undefined {
  if (group.length === 0 || group.length > MAX_GROUP_DIGITS) return undefined;
  for (let i = 0; i < group.length; i++) {
    if (!isHexDigitCode(group.charCodeAt(i))) return undefined;
  }
  return Number.parseInt(group, 16);
}

/** `Java`'s `String.split(":", -1)` keeps trailing/consecutive empty pieces; JS's default `split`
 * already does the same, so an empty `s` (no groups on that side of `::`, or no `::` at all with
 * nothing on that side) is the one case handled separately -- `"".split(':')` yields `[""]`, one
 * empty group, not zero groups. */
function splitGroups(s: string): string[] {
  return s.length === 0 ? [] : s.split(':');
}

function writeGroupBytes(result: Uint8Array, offset: number, value: number): void {
  result[offset] = (value >> 8) & 0xff;
  result[offset + 1] = value & 0xff;
}

/**
 * RFC 4291 §2.2's full text representation. Returns the 16 address bytes, or `undefined` if
 * `text` is not shaped like this production at all.
 *
 * Exported for `cidr6.ts`'s reuse, the same way {@link parseIpv4Octets} is exported for
 * `cidr4.ts`.
 */
export function parseIpv6Bytes(text: string): Uint8Array | undefined {
  const compressionAt = text.indexOf('::');
  const compressed = compressionAt >= 0;
  const before = compressed ? text.slice(0, compressionAt) : text;
  const after = compressed ? text.slice(compressionAt + 2) : '';
  if (compressed && after.includes('::')) return undefined;

  const beforeGroups = splitGroups(before);
  const afterGroups = splitGroups(after);
  if (beforeGroups.some((group) => group.length === 0)) return undefined;
  if (afterGroups.some((group) => group.length === 0)) return undefined;

  // The IPv4-tail form is only recognised as the address's very last group -- either the last
  // group before "::" when there is no compression at all, or the last group after "::" when
  // there is. A dot anywhere else is simply an invalid hex group.
  const lastBefore = beforeGroups.at(-1);
  const ipv4TailInBefore = !compressed && (lastBefore?.includes('.') ?? false);
  const lastAfter = afterGroups.at(-1);
  const ipv4TailInAfter = compressed && (lastAfter?.includes('.') ?? false);

  const beforeHexCount = beforeGroups.length - (ipv4TailInBefore ? 1 : 0);
  const afterHexCount = afterGroups.length - (ipv4TailInAfter ? 1 : 0);
  const ipv4Slots = ipv4TailInBefore || ipv4TailInAfter ? 2 : 0;
  const explicitSlots = beforeHexCount + afterHexCount + ipv4Slots;

  if (compressed) {
    // "::" must stand for at least one group of zeros -- otherwise it is redundant and ambiguous
    // with the non-compressed preferred form.
    if (explicitSlots >= GROUP_COUNT) return undefined;
  } else if (explicitSlots !== GROUP_COUNT) {
    return undefined;
  }

  const result = new Uint8Array(16);
  let offset = 0;
  for (let i = 0; i < beforeHexCount; i++) {
    const group = beforeGroups.at(i);
    const value = group === undefined ? undefined : parseHexGroup(group);
    if (value === undefined) return undefined;
    writeGroupBytes(result, offset, value);
    offset += 2;
  }
  if (ipv4TailInBefore) {
    const tail = parseIpv4Octets(lastBefore ?? '');
    if (tail === undefined) return undefined;
    result.set(tail, offset);
    offset += 4;
  }
  if (compressed) {
    offset += (GROUP_COUNT - explicitSlots) * 2; // already zero-initialised
  }
  for (let i = 0; i < afterHexCount; i++) {
    const group = afterGroups.at(i);
    const value = group === undefined ? undefined : parseHexGroup(group);
    if (value === undefined) return undefined;
    writeGroupBytes(result, offset, value);
    offset += 2;
  }
  if (ipv4TailInAfter) {
    const tail = parseIpv4Octets(lastAfter ?? '');
    if (tail === undefined) return undefined;
    result.set(tail, offset);
  }
  return result;
}

/**
 * `read`'s inverse: the uncompressed, full 8-group form, each group's leading zeros stripped --
 * the same shape `Inet6Address#getHostAddress()` produces (`Ipv6Parser.java`'s own regression
 * test pins `"2001:db8::1"` writing back as `"2001:db8:0:0:0:0:0:1"`). Still valid per {@link
 * parseIpv6Bytes}'s own grammar, just not the shortest legal spelling -- canonicalising to `::`
 * per RFC 5952 is not needed for round-tripping to work.
 */
export function formatIpv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i += 1) {
    const pair = bytes.subarray(i * 2, i * 2 + 2);
    const value = pair.reduce((accumulator, byte) => (accumulator << 8) | byte, 0);
    groups.push(value.toString(16));
  }
  return groups.join(':');
}

/**
 * Builds the `AtomType` for one fully-parameterised `ipv6_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'ipv6'` for §5.5's unconstrained `ipv6 => !ipv6_type {}`.
 */
export function createIpv6Parser(typeRef: string, constraints: Ipv6Type): AtomType<Ipv6Address> {
  // `within`/`excluding` are accepted but not enforced -- see `ipv4.ts`'s own TSDoc for why.
  const { within: _within, excluding: _excluding } = constraints;

  function read(token: AtomToken): Ipv6Address {
    const text = token.text;
    const octets = parseIpv6Bytes(text);
    if (octets === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid IPv6 address -- expected RFC 4291 §2.2's text representation (§5.5)`,
        'an IPv6 address',
      );
    }
    return { kind: 'ipv6', octets };
  }

  function write(value: Ipv6Address): string {
    return formatIpv6(value.octets);
  }

  return { read, write };
}
