import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createCidr4Parser } from '../src/atom/network/cidr4.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { Cidr4Type } from '../src/schema/meta/atoms-network.js';

// §5.5's `!cidr4` atom (RFC 4632): a dotted-quad address, '/', and a prefix length of 0-32. Per
// §5.5's own split, a token that isn't CIDR-shaped is a parse error; a prefix outside the family
// range or an address with nonzero host bits is a validation error -- so these tests assert which,
// not merely that something was rejected.

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: Cidr4Type = {
  kind: 'cidr4_type',
  spec: 'rfc4632',
  within: [],
  excluding: [],
};

function withPrefixBounds(minPrefix?: number, maxPrefix?: number): Cidr4Type {
  return {
    ...UNCONSTRAINED,
    ...(minPrefix !== undefined && { minPrefix }),
    ...(maxPrefix !== undefined && { maxPrefix }),
  };
}

describe('§5.5 !cidr4 -- accepted networks, text preserved exactly', () => {
  const parser = createCidr4Parser('cidr4', UNCONSTRAINED);

  it.each([
    '10.0.0.0/8',
    '192.168.0.0/16',
    '192.0.2.128/25', // host bits zero at a non-byte boundary
    '203.0.113.5/32', // a single host is a valid /32 network
    '0.0.0.0/0', // the whole space
  ])('accepts %s and returns the authored text unchanged', (text) => {
    expect(parser.read(token(text))).toEqual({ kind: 'cidr4', text });
  });

  it('write is the identity over the authored text', () => {
    expect(parser.write({ kind: 'cidr4', text: '10.0.0.0/8' })).toBe('10.0.0.0/8');
  });
});

describe('§5.5 !cidr4 -- malformed networks are parse errors', () => {
  const parser = createCidr4Parser('cidr4', UNCONSTRAINED);

  it.each([
    '10.0.0.0', // no prefix at all
    '10.0.0.0/', // empty prefix
    '/8', // no address
    '10.0.0.0/8/16', // two slashes
    '10.0.0.0/08', // leading zero -- a second spelling of /8
    '10.0.0.0/+8',
    '10.0.0.0/ 8',
    '10.0.0.0/eight',
    '10.0.0.0/1000', // longer than any family's prefix, so a shape failure
    '0177.0.0.0/8', // ipv4.ts's own leading-zero octet rule still applies
    '10.0.0/8', // BSD short form
    '2001:db8::/32', // an IPv6 network, not this family
    '',
  ])('rejects %s as a parse error', (text) => {
    expect(() => parser.read(token(text))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !cidr4 -- a prefix outside the family range is a validation error', () => {
  const parser = createCidr4Parser('cidr4', UNCONSTRAINED);

  it.each(['10.0.0.0/33', '10.0.0.0/128', '10.0.0.0/999'])('rejects %s', (text) => {
    try {
      parser.read(token(text));
      expect.fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect((error as TsonAtomValidationError).expected).toBe('>= 0 and <= 32');
    }
  });
});

describe('§5.5 !cidr4 -- nonzero host bits are a validation error (the value is a network)', () => {
  const parser = createCidr4Parser('cidr4', UNCONSTRAINED);

  it.each([
    '10.1.0.0/8',
    '192.0.2.1/24',
    '192.0.2.129/25', // one bit past the prefix, mid-byte
    '10.0.0.1/0',
  ])('rejects %s', (text) => {
    try {
      parser.read(token(text));
      expect.fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect((error as TsonAtomValidationError).expected).toBe('zero host bits beyond the prefix');
    }
  });
});

describe('§5.5 !cidr4 -- cidr4_type minPrefix/maxPrefix facets', () => {
  it('applies minPrefix', () => {
    const parser = createCidr4Parser('cidr4', withPrefixBounds(16, undefined));
    expect(parser.read(token('192.168.0.0/16'))).toEqual({ kind: 'cidr4', text: '192.168.0.0/16' });
    try {
      parser.read(token('10.0.0.0/8'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect((error as TsonAtomValidationError).expected).toBe('>= 16');
    }
  });

  it('applies maxPrefix', () => {
    const parser = createCidr4Parser('cidr4', withPrefixBounds(undefined, 24));
    expect(parser.read(token('192.0.2.0/24'))).toEqual({ kind: 'cidr4', text: '192.0.2.0/24' });
    try {
      parser.read(token('192.0.2.128/25'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect((error as TsonAtomValidationError).expected).toBe('<= 24');
    }
  });

  it('a bound outside the family range neither fails nor widens (family range still applies)', () => {
    const parser = createCidr4Parser('cidr4', withPrefixBounds(undefined, 64));
    expect(parser.read(token('192.0.2.0/24'))).toEqual({ kind: 'cidr4', text: '192.0.2.0/24' });
    expect(() => parser.read(token('10.0.0.0/33'))).toThrow(TsonAtomValidationError);
  });
});
