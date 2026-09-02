import { describe, expect, it } from 'vitest';
import { createTson } from '../src/config.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { TsonNameHygieneRefusedError } from '../src/core/errors.js';
import { DEFAULT_NAME_POLICY, withSkeletonDistinctness } from '../src/unicode/policy.js';

/**
 * `config.ts`'s own exposure of {@link import('../src/unicode/policy.js').NamePolicy} -- a plain
 * config field, stated once on the instance the way `maxNestingDepth`/`schemaSource` already are.
 * Kept as its own file rather than added to `config.test.ts`: that file is under concurrent edit
 * elsewhere in this work, and this is a small, self-contained addition.
 */
describe('createTson({ identifierPolicy })', () => {
  it('is absent by default -- an empty config carries no identifierPolicy of its own', () => {
    const tson = createTson();
    expect(tson.config.identifierPolicy).toBeUndefined();
  });

  it('is carried on the instance config exactly as configured', () => {
    const relaxed = withSkeletonDistinctness(DEFAULT_NAME_POLICY, false);
    const tson = createTson({ identifierPolicy: relaxed });
    expect(tson.config.identifierPolicy).toBe(relaxed);
  });
});

describe('the name policy reaches schema linking (§11.4)', () => {
  // Latin `aec` and Cyrillic `аес` are two declared names no reader can tell apart. §11.4 makes
  // one schema's declared names a scope, so the pair is refused where a lone name never would be.
  const CONFUSABLE_SCHEMA = [
    '!!id:"https://example.com/confusable.tn"',
    '!!meta:"https://tson.io/2026/34/m/meta.tn"',
    '!!import:"https://tson.io/2026/34/m/core.tn"',
    '{ aec => text  \u0430\u0435\u0441 => text }',
  ].join('\n');

  it('refuses a schema whose declared names are confusable, at the default policy', () => {
    const tson = standardLibrary();
    expect(() => tson.resolveSchema(CONFUSABLE_SCHEMA)).toThrow(TsonNameHygieneRefusedError);
  });

  it("honours a relaxed policy, which is the caller's own code decision", () => {
    const tson = standardLibrary({
      identifierPolicy: withSkeletonDistinctness(DEFAULT_NAME_POLICY, false),
    });
    expect(tson.resolveSchema(CONFUSABLE_SCHEMA).entries.size).toBeGreaterThan(0);
  });
});
