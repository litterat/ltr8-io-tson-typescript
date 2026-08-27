import { describe, expect, it } from 'vitest';
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonNotImplementedError,
} from '../src/core/errors.js';
import { createDateTimeParser } from '../src/atom/temporal/datetime.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { DateTimeType } from '../src/schema/meta/atoms-temporal.js';

// §5.4's `!datetime` atom, RFC 3339 `date-time = full-date "T" full-time`.

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: DateTimeType = { kind: 'datetime_type' };

describe('§5.4 !datetime -- valid forms', () => {
  it('accepts full-date T full-time, MUST be quoted', () => {
    expect(
      createDateTimeParser('datetime', UNCONSTRAINED).read(token('2025-03-13T10:15:30Z')),
    ).toEqual({
      date: { year: 2025, month: 3, day: 13 },
      time: { hour: 10, minute: 15, second: 30, nanosecond: 0, offset: { totalMinutes: 0 } },
    });
  });

  it('RFC 3339 allows lowercase t/z as alternatives to T/Z, value is canonical uppercase', () => {
    const parser = createDateTimeParser('datetime', UNCONSTRAINED);
    const value = parser.read(token('2025-03-13t10:15:30z'));
    expect(parser.write(value)).toBe('2025-03-13T10:15:30Z');
  });
});

describe('§5.4 !datetime -- date-time requires the T/t separator specifically', () => {
  it('rejects a space in place of the separator', () => {
    expect(() =>
      createDateTimeParser('datetime', UNCONSTRAINED).read(token('2025-03-13 10:15:30Z')),
    ).toThrow(TsonAtomParseError);
  });
});

describe('§5.4 !datetime -- CONFORMANCE.md: inherits full-date/full-time strictness', () => {
  it('rejects an extended-year date half', () => {
    expect(() =>
      createDateTimeParser('datetime', UNCONSTRAINED).read(token('+12025-03-13T10:15:30Z')),
    ).toThrow(TsonAtomParseError);
  });

  it('rejects a missing offset on the time half', () => {
    expect(() =>
      createDateTimeParser('datetime', UNCONSTRAINED).read(token('2025-03-13T10:15:30')),
    ).toThrow(TsonAtomParseError);
  });
});

describe('§5.4 !datetime -- datetime_type min/max, instant-normalised across dates', () => {
  it('a bound is compared by absolute instant, not by field', () => {
    const bounded: DateTimeType = {
      kind: 'datetime_type',
      min: {
        date: { year: 2025, month: 1, day: 2 },
        time: { hour: 0, minute: 0, second: 0, nanosecond: 0 },
        offsetSeconds: 0,
      },
    };
    // 2025-01-01T23:00-02:00 is 2025-01-02T01:00Z, which is after the minimum instant.
    expect(() =>
      createDateTimeParser('datetime', bounded).read(token('2025-01-01T23:00:00-02:00')),
    ).not.toThrow();
    // 2025-01-01T23:00Z is before the 2025-01-02T00:00Z minimum instant.
    expect(() =>
      createDateTimeParser('datetime', bounded).read(token('2025-01-01T23:00:00Z')),
    ).toThrow(TsonAtomValidationError);
  });
});

describe('§5.4 !datetime -- precision/requireTimezone refused', () => {
  it('refuses a schema that sets precision', () => {
    expect(() =>
      createDateTimeParser('datetime', { kind: 'datetime_type', precision: 3n }),
    ).toThrow(TsonNotImplementedError);
  });
});
