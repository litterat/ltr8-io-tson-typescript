import { describe, expect, it } from 'vitest';

import {
  isQualifiedName,
  isSiblingField,
  parseReference,
  parseTypeReference,
  referenceNames,
  referenceText,
} from '../src/atom/referenceGrammar.js';
import { TsonAtomParseError } from '../src/core/errors.js';

/**
 * `atom/referenceGrammar.ts` -- [TSON-DATA] §7.4's `reference` production read from text, the form
 * a JSON string at a reference-typed position holds ([TSON-JSON] §5.6). The same rules
 * `stream/dataStream.ts` applies to tokens.
 */

describe('qualified-name (§7.4, §7.7)', () => {
  it('is one or more identifiers joined by ".", each matched in full', () => {
    expect(isQualifiedName('order')).toBe(true);
    expect(isQualifiedName('geo.address')).toBe(true);
    expect(isQualifiedName('my-type.sub-type')).toBe(true);
  });

  it('refuses an empty segment and a segment that is no identifier', () => {
    for (const text of ['', '.a', 'a.', 'a..b', '42x', 'a.42x', '_id', '-a']) {
      expect(isQualifiedName(text)).toBe(false);
    }
  });
});

describe('sibling-ref (§7.4)', () => {
  it('names one field by a single identifier', () => {
    expect(isSiblingField('kind')).toBe(true);
    expect(isSiblingField('a.b')).toBe(false);
    expect(isSiblingField('')).toBe(false);
    expect(isSiblingField('42x')).toBe(false);
  });

  it('is read to a sibling reference, the "!" ending the text', () => {
    expect(parseReference('kind!')).toEqual({ kind: 'sibling', field: 'kind' });
    expect(() => parseReference('kind!x')).toThrow(TsonAtomParseError);
    expect(() => parseReference('a.b!')).toThrow(/single segment/);
  });

  it('stands only at a record field type: parseTypeReference refuses it (§5.2)', () => {
    expect(() => parseTypeReference('kind!')).toThrow(TsonAtomParseError);
    expect(() => parseTypeReference('kind!')).toThrow(/record field's type/);
  });
});

describe('reference (§7.4)', () => {
  it('a name without arguments is a name', () => {
    expect(parseReference('geo.address')).toEqual({ kind: 'name', name: 'geo.address' });
  });

  it('an application keeps its arguments in order, a nested application a reference of its own', () => {
    expect(parseReference('map<text list<int32>>')).toEqual({
      kind: 'application',
      name: 'map',
      arguments: [
        { kind: 'reference', reference: { kind: 'name', name: 'text' } },
        {
          kind: 'reference',
          reference: {
            kind: 'application',
            name: 'list',
            arguments: [{ kind: 'reference', reference: { kind: 'name', name: 'int32' } }],
          },
        },
      ],
    });
  });

  it('whitespace and a comma inside the list are free: result< T > and result<T> are one reference', () => {
    expect(parseReference('result< T >')).toEqual(parseReference('result<T>'));
    expect(parseReference('pair<a, b>')).toEqual(parseReference('pair<a b>'));
    expect(parseReference('pair<a b,>')).toEqual(parseReference('pair<a b>'));
  });

  it('an argument that is no name is a value, and a quoted one is never a reference', () => {
    expect(parseReference('x<201 "a b" "T">')).toEqual({
      kind: 'application',
      name: 'x',
      arguments: [
        { kind: 'value', text: '201', form: 'unquoted' },
        { kind: 'value', text: 'a b', form: 'single-line' },
        { kind: 'value', text: 'T', form: 'single-line' },
      ],
    });
  });

  it('a quoted argument takes the JSON escapes', () => {
    expect(parseReference('x<"a\\"b\\\\c\\n\\u0041">')).toMatchObject({
      arguments: [{ kind: 'value', text: 'a"b\\c\nA' }],
    });
    expect(() => parseReference('x<"a\\q">')).toThrow(/no escape/);
    expect(() => parseReference('x<"a\\u00">')).toThrow(/four hex digits/);
    expect(() => parseReference('x<"a>')).toThrow(/no closing/);
  });

  it('refuses a sibling reference as an argument (§7.4)', () => {
    expect(() => parseReference('box<kind!>')).toThrow(/sibling reference/);
  });

  it('refuses an unclosed list, an empty one, a missing separator and an argument list on a non-name', () => {
    expect(() => parseReference('box<text')).toThrow(/no closing/);
    expect(() => parseReference('box<>')).toThrow(/at least one argument/);
    expect(() => parseReference('box<a"b">')).toThrow(TsonAtomParseError);
    expect(() => parseReference('42x<a>')).toThrow(TsonAtomParseError);
    expect(() => parseReference('box<42x<a>>')).toThrow(/no qualified name/);
    expect(() => parseReference('box<a> b')).toThrow(/follows the reference/);
    expect(() => parseReference('')).toThrow(/empty/);
  });
});

describe('canonical text and names (§7.4)', () => {
  it('writes no whitespace but one space between arguments, a value keeping its form', () => {
    expect(referenceText(parseReference('map<  text,list<int32>  "a b" 7>'))).toBe(
      'map<text list<int32> "a b" 7>',
    );
    expect(referenceText(parseReference('kind!'))).toBe('kind!');
  });

  it('text reads back to the reference it spells', () => {
    const reference = parseReference('geo.pair<a "x \\"y\\"" 3 b<c>>');
    expect(parseReference(referenceText(reference))).toEqual(reference);
  });

  it('referenceNames lists the head and every reference argument at any depth, never a value', () => {
    expect(referenceNames(parseTypeReference('map<text list<geo.id> 7 "q">'))).toEqual([
      'map',
      'text',
      'list',
      'geo.id',
    ]);
  });
});
