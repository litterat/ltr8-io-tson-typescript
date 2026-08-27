import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createIpv6Parser } from '../src/atom/network/ipv6.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { Ipv6Type } from '../src/schema/meta/atoms-network.js';

// §5.5's `!ipv6` atom, RFC 4291 §2.2's text representation. Parsed from scratch rather than
// delegated, per CONFORMANCE.md: the embedded IPv4-mapped tail form would otherwise reintroduce
// !ipv4's own leniency gap.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: Ipv6Type = { kind: 'ipv6_type', spec: 'rfc4291', within: [], excluding: [] };

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe('§5.5 !ipv6 -- accepted forms', () => {
  const parser = createIpv6Parser('ipv6', UNCONSTRAINED);

  it('accepts the full preferred 8-group form', () => {
    expect(parser.read(token('1:2:3:4:5:6:7:8'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00010002000300040005000600070008'),
    });
  });

  it('accepts the unspecified address and loopback', () => {
    expect(parser.read(token('::'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00000000000000000000000000000000'),
    });
    expect(parser.read(token('::1'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00000000000000000000000000000001'),
    });
  });

  it('accepts trailing and mid-address compression', () => {
    expect(parser.read(token('1::'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00010000000000000000000000000000'),
    });
    expect(parser.read(token('2001:db8::1'))).toEqual({
      kind: 'ipv6',
      octets: bytes('20010db8000000000000000000000001'),
    });
  });

  it('accepts compression representing exactly one group', () => {
    expect(parser.read(token('1:2::4:5:6:7:8'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00010002000000040005000600070008'),
    });
  });

  it('accepts uppercase hex digits and leading zeros within a hex group', () => {
    expect(parser.read(token('2001:DB8::1'))).toEqual({
      kind: 'ipv6',
      octets: bytes('20010db8000000000000000000000001'),
    });
    // Unlike ipv4's decimal octets, a hex group's own leading zeros are fine -- a digit count
    // restriction (1-4), not a leading-zero prohibition.
    expect(parser.read(token('0000:0000:0000:0000:0000:0000:0000:0001'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00000000000000000000000000000001'),
    });
  });

  it('accepts the RFC 4291 §2.2 IPv4-mapped and IPv4-tail forms', () => {
    expect(parser.read(token('::ffff:192.0.2.1'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00000000000000000000ffffc0000201'),
    });
    expect(parser.read(token('1:2:3:4:5:6:1.2.3.4'))).toEqual({
      kind: 'ipv6',
      octets: bytes('00010002000300040005000601020304'),
    });
  });
});

describe('§5.5 !ipv6 -- malformed shapes', () => {
  const parser = createIpv6Parser('ipv6', UNCONSTRAINED);

  it('rejects more than one compression run', () => {
    expect(() => parser.read(token('1::2::3'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('1:::2'))).toThrow(TsonAtomParseError);
  });

  it('rejects too few groups without compression and too many groups with or without it', () => {
    expect(() => parser.read(token('1:2:3:4:5:6:7'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('1:2:3:4:5:6:7:8:9'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('1:2:3:4:5:6:7::8'))).toThrow(TsonAtomParseError);
  });

  it('rejects a group with too many hex digits', () => {
    expect(() => parser.read(token('12345::'))).toThrow(TsonAtomParseError);
  });

  it('rejects an IPv4 tail that is not the very last group', () => {
    expect(() => parser.read(token('1.2.3.4::5'))).toThrow(TsonAtomParseError);
  });

  it("rejects an IPv4 tail with a leading zero -- ipv4.ts's own dec-octet strictness reused", () => {
    expect(() => parser.read(token('::ffff:192.0.02.1'))).toThrow(TsonAtomParseError);
  });

  it('rejects a zone identifier -- host-local, excluded from the ipv6 contract (core.tn)', () => {
    expect(() => parser.read(token('fe80::1%eth0'))).toThrow(TsonAtomParseError);
  });

  it('rejects the empty token and plain IPv4 text', () => {
    expect(() => parser.read(token(''))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('192.168.0.1'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !ipv6 -- write', () => {
  it('writes the uncompressed 8-group form, still valid per read, but not the shortest spelling', () => {
    const parser = createIpv6Parser('ipv6', UNCONSTRAINED);
    const written = parser.write(parser.read(token('2001:db8::1')));
    expect(written).toBe('2001:db8:0:0:0:0:0:1');
    expect(parser.read(token(written))).toEqual({
      kind: 'ipv6',
      octets: bytes('20010db8000000000000000000000001'),
    });
  });
});
