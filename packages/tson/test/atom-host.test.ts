import { describe, expect, it } from 'vitest';

import { TsonAtomParseError } from '../src/core/errors.js';
import {
  createHostParser,
  formatIpv6Rfc5952,
  parseHost,
  type HostValue,
} from '../src/atom/network/index.js';
import { parseIpv6Bytes } from '../src/atom/network/ipv6.js';

function refusal(text: string): string {
  try {
    parseHost(text);
  } catch (error) {
    if (error instanceof TsonAtomParseError) return error.message;
    throw error;
  }
  throw new Error(`'${text}' was accepted`);
}

describe('host: a host name, an IPv4 address or an IPv6 address ([TSON-DATA] §5.5)', () => {
  it('reads a host name to the hostname value, canonical text the U-label form', () => {
    const host: HostValue = parseHost('Example.COM');
    expect(host.kind).toBe('hostname');
    expect(host.text).toBe('example.com');
    expect(parseHost('xn--bcher-kva.example').text).toBe('bücher.example');
  });

  it('reads an IPv4 address to its dotted-quad', () => {
    const host = parseHost('192.0.2.1');
    expect(host.kind).toBe('ipv4');
    expect(host.text).toBe('192.0.2.1');
  });

  it('reads an IPv6 address with or without brackets to RFC 5952 text, one value either way', () => {
    expect(parseHost('[2001:DB8::1]').text).toBe('2001:db8::1');
    expect(parseHost('2001:DB8::1').text).toBe('2001:db8::1');
    expect(parseHost('0:0:0:0:0:0:0:1').text).toBe('::1');
    expect(parseHost('[0:0:0:0:0:0:0:1]').text).toBe('::1');
    expect(parseHost('[::1]').kind).toBe('ipv6');
  });

  it('never equates an IPv4 address with an IPv6 one, even its IPv4-mapped form (§5.5)', () => {
    expect(parseHost('127.0.0.1').text).not.toBe(parseHost('::ffff:127.0.0.1').text);
    expect(parseHost('::ffff:7f00:1').text).toBe('::ffff:127.0.0.1');
  });

  it('refuses a zone identifier, which is local to one machine', () => {
    expect(refusal('fe80::1%eth0')).toContain('zone identifier');
    expect(refusal('[fe80::1%eth0]')).toContain('zone identifier');
  });

  it('refuses IPvFuture and a malformed IP literal', () => {
    expect(refusal('[v1.x]')).toContain('must be one');
    expect(refusal('[::1')).toContain('must be one');
    expect(refusal('::1]')).toContain('must be one');
    expect(refusal('1:2:3')).toContain('must be one');
  });

  it('refuses dotted digits that are not an IPv4 address rather than reading them as a name', () => {
    expect(refusal('1.2.3')).toContain('not an IPv4 address');
    expect(refusal('256.0.0.1')).toContain('not an IPv4 address');
    expect(refusal('01.2.3.4')).toContain('not an IPv4 address');
  });

  it("refuses what is no host name, with the name grammar's reason", () => {
    expect(refusal('exa_mple.com')).toContain("'_'");
    expect(refusal('example.com.')).toContain('trailing dot');
  });

  it('names the type it was asked as, and what it expected', () => {
    try {
      parseHost('', 'listener_host');
      expect.unreachable();
    } catch (error) {
      expect((error as TsonAtomParseError).typeRef).toBe('listener_host');
      expect((error as TsonAtomParseError).expected).toBe(
        'a host name, an IPv4 address or an IPv6 address',
      );
    }
  });
});

describe('host: RFC 5952 text (§4)', () => {
  function text(address: string): string {
    const octets = parseIpv6Bytes(address);
    if (octets === undefined) throw new Error(`${address} is not an IPv6 address`);
    return formatIpv6Rfc5952(octets);
  }

  it('suppresses leading zeros and lowercases (§4.1, §4.3)', () => {
    expect(text('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });

  it('compresses the longest run of zero groups, the first on a tie (§4.2.3)', () => {
    expect(text('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(text('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
  });

  it('never compresses a single zero group (§4.2.2)', () => {
    expect(text('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
  });

  it('writes the unspecified address and a trailing run with both colons', () => {
    expect(text('::')).toBe('::');
    expect(text('2001:db8::')).toBe('2001:db8::');
    expect(text('::2')).toBe('::2');
  });
});

describe('host: the AtomType (§5.5)', () => {
  const atom = createHostParser('host');
  const form = 'unquoted' as const;

  it("reads to the member's canonical text, so one host in two spellings is one value", () => {
    expect(atom.read({ text: '[::1]', form })).toBe(atom.read({ text: '0:0:0:0:0:0:0:1', form }));
    expect(atom.write(atom.read({ text: 'LOCALHOST', form }))).toBe('localhost');
  });
});
