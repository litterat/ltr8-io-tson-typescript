import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createIpv4Parser } from '../src/atom/network/ipv4.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { Ipv4Type } from '../src/schema/meta/atoms-network.js';

// §5.5's `!ipv4` atom, RFC 3986's `IPv4address`/`dec-octet` production. CONFORMANCE.md is explicit
// that this is a security-motivated strictness, not merely spec fidelity: a lenient parser here is
// the same leniency class behind real SSRF filter bypasses.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: Ipv4Type = { kind: 'ipv4_type', spec: 'rfc3986', within: [], excluding: [] };

describe('§5.5 !ipv4 -- accepted forms', () => {
  it('accepts a canonical dotted-quad', () => {
    const value = createIpv4Parser('ipv4', UNCONSTRAINED).read(token('192.168.0.1'));
    expect(value).toEqual({ kind: 'ipv4', octets: Uint8Array.from([192, 168, 0, 1]) });
  });

  it('accepts the zero and max octets', () => {
    const parser = createIpv4Parser('ipv4', UNCONSTRAINED);
    expect(parser.read(token('0.0.0.0'))).toEqual({
      kind: 'ipv4',
      octets: Uint8Array.from([0, 0, 0, 0]),
    });
    expect(parser.read(token('255.255.255.255'))).toEqual({
      kind: 'ipv4',
      octets: Uint8Array.from([255, 255, 255, 255]),
    });
  });
});

describe('§5.5 !ipv4 -- the leniency the JDK InetAddress accepts, rejected here', () => {
  const parser = createIpv4Parser('ipv4', UNCONSTRAINED);

  it('rejects a leading zero on an octet', () => {
    expect(() => parser.read(token('0177.0.0.1'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('010.0.0.1'))).toThrow(TsonAtomParseError);
  });

  it('rejects the legacy BSD short/class-based form', () => {
    expect(() => parser.read(token('1.2.3'))).toThrow(TsonAtomParseError);
  });

  it('rejects a bare 32-bit integer literal', () => {
    expect(() => parser.read(token('3232235521'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !ipv4 -- other malformed shapes', () => {
  const parser = createIpv4Parser('ipv4', UNCONSTRAINED);

  it('rejects an out-of-range octet', () => {
    expect(() => parser.read(token('256.0.0.1'))).toThrow(TsonAtomParseError);
  });

  it('rejects too few or too many octets', () => {
    expect(() => parser.read(token('1.2.3.4.5'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('1.2.3'))).toThrow(TsonAtomParseError);
  });

  it('rejects IPv6 text', () => {
    expect(() => parser.read(token('::1'))).toThrow(TsonAtomParseError);
  });

  it("the parse error's expected fragment is a grammar shape, per atom/contract.ts's vocabulary", () => {
    try {
      parser.read(token('not-an-address'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).expected).toBe('an IPv4 address');
      expect((error as TsonAtomParseError).typeRef).toBe('ipv4');
    }
  });
});

describe('§5.5 !ipv4 -- write', () => {
  it('round trips through read, in canonical dotted-decimal form', () => {
    const parser = createIpv4Parser('ipv4', UNCONSTRAINED);
    expect(parser.write(parser.read(token('192.168.0.1')))).toBe('192.168.0.1');
  });
});
