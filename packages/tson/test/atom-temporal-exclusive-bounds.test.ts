import { describe, expect, it } from 'vitest';
import { TsonAtomValidationError } from '../src/core/errors.js';
import { createDateParser } from '../src/atom/temporal/date.js';
import { createDateTimeParser } from '../src/atom/temporal/datetime.js';
import { createTimeParser } from '../src/atom/temporal/time.js';
import type { AtomToken } from '../src/atom/contract.js';
import { checkAtomCoherence, checkAtomNarrows } from '../src/compiler/atomChecks.js';
import type {
  DateTimeType,
  DateType,
  OffsetDateTime,
  OffsetTime,
  TimeType,
} from '../src/schema/meta/atoms-temporal.js';

// §5.5 and §5.7: `( min | exclusive_min )?` and `( max | exclusive_max )?` on the date, time and
// datetime constructors, ordered by the value and never by its spelling.

const token = (text: string): AtomToken => ({ text, form: 'single-line' });

const day = (year: number, month: number, d: number) => ({ year, month, day: d });
const time = (hour: number, minute: number, offsetSeconds: number): OffsetTime => ({
  time: { hour, minute, second: 0, nanosecond: 0 },
  offsetSeconds,
});
const instant = (
  date: { year: number; month: number; day: number },
  hour: number,
  offsetSeconds: number,
): OffsetDateTime => ({
  date,
  time: { hour, minute: 0, second: 0, nanosecond: 0 },
  offsetSeconds,
});

function violation(run: () => unknown): TsonAtomValidationError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(TsonAtomValidationError);
    return e as TsonAtomValidationError;
  }
  throw new Error('expected a validation error');
}

describe('§5.5 date exclusive bounds on read', () => {
  const read = (constraints: DateType, text: string) =>
    createDateParser('date', constraints).read(token(text));

  it('a date equal to exclusive_min is refused, one a day above is admitted', () => {
    const constraints: DateType = { kind: 'date_type', exclusiveMin: day(2026, 1, 1) };
    expect(violation(() => read(constraints, '2026-01-01')).expected).toBe('> 2026-01-01');
    expect(read(constraints, '2026-01-02')).toEqual(day(2026, 1, 2));
  });

  it('a date equal to exclusive_max is refused, one a day below is admitted', () => {
    const constraints: DateType = { kind: 'date_type', exclusiveMax: day(2026, 1, 1) };
    expect(violation(() => read(constraints, '2026-01-01')).expected).toBe('< 2026-01-01');
    expect(read(constraints, '2025-12-31')).toEqual(day(2025, 12, 31));
  });

  it('an inclusive bound still admits its own value', () => {
    expect(read({ kind: 'date_type', min: day(2026, 1, 1) }, '2026-01-01')).toEqual(
      day(2026, 1, 1),
    );
  });
});

describe('§5.5 time and datetime bounds order the value, not its spelling', () => {
  it('11:00:00+01:00 ties with an exclusive_min written 10:00:00Z, so it is refused', () => {
    const constraints: TimeType = { kind: 'time_type', exclusiveMin: time(10, 0, 0) };
    expect(() => createTimeParser('time', constraints).read(token('11:00:00+01:00'))).toThrow(
      TsonAtomValidationError,
    );
  });

  it('a time whose offset carries it past midnight is its UTC time of day: 23:30:00-02:00 is 01:30:00Z', () => {
    const constraints: TimeType = { kind: 'time_type', max: time(2, 0, 0) };
    expect(() => createTimeParser('time', constraints).read(token('23:30:00-02:00'))).not.toThrow();
    const after: TimeType = { kind: 'time_type', min: time(1, 30, 0), max: time(1, 30, 0) };
    expect(() => createTimeParser('time', after).read(token('23:30:00-02:00'))).not.toThrow();
  });

  it('a datetime tying an exclusive_max across offsets is refused', () => {
    const constraints: DateTimeType = {
      kind: 'datetime_type',
      exclusiveMax: instant(day(2026, 1, 1), 10, 0),
    };
    expect(() =>
      createDateTimeParser('datetime', constraints).read(token('2026-01-01T11:00:00+01:00')),
    ).toThrow(TsonAtomValidationError);
    expect(() =>
      createDateTimeParser('datetime', constraints).read(token('2026-01-01T09:59:59Z')),
    ).not.toThrow();
  });
});

describe('§5.7 date, time and datetime refinement', () => {
  it('an exclusive floor under an inclusive source floor at the same value tightens', () => {
    const source: DateType = { kind: 'date_type', min: day(2026, 1, 1) };
    const refined: DateType = { kind: 'date_type', exclusiveMin: day(2026, 1, 1) };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });

  it('an inclusive floor over an exclusive source floor at the same value widens', () => {
    const source: DateType = { kind: 'date_type', exclusiveMin: day(2026, 1, 1) };
    const refined: DateType = { kind: 'date_type', min: day(2026, 1, 1) };
    expect(checkAtomNarrows(source, refined)).toHaveLength(1);
  });

  it('a time bound restated in another offset is the same value, so it tightens vacuously', () => {
    const source: TimeType = { kind: 'time_type', exclusiveMax: time(10, 0, 0) };
    const refined: TimeType = { kind: 'time_type', exclusiveMax: time(11, 0, 3600) };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });

  it('a datetime bound restated in another offset is the same instant', () => {
    const source: DateTimeType = {
      kind: 'datetime_type',
      min: instant(day(2026, 1, 1), 10, 0),
    };
    const refined: DateTimeType = {
      kind: 'datetime_type',
      min: instant(day(2026, 1, 1), 11, 3600),
    };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });
});

describe("§7.4 coherence of a date, time or datetime body's bounds", () => {
  it('exclusive_min meeting max at one date leaves nothing', () => {
    const body: DateType = {
      kind: 'date_type',
      exclusiveMin: day(2026, 1, 1),
      max: day(2026, 1, 1),
    };
    expect(checkAtomCoherence(body)).toHaveLength(1);
  });

  it('min equal to max is coherent: it pins one date', () => {
    const body: DateType = { kind: 'date_type', min: day(2026, 1, 1), max: day(2026, 1, 1) };
    expect(checkAtomCoherence(body)).toEqual([]);
  });

  it('two time bounds in different offsets meeting at one value, one exclusive, are empty', () => {
    const body: TimeType = {
      kind: 'time_type',
      exclusiveMin: time(10, 0, 0),
      max: time(11, 0, 3600),
    };
    expect(checkAtomCoherence(body)).toHaveLength(1);
  });

  it('a datetime ceiling below its floor, written in another offset, is refused', () => {
    const body: DateTimeType = {
      kind: 'datetime_type',
      min: instant(day(2026, 1, 1), 10, 0),
      max: instant(day(2026, 1, 1), 10, 3600),
    };
    expect(checkAtomCoherence(body)).toHaveLength(1);
  });
});
