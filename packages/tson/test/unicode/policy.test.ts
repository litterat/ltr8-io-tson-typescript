import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAME_POLICY,
  DEFAULT_TOKEN_POLICY,
  appliesIdentifierProfile,
  nameHygieneRefusal,
  perSegment,
  tokenPolicy,
  tokenSatisfiesPolicy,
  withIdentifierStatus,
  withRestrictionLevel,
  withSkeletonDistinctness,
} from '../../src/unicode/policy.js';

// [TSON-DATA] §8.2's name-hygiene policy value type. Mixed-script/confusable examples are built
// from code points rather than typed literals, matching `unicode/skeleton.test.ts`/
// `unicode/restriction-level.test.ts`'s own convention -- a literal confusable is unreviewable.

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

const CYR_A = cp(0x0430); // Cyrillic а
const GREEK_ALPHA = cp(0x03b1);
const RESTRICTED = cp(0x07e8); // NKo letter: XID_Continue, Identifier_Status=Restricted

describe('DEFAULT_NAME_POLICY (§8.2 defaults)', () => {
  it('enforces mechanisms 1 and 2, mechanism 3 at Highly Restrictive over the whole name', () => {
    expect(DEFAULT_NAME_POLICY).toEqual({
      skeletonDistinctness: true,
      identifierStatus: true,
      restrictionLevel: 'HIGHLY_RESTRICTIVE',
      restrictionUnit: 'WHOLE_NAME',
    });
  });
});

describe('appliesIdentifierProfile', () => {
  it('is on whenever identifierStatus is on and the level is not Unrestricted', () => {
    expect(appliesIdentifierProfile(DEFAULT_NAME_POLICY)).toBe(true);
    expect(
      appliesIdentifierProfile(withRestrictionLevel(DEFAULT_NAME_POLICY, 'MINIMALLY_RESTRICTIVE')),
    ).toBe(true);
  });

  it('Unrestricted drops the identifier profile too, taking mechanism 2 with it (§8.2)', () => {
    expect(
      appliesIdentifierProfile(withRestrictionLevel(DEFAULT_NAME_POLICY, 'UNRESTRICTED')),
    ).toBe(false);
  });

  it('an explicit identifierStatus:false turns it off independent of the level', () => {
    expect(appliesIdentifierProfile(withIdentifierStatus(DEFAULT_NAME_POLICY, false))).toBe(false);
  });
});

describe('nameHygieneRefusal -- mechanism 1 (skeleton distinctness, a relation over the scope)', () => {
  it('refuses §8.2s own Latin/Cyrillic admin/аdmin pair', () => {
    // 'аdmin' mixes Cyrillic а with Latin 'dmin' *within one word*, so at the default policy this
    // pair also trips mechanism 3 (restriction level) on 'аdmin' alone -- see the whole-script
    // 'aec'/'аес' pair below for a pair that isolates mechanism 1 from mechanism 3.
    const refusal = nameHygieneRefusal(['admin', CYR_A + 'dmin']);
    expect(refusal).toBeDefined();
  });

  it('refuses the whole-script aec/аес pair -- each name single-script, so only mechanism 1 can see it', () => {
    const refusal = nameHygieneRefusal(['aec', cp(0x0430, 0x0435, 0x0441)]);
    expect(refusal?.mechanism).toBe('skeleton-distinctness');
    expect(refusal?.names).toEqual(['aec', cp(0x0430, 0x0435, 0x0441)]);
  });

  it('never fires on a lone name -- it is a relation, not a property of one name', () => {
    const name =
      'id_' +
      cp(
        0x043f,
        0x043e,
        0x043b,
        0x044c,
        0x0437,
        0x043e,
        0x0432,
        0x0430,
        0x0442,
        0x0435,
        0x043b,
        0x044f,
      );
    // mechanism 1 alone would find nothing here; disable 2 and 3 to isolate it.
    const policy = withRestrictionLevel(
      withIdentifierStatus(DEFAULT_NAME_POLICY, false),
      'UNRESTRICTED',
    );
    expect(nameHygieneRefusal([name], policy)).toBeUndefined();
  });

  it('is switched off by withSkeletonDistinctness(false)', () => {
    const policy = withSkeletonDistinctness(DEFAULT_NAME_POLICY, false);
    expect(nameHygieneRefusal(['aec', cp(0x0430, 0x0435, 0x0441)], policy)).toBeUndefined();
  });
});

