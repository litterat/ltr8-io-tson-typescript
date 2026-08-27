/**
 * Parses and validates against meta.tn's `cidr6_type` constructor (§5.5's `!cidr6` atom, RFC
 * 4291 §2.3) -- `cidr4.ts`'s exact IPv6 counterpart, the port of `atom/Cidr6Parser.java`. Same
 * shape, same host value and the reasoning behind it, same treatment of `minPrefix`/`maxPrefix`
 * and of `within`/`excluding`; see `cidr4.ts`'s own TSDoc for all of it. The prefix range is
 * 0-128 rather than 0-32, enforced by `cidrParsing.ts`'s own family-range check against the
 * address's byte length.
 *
 * The address half is `ipv6.ts`'s own RFC 4291 §2.2 parse, reused whole, so a zone identifier
 * (`fe80::1%eth0`) is excluded here for the reason it is excluded there, and the IPv4-mapped tail
 * form (`::ffff:192.0.2.0/120`) is admitted on the same terms.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { Cidr6Type } from '../../schema/meta/atoms-network.js';
import type { Cidr } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { parseIpv6Bytes } from './ipv6.js';
import { tryParsePrefixLength, validateNetwork } from './cidrParsing.js';

function malformed(typeRef: string, text: string): TsonAtomParseError {
  return new TsonAtomParseError(
    typeRef,
    `'${text}' is not a valid IPv6 network -- expected RFC 4291 §2.3's CIDR notation, an RFC 4291 ` +
      `§2.2 address followed by '/' and a decimal prefix length (§5.5)`,
    'an IPv6 network in CIDR notation',
  );
}

/**
 * Builds the `AtomType` for one fully-parameterised `cidr6_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'cidr6'` for §5.5's unconstrained `cidr6 => !cidr6_type {}`.
 */
export function createCidr6Parser(typeRef: string, constraints: Cidr6Type): AtomType<Cidr> {
  // `within`/`excluding` are accepted but not enforced -- see `ipv4.ts`'s own TSDoc for why.
  const { within: _within, excluding: _excluding } = constraints;

  function read(token: AtomToken): Cidr {
    const text = token.text;
    const slash = text.indexOf('/');
    if (slash < 0 || text.includes('/', slash + 1)) {
      throw malformed(typeRef, text);
    }
    const address = parseIpv6Bytes(text.slice(0, slash));
    const prefixLength = tryParsePrefixLength(text.slice(slash + 1));
    if (address === undefined || prefixLength === undefined) {
      throw malformed(typeRef, text);
    }
    validateNetwork(
      typeRef,
      text,
      address,
      prefixLength,
      constraints.minPrefix,
      constraints.maxPrefix,
    );
    return { kind: 'cidr6', text };
  }

  function write(value: Cidr): string {
    return value.text;
  }

  return { read, write };
}
