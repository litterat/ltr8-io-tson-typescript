import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createDateParser } from '../src/atom/temporal/date.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { DateType } from '../src/schema/meta/atoms-temporal.js';

// §5.4's `!date` atom, RFC 3339 `full-date`.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: DateType = { kind: 'date_type' };

describe('§5.4 !date -- valid forms', () => {
  it('accepts full-date unquoted (§5.4: full-date values are valid unquoted)', () => {
    expect(createDateParser('date', UNCONSTRAINED).read(token('2025-03-13'))).toEqual({
      year: 2025,
      month: 3,
      day: 13,
    });
  });

  it('2024 is a leap year -- February 29 is a valid calendar date', () => {
    expect(createDateParser('date', UNCONSTRAINED).read(token('2024-02-29'))).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });
});

describe('§5.4 !date -- CONFORMANCE.md: stricter than LocalDate.parse', () => {
  it('rejects ISO 8601 extended-year form (leading sign, >4 digits)', () => {
    try {
      createDateParser('date', UNCONSTRAINED).read(token('+12025-03-13'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
      expect((error as TsonAtomParseError).expected).toBe('an RFC 3339 full-date');
    }
  });

  it('2023 is not a leap year -- February 29 is a parse error, not a validation error', () => {
    try {
      createDateParser('date', UNCONSTRAINED).read(token('2023-02-29'));
      expect.fail('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomParseError);
    }
  });

  it('rejects a month outside 01-12', () => {
    expect(() => createDateParser('date', UNCONSTRAINED).read(token('2025-13-01'))).toThrow(
      TsonAtomParseError,
    );
  });

  it('rejects trailing garbage past the ten-character shape', () => {
    expect(() => createDateParser('date', UNCONSTRAINED).read(token('2025-03-13x'))).toThrow(
      TsonAtomParseError,
    );
  });
});

describe('§5.4 !date -- date_type min/max', () => {
  const bounded: DateType = {
    kind: 'date_type',
    min: { year: 2020, month: 1, day: 1 },
    max: { year: 2020, month: 12, day: 31 },
  };

  it('inclusive boundaries are valid', () => {
    expect(createDateParser('date', bounded).read(token('2020-01-01'))).toEqual({
      year: 2020,
      month: 1,
      day: 1,
    });
    expect(createDateParser('date', bounded).read(token('2020-12-31'))).toEqual({
      year: 2020,
      month: 12,
      day: 31,
    });
  });

  it('before the minimum is a validation error, not a parse error', () => {
    try {
      createDateParser('date', bounded).read(token('2019-12-31'));
      expect.fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect((error as TsonAtomValidationError).expected).toBe('>= 2020-01-01');
    }
  });

  it('after the maximum is a validation error', () => {
    expect(() => createDateParser('date', bounded).read(token('2021-01-01'))).toThrow(
      TsonAtomValidationError,
    );
  });
});

describe('§5.4 !date -- write', () => {
  it('round-trips to the exact full-date form, zero-padded', () => {
    const parser = createDateParser('date', UNCONSTRAINED);
    expect(parser.write(parser.read(token('2025-03-13')))).toBe('2025-03-13');
    expect(parser.write({ year: 5, month: 1, day: 2 })).toBe('0005-01-02');
  });
});
