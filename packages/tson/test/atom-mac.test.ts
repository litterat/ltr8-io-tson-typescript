import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createMacParser } from '../src/atom/network/mac.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { MacType } from '../src/schema/meta/atoms-network.js';

// §5.5's `!mac` atom (EUI-48 per RFC 9542): six hex octets, colon- or hyphen-separated, not mixed.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: MacType = { kind: 'mac_type', spec: 'rfc9542' };

describe('§5.5 !mac -- accepts both separator forms in any hex case', () => {
  const parser = createMacParser('mac', UNCONSTRAINED);

  it.each([
    ['00-1B-63-84-45-E6', Uint8Array.from([0x00, 0x1b, 0x63, 0x84, 0x45, 0xe6])],
    ['00:1B:63:84:45:E6', Uint8Array.from([0x00, 0x1b, 0x63, 0x84, 0x45, 0xe6])],
    ['aa-bb-cc-dd-ee-ff', Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])],
    ['FF:FF:FF:FF:FF:FF', Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ['00-00-00-00-00-00', Uint8Array.from([0, 0, 0, 0, 0, 0])],
  ] as const)('accepts %s', (text, octets) => {
    expect(parser.read(token(text))).toEqual({ octets });
  });
});

describe('§5.5 !mac -- write picks a canonical spelling (see mac.ts TSDoc)', () => {
  it('the host value is bytes, not the authored text, so write always returns lowercase colon form', () => {
    const parser = createMacParser('mac', UNCONSTRAINED);
    expect(parser.write(parser.read(token('aa-BB-cc-DD-ee-FF')))).toBe('aa:bb:cc:dd:ee:ff');
  });
});

describe('§5.5 !mac -- rejects mixed separators (alternatives, not a per-octet character class)', () => {
  it('rejects a colon/hyphen mix', () => {
    const parser = createMacParser('mac', UNCONSTRAINED);
    expect(() => parser.read(token('00-1B:63-84:45-E6'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !mac -- rejects anything else', () => {
  const parser = createMacParser('mac', UNCONSTRAINED);

  it.each([
    '00-1B-63-84-45', // five octets
    '00-1B-63-84-45-E6-77', // seven
    '00-1B-63-84-45-E', // short octet
    '00-1B-63-84-45-E66', // long octet
    '001B.6384.45E6', // Cisco dotted-quad form, not EUI-48
    '00 1B 63 84 45 E6', // space-separated
    'GG-1B-63-84-45-E6', // non-hex
    '001B638445E6', // unseparated
    '',
  ])('rejects %s', (text) => {
    expect(() => parser.read(token(text))).toThrow(TsonAtomParseError);
  });
});
