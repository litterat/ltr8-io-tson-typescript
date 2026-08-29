import { describe, expect, it } from 'vitest';
import { isIdentifierText } from '../src/unicode/identifier-profile.js';

// §7.7's bare production plus rule 1 (NFC). Rule 2 (the joining-control contextual rule) is
// deliberately not implemented here — see the module's own doc comment — so a text containing a
// joiner is judged only by the production and NFC, never by UTS #39 context, in these tests.

describe('isIdentifierText (§7.7)', () => {
  it('accepts an ordinary ASCII identifier', () => {
    expect(isIdentifierText('my_type')).toBe(true);
    expect(isIdentifierText('Alice')).toBe(true);
  });

  it('accepts a hyphenated identifier', () => {
    expect(isIdentifierText('my-type')).toBe(true);
    expect(isIdentifierText('A-100')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isIdentifierText('')).toBe(false);
  });

  it('rejects a digit-initial text', () => {
    // identifier-start = XID_Start, which excludes Nd — unlike the unquoted-token profile, which
    // admits Nd so a number can also be an unquoted token.
    expect(isIdentifierText('42x')).toBe(false);
    expect(isIdentifierText('0')).toBe(false);
  });

  it('rejects a sign-initial text', () => {
    expect(isIdentifierText('-foo')).toBe(false);
    expect(isIdentifierText('+foo')).toBe(false);
  });

  it('rejects a dot anywhere — not an identifier-continue character', () => {
    // Unlike the token profile, `.` is not part of identifier-continue: only `-` is.
    expect(isIdentifierText('a.b')).toBe(false);
    expect(isIdentifierText('.foo')).toBe(false);
  });

  it('rejects a plus sign anywhere', () => {
    expect(isIdentifierText('a+b')).toBe(false);
  });

  it('accepts a hyphen in continuation position but rejects it as the first character', () => {
    expect(isIdentifierText('a-b')).toBe(true);
    expect(isIdentifierText('-ab')).toBe(false); // '-' is not XID_Start
  });

  it('rejects underscore as the first character: no identifier begins with it (rule 3)', () => {
    // `_` is XID_Continue only, never XID_Start, so identifier-start already refuses it — no
    // special case is written for this anywhere in the module.
    expect(isIdentifierText('_')).toBe(false);
    expect(isIdentifierText('_id')).toBe(false);
  });

  it('accepts underscore in continuation position', () => {
    expect(isIdentifierText('my_type')).toBe(true);
  });

  it('treats true/false/null as ordinary identifiers: no reserved-word list (rule 3)', () => {
    expect(isIdentifierText('true')).toBe(true);
    expect(isIdentifierText('false')).toBe(true);
    expect(isIdentifierText('null')).toBe(true);
  });

  it('accepts non-ASCII XID_Start scripts', () => {
    expect(isIdentifierText('名前')).toBe(true);
  });

  it('rejects text that is not NFC-normalized (rule 1)', () => {
    // "café" with a combining acute accent (U+0301) rather than the precomposed é (U+00E9).
    const decomposed = 'café';
    expect(decomposed.normalize('NFC')).not.toBe(decomposed);
    expect(isIdentifierText(decomposed)).toBe(false);
  });

  it('accepts the precomposed NFC form of the same text', () => {
    expect(isIdentifierText('café')).toBe(true);
  });

  it('rejects a space or structural character', () => {
    expect(isIdentifierText('my type')).toBe(false);
    expect(isIdentifierText('my{type')).toBe(false);
  });

  it('refuses a joiner where it is invisible, which the production alone would admit (rule 2)', () => {
    // ZWNJ/ZWJ are XID_Continue, so the production admits them anywhere after the first
    // character; UTS #39 §3.1.1.1's contexts are what keep them out of a Latin name, where they
    // have no shaping effect and every use is a spoof.
    expect(isIdentifierText('ad‌min')).toBe(false);
  });

  it('admits a joiner where it does shape the text', () => {
    // Persian: ZWNJ between HEH and ALEF breaks a cursive connection that would otherwise join.
    expect(isIdentifierText('کتاب‌ها')).toBe(true);
  });
});
