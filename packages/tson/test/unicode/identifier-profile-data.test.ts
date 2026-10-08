import { describe, expect, it } from 'vitest';
import {
  NAME_PROFILE,
  checkIdentifier,
  identifierProfileOf,
  profileIncoherence,
  profileSeparates,
  restrictedCharacterViolation,
  type IdentifierProfile,
} from '../../src/unicode/identifier-profile.js';
import { DEFAULT_NAME_POLICY, judgeName, perSegment } from '../../src/unicode/policy.js';
import { createConfusableScope } from '../../src/unicode/skeleton.js';

// [TSON-SCHEMA] §5.5, §7.7: an identifier profile as data, built from `identifier_type`'s facets.

const CYR_A = 'а';
const ZWJ = '\u200d';
const NKO = 'ߨ'; // XID_Continue, Identifier_Status=Restricted

function profile(
  facets: Partial<Parameters<typeof identifierProfileOf>[0]> = {},
): IdentifierProfile {
  return identifierProfileOf({
    start: 'XID',
    continue: 'XID',
    normalization: 'NFC',
    ...facets,
  });
}

/** `header_name`'s profile from the corpus: lowercase letters, digits and `-`, folded. */
const HEADER_NAME = profile({
  start: 'NONE',
  continue: 'NONE',
  startAdd: 'abcdefghijklmnopqrstuvwxyz',
  continueAdd: 'abcdefghijklmnopqrstuvwxyz0123456789-',
  normalization: 'NFKC_CASEFOLD',
});

describe('checkIdentifier -- the kernel identifier (§7.7)', () => {
  it('NAME_PROFILE is the profile `identifier => !identifier_type { continue_add: "-" }` builds', () => {
    expect(profile({ continueAdd: '-' })).toEqual(NAME_PROFILE);
  });

  it('admits a name and refuses what §7.7 refuses', () => {
    expect(checkIdentifier(NAME_PROFILE, 'content-type')).toBeUndefined();
    expect(checkIdentifier(NAME_PROFILE, '')).toContain('may not be empty');
    expect(checkIdentifier(NAME_PROFILE, '2fast')).toContain('never begins with a digit');
    expect(checkIdentifier(NAME_PROFILE, 'a b')).toContain('U+0020 at index 1');
  });

  it('refuses text not in the profile’s normalization form rather than normalising it', () => {
    expect(checkIdentifier(NAME_PROFILE, 'café')).toContain('not in NFC form');
    expect(checkIdentifier(HEADER_NAME, 'Content-Type')).toContain('not in NFKC_CASEFOLD form');
  });

  it('indexes a character after a supplementary one by UTF-16 offset but judges it by code point', () => {
    expect(checkIdentifier(NAME_PROFILE, '\u{1d7d8}')).toContain('cannot start an identifier');
    expect(checkIdentifier(NAME_PROFILE, 'a\u{1f600}')).toContain('U+1F600 at index 1');
  });
});

describe('checkIdentifier -- a profile of its own (§5.5)', () => {
  it('judges the value: a folding profile of lowercase letters admits what the fold produces', () => {
    expect(checkIdentifier(HEADER_NAME, 'content-type')).toBeUndefined();
    expect(checkIdentifier(HEADER_NAME, '9lives')).toContain('cannot start an identifier');
  });

  it('a medial character stands only between two others and never beside another medial', () => {
    const kebab = profile({ medial: '-' });
    expect(checkIdentifier(kebab, 'content-type')).toBeUndefined();
    expect(checkIdentifier(kebab, 'content-')).toContain('medial character and cannot end');
    expect(checkIdentifier(kebab, '-content')).toContain('cannot start an identifier');
    expect(checkIdentifier(kebab, 'a--b')).toContain('follows another medial');
  });

  it('draws Start and Continue from ID_Start/ID_Continue when asked', () => {
    const idProfile = profile({ start: 'ID', continue: 'ID' });
    expect(checkIdentifier(idProfile, 'abc')).toBeUndefined();
  });

  it('exclude removes a character from both Start and Continue', () => {
    const noUnderscore = profile({ exclude: '_' });
    expect(checkIdentifier(noUnderscore, 'a_b')).toContain('cannot appear in an identifier');
    expect(checkIdentifier(NAME_PROFILE, 'a_b')).toBeUndefined();
  });

  it('keeps §7.7 rule 2’s join-control contexts under every profile', () => {
    expect(checkIdentifier(profile(), `a${ZWJ}b`)).toContain('join control');
    expect(checkIdentifier(profile({ start: 'ID', continue: 'ID' }), `a${ZWJ}b`)).toContain(
      'join control',
    );
    // A folding profile never sees the joiner: the fold removes it, so the text is not in the form.
    expect(checkIdentifier(HEADER_NAME, `a${ZWJ}b`)).toContain('not in NFKC_CASEFOLD form');
  });
});

