/**
 * Parses and validates against meta-kernel's `ipv4_type` constructor (§5.5's `!ipv4` atom, RFC
 * 3986's `IPv4address` production) -- the port of `atom/Ipv4Parser.java`.
 *
 * **Parses the token itself; there is no host `InetAddress` to lean on and no reason to want
 * one.** `CONFORMANCE.md` documents this as a security choice, not a spec-fidelity nicety:
 * `InetAddress.ofLiteral` -- Java's modern, no-DNS, literal-only entry point, confirmed
 * empirically there before deciding this -- is still far more lenient than RFC 3986's
 * `dec-octet` grammar. It accepts a leading zero (`"0177.0.0.1"`), the legacy BSD short/class-
 * based form (`"1.2.3"` -> `1.2.0.3`), and even a bare 32-bit integer literal (`"3232235521"` ->
 * `192.168.0.1`). That is the same leniency class behind real-world SSRF-filter-bypass
 * techniques -- a validator and the network stack disagreeing about what address a string
 * denotes -- so this atom validates the token against RFC 3986's `dec-octet` grammar itself and
 * builds the host value directly from the four decoded octets, never handing the original text
 * to any host parser (this port has none to hand it to regardless -- JS has no `InetAddress`).
 *
 * `within`/`excluding` (meta.tn's `ipv4_type`) are not modeled -- no built-in instance sets
 * either, and set-membership/non-overlap against an array of other addresses or CIDR blocks is a
 * materially bigger piece of work than a scalar constraint, left for later (matching
 * `Ipv4Parser.java`'s own deferral).
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { Ipv4Type } from '../../schema/meta/atoms-network.js';
import type { Ipv4Address } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

/**
 * `dec-octet` (RFC 3986 §3.2.2): `"0"`-`"9"` alone; `"10"`-`"99"` with no leading zero;
 * `"100"`-`"199"`; `"200"`-`"249"`; `"250"`-`"255"`. A leading zero on any multi-digit octet
 * (`"0177"`, `"010"`) is rejected -- there is exactly one spelling of each value 0-255, the
 * property that shuts down the leading-zero leniency this module's own TSDoc describes.
 */
function parseDecOctet(part: string): number | undefined {
  if (part.length === 0 || part.length > 3) return undefined;
  for (let i = 0; i < part.length; i++) {
    const code = part.charCodeAt(i);
    if (code < ASCII_ZERO || code > ASCII_NINE) return undefined;
  }
  if (part.length > 1 && part.charCodeAt(0) === ASCII_ZERO) return undefined;
  const value = Number.parseInt(part, 10);
  return value <= 255 ? value : undefined;
}

/**
 * `IPv4address = dec-octet "." dec-octet "." dec-octet "." dec-octet` (RFC 3986 §3.2.2). Returns
 * the four octets, or `undefined` if `text` is not shaped like this production at all -- no
 * leading zeros, no BSD short form, no bare integer literal (see this module's own TSDoc for why
 * each of those is rejected rather than accepted the way `InetAddress.ofLiteral` would be).
 *
 * Exported for `ipv6.ts`'s and `cidr4.ts`'s reuse: RFC 4291 §2.2's IPv4-mapped tail and
 * `cidr4_type`'s address half both need this exact grammar, not a second, potentially-drifting
 * copy of it -- the same reuse `Ipv6Parser.java`/`Cidr4Parser.java` make of `Ipv4Parser`'s own
 * `IPV4_ADDRESS` pattern.
 */
export function parseIpv4Octets(text: string): Uint8Array | undefined {
  // Splitting on '.' rather than scanning by hand is safe here specifically because dec-octet's
  // own character set excludes '.': a dotted-quad's four octets can never themselves contain the
  // separator, so there is no ambiguity a hand-written scan would resolve differently.
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    const value = parseDecOctet(part);
    if (value === undefined) return undefined;
    octets.push(value);
  }
  return Uint8Array.from(octets);
}

/** `read`'s inverse: plain decimal octets joined by `.`, the canonical dotted-quad spelling. */
export function formatIpv4(octets: Uint8Array): string {
  return Array.from(octets, (octet) => String(octet)).join('.');
}

/**
 * Builds the `AtomType` for one fully-parameterised `ipv4_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'ipv4'` for §5.5's unconstrained `ipv4 => !ipv4_type {}`.
 */
export function createIpv4Parser(typeRef: string, constraints: Ipv4Type): AtomType<Ipv4Address> {
  // `within`/`excluding` are accepted but not enforced -- see this module's own TSDoc. Destructured
  // only to keep that deferral visible at the type level rather than silently dropping the parameter.
  const { within: _within, excluding: _excluding } = constraints;

  function read(token: AtomToken): Ipv4Address {
    const text = token.text;
    const octets = parseIpv4Octets(text);
    if (octets === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid IPv4 address -- expected RFC 3986's dotted-quad IPv4address ` +
          `production, no leading zeros or non-canonical forms (§5.5)`,
        'an IPv4 address',
      );
    }
    return { kind: 'ipv4', octets };
  }

  function write(value: Ipv4Address): string {
    return formatIpv4(value.octets);
  }

  return { read, write };
}
