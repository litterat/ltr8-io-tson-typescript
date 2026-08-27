import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createDurationParser } from '../src/atom/temporal/duration.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { DurationType } from '../src/schema/meta/atoms-temporal.js';

// §5.4's `!duration` atom, ISO 8601 `PnYnMnDTnHnMnS`.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: DurationType = { kind: 'duration_type' };

describe('§5.4 !duration -- valid forms, split into period/clock (value/types.ts TsonDuration)', () => {
  it('a pure calendar duration has no T-time part at all', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('P1Y2M3D'))).toEqual({
      period: 'P1Y2M3D',
      clock: 'PT0S',
    });
  });

  it('a pure clock duration has no calendar part at all', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('PT1H30M'))).toEqual({
      period: 'P0D',
      clock: 'PT1H30M',
    });
  });

  it('the combined form splits calendar and clock into independent substrings', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('P1Y2M3DT4H5M6S'))).toEqual({
      period: 'P1Y2M3D',
      clock: 'PT4H5M6S',
    });
  });

  it('accepts a fractional-second clock designator', () => {
    expect(createDurationParser('duration', UNCONSTRAINED).read(token('PT1.5S'))).toEqual({
      period: 'P0D',
      clock: 'PT1.5S',
    });
  });
});

describe('§5.4 !duration -- CONFORMANCE.md: uppercase designators only, no leading sign', () => {
  it("'P' alone, every designator absent, is not a duration", () => {
    try {
      createDurationParser('duration', UNCONSTRAINED).read(token('P'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).expected).toBe('an ISO 8601 duration');
    }
  });

  it('rejects lowercase designators -- unlike Duration.parse/Period.parse', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('pt1h'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects a leading sign', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('-P1D'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !duration -- open question resolved conservatively: no PnW week form', () => {
  it('rejects the ISO 8601 alternative week-count form', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P3W'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !duration -- a dangling T with no clock designator is rejected', () => {
  it('rejects "P1YT" -- T present but no H/M/S follows it', () => {
    expect(() => createDurationParser('duration', UNCONSTRAINED).read(token('P1YT'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !duration -- write', () => {
  it('recombines period/clock into the single PnYnMnDTnHnMnS form', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write({ period: 'P1Y2M3D', clock: 'PT4H5M6S' })).toBe('P1Y2M3DT4H5M6S');
  });

  it('omits an absent (P0D) calendar half', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write({ period: 'P0D', clock: 'PT1H30M' })).toBe('PT1H30M');
  });

  it('omits an absent (PT0S) clock half', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write({ period: 'P1Y2M3D', clock: 'PT0S' })).toBe('P1Y2M3D');
  });

  it('falls back to PT0S when both halves are absent', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    expect(parser.write({ period: 'P0D', clock: 'PT0S' })).toBe('PT0S');
  });

  it('round-trips every valid vocabulary vector', () => {
    const parser = createDurationParser('duration', UNCONSTRAINED);
    for (const text of ['P1Y2M3D', 'PT1H30M', 'P1Y2M3DT4H5M6S']) {
      expect(parser.write(parser.read(token(text)))).toBe(text);
    }
  });
});