describe('profileIncoherence (§5.5)', () => {
  it('refuses a profile with an empty Start set', () => {
    const empty = profile({ start: 'NONE', continue: 'NONE', continueAdd: 'abc' });
    expect(profileIncoherence(empty)).toEqual([
      'the Start set is empty, so no text is an identifier',
    ]);
    expect(
      profileIncoherence(profile({ start: 'NONE', startAdd: 'a', exclude: 'a' })),
    ).toHaveLength(1);
  });

  it('refuses a medial character that is also Start or Continue', () => {
    expect(profileIncoherence(profile({ continueAdd: '-', medial: '-' }))).toEqual([
      'U+002D is medial and also Start or Continue',
    ]);
    expect(profileIncoherence(profile({ medial: 'a' }))).toHaveLength(1);
  });

  it('finds nothing wrong with the kernel identifier or a clean medial', () => {
    expect(profileIncoherence(NAME_PROFILE)).toEqual([]);
    expect(profileIncoherence(profile({ medial: '-' }))).toEqual([]);
  });
});

describe('restrictedCharacterViolation and profileSeparates (§8.2)', () => {
  it('a character the profile adds meets no restricted-character rule', () => {
    const dollar = profile({ continueAdd: '$' });
    expect(restrictedCharacterViolation(dollar, 'a$b')).toBeUndefined();
    expect(restrictedCharacterViolation(NAME_PROFILE, `a${NKO}`)).toContain(
      'Identifier_Status=Restricted',
    );
  });

  it('a character the profile adds that is not XID_Continue divides a name into segments', () => {
    expect(profileSeparates(NAME_PROFILE, 0x2d)).toBe(true); // `-`
    expect(profileSeparates(NAME_PROFILE, 0x5f)).toBe(true); // `_`
    expect(profileSeparates(NAME_PROFILE, 0x61)).toBe(false);
    expect(profileSeparates(profile({ medial: '.' }), 0x2e)).toBe(true);
    expect(profileSeparates(NAME_PROFILE, 0x2e)).toBe(false);
  });
});

describe('judgeName -- every rule a name fails (§8.2)', () => {
  it('reports the restricted-character rule before the restricted-script rule, and both for a name failing both', () => {
    const name = `${CYR_A}dmin${NKO}`;
    const violations = judgeName(name, NAME_PROFILE, DEFAULT_NAME_POLICY);
    expect(violations.map((v) => v.mechanism)).toEqual(['identifier-status', 'restriction-level']);
  });

  it('reports one rule alone when only one fails', () => {
    expect(
      judgeName(`${CYR_A}dmin`, NAME_PROFILE, DEFAULT_NAME_POLICY).map((v) => v.mechanism),
    ).toEqual(['restriction-level']);
    expect(judgeName('admin', NAME_PROFILE, DEFAULT_NAME_POLICY)).toEqual([]);
  });

  it('divides a name at the profile’s own separators under a per-segment unit', () => {
    const policy = perSegment(DEFAULT_NAME_POLICY);
    const mixed = `id-${CYR_A}${CYR_A}`;
    expect(judgeName(mixed, NAME_PROFILE, policy)).toEqual([]);
    // Under a profile that does not add `-`, the hyphen is not a separator and the name mixes scripts.
    const dollar = profile({ continueAdd: '$' });
    expect(judgeName(`id$${CYR_A}${CYR_A}`, dollar, policy)).toEqual([]);
    expect(judgeName(`id-${CYR_A}${CYR_A}`, profile(), policy)).toHaveLength(1);
  });
});

describe('createConfusableScope -- a scope filled a name at a time (§8.2, §11.4)', () => {
  it('answers the earlier name the new one reads alike with, reported at the second', () => {
    const scope = createConfusableScope();
    expect(scope.add('pass')).toBeUndefined();
    expect(scope.add('раѕѕ')).toEqual({
      first: 'pass',
      second: 'раѕѕ',
    });
  });

  it('a name equal to one already added collides with nothing: a repeat is a duplicate, another rule’s', () => {
    const scope = createConfusableScope();
    scope.add('pass');
    expect(scope.add('pass')).toBeUndefined();
  });
});
