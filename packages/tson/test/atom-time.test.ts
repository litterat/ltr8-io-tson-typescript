import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createTimeParser } from '../src/atom/temporal/time.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { TimeType } from '../src/schema/meta/atoms-temporal.js';

// §5.4's `!time` atom, RFC 3339 `full-time`.

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: TimeType = { kind: 'time_type' };

describe('§5.4 !time -- valid forms', () => {
  it('accepts a UTC full-time (MUST be quoted -- it contains colons)', () => {
    expect(createTimeParser('time', UNCONSTRAINED).read(token('10:15:30Z'))).toEqual({
      hour: 10,
      minute: 15,
      second: 30,
      nanosecond: 0,
      offset: { totalMinutes: 0 },
    });
  });

  it('accepts a signed numeric offset', () => {
    expect(createTimeParser('time', UNCONSTRAINED).read(token('10:15:30+05:30'))).toEqual({
      hour: 10,
      minute: 15,
      second: 30,
      nanosecond: 0,
      offset: { totalMinutes: 330 },
    });
  });

  it('RFC 3339 allows lowercase z as an alternative to Z', () => {
    expect(createTimeParser('time', UNCONSTRAINED).read(token('10:15:30z'))).toEqual({
      hour: 10,
      minute: 15,
      second: 30,
      nanosecond: 0,
      offset: { totalMinutes: 0 },
    });
  });

  it('accepts a fractional second', () => {
    expect(createTimeParser('time', UNCONSTRAINED).read(token('10:15:30.5Z'))).toEqual({
      hour: 10,
      minute: 15,
      second: 30,
      nanosecond: 500_000_000,
      offset: { totalMinutes: 0 },
    });
  });
});

describe('§5.4 !time -- full-time = partial-time time-offset, offset mandatory', () => {
  it('rejects a bare local time with no offset at all', () => {
    expect(() => createTimeParser('time', UNCONSTRAINED).read(token('10:15:30'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !time -- CONFORMANCE.md: one accepted, unfixable gap', () => {
  it('rejects a spec-legal leap second (60) -- java.time has no leap-second concept', () => {
    expect(() => createTimeParser('time', UNCONSTRAINED).read(token('23:59:60Z'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !time -- offset bound (±18:00, java.time.ZoneOffset)', () => {
  it('rejects an offset beyond ±18:00', () => {
    expect(() => createTimeParser('time', UNCONSTRAINED).read(token('10:15:30+19:00'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('accepts exactly ±18:00', () => {
    expect(createTimeParser('time', UNCONSTRAINED).read(token('10:15:30+18:00')).offset).toEqual({
      totalMinutes: 1080,
    });
  });
});

describe('§5.4 !time -- time_type min/max, instant-normalised', () => {
  it('a bound written in one offset compares correctly against a value in another', () => {
    const bounded: TimeType = {
      kind: 'time_type',
      min: { time: { hour: 9, minute: 0, second: 0, nanosecond: 0 }, offsetSeconds: 0 },
    };
    // 10:00+05:30 is 04:30Z, which is before the 09:00Z minimum.
    expect(() => createTimeParser('time', bounded).read(token('10:00:00+05:30'))).toThrow(
      TsonAtomValidationError,
    );
    // 15:00+05:30 is 09:30Z, which is after the 09:00Z minimum.
    expect(() => createTimeParser('time', bounded).read(token('15:00:00+05:30'))).not.toThrow();
  });
});

describe('§5.5 !time -- precision', () => {
  it('accepts a token at exactly the bound', () => {
    const parser = createTimeParser('time', { kind: 'time_type', precision: 3n });
    expect(parser.read(token('10:15:30.100Z')).nanosecond).toBe(100000000);
  });

  it('accepts a token under the bound', () => {
    const parser = createTimeParser('time', { kind: 'time_type', precision: 3n });
    expect(parser.read(token('10:15:30Z')).nanosecond).toBe(0);
  });

  it('rejects a token with more written digits than the bound, even with trailing zeros', () => {
    const parser = createTimeParser('time', { kind: 'time_type', precision: 3n });
    // Four written digits, even though the trailing zero means the same nanosecond count as
    // `.100` would -- precision is judged on the written token (§5.5), not the parsed value.
    expect(() => parser.read(token('10:15:30.1000Z'))).toThrow(TsonAtomValidationError);
  });

  it('precision: 0 admits no fractional part at all', () => {
    const parser = createTimeParser('time', { kind: 'time_type', precision: 0n });
    expect(parser.read(token('10:15:30Z')).nanosecond).toBe(0);
    expect(() => parser.read(token('10:15:30.1Z'))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.4 !time -- write', () => {
  it('round-trips, normalising a lowercase z to canonical uppercase Z', () => {
    const parser = createTimeParser('time', UNCONSTRAINED);
    expect(parser.write(parser.read(token('10:15:30z')))).toBe('10:15:30Z');
  });

  it('trims trailing zero fraction digits', () => {
    const parser = createTimeParser('time', UNCONSTRAINED);
    expect(parser.write(parser.read(token('10:15:30.500Z')))).toBe('10:15:30.5Z');
  });
});
