import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createUuidParser } from '../src/atom/network/uuid.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { UuidType } from '../src/schema/meta/atoms-text.js';

// §5.5's `!uuid` atom (RFC 9562), requiring the canonical 8-4-4-4-12 grouping -- CONFORMANCE.md:
// `UUID.fromString` alone accepts unpadded groups and silently reinterprets group boundaries.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: UuidType = { kind: 'uuid_type' };

function bytesOf(canonical: string): Uint8Array {
  const hex = canonical.replaceAll('-', '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('§5.5 !uuid -- accepted forms', () => {
  const parser = createUuidParser('uuid', UNCONSTRAINED);
  const canonical = '9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09';

  it('accepts the canonical lowercase form', () => {
    expect(parser.read(token(canonical))).toEqual({ bytes: bytesOf(canonical) });
  });

  it('accepts uppercase hex digits, same value as the lowercase form', () => {
    expect(parser.read(token(canonical.toUpperCase()))).toEqual({ bytes: bytesOf(canonical) });
  });

  it('all zeros is valid', () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    expect(parser.read(token(zero))).toEqual({ bytes: bytesOf(zero) });
  });
});

describe('§5.5 !uuid -- rejects what UUID.fromString would silently accept', () => {
  const parser = createUuidParser('uuid', UNCONSTRAINED);

  it('rejects unpadded groups', () => {
    expect(() => parser.read(token('1-2-3-4-5'))).toThrow(TsonAtomParseError);
  });

  it('rejects a group one hex digit short', () => {
    expect(() => parser.read(token('9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a0'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects no hyphens at all', () => {
    expect(() => parser.read(token('9f1c8e2a4b7d4e6f9a3b2c5d8e7f1a09'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a non-hex character', () => {
    expect(() => parser.read(token('9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7fzz09'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a non-UUID token entirely', () => {
    expect(() => parser.read(token('not-a-uuid'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !uuid -- version constraint (no built-in instance sets it, but implemented)', () => {
  const v4 = '9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09'; // version nibble ('4') is the 13th hex digit

  it('accepts a matching version', () => {
    const parser = createUuidParser('uuid', { kind: 'uuid_type', version: 4 });
    expect(parser.read(token(v4))).toEqual({ bytes: bytesOf(v4) });
  });

  it('rejects a mismatched version as a validation error', () => {
    const parser = createUuidParser('uuid', { kind: 'uuid_type', version: 1 });
    expect(() => parser.read(token(v4))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.5 !uuid -- write', () => {
  it('round trips through read, always in canonical lowercase form', () => {
    const parser = createUuidParser('uuid', UNCONSTRAINED);
    const canonical = '9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09';
    expect(parser.write(parser.read(token(canonical.toUpperCase())))).toBe(canonical);
  });
});
