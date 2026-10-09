import { describe, expect, it } from 'vitest';

import { createDefinitionMetaReader, metaAtomDecoder } from '../src/schema/metaReader.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import { fromBytes, runSync } from '../src/io/bytes.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import type { Top } from '../src/schema/meta/typedef.js';
import type { AtomBinding } from '../src/bind/binding.js';
import type { TokenValue } from '../src/ast/value.js';

const KERNEL_ID = 'https://tson.io/2026/37/m/meta-kernel.tn';
const META_ID = 'https://tson.io/2026/37/m/meta.tn';

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

// ── Constructor applications read through the governing meta (§5.5, §5.7) ──────────────────────

describe('createDefinitionMetaReader -- the Revision 37 constructors', () => {
  const tson = standardLibrary();
  const kernel = tson.schemas.get(canonicalizeIdentity(KERNEL_ID));
  if (kernel === undefined) throw new Error('the standard library registers meta-kernel');
  const meta = tson.schemas.get(canonicalizeIdentity(META_ID));
  if (meta === undefined) throw new Error('the standard library registers meta');
  const read = createDefinitionMetaReader(
    (name) => meta.entries.get(name) ?? kernel.entries.get(name),
  );

  function body(typeRef: string, source: string): Top {
    const { document } = runSync(parseDocument(fromBytes(encodeUtf8(`!${typeRef} ${source}`))));
    return read(typeRef, document.root);
  }

  it('an identifier_type instance takes the profile and normalization defaults the kernel declares', () => {
    expect(body('identifier_type', '{ continue_add: "-" }')).toEqual({
      kind: 'identifier_type',
      spec: 'https://www.unicode.org/reports/tr31/',
      normalization: 'NFC',
      start: 'XID',
      continue: 'XID',
      continueAdd: '-',
    });
  });

  it('a text_type takes normalization NONE, and a regex_type fixes it', () => {
    expect(body('text_type', '{}')).toEqual({ kind: 'text_type', normalization: 'NONE' });
    expect(body('regex_type', '{}')).toMatchObject({ kind: 'regex_type', normalization: 'NONE' });
  });

  it('a uri_type permits relative references and fragments until it withdraws either, and holds schemes as a set', () => {
    expect(body('uri_type', '{}')).toMatchObject({
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
    });
    expect(body('uri_type', '{ allow_relative: false  schemes: [http https] }')).toMatchObject({
      allowRelative: false,
      schemes: ['http', 'https'],
    });
  });

  it('an enum pins its type to identifier, a text_enum to text, and an enum_type states its own', () => {
    expect(body('enum', '[A B]')).toEqual({
      kind: 'enum',
      type: 'identifier',
      members: ['A', 'B'],
    });
    expect(body('text_enum', '["a b" c]')).toEqual({
      kind: 'enum',
      type: 'text',
      members: ['a b', 'c'],
    });
    expect(body('enum_type', '{ type: kebab  members: [a-b] }')).toEqual({
      kind: 'enum',
      type: 'kebab',
      members: ['a-b'],
    });
  });

  it('an array is ordered and a map unordered unless they say otherwise (§5.3, §7.5)', () => {
    expect(body('array', '{ element_type: text }')).toMatchObject({
      ordered: true,
      voidable: false,
    });
    expect(body('map', '{ key_type: text  value_type: text }')).toMatchObject({
      ordered: false,
      voidable: false,
    });
    expect(body('set_type', '{ element_type: text }')).toMatchObject({
      ordered: false,
      uniqueItems: true,
    });
  });

  it('a field group reads its options, its optional members, and defaults optional to false (§5.11)', () => {
    const group = body(
      'record',
      '{ fields: [ { name: a  type: text  optional: true } { name: b  type: text  optional: true } ]  groups: [ { members: [[a b]]  optional_members: [a b] } ] }',
    );
    expect(group).toMatchObject({
      kind: 'record',
      groups: [{ members: [['a', 'b']], optionalMembers: ['a', 'b'], optional: false }],
    });
  });

  it('a template reads its typed parameters, a bound only on a type parameter', () => {
    const held = body(
      'template',
      '{ parameters: [ { name: T  type: type_ref  bound: text } { name: N  type: non_negative_integer } ]  template: "!array { element_type: T }" }',
    );
    expect(held).toMatchObject({
      parameters: [
        { name: 'T', type: { name: 'type_ref' }, bound: { name: 'text' } },
        { name: 'N', type: { name: 'non_negative_integer' } },
      ],
    });
  });
});
