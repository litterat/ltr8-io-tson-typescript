/**
 * Parses and validates against meta.tn's `cidr4_type` constructor (§5.5's `!cidr4` atom, RFC
 * 4632): an IPv4 address, `/`, and a prefix length of 0-32 -- the port of `atom/Cidr4Parser.java`.
 * The address half is `ipv4.ts`'s own strict RFC 3986 `dec-octet` grammar, reused rather than
 * copied -- a network's address is an address, and a second, drifting copy would reopen exactly
 * the leniency gap that module documents.
 *
 * **Host value holds the authored text verbatim, not a decoded address/prefix pair.**
 * `CONFORMANCE.md` is explicit about why: "the host value is the token's own text rather than an
 * invented address/prefix pair -- validated, never rewritten, so a round trip is exact." The
 * address and prefix are still validated at parse time (reusing the address grammars above);
 * that check simply does not change what gets stored -- see `value/types.ts`'s {@link Cidr}.
 *
 * `minPrefix`/`maxPrefix` *are* applied -- they are scalar facets, unlike `within`/`excluding`,
 * which stay unmodeled here for the reason `ipv4.ts` records. Whether a declared bound itself
 * falls inside the family range ("invalid at the schema level", per meta.tn) is a
 * constraint-family coherence rule and is not checked here; an out-of-range bound is inert
 * either way, since the family range is enforced regardless and so a wider bound cannot widen
 * what this accepts.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { Cidr4Type } from '../../schema/meta/atoms-network.js';
import type { Cidr } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { parseIpv4Octets } from './ipv4.js';
import { tryParsePrefixLength, validateNetwork } from './cidrParsing.js';

function malformed(typeRef: string, text: string): TsonAtomParseError {
  return new TsonAtomParseError(
    typeRef,
    `'${text}' is not a valid IPv4 network -- expected RFC 4632's CIDR notation, a dotted-quad ` +
      `address followed by '/' and a decimal prefix length (§5.5)`,
    'an IPv4 network in CIDR notation',
  );
}

/**
 * Builds the `AtomType` for one fully-parameterised `cidr4_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'cidr4'` for §5.5's unconstrained `cidr4 => !cidr4_type {}`.
 */
export function createCidr4Parser(typeRef: string, constraints: Cidr4Type): AtomType<Cidr> {
  // `within`/`excluding` are accepted but not enforced -- see `ipv4.ts`'s own TSDoc for why.
  const { within: _within, excluding: _excluding } = constraints;

  function read(token: AtomToken): Cidr {
    const text = token.text;
    const slash = text.indexOf('/');
    if (slash < 0 || text.includes('/', slash + 1)) {
      throw malformed(typeRef, text);
    }
    const address = parseIpv4Octets(text.slice(0, slash));
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
    return { kind: 'cidr4', text };
  }

  function write(value: Cidr): string {
    return value.text;
  }

  return { read, write };
}
