/**
 * A host as RFC 3987's `ihost` names one, profiled to DNS ([TSON-DATA] §5.5's `!host`): a host
 * name ({@link HostnameValue}), an IPv4 address or an IPv6 address -- what a listener binds, what
 * an allow-list names and what an identifying URI's authority holds (§2.2.1). One value, never
 * both: a name never equals an address.
 *
 * **Each member keeps its own equality.** A name compares by name, an address by its octets, so
 * `::1` and `0:0:0:0:0:0:0:1` are one value; the two address families never equal each other, so
 * `127.0.0.1` and its IPv4-mapped `::ffff:127.0.0.1` are two. {@link HostValue.text} is the
 * member's canonical text -- the name's U-labels, a dotted-quad, RFC 5952 text for IPv6 -- and two
 * hosts are one value exactly when their canonical texts are equal.
 *
 * **Brackets are a second spelling of an IPv6 address.** A URI brackets one so that it can find
 * the port after it, and operators copy `[::1]` out of URLs; the address is the value, so `[::1]`
 * and `::1` are one, written back unbracketed. A zone identifier (`fe80::1%eth0`), IPvFuture and
 * any percent-encoding are refused. (`ipv6` itself still refuses brackets.)
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { AtomToken, AtomType } from '../contract.js';
import {
  parseHostName,
  syntaxFailure,
  syntaxSuccess,
  type HostnameValue,
  type Syntax,
} from './hostName.js';
import { formatIpv4, parseIpv4Octets } from './ipv4.js';
import { parseIpv6Bytes } from './ipv6.js';

/** An IPv4 or IPv6 address as a host, compared by its family and octets. */
export interface HostAddressValue {
  readonly kind: 'ipv4' | 'ipv6';
  /** Four octets for `ipv4`, sixteen for `ipv6`. */
  readonly octets: Uint8Array;
  /** The canonical text: a dotted-quad, or RFC 5952 text without brackets. */
  readonly text: string;
}

/** A host: a host name or an address. */
export type HostValue = HostnameValue | HostAddressValue;

/**
 * RFC 5952 text for sixteen IPv6 octets: lowercase hexadecimal, no leading zeros in a group, the
 * longest run of two or more zero groups (the first, on a tie) compressed to `::`. An IPv4-mapped
 * address keeps its dotted tail (RFC 5952 §5), which is the spelling it was written in and the one
 * a reader of it expects back.
 */
export function formatIpv6Rfc5952(octets: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(((octets[i * 2] ?? 0) << 8) | (octets[i * 2 + 1] ?? 0));
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `::ffff:${formatIpv4(octets.subarray(12, 16))}`;
  }
  let bestStart = -1;
  let bestLength = 1; // a run of one is never compressed (RFC 5952 §4.2.2)
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let end = i;
    while (end < 8 && groups[end] === 0) end++;
    if (end - i > bestLength) {
      bestStart = i;
      bestLength = end - i;
    }
    i = end;
  }
  let text = '';
  for (let i = 0; i < 8; i++) {
    if (bestStart >= 0 && i === bestStart) {
      // Always both colons: the run may end the address, and there is then no group after it to
      // supply the second one.
      text += '::';
      i += bestLength - 1;
      continue;
    }
    if (text.length > 0 && !text.endsWith(':')) text += ':';
    text += (groups[i] ?? 0).toString(16);
  }
  return text;
}

/** Whether `text` is non-empty and holds digits and dots alone. */
function isDottedDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!(code === 0x2e || (code >= 0x30 && code <= 0x39))) return false;
  }
  return true;
}

/** The bracketed or bare IPv6 address `text` spells. */
function readIpv6Host(text: string): Syntax<HostAddressValue> {
  const bracketed = text.startsWith('[');
  const inner = bracketed && text.endsWith(']') ? text.slice(1, -1) : text;
  if (inner.includes('%')) {
    return syntaxFailure(
      'carries a zone identifier, which is local to one machine and not part of a host',
    );
  }
  const octets = bracketed && !text.endsWith(']') ? undefined : parseIpv6Bytes(inner);
  if (octets === undefined) {
    return syntaxFailure("is not an IPv6 address, and a host holding ':' or '[' must be one");
  }
  return syntaxSuccess({ kind: 'ipv6', octets, text: formatIpv6Rfc5952(octets) });
}

/**
 * The host `text` names: a bracketed or bare IPv6 address, a dotted-quad, or a host name.
 * Failing, the reason is worded to follow `it `.
 */
export function parseHostText(text: string): Syntax<HostValue> {
  if (text.startsWith('[') || text.includes(':')) return readIpv6Host(text);
  const octets = parseIpv4Octets(text);
  if (octets !== undefined) {
    return syntaxSuccess({ kind: 'ipv4', octets, text: formatIpv4(octets) });
  }
  if (isDottedDigits(text)) {
    return syntaxFailure(
      "is not an IPv4 address, and a host name's last label begins with a letter",
    );
  }
  return parseHostName(text);
}

/**
 * Reads a `!host` token against `host_type` ([TSON-SCHEMA] §5.5) and returns the host with its
 * canonical text. A pure format check, with nothing to configure.
 *
 * @param text the token's decoded text, in any spelling of the host
 * @param typeRef the type's name, for error reporting
 * @throws {@link TsonAtomParseError} when `text` is not a host; `expected` is
 *   `a host name, an IPv4 address or an IPv6 address`
 */
export function parseHost(text: string, typeRef = 'host'): HostValue {
  const parsed = parseHostText(text);
  if (!parsed.ok) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a host: it ${parsed.reason}`,
      'a host name, an IPv4 address or an IPv6 address',
    );
  }
  return parsed.value;
}

/**
 * The `AtomType` for one `host_type` instance, whose host value is the canonical text of the
 * member: two hosts are one value exactly when their canonical texts are equal, an IPv4 address
 * never equal to an IPv6 one.
 */
export function createHostParser(typeRef: string): AtomType<string> {
  return {
    read: (token: AtomToken): string => parseHost(token.text, typeRef).text,
    write: (value: string): string => value,
  };
}
