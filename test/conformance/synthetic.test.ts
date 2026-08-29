import { describe, expect, it } from 'vitest';
import { SYNTHETIC_HASH_PLACEHOLDER, normalizeSyntheticName } from './synthetic.js';

/**
 * Self-contained (no `.references/` needed): RUNNER.md rule 6 has no exercising vector in this
 * checkout (`class2/` is absent), so this is the harness's own proof the normalization is
 * correct ahead of it, the way `ConformanceSuiteTest.resolvedRawSplicesRealDirectivesThatActuallyResolve`
 * proves the schema splice ahead of any vector needing it.
 */
describe('normalizeSyntheticName (RUNNER.md rule 6, Class 2)', () => {
  it('reduces a trailing content hash to the fixed placeholder', () => {
    expect(normalizeSyntheticName('box_text_a1b2c3d4')).toBe(
      `box_text_${SYNTHETIC_HASH_PLACEHOLDER.slice(1)}`,
    );
  });

  it('makes two structurally-equal synthetics with different hashes compare equal', () => {
    const left = normalizeSyntheticName('vector_float32_3_deadbeef');
    const right = normalizeSyntheticName('vector_float32_3_00ff00ff');
    expect(left).toBe(right);
  });

  it('leaves an ordinary declared name untouched', () => {
    expect(normalizeSyntheticName('my_int')).toBe('my_int');
  });

  it('leaves a name whose suffix is not exactly 8 hex digits after an underscore untouched', () => {
    expect(normalizeSyntheticName('thing_abcdefg')).toBe('thing_abcdefg'); // 7 hex + 1 non-hex
    expect(normalizeSyntheticName('thing_deadbeef1')).toBe('thing_deadbeef1'); // 9 hex digits, one too many
    expect(normalizeSyntheticName('thingabcdef12')).toBe('thingabcdef12'); // no underscore at all
  });
});
