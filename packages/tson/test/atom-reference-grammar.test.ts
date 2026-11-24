import { describe, expect, it } from 'vitest';

import { isQualifiedName, isSiblingField, parseReference } from '../src/atom/referenceGrammar.js';
import { TsonAtomParseError } from '../src/core/errors.js';

/**
 * `atom/referenceGrammar.ts` -- a reference's text, whatever the token's form ([TSON-DATA] §2.4,
 * §7.4): the form a JSON string at a reference-typed position holds ([TSON-JSON] §5.6). A reference
 * in a value is a qualified name, and an argument list or a dependent type's mark is schema
 * grammar (§4.1, §7.2.5).
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

describe('a dependent type names one field (§7.4, [TSON-SCHEMA] §12.1)', () => {
  it('is one identifier, a single segment', () => {
    expect(isSiblingField('kind')).toBe(true);
    expect(isSiblingField('a.b')).toBe(false);
    expect(isSiblingField('')).toBe(false);
    expect(isSiblingField('42x')).toBe(false);
  });
});

describe('a reference is a qualified name (§2.4, §4.1)', () => {
  it('a name is a name', () => {
    expect(parseReference('geo.address')).toEqual('geo.address');
  });

  it('is read in NFC, so a decomposed spelling is the name its composed one is (§7.7)', () => {
    expect(parseReference('café')).toEqual('café');
  });

  it('refuses an argument list, saying an application is named by a declaration (§4.1)', () => {
    for (const text of ['set<text>', 'map<text list<int32>>', 'box<>']) {
      expect(() => parseReference(text)).toThrow(TsonAtomParseError);
      expect(() => parseReference(text)).toThrow(/argument list is schema grammar/);
    }
  });

  it('refuses a dependent type\'s mark, "kind!" being outside the grammar ([TSON-JSON] §5.6)', () => {
    expect(() => parseReference('kind!')).toThrow(TsonAtomParseError);
    expect(() => parseReference('kind!')).toThrow(/schema grammar/);
  });

  it('refuses an empty text, an empty segment and a first segment that is no identifier', () => {
    expect(() => parseReference('')).toThrow(/empty/);
    expect(() => parseReference('a..b')).toThrow(/empty segment/);
    expect(() => parseReference('.a')).toThrow(/empty segment/);
    expect(() => parseReference('42x.a')).toThrow(/no name/);
  });

  it('leaves a segment past the first to the family of what it enters ([TSON-SCHEMA] §5.12)', () => {
    expect(parseReference('orders.42x')).toEqual('orders.42x');
  });
});
