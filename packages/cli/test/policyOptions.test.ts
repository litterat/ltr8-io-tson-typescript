/**
 * `policyOptions.ts` -- flag parsing (`consumePolicyOptions`) and the policy readback
 * (`processorPolicyOf`), checked against the reference implementation's own `PolicyOptions`.
 */
import { describe, expect, it } from 'vitest';
import { consumePolicyOptions, processorPolicyOf } from '../src/policyOptions.js';
import { UsageError } from '../src/exit.js';

describe('consumePolicyOptions: defaults', () => {
  it("is [TSON-DATA] §8.2's own defaults when given no flags at all", () => {
    const { policy, rest } = consumePolicyOptions([]);
    expect(policy.identifierPolicy).toEqual({
      skeletonDistinctness: true,
      identifierStatus: true,
      restrictionLevel: 'HIGHLY_RESTRICTIVE',
      restrictionUnit: 'WHOLE_NAME',
      permittedScripts: [],
    });
    expect(policy.tokenPolicy).toEqual({ restrictionLevel: 'UNRESTRICTED', permittedScripts: [] });
    expect(rest).toEqual([]);
  });

  it('leaves every non-policy argument in rest, in order', () => {
    const { rest } = consumePolicyOptions(['a.tn', '--format', 'json', 'b.tn']);
    expect(rest).toEqual(['a.tn', '--format', 'json', 'b.tn']);
  });
});

describe('consumePolicyOptions: --identifier-policy / --token-policy', () => {
  it('accepts the hyphenated lower-case spelling', () => {
    const { policy } = consumePolicyOptions(['--identifier-policy', 'ascii-only']);
    expect(policy.identifierPolicy.restrictionLevel).toBe('ASCII_ONLY');
  });

  it('accepts the UPPER_SNAKE spelling tson policy prints', () => {
    const { policy } = consumePolicyOptions(['--token-policy', 'SINGLE_SCRIPT']);
    expect(policy.tokenPolicy.restrictionLevel).toBe('SINGLE_SCRIPT');
  });

  it('is case-insensitive', () => {
    const { policy } = consumePolicyOptions(['--identifier-policy', 'Highly-Restrictive']);
    expect(policy.identifierPolicy.restrictionLevel).toBe('HIGHLY_RESTRICTIVE');
  });

  it('rejects an unknown level as a usage error naming the accepted spellings', () => {
    expect(() => consumePolicyOptions(['--identifier-policy', 'bogus'])).toThrow(UsageError);
    expect(() => consumePolicyOptions(['--identifier-policy', 'bogus'])).toThrow(/ascii-only/);
  });

  it('a flag with no value is a usage error', () => {
    expect(() => consumePolicyOptions(['--identifier-policy'])).toThrow(UsageError);
    expect(() => consumePolicyOptions(['--token-policy'])).toThrow(UsageError);
  });

  it('order does not matter: a level stated after a relaxation still applies', () => {
    const { policy } = consumePolicyOptions([
      '--identifier-per-segment',
      '--identifier-policy',
      'moderately-restrictive',
    ]);
    expect(policy.identifierPolicy.restrictionLevel).toBe('MODERATELY_RESTRICTIVE');
    expect(policy.identifierPolicy.restrictionUnit).toBe('PER_SEGMENT');
  });
});

describe('consumePolicyOptions: --identifier-per-segment', () => {
  it('sets restrictionUnit to PER_SEGMENT under the default (scanning) level', () => {
    const { policy } = consumePolicyOptions(['--identifier-per-segment']);
    expect(policy.identifierPolicy.restrictionUnit).toBe('PER_SEGMENT');
    expect(policy.identifierPolicy.restrictionLevel).toBe('HIGHLY_RESTRICTIVE');
  });

  it('is a usage error paired with a stated level that scans no scripts (unrestricted)', () => {
    expect(() =>
      consumePolicyOptions(['--identifier-per-segment', '--identifier-policy', 'unrestricted']),
    ).toThrow(UsageError);
    expect(() =>
      consumePolicyOptions(['--identifier-per-segment', '--identifier-policy', 'unrestricted']),
    ).toThrow(/scans no scripts/);
  });

  it('is a usage error paired with minimally-restrictive too, for the same reason', () => {
    expect(() =>
      consumePolicyOptions([
        '--identifier-per-segment',
        '--identifier-policy',
        'minimally-restrictive',
      ]),
    ).toThrow(UsageError);
  });
});

