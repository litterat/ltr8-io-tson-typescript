import { describe, expect, it } from 'vitest';

import { metaAtomDecoder } from '../src/schema/metaReader.js';
import type { AtomBinding } from '../src/bind/binding.js';
import type { TokenValue } from '../src/ast/value.js';

// A `value`-typed schema facet is read under the atom the slot stands for, once that atom is in
// scope (§7.4). `date_type`/`time_type`/`datetime_type` are the three families the kernel types
// directly by name rather than through `value` (§7.4's kernel exception is `integer_type` alone),
// so `metaAtomDecoder` must decode their own tokens into the structured shape the corresponding
// `schema/bindings.ts` binding expects -- `calendarDateBinding`/`offsetTimeBinding`/
// `offsetDateTimeBinding`'s own doc comments.

function atomBinding<T>(wireType: string): AtomBinding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

function token(text: string): TokenValue {
  return { kind: 'token', text, form: 'unquoted' };
}

describe('metaAtomDecoder -- date/time/datetime (§7.4)', () => {
  it("decodes 'date' into a CalendarDate, calendarDateBinding's own expected shape", () => {
    expect(metaAtomDecoder(atomBinding('date'), token('2020-01-01'))).toEqual({
      year: 2020,
      month: 1,
      day: 1,
    });
  });

  it('rejects a token that is not a valid RFC 3339 full-date', () => {
    expect(() => metaAtomDecoder(atomBinding('date'), token('not-a-date'))).toThrow();
  });

  it("decodes 'time' into offsetTimeBinding's own expected PlainTime shape", () => {
    expect(metaAtomDecoder(atomBinding('time'), token('12:00:00.500Z'))).toEqual({
      hour: 12,
      minute: 0,
      second: 0,
      nanosecond: 500_000_000,
      offset: { totalMinutes: 0 },
    });
  });

  it("decodes 'datetime' into offsetDateTimeBinding's own expected PlainDateTime shape", () => {
    expect(metaAtomDecoder(atomBinding('datetime'), token('2020-01-01T12:00:00+01:00'))).toEqual({
      date: { year: 2020, month: 1, day: 1 },
      time: { hour: 12, minute: 0, second: 0, nanosecond: 0, offset: { totalMinutes: 60 } },
    });
  });

  it("rejects a 'datetime' token with a space instead of the T/t separator", () => {
    expect(() => metaAtomDecoder(atomBinding('datetime'), token('2020-01-01 12:00:00Z'))).toThrow();
  });
});
