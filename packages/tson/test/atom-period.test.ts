import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createPeriodParser } from '../src/atom/temporal/period.js';
import type { AtomToken } from '../src/atom/contract.js';

// §5.4's `!period` atom: `P` with a `Y` component, an `M` component, or both, and nothing else.
// The value space is a signed integer count of months.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

function period(months: bigint) {
  return { months };
}

describe('§5.4 !period -- valid forms', () => {
  it('a Y component alone is twelve months per year', () => {
    expect(createPeriodParser('period').read(token('P1Y'))).toEqual(period(12n));
  });

  it('an M component alone', () => {
    expect(createPeriodParser('period').read(token('P18M'))).toEqual(period(18n));
  });

  it('Y then M, in that order', () => {
    expect(createPeriodParser('period').read(token('P1Y6M'))).toEqual(period(18n));
  });

  it('P1Y and P12M are one value', () => {
    const parser = createPeriodParser('period');
    expect(parser.read(token('P1Y'))).toEqual(parser.read(token('P12M')));
  });

  it('P0Y, P0M and -P0M are one value', () => {
    const parser = createPeriodParser('period');
    const zero = period(0n);
    expect(parser.read(token('P0Y'))).toEqual(zero);
    expect(parser.read(token('P0M'))).toEqual(zero);
    expect(parser.read(token('-P0M'))).toEqual(zero);
  });

  it('accepts a leading sign', () => {
    expect(createPeriodParser('period').read(token('-P3M'))).toEqual(period(-3n));
  });
});

describe('§5.4 !period -- shape errors (TsonAtomParseError, category resolver)', () => {
  it("'P' alone, neither Y nor M present, is not a period", () => {
    try {
      createPeriodParser('period').read(token('P'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).expected).toBe('a period');
    }
  });

  it('rejects a D component -- a day has a fixed length, so it is a duration', () => {
    expect(() => createPeriodParser('period').read(token('P1M15D'))).toThrow(TsonAtomParseError);
  });

  it('rejects M before Y -- the grammar admits Y then M, no other order', () => {
    expect(() => createPeriodParser('period').read(token('P6M1Y'))).toThrow(TsonAtomParseError);
  });

  it('rejects a T (clock) part', () => {
    expect(() => createPeriodParser('period').read(token('P1YT1H'))).toThrow(TsonAtomParseError);
  });

  it('rejects a W component -- a week has a fixed length, so it is a duration', () => {
    expect(() => createPeriodParser('period').read(token('P2W'))).toThrow(TsonAtomParseError);
  });

  it('rejects lowercase designators', () => {
    expect(() => createPeriodParser('period').read(token('p1y'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.4 !period -- write', () => {
  it('writes whole years and a remaining months component', () => {
    const parser = createPeriodParser('period');
    expect(parser.write(period(18n))).toBe('P1Y6M');
    expect(parser.write(period(12n))).toBe('P1Y');
    expect(parser.write(period(6n))).toBe('P6M');
  });

  it('writes zero as P0M', () => {
    expect(createPeriodParser('period').write(period(0n))).toBe('P0M');
  });

  it('writes a negative period with the sign before P', () => {
    expect(createPeriodParser('period').write(period(-18n))).toBe('-P1Y6M');
  });

  it('round-trips every value it writes', () => {
    const parser = createPeriodParser('period');
    for (const text of ['P1Y', 'P6M', 'P1Y6M', 'P0M', '-P3M']) {
      expect(parser.write(parser.read(token(text)))).toBe(text);
    }
  });
});
