import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createIntegerParser } from '../src/atom/numeric/integer.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';

// §5.6's integer atoms: the fixed-width int8..int256/uint8..uint256 ladder and the four
// sign-bounded, unbounded-precision refinements, defined against §7.6's integer/based-integer
// productions.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const INT32: IntegerType = { kind: 'integer_type', size: { bits: 32n, signed: true } };
const UINT32: IntegerType = { kind: 'integer_type', size: { bits: 32n, signed: false } };
const UINT64: IntegerType = { kind: 'integer_type', size: { bits: 64n, signed: false } };
const INT8: IntegerType = { kind: 'integer_type', size: { bits: 8n, signed: true } };
const UNCONSTRAINED: IntegerType = { kind: 'integer_type' };

describe('§5.6 integer atoms -- host representation', () => {
  it('a width of 32 bits or less narrows to a plain number', () => {
    const int32 = createIntegerParser('int32', INT32);
    expect(int32.read(token('42'))).toBe(42);
    expect(typeof int32.read(token('42'))).toBe('number');
  });

  it('a width of 64 bits or more stays bigint -- the trap this mapping exists to prevent', () => {
    const uint64 = createIntegerParser('uint64', UINT64);
    const value = uint64.read(token('18446744073709551615'));
    expect(typeof value).toBe('bigint');
    expect(value).toBe(18446744073709551615n);
  });

  it('the unconstrained kernel integer (no declared size) is bigint, arbitrary precision', () => {
    const unconstrained = createIntegerParser('integer', UNCONSTRAINED);
    expect(unconstrained.read(token('123456789012345678901234567890'))).toBe(
      123456789012345678901234567890n,
    );
  });
});

describe('§5.6 integer atoms -- accepted forms', () => {
  it('accepts integer and based-integer forms uniformly, decimal and hex alike', () => {
    const uint32 = createIntegerParser('uint32', UINT32);
    expect(uint32.read(token('0xFF00_0000'))).toBe(4278190080);
    expect(uint32.read(token('+10'))).toBe(10);
  });

  it('rejects a float-form token (§5.6: unlike float32/float64, no float form here)', () => {
    const int32 = createIntegerParser('int32', INT32);
    expect(() => int32.read(token('3.14'))).toThrow(TsonAtomParseError);
  });

  it("the spec's own example: 'twelve' fails the grammar before any range check runs", () => {
    const int32 = createIntegerParser('int32', INT32);
    try {
      int32.read(token('twelve'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).typeRef).toBe('int32');
    }
  });
});

describe('§5.6 integer atoms -- range validation', () => {
  it('inclusive boundaries of the signed 32-bit range are valid', () => {
    const int32 = createIntegerParser('int32', INT32);
    expect(int32.read(token('-2147483648'))).toBe(-2147483648);
    expect(int32.read(token('2147483647'))).toBe(2147483647);
  });

  it("the spec's own example: 9999999999 parses but exceeds the signed 32-bit range -- a validation error", () => {
    const int32 = createIntegerParser('int32', INT32);
    try {
      int32.read(token('9999999999'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect(error).not.toBeInstanceOf(TsonAtomParseError);
    }
  });

  it('§5.6: "the range constraint, not the lexer, enforces unsignedness" -- -10 parses, then fails uint32', () => {
    const uint32 = createIntegerParser('uint32', UINT32);
    expect(() => uint32.read(token('-10'))).toThrow(TsonAtomValidationError);
  });

  it('0 is the inclusive lower bound of the unsigned 32-bit range', () => {
    const uint32 = createIntegerParser('uint32', UINT32);
    expect(uint32.read(token('0'))).toBe(0);
  });

  it("an unsigned 8-bit range needs the wider host representation Java's Byte cannot hold, but number always can", () => {
    const uint8: IntegerType = { kind: 'integer_type', size: { bits: 8n, signed: false } };
    const parser = createIntegerParser('uint8', uint8);
    expect(parser.read(token('255'))).toBe(255);
    expect(() => parser.read(token('256'))).toThrow(TsonAtomValidationError);
  });

  it('exposes a two-sided range as ">= min and <= max" in the expected fragment (§5.2 vocabulary)', () => {
    const int8 = createIntegerParser('int8', INT8);
    try {
      int8.read(token('200'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect((error as TsonAtomValidationError).expected).toBe('>= -128 and <= 127');
    }
  });
});

describe('§5.6 integer atoms -- refinement constraints', () => {
  it('positive_integer => !integer ^ { min: 1 }', () => {
    const positive: IntegerType = { kind: 'integer_type', min: 1n };
    const parser = createIntegerParser('positive_integer', positive);
    expect(parser.read(token('1'))).toBe(1n);
    expect(() => parser.read(token('0'))).toThrow(TsonAtomValidationError);
  });

  it('exclusive_min/exclusive_max exclude the boundary itself', () => {
    const bounded: IntegerType = { kind: 'integer_type', exclusiveMin: 0n, exclusiveMax: 10n };
    const parser = createIntegerParser('bounded', bounded);
    expect(parser.read(token('5'))).toBe(5n);
    expect(() => parser.read(token('0'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('10'))).toThrow(TsonAtomValidationError);
  });

  it('multiple_of rejects a non-multiple', () => {
    const stepped: IntegerType = { kind: 'integer_type', multipleOf: 5n };
    const parser = createIntegerParser('stepped', stepped);
    expect(parser.read(token('15'))).toBe(15n);
    expect(() => parser.read(token('7'))).toThrow(TsonAtomValidationError);
  });
});

describe("§5.6 integer atoms -- write is read's inverse", () => {
  it('writes plain decimal digits for both number and bigint host values', () => {
    expect(createIntegerParser('int32', INT32).write(-7)).toBe('-7');
    expect(createIntegerParser('uint64', UINT64).write(18446744073709551615n)).toBe(
      '18446744073709551615',
    );
  });
});
