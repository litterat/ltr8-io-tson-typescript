import { describe, expect, it } from 'vitest';
import { isXidContinue } from '../src/unicode/xid.js';
import { isUnquotedTokenContinue, isUnquotedTokenStart } from '../src/unicode/token-profile.js';

// §7.1's UAX #31 profile (requirement R1):
//   Start    = XID_Start ∪ Nd ∪ { - + . }
//   Continue = XID_Continue ∪ { - + . }

describe('isUnquotedTokenStart (§7.1)', () => {
  it('accepts ASCII letters', () => {
    expect(isUnquotedTokenStart(0x61 /* a */)).toBe(true);
    expect(isUnquotedTokenStart(0x5a /* Z */)).toBe(true);
  });

  it('accepts decimal digits of any script via Nd', () => {
    expect(isUnquotedTokenStart(0x30 /* 0 */)).toBe(true);
    expect(isUnquotedTokenStart(0x0660 /* ARABIC-INDIC DIGIT ZERO */)).toBe(true);
  });

  it('accepts the three profile extension characters', () => {
    expect(isUnquotedTokenStart(0x2d /* - */)).toBe(true);
    expect(isUnquotedTokenStart(0x2b /* + */)).toBe(true);
    expect(isUnquotedTokenStart(0x2e /* . */)).toBe(true);
  });

  it('rejects underscore, reserved to the absent sentinel at token-initial position', () => {
    // §7.1: "Underscore (U+005F) is in XID_Continue but not XID_Start ... Token-initial
    // underscore is reserved to the format and occupied by the absent sentinel _."
    expect(isUnquotedTokenStart(0x5f)).toBe(false);
  });

  it('rejects structural and special characters', () => {
    for (const cp of [0x20, 0x2c, 0x3a, 0x7b, 0x7d, 0x5b, 0x5d, 0x40, 0x21]) {
      expect(isUnquotedTokenStart(cp)).toBe(false);
    }
  });

  it('rejects the dollar sign, as the Java reference implementation also does', () => {
    // Not a divergence. `$` is Sc, so the real XID_Start table excludes it — and so does
    // Character.isUnicodeIdentifierStart, which returns false for U+0024. Verified against the
    // JDK rather than assumed.
    expect(isUnquotedTokenStart(0x24)).toBe(false);
  });

  it('excludes ZWNJ and ZWJ, which §7.1 subtracts from the profile', () => {
    // The subtraction is load-bearing, not defensive: from Unicode 16 both are XID_Continue, so a
    // profile built from the property alone admits exactly the two code points the spec removes.
    // They are invisible, hence confusable and spoofing surface (§9.4); a name needing them must
    // be quoted.
    for (const cp of [0x200c, 0x200d]) {
      expect(isXidContinue(cp), 'the property still admits it').toBe(true);
      expect(isUnquotedTokenStart(cp), 'but the profile must not').toBe(false);
      expect(isUnquotedTokenContinue(cp), 'in either position').toBe(false);
    }
  });

  it('rejects the other identifier-ignorable characters the Java admits', () => {
    // isUnicodeIdentifierPart returns true for all of these; real XID tables reject them. U+FEFF
    // is the one worth reporting upstream — §7.1 says a byte-order mark is not a character of the
    // token, so here this port is right and the reference is wrong.
    for (const cp of [0x00ad, 0x2060, 0xfeff, 0x0000, 0x0008, 0x007f]) {
      expect(isUnquotedTokenContinue(cp), `U+${cp.toString(16).toUpperCase()}`).toBe(false);
    }
  });

  it('accepts astral identifier characters', () => {
    expect(isUnquotedTokenStart(0x10400 /* DESERET CAPITAL LONG I */)).toBe(true);
  });
});

describe('isUnquotedTokenContinue (§7.1)', () => {
  it('accepts underscore as a continuation character', () => {
    expect(isUnquotedTokenContinue(0x5f)).toBe(true);
  });

  it('accepts ASCII letters and digits', () => {
    expect(isUnquotedTokenContinue(0x61)).toBe(true);
    expect(isUnquotedTokenContinue(0x39 /* 9 */)).toBe(true);
  });

  it('accepts the three profile extension characters', () => {
    expect(isUnquotedTokenContinue(0x2d)).toBe(true);
    expect(isUnquotedTokenContinue(0x2b)).toBe(true);
    expect(isUnquotedTokenContinue(0x2e)).toBe(true);
  });

  it('rejects whitespace and structural characters', () => {
    for (const cp of [0x20, 0x09, 0x0a, 0x2c, 0x3a, 0x7b, 0x7d]) {
      expect(isUnquotedTokenContinue(cp)).toBe(false);
    }
  });

  it('rejects a non-identifier symbol', () => {
    expect(isUnquotedTokenContinue(0x2019 /* RIGHT SINGLE QUOTATION MARK */)).toBe(false);
  });

  it('holds every start character as also a continue character', () => {
    // XID_Start ⊆ XID_Continue (UAX #31), and Nd ⊆ XID_Continue too, so Start ⊆ Continue as a
    // whole even though the Continue formula does not repeat Nd.
    const sample = [0x61, 0x30, 0x2d, 0x2b, 0x2e, 0x0660, 0x10400];
    for (const cp of sample) {
      expect(isUnquotedTokenStart(cp)).toBe(true);
      expect(isUnquotedTokenContinue(cp)).toBe(true);
    }
  });
});
