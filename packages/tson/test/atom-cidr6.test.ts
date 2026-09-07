import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createCidr6Parser } from '../src/atom/network/cidr6.js';
import { parseIpv6Bytes } from '../src/atom/network/ipv6.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { Cidr } from '../src/value/types.js';
import type { Cidr6Type } from '../src/schema/meta/atoms-network.js';

/** `atom-cidr4.test.ts`'s own `cidr4` helper, over the 128-bit family. */
function cidr6(addressText: string, prefixLength: number): Cidr {
  const address = parseIpv6Bytes(addressText);
  if (address === undefined)
    throw new Error(`test fixture error: '${addressText}' is not an IPv6 address`);
  return { kind: 'cidr6', addressText, address, prefixLength };
}

// §5.5's `!cidr6` atom (RFC 4291 §2.3) -- `!cidr4`'s exact IPv6 counterpart. What is exercised
// here beyond atom-cidr4.test.ts is the wider 0-128 prefix range and the address forms only this
// family has (compression, the IPv4-mapped tail, and a zone identifier's exclusion).

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: Cidr6Type = {
  kind: 'cidr6_type',
  spec: 'rfc4291',
  within: [],
  excluding: [],
};

function withPrefixBounds(minPrefix?: bigint, maxPrefix?: bigint): Cidr6Type {
  return {
    ...UNCONSTRAINED,
    ...(minPrefix !== undefined && { minPrefix }),
    ...(maxPrefix !== undefined && { maxPrefix }),
  };
}

describe('§5.5 !cidr6 -- accepted networks, addressText preserved exactly (compression not expanded)', () => {
  const parser = createCidr6Parser('cidr6', UNCONSTRAINED);

  it.each([
    '2001:db8::/32',
    '2001:0db8:0000:0000:0000:0000:0000:0000/32', // the same network, uncompressed
    'fe80::/10', // host bits zero at a non-byte boundary
    '2001:db8:abcd:1234:5678:9abc:def0:1/128', // a single host
    '::/0', // the whole space
    '::ffff:192.0.2.0/120', // RFC 4291 §2.2's embedded IPv4 tail
  ])('accepts %s as address/prefix, addressText preserved exactly', (text) => {
    const slash = text.lastIndexOf('/');
    expect(parser.read(token(text))).toEqual(
      cidr6(text.slice(0, slash), Number(text.slice(slash + 1))),
    );
  });

  it('"::" is not expanded on a round trip -- write reproduces addressText, not a re-derived spelling', () => {
    expect(parser.read(token('2001:db8::/32'))).toEqual(cidr6('2001:db8::', 32));
    expect(parser.write(cidr6('2001:db8::', 32))).toBe('2001:db8::/32');
  });
});

describe('§5.5 !cidr6 -- malformed networks are parse errors', () => {
  const parser = createCidr6Parser('cidr6', UNCONSTRAINED);

  it.each([
    '2001:db8::', // no prefix at all
    '2001:db8::/', // empty prefix
    '/32', // no address
    '2001:db8::/32/48', // two slashes
    '2001:db8::/032', // leading zero
    '2001:db8::/thirty',
    '2001:db8::/1000', // longer than any family's prefix, so a shape failure
    '2001:db8:::/32', // ipv6.ts's own grammar still applies
    'fe80::1%eth0/64', // zone identifiers are excluded from the contract
    '10.0.0.0/8', // an IPv4 network, not this family
    '',
  ])('rejects %s as a parse error', (text) => {
    expect(() => parser.read(token(text))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !cidr6 -- prefix range and host-bits validation errors', () => {
  const parser = createCidr6Parser('cidr6', UNCONSTRAINED);

  it.each(['2001:db8::/129', '2001:db8::/999'])(
    'rejects a prefix length outside the family range: %s',
    (text) => {
      try {
        parser.read(token(text));
        expect.fail('expected a validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(TsonAtomValidationError);
        expect((error as TsonAtomValidationError).expected).toBe('>= 0 and <= 128');
      }
    },
  );

  it('accepts a prefix the IPv4 family would reject -- the range is per family', () => {
    expect(parser.read(token('2001:db8:8000::/33'))).toEqual(cidr6('2001:db8:8000::', 33));
  });

  it.each([
    '2001:db8:1::/32',
    'fe80:0040::/10', // one bit past the prefix, mid-byte
    '::1/0',
  ])('rejects nonzero host bits: %s', (text) => {
    try {
      parser.read(token(text));
      expect.fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect((error as TsonAtomValidationError).expected).toBe('zero host bits beyond the prefix');
    }
  });
});

describe('§5.5 !cidr6 -- cidr6_type minPrefix/maxPrefix facets', () => {
  it('applies both bounds', () => {
    const parser = createCidr6Parser('cidr6', withPrefixBounds(32n, 48n));
    expect(parser.read(token('2001:db8::/32'))).toEqual(cidr6('2001:db8::', 32));
    try {
      parser.read(token('2000::/16'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect((error as TsonAtomValidationError).expected).toBe('>= 32');
    }
    try {
      parser.read(token('2001:db8:0:1::/64'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect((error as TsonAtomValidationError).expected).toBe('<= 48');
    }
  });
});

// §5.5's overlap rule, over the 128-bit family.
describe('§5.5 !cidr6 -- within/excluding are enforced against the network, by overlap', () => {
  it('a network that is a subnet of `within` is accepted; one that is not is a validation error', () => {
    const parser = createCidr6Parser('cidr6', {
      kind: 'cidr6_type',
      spec: 'rfc4291',
      within: ['2001:db8::/32'],
      excluding: [],
    });
    expect(parser.read(token('2001:db8:1::/48'))).toEqual(cidr6('2001:db8:1::', 48));
    expect(() => parser.read(token('2001:db9::/32'))).toThrow(TsonAtomValidationError);
  });

  it('a network wider than an `excluding` block still overlaps it and is refused', () => {
    const parser = createCidr6Parser('cidr6', {
      kind: 'cidr6_type',
      spec: 'rfc4291',
      within: [],
      excluding: ['2001:db8:1::/48'],
    });
    expect(() => parser.read(token('2001:db8::/32'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('2001:db8:1::/64'))).toThrow(TsonAtomValidationError);
    expect(parser.read(token('2001:db8:2::/48'))).toEqual(cidr6('2001:db8:2::', 48));
  });
});