describe('nameHygieneRefusal -- mechanism 3 (restriction level, default Highly Restrictive / whole name)', () => {
  const name =
    'id_' +
    cp(
      0x043f,
      0x043e,
      0x043b,
      0x044c,
      0x0437,
      0x043e,
      0x0432,
      0x0430,
      0x0442,
      0x0435,
      0x043b,
      0x044f,
    ); // id_пользователя

  it('refuses an ordinary compound like id_пользователя under the default whole-name unit', () => {
    const refusal = nameHygieneRefusal([name]);
    expect(refusal?.mechanism).toBe('restriction-level');
    expect(refusal?.names).toEqual([name]);
  });

  it('is admitted once the unit is per-segment -- §8.2s recommended first relaxation', () => {
    expect(nameHygieneRefusal([name], perSegment(DEFAULT_NAME_POLICY))).toBeUndefined();
  });

  it('is admitted at a looser level too', () => {
    const policy = withRestrictionLevel(DEFAULT_NAME_POLICY, 'MINIMALLY_RESTRICTIVE');
    expect(nameHygieneRefusal([name], policy)).toBeUndefined();
  });
});

describe('nameHygieneRefusal -- mechanism 2 (Identifier_Status)', () => {
  it('refuses a name carrying an Identifier_Status=Restricted character', () => {
    const refusal = nameHygieneRefusal([RESTRICTED]);
    expect(refusal?.mechanism).toBe('identifier-status');
    expect(refusal?.names).toEqual([RESTRICTED]);
  });

  it('is admitted once identifierStatus is switched off', () => {
    const policy = withIdentifierStatus(DEFAULT_NAME_POLICY, false);
    expect(nameHygieneRefusal([RESTRICTED], policy)).toBeUndefined();
  });

  it("the '-' profile-extension character never participates (carries no Identifier_Status)", () => {
    expect(nameHygieneRefusal(['well-known'])).toBeUndefined();
  });
});

describe('nameHygieneRefusal -- per-name mechanisms run before the whole-scope relation', () => {
  it('reports the first per-name failure rather than waiting to check mechanism 1', () => {
    // Two names, neither confusable with the other, but the second fails mechanism 3.
    const refusal = nameHygieneRefusal(['plain', 'alpha_' + GREEK_ALPHA]);
    expect(refusal?.mechanism).toBe('restriction-level');
  });
});

describe('TokenPolicy (§8.2 "Values")', () => {
  it('defaults to Unrestricted, so no scan runs', () => {
    expect(DEFAULT_TOKEN_POLICY.restrictionLevel).toBe('UNRESTRICTED');
    expect(tokenSatisfiesPolicy(CYR_A + 'dmin')).toBe(true);
    expect(tokenSatisfiesPolicy(CYR_A + 'dmin', DEFAULT_TOKEN_POLICY)).toBe(true);
  });

  it('builds a whole-text policy at any level', () => {
    const policy = tokenPolicy('ASCII_ONLY');
    expect(tokenSatisfiesPolicy('plain', policy)).toBe(true);
    expect(tokenSatisfiesPolicy(CYR_A, policy)).toBe(false);
  });

  it('refuses a per-segment token policy outright at configuration -- unit belongs to names only', () => {
    expect(() => tokenPolicy('HIGHLY_RESTRICTIVE', 'PER_SEGMENT')).toThrow();
  });
});
