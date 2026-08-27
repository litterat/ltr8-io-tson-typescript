/**
 * Parses and validates against meta.tn's `mac_type` constructor (§5.5's `!mac` atom, EUI-48 per
 * RFC 9542) -- the port of `atom/MacParser.java`. A pure format check (§5.2: "the remaining
 * atoms are pure format checks") -- {@link MacType} carries only its RFC pin, so there are no
 * facets to apply.
 *
 * **Host value is {@link MacAddress}'s six raw octets, not the authored text.** This is a
 * deliberate divergence from `MacParser.java`, which returns `String` specifically because Java
 * has no MAC-address type and `byte[]` there is already spoken for (the reference's own
 * `VocabularyAtoms` maps `byte[]` to `!base64`). This port faces no such collision --
 * `value/types.ts`'s {@link MacAddress} is its own named shape, distinct from the generic binary
 * host type -- so decoding to bytes, the same choice `ipv4.ts`/`ipv6.ts` make for their own addresses, is
 * available and is what `value/types.ts` (frozen) already declares.
 *
 * **The consequence: `write` cannot reproduce the authored separator or letter case.**
 * `MacParser.java`'s own Javadoc records that core.tn nominates no canonical form and that
 * *its* `write` therefore returns the input unchanged -- a choice only available to a
 * string-typed host value. Once the value is decoded to bytes that original spelling is gone (a
 * MAC's six octets carry no separator-choice or case bit of their own), so `write` here picks
 * one canonical spelling -- lowercase hex, colon-separated, matching the form core.tn's own
 * `@doc` treats as primary ("The colon form must be quoted; the hyphen form may be written
 * unquoted", stating the colon form first). A value read from `"AA-BB-CC-DD-EE-FF"` therefore
 * writes back as `"aa:bb:cc:dd:ee:ff"` -- the same octets, a different (but equally valid, per
 * this atom's own grammar) spelling. This is real information loss relative to the Java's
 * identity `write`, and is the direct cost of the host-type choice above.
 *
 * Mixing separators (`AA-BB:CC-DD:EE-FF`) is rejected: the two forms are alternatives, not a
 * character class, so each is matched whole rather than by a per-octet separator test.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { MacType } from '../../schema/meta/atoms-network.js';
import type { MacAddress } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_F = 0x46;
const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_F = 0x66;
const OCTET_COUNT = 6;

function isHexDigitCode(code: number): boolean {
  return (
    (code >= ASCII_ZERO && code <= ASCII_NINE) ||
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_F) ||
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_F)
  );
}

function parseHexOctet(part: string): number | undefined {
  if (
    part.length !== 2 ||
    !isHexDigitCode(part.charCodeAt(0)) ||
    !isHexDigitCode(part.charCodeAt(1))
  ) {
    return undefined;
  }
  return Number.parseInt(part, 16);
}

function parseWithSeparator(text: string, separator: string): Uint8Array | undefined {
  const parts = text.split(separator);
  if (parts.length !== OCTET_COUNT) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    const value = parseHexOctet(part);
    if (value === undefined) return undefined;
    octets.push(value);
  }
  return Uint8Array.from(octets);
}

/**
 * `eui-48 = 2HEXDIG (":" 2HEXDIG){5} / 2HEXDIG ("-" 2HEXDIG){5}` (RFC 9542): six hex octets,
 * separated consistently by `:` or by `-`, one alternative each so the two can never mix within
 * one token -- checked directly, before ever choosing a separator to split on, rather than
 * discovering the mix only after a split produces malformed pieces.
 */
function tryParseMacOctets(text: string): Uint8Array | undefined {
  const hasColon = text.includes(':');
  const hasHyphen = text.includes('-');
  if (hasColon && hasHyphen) return undefined;
  return parseWithSeparator(text, hasColon ? ':' : '-');
}

function toLowercaseHexPair(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** `read`'s inverse -- see this module's own TSDoc for why this is a canonical spelling, not the
 * authored text `MacParser.java`'s `String`-typed `write` returns unchanged. */
export function formatMac(octets: Uint8Array): string {
  return Array.from(octets, toLowercaseHexPair).join(':');
}

/**
 * Builds the `AtomType` for one fully-parameterised `mac_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'mac'` for §5.5's unconstrained `mac => !mac_type {}`.
 */
export function createMacParser(typeRef: string, _constraints: MacType): AtomType<MacAddress> {
  function read(token: AtomToken): MacAddress {
    const text = token.text;
    const octets = tryParseMacOctets(text);
    if (octets === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid MAC address -- expected RFC 9542's EUI-48 form, six hex octets ` +
          `separated consistently by ':' or by '-' (§5.5)`,
        'an EUI-48 MAC address',
      );
    }
    return { octets };
  }

  function write(value: MacAddress): string {
    return formatMac(value.octets);
  }

  return { read, write };
}
