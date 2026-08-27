import { describe, expect, it } from 'vitest';
import { UNICODE_VERSION, isNd, isXidContinue, isXidStart } from '../src/unicode/xid.js';

/**
 * The host's Unicode version, when it can be determined. `process.versions.unicode` is a Node
 * detail and the package itself never reads it — but a test may, and the exhaustive cross-checks
 * below are only meaningful when the host agrees with the generated tables.
 */
const hostUnicodeVersion: string | undefined = (
  globalThis as { process?: { versions?: { unicode?: string } } }
).process?.versions?.unicode;

const hostMatches = hostUnicodeVersion === UNICODE_VERSION;
const describeIfHostMatches = hostMatches ? describe : describe.skip;

const MAX_CODE_POINT = 0x10ffff;

/** Code points that are not scalar values; no well-formed document can contain one. */
function isSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

describe('generated Unicode tables', () => {
  it('records the Unicode version the tables were derived from', () => {
    expect(UNICODE_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it('accepts ASCII letters as identifier starts and continues', () => {
    for (const ch of 'abzABZ') {
      const cp = ch.codePointAt(0);
      if (cp === undefined) throw new Error('unreachable: iterating a non-empty string');
      expect(isXidStart(cp)).toBe(true);
      expect(isXidContinue(cp)).toBe(true);
    }
  });

  it('accepts digits as continues but not as starts', () => {
    // This is the distinction that separates XID_Continue from XID_Start. A generator that
    // applies the start rule to both produces a XID_Continue table with no digits in it, which
    // every numeric-suffixed identifier would then be rejected for.
    for (let cp = 0x30; cp <= 0x39; cp++) {
      expect(isXidStart(cp)).toBe(false);
      expect(isXidContinue(cp)).toBe(true);
      expect(isNd(cp)).toBe(true);
    }
  });

  it('treats XID_Start and XID_Continue as distinct tables', () => {
    // A regression guard with teeth: the two tables were briefly byte-identical because both
    // were derived with the start rule. Any code point that continues but cannot start proves
    // they are not the same set.
    expect(isXidContinue(0x30)).toBe(true);
    expect(isXidStart(0x30)).toBe(false);
  });

  it('excludes code points that are ID_Start but not NFKC-closed', () => {
    // U+037A GREEK YPOGEGRAMMENI is ID_Start, but NFKC expands it to a space followed by iota,
    // and a space cannot start an identifier. It is the canonical XID_Start exclusion.
    expect(isXidStart(0x037a)).toBe(false);
  });

  it('keeps compatibility singletons whose expansion is itself an identifier character', () => {
    // U+2126 OHM SIGN normalises to U+03A9 GREEK CAPITAL OMEGA, which is ID_Start, so the Ohm
    // sign stays in XID_Start. Excluding everything with a compatibility mapping would be wrong.
    expect(isXidStart(0x2126)).toBe(true);
    // U+00B5 MICRO SIGN normalises to U+03BC GREEK SMALL MU.
    expect(isXidStart(0x00b5)).toBe(true);
  });

  it('rejects punctuation, spaces and symbols', () => {
    for (const cp of [0x20, 0x09, 0x0a, 0x2e, 0x2c, 0x3a, 0x7b, 0x7d, 0x5b, 0x5d, 0x21, 0x2d]) {
      expect(isXidStart(cp)).toBe(false);
      expect(isXidContinue(cp)).toBe(false);
    }
  });

  it('rejects the dollar sign, where the reference implementation accepts it', () => {
    // Documented divergence. `$` is Sc, not ID_Start, so real XID tables reject it. The Java
    // uses Character.isUnicodeIdentifierStart, which is a documented approximation of XID and
    // admits `$`. This port is the stricter of the two.
    expect(isXidStart(0x24)).toBe(false);
    expect(isXidContinue(0x24)).toBe(false);
  });

  it('accepts underscore as a continue but not a start', () => {
    expect(isXidStart(0x5f)).toBe(false);
    expect(isXidContinue(0x5f)).toBe(true);
  });

  it('accepts astral identifier characters', () => {
    // U+10400 DESERET CAPITAL LONG I. A table indexed by UTF-16 unit would miss this entirely.
    expect(isXidStart(0x10400)).toBe(true);
    expect(isXidContinue(0x10400)).toBe(true);
  });

  it('rejects code points beyond the Unicode range and below zero', () => {
    expect(isXidStart(MAX_CODE_POINT + 1)).toBe(false);
    expect(isXidContinue(MAX_CODE_POINT + 1)).toBe(false);
    expect(isNd(-1)).toBe(false);
  });

  it('reports non-digit numerics as digits only when they are Nd', () => {
    // U+2160 ROMAN NUMERAL ONE is Nl, not Nd: it is a letter-like number, and the number
    // grammar must not treat it as a digit.
    expect(isNd(0x2160)).toBe(false);
    // U+0660 ARABIC-INDIC DIGIT ZERO is Nd.
    expect(isNd(0x0660)).toBe(true);
  });
});

describeIfHostMatches(`exhaustive cross-check against host Unicode ${UNICODE_VERSION}`, () => {
  // These walk the whole code space and compare the checked-in tables against the host's own
  // property data. They run only when the host's Unicode version matches the one the tables
  // were generated from — a mismatch is a real condition (Node 22 and Node 24 ship different
  // versions), not a failure, and skipping says so rather than producing a false red.

  const idStart = /^\p{ID_Start}$/u;
  const idContinue = /^\p{ID_Continue}$/u;
  const nd = /^\p{Nd}$/u;

  it('matches the host exactly for Nd', () => {
    const mismatches: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (isNd(cp) !== nd.test(String.fromCodePoint(cp))) mismatches.push(cp);
    }
    expect(mismatches).toEqual([]);
  });

  it('is a subset of ID_Start, differing only where NFKC closure fails', () => {
    const unexpected: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      const ch = String.fromCodePoint(cp);
      if (!isXidStart(cp)) continue;
      // Everything the table accepts must at minimum be ID_Start.
      if (!idStart.test(ch)) unexpected.push(cp);
    }
    expect(unexpected).toEqual([]);
  });

  it('is a subset of ID_Continue, differing only where NFKC closure fails', () => {
    const unexpected: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (!isXidContinue(cp)) continue;
      if (!idContinue.test(String.fromCodePoint(cp))) unexpected.push(cp);
    }
    expect(unexpected).toEqual([]);
  });

  it('accepts every ID_Start code point whose NFKC expansion is identifier-shaped', () => {
    const missing: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      const ch = String.fromCodePoint(cp);
      if (!idStart.test(ch)) continue;
      // Array.from iterates code points, not UTF-16 units. Astral characters must stay whole.
      const [first, ...rest] = Array.from(ch.normalize('NFKC'));
      const closed =
        first !== undefined && idStart.test(first) && rest.every((c) => idContinue.test(c));
      if (closed && !isXidStart(cp)) missing.push(cp);
    }
    expect(missing).toEqual([]);
  });

  it('accepts every ID_Continue code point whose NFKC expansion is all continues', () => {
    const missing: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      const ch = String.fromCodePoint(cp);
      if (!idContinue.test(ch)) continue;
      const points = Array.from(ch.normalize('NFKC'));
      const closed = points.length > 0 && points.every((c) => idContinue.test(c));
      if (closed && !isXidContinue(cp)) missing.push(cp);
    }
    expect(missing).toEqual([]);
  });

  it('holds XID_Start as a strict subset of XID_Continue', () => {
    // UAX #31: anything that can start an identifier can continue one.
    const violations: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (isXidStart(cp) && !isXidContinue(cp)) violations.push(cp);
    }
    expect(violations).toEqual([]);
  });

  it('holds every Nd code point as an identifier continue', () => {
    const violations: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (isSurrogate(cp)) continue;
      if (isNd(cp) && !isXidContinue(cp)) violations.push(cp);
    }
    expect(violations).toEqual([]);
  });
});
