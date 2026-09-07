import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createDurationParser } from '../src/atom/temporal/duration.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { DurationType } from '../src/schema/meta/atoms-temporal.js';

// §5.4's `!duration` atom: RFC 3339 Appendix A's `dur-date`/`dur-time`/`dur-week`, restricted to
// no `Y` or month-`M` component. The value space is a signed exact count of nanoseconds.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: DurationType = { kind: 'duration_type' };

function duration(nanoseconds: bigint) {
  return { nanoseconds };
}

describe('§5.4 !duration -- valid forms', () => {
  it('a clock-only span reads as its exact nanosecond count', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('PT1H30M'))).toEqual(
      duration(5_400_000_000_000n),
    );
  });

  it('accepts a fractional-second clock designator, down to nanosecond resolution', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('PT1.5S'))).toEqual(
      duration(1_500_000_000n),
    );
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('PT0.000000001S'))).toEqual(
      duration(1n),
    );
  });

  it('a standalone PnW is accepted -- a week is exactly 7 days', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('P3W'))).toEqual(
      duration(1_814_400_000_000_000n),
    );
  });

  it('PT90M, PT1H30M and P0DT5400S are one value', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    const ninety = parser.read(token('PT90M'));
    expect(parser.read(token('PT1H30M'))).toEqual(ninety);
    expect(parser.read(token('P0DT5400S'))).toEqual(ninety);
  });

  it('accepts a leading sign', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('-PT1H'))).toEqual(
      duration(-3_600_000_000_000n),
    );
  });

  it('accepts the widest magnitude, 2^63 - 1 nanoseconds, both signs', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    const widest = 9_223_372_036_854_775_807n;
    expect(parser.read(token('PT9223372036.854775807S'))).toEqual(duration(widest));
    expect(parser.read(token('-PT9223372036.854775807S'))).toEqual(duration(-widest));
  });
});

describe('§5.4 !duration -- shape errors (TsonAtomParseError, category resolver)', () => {
  it("'P' alone, every designator absent, is not a duration", () => {
    try {
      createDurationParser('duration', UNCONSTRAINED).read(token('P'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).expected).toBe('a duration');
    }
  });

  it('rejects lowercase designators -- unlike Duration.parse', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('pt1h'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a Y component -- a year has no fixed length, so it is a period', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P1Y2M3D'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects the combined calendar-and-clock form (P1Y2M3DT4H5M6S) -- gone with the split', () => {
    expect(() =>
      createDurationParser('duration', UNCONSTRAINED).read(token('P1Y2M3DT4H5M6S')),
    ).toThrow(TsonAtomParseError);
  });

  it('rejects PnW mixed with any other component -- the week form stands alone', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P1W2D'))).toThrow(
      TsonAtomParseError,
    );
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P1WT1H'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects "P1YT" -- T present but no H/M/S follows it', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P1YT'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a fractional second past nine digits -- a resolver error, not validation', () => {
    expect(() =>
      createDurationParser('duration', UNCONSTRAINED).read(token('PT0.0000000001S')),
    ).toThrow(TsonAtomParseError);
  });
});

describe('§5.4 !duration -- magnitude errors (TsonAtomValidationError, category validation)', () => {
  it('one nanosecond past the ceiling is refused', () => {
    expect(() =>
      createDurationParser('duration', UNCONSTRAINED).read(token('PT9223372036.854775808S')),
    ).toThrow(TsonAtomValidationError);
  });

  it('the ceiling is a magnitude, not the asymmetric int64 range', () => {
    expect(() =>
      createDurationParser('duration', UNCONSTRAINED).read(token('-PT9223372036.854775808S')),
    ).toThrow(TsonAtomValidationError);
  });
});

describe('§5.4 !duration -- write', () => {
  it('writes the canonical PTnHnMnS form', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write(duration(5_400_000_000_000n))).toBe('PT1H30M');
  });

  it('writes a negative duration with the sign before P', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write(duration(-3_600_000_000_000n))).toBe('-PT1H');
  });

  it('writes zero as PT0S', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).write(duration(0n))).toBe('PT0S');
  });

  it('day and week spellings do not survive a round trip -- PTnHnMnS only', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write(parser.read(token('P3W')))).toBe('PT504H');
    expect(parser.write(parser.read(token('P9DT1H')))).toBe('PT217H');
  });

  it('round-trips every PTnHnMnS value it writes', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    for (const text of ['PT1H30M', 'PT4H5M6S', 'PT1.5S', 'PT0S']) {
      expect(parser.write(parser.read(token(text)))).toBe(text);
    }
  });
});
