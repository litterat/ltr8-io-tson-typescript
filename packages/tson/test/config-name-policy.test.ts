import { describe, expect, it } from 'vitest';
import { createTson } from '../src/config.js';
import { DEFAULT_NAME_POLICY, withSkeletonDistinctness } from '../src/unicode/policy.js';

/**
 * `config.ts`'s own exposure of {@link import('../src/unicode/policy.js').NamePolicy} -- a plain
 * config field, stated once on the instance the way `maxNestingDepth`/`schemaSource` already are.
 * Kept as its own file rather than added to `config.test.ts`: that file is under concurrent edit
 * elsewhere in this work, and this is a small, self-contained addition.
 */
describe('createTson({ namePolicy })', () => {
  it('is absent by default -- an empty config carries no namePolicy of its own', () => {
    const tson = createTson();
    expect(tson.config.namePolicy).toBeUndefined();
  });

  it('is carried on the instance config exactly as configured', () => {
    const relaxed = withSkeletonDistinctness(DEFAULT_NAME_POLICY, false);
    const tson = createTson({ namePolicy: relaxed });
    expect(tson.config.namePolicy).toBe(relaxed);
  });
});
