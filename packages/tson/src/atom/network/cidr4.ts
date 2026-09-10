/**
 * Parses and validates against meta.tn's `cidr4_type` constructor (§5.5's `!cidr4` atom, RFC
 * 4632): an IPv4 address, `/`, and a prefix length of 0-32 -- the port of `atom/Cidr4Parser.java`.
 * The address half is `ipv4.ts`'s own strict RFC 3986 `dec-octet` grammar, reused rather than
 * copied -- a network's address is an address, and a second, drifting copy would reopen exactly
 * the leniency gap that module documents.
 *
 * **Host value is a decoded network, not retained text** -- see `value/types.ts`'s {@link Cidr}
 * for the shape and why it still keeps the authored address spelling alongside the decoded bytes.
 * Becoming a network value is what lets `within`/`excluding` and the prefix facets all judge the
 * same parsed `address`/`prefixLength` pair rather than each re-parsing the token's text.
 *
 * `minPrefix`/`maxPrefix` narrow the prefix length; `within`/`excluding` are enforced against the
 * value as a network block -- a subnet of at least one `within` entry when the field is present,
 * overlapping none of `excluding` ([TSON-SCHEMA] §5.5: "overlap, not containment"). Whether the
 * declared bounds and lists between them admit any value at all is a schema-load coherence
 * question (`../../compiler/atomChecks.ts`), not this module's.
 */

import { TsonAtomParseError } from '../../core/errors.js';
import type { Cidr4Type } from '../../schema/meta/atoms-network.js';
import type { Cidr } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { parseIpv4Octets } from './ipv4.js';
import {
  checkNetworkAdmitted,
  networkBlock,
  overlaps,
  parseNetworkList,
  tryParsePrefixLength,
  validateNetwork,
} from './cidrParsing.js';

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
  const within = parseNetworkList(constraints.within, parseIpv4Octets);
  const excluding = parseNetworkList(constraints.excluding, parseIpv4Octets);

  function read(token: AtomToken): Cidr {
    const text = token.text;
    const slash = text.indexOf('/');
    if (slash < 0 || text.includes('/', slash + 1)) {
      throw malformed(typeRef, text);
    }
    const addressText = text.slice(0, slash);
    const address = parseIpv4Octets(addressText);
    const prefixLength = tryParsePrefixLength(text.slice(slash + 1));
    if (address === undefined || prefixLength === undefined) {
      throw malformed(typeRef, text);
    }
    validateNetwork(
      typeRef,
      text,
      address,
      prefixLength,
      constraints.minPrefix === undefined ? undefined : Number(constraints.minPrefix),
      constraints.maxPrefix === undefined ? undefined : Number(constraints.maxPrefix),
    );
    checkNetworkAdmitted(
      typeRef,
      text,
      networkBlock(address, prefixLength),
      within,
      excluding,
      32,
      overlaps,
    );
    return { kind: 'cidr4', addressText, address, prefixLength };
  }

  function write(value: Cidr): string {
    return `${value.addressText}/${String(value.prefixLength)}`;
  }

  return { read, write };
}
