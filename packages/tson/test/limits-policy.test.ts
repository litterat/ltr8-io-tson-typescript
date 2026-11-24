/**
 * The limits table ([TSON-DATA] §9.1, [TSON-SCHEMA] §11.5) as `spec/m/policy.tn`'s `policy.limits`
 * states it: its members, their order and their defaults, and the positive-`int64` rule every
 * limit obeys (`policy.limit => !int64 ^ { min: 1 }`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTson, withLimits } from '../src/config.js';
import { TsonLimitRefusedError, TsonSchemaValidationError } from '../src/core/errors.js';
import {
  DEFAULT_LIMITS,
  MAX_LIMIT,
  aliasChainLimitRefusal,
  limitsPolicyOf,
  waitDepthLimitRefusal,
} from '../src/core/limits.js';

const policyTn = readFileSync(new URL('../../../spec/m/policy.tn', import.meta.url), 'utf8');

/** `policy.tn`'s `limits` members, in order, with their `~` defaults, read off the document's own text. */
function declaredLimits(): [string, number][] {
  const start = policyTn.indexOf('limits => {');
  const body = policyTn.slice(start, policyTn.indexOf('}', start));
  return [...body.matchAll(/(max_[a-z_]+)\?:\s+policy\.limit ~ (\d+)/g)].map((m) => [
    m[1] ?? '',
    Number(m[2]),
  ]);
}

const camel = (name: string): string =>
  name
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^maxDepth$/, 'maxNestingDepth');

describe('§9.1 / §11.5: the limits table is policy.limits', () => {
  it('carries every member of policy.tn, in its order, at its default', () => {
    const declared = declaredLimits();
    expect(declared).toHaveLength(16);
    expect(Object.entries(DEFAULT_LIMITS)).toEqual(declared.map(([n, v]) => [camel(n), v]));
  });

  it('holds max_wait_depth (§11.5) at 64 and max_alias_chain replaces the reference-chain limit', () => {
    expect(DEFAULT_LIMITS.maxWaitDepth).toBe(64);
    expect(DEFAULT_LIMITS.maxAliasChain).toBe(64);
    expect(DEFAULT_LIMITS).not.toHaveProperty('maxReferenceChain');
    expect(DEFAULT_LIMITS).not.toHaveProperty('maxForeignSchemas');
  });

  it('is reachable off a Tson instance, with a stated limit replacing its default', () => {
    const tson = createTson(withLimits({}, { maxWaitDepth: 8, maxAliasChain: 3 }));
    expect(tson.processorPolicy.limits).toEqual({
      ...DEFAULT_LIMITS,
      maxWaitDepth: 8,
      maxAliasChain: 3,
    });
  });
});

describe('§9.1: every limit is a positive int64, capped where the processor holds less', () => {
  it.each([0, -1, 1.5, Number.NaN, 0n, -5n])('refuses %s', (bad) => {
    expect(() => limitsPolicyOf({ limits: { maxWaitDepth: bad } })).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('caps a limit past what a number holds, from a number or an int64 bigint', () => {
    const limits = limitsPolicyOf({
      limits: { maxDocumentSize: 9_223_372_036_854_775_807n, maxValues: 2 ** 60 },
    });
    expect(limits.maxDocumentSize).toBe(MAX_LIMIT);
    expect(limits.maxValues).toBe(MAX_LIMIT);
  });

  it('refuses a name that is no limit, including the retired reference-chain and foreign-schemas ones', () => {
    for (const name of ['maxReferenceChain', 'maxForeignSchemas', 'maxNestingDepth']) {
      expect(() => limitsPolicyOf({ limits: { [name]: 4 } })).toThrow(TsonSchemaValidationError);
    }
  });
});

describe('§8.1 fifth outcome: a counted limit names itself and its threshold', () => {
  it('max_alias_chain refuses as alias-chain', () => {
    const refusal = aliasChainLimitRefusal(5, 'a');
    expect(refusal).toBeInstanceOf(TsonLimitRefusedError);
    expect(refusal.limit).toBe('alias-chain');
    expect(refusal.configuredThreshold).toBe(5);
  });

  it('max_wait_depth (§11.5) refuses as wait-depth, at the entry whose chain is too long', () => {
    const refusal = waitDepthLimitRefusal(7, 'deep');
    expect(refusal.limit).toBe('wait-depth');
    expect(refusal.configuredThreshold).toBe(7);
    expect(refusal.message).toContain("'deep'");
  });
});