describe('consumePolicyOptions: --identifier-scripts / --token-scripts', () => {
  it('admits the named combination, resolved to ScriptIds, at the default (scanning) identifier level', () => {
    const { policy } = consumePolicyOptions(['--identifier-scripts', 'Latin+Cyrillic']);
    expect(policy.identifierPolicy.restrictionLevel).toBe('HIGHLY_RESTRICTIVE');
    expect(policy.identifierPolicy.permittedScripts).toHaveLength(1);
    expect(policy.identifierPolicy.permittedScripts[0]).toHaveLength(2);
  });

  it('is repeatable, accumulating one combination per occurrence', () => {
    const { policy } = consumePolicyOptions([
      '--identifier-scripts',
      'Latin+Cyrillic',
      '--identifier-scripts',
      'Latin+Greek',
    ]);
    expect(policy.identifierPolicy.permittedScripts).toHaveLength(2);
  });

  it('--token-scripts alone raises the token level to single-script, its default scanning nothing', () => {
    const { policy } = consumePolicyOptions(['--token-scripts', 'Latin+Cyrillic']);
    expect(policy.tokenPolicy.restrictionLevel).toBe('SINGLE_SCRIPT');
    expect(policy.tokenPolicy.permittedScripts).toHaveLength(1);
  });

  it('--token-scripts does not override a level the caller stated explicitly', () => {
    const { policy } = consumePolicyOptions([
      '--token-policy',
      'moderately-restrictive',
      '--token-scripts',
      'Latin+Cyrillic',
    ]);
    expect(policy.tokenPolicy.restrictionLevel).toBe('MODERATELY_RESTRICTIVE');
  });

  it('is a usage error paired with a stated token level that scans no scripts', () => {
    expect(() =>
      consumePolicyOptions(['--token-policy', 'unrestricted', '--token-scripts', 'Latin+Cyrillic']),
    ).toThrow(UsageError);
    expect(() =>
      consumePolicyOptions(['--token-policy', 'unrestricted', '--token-scripts', 'Latin+Cyrillic']),
    ).toThrow(/scans no scripts/);
  });

  it('is a usage error paired with a stated identifier level that scans no scripts too', () => {
    expect(() =>
      consumePolicyOptions([
        '--identifier-policy',
        'unrestricted',
        '--identifier-scripts',
        'Latin+Cyrillic',
      ]),
    ).toThrow(/--identifier-scripts given with it would configure nothing/);
  });

  it('names both flags when --identifier-per-segment and --identifier-scripts are both given against a non-scanning level', () => {
    expect(() =>
      consumePolicyOptions([
        '--identifier-policy',
        'unrestricted',
        '--identifier-per-segment',
        '--identifier-scripts',
        'Latin+Cyrillic',
      ]),
    ).toThrow(/--identifier-scripts and --identifier-per-segment given with it/);
  });

  it('rejects an unknown script name as a usage error naming the offender', () => {
    expect(() => consumePolicyOptions(['--identifier-scripts', 'Latin+Bogus'])).toThrow(UsageError);
    expect(() => consumePolicyOptions(['--identifier-scripts', 'Latin+Bogus'])).toThrow(
      /unknown script 'Bogus' in 'Latin\+Bogus'/,
    );
  });

  it('rejects the four-letter alias form -- only UCD long-form names are accepted', () => {
    expect(() => consumePolicyOptions(['--identifier-scripts', 'Latn'])).toThrow(
      /unknown script 'Latn'/,
    );
  });

  it('a flag with no value is a usage error, so a trailing flag is not silently swallowed', () => {
    expect(() => consumePolicyOptions(['--identifier-scripts'])).toThrow(/requires a value/);
  });
});

describe('processorPolicyOf', () => {
  it('reads the policy back through a real Tson, matching what was assembled', () => {
    const { policy } = consumePolicyOptions(['--identifier-policy', 'ascii-only']);
    const processorPolicy = processorPolicyOf(policy);
    expect(processorPolicy.identifierPolicy.restrictionLevel).toBe('ASCII_ONLY');
    expect(processorPolicy.tokenPolicy.restrictionLevel).toBe('UNRESTRICTED');
    expect(typeof processorPolicy.unicodeDataVersion).toBe('string');
    expect(processorPolicy.unicodeDataVersion.length).toBeGreaterThan(0);
  });

  it("matches §8.2's own defaults when nothing was configured", () => {
    const { policy } = consumePolicyOptions([]);
    const processorPolicy = processorPolicyOf(policy);
    expect(processorPolicy.identifierPolicy.restrictionLevel).toBe('HIGHLY_RESTRICTIVE');
    expect(processorPolicy.tokenPolicy.restrictionLevel).toBe('UNRESTRICTED');
  });
});
