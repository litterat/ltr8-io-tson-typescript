import { describe, expect, it } from 'vitest';
import { runSync } from '../src/io/bytes.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { bodyContextOver, collectingContextOver } from './reader-tree-helpers.js';
import { TsonNameHygieneRefusedError } from '../src/core/errors.js';
import { DEFAULT_TOKEN_POLICY, tokenPolicy, type TokenPolicy } from '../src/unicode/policy.js';
import type { Value } from '../src/tree/nodes.js';

/**
 * `reader/schemaless/tree.ts`'s wiring of [TSON-DATA] §8.2's "Values" paragraph: the policy a read
 * applies to every token it decodes.
 *
 * Only the restricted-script rule reaches a value. A token carries no identifier profile to
 * violate, and stands in no scope to be distinct within, so mechanisms 1 and 2 have nothing to say
 * about one -- which is why this is a separate surface from the name policy rather than the same
 * one pointed at a different position.
 */

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

/** Cyrillic а + Latin `dmin`: two scripts in one token. */
const MIXED_SCRIPT = cp(0x0430) + 'dmin';

function read(text: string, policy?: TokenPolicy): Value {
  const options = policy === undefined ? {} : { tokenPolicy: policy };
  return runSync(schemalessTreeReader(options).read(bodyContextOver(text)));
}

function readCollect(text: string, policy?: TokenPolicy) {
  const { ctx, diagnostics } = collectingContextOver(text);
  const options = policy === undefined ? {} : { tokenPolicy: policy };
  const value = runSync(schemalessTreeReader(options).read(ctx));
  return { value, diagnostics: diagnostics.diagnostics };
}

describe('schemalessTreeReader -- token policy (§8.2 "Values")', () => {
  it('scans nothing at the default policy, so a mixed-script value reads clean', () => {
    // The default is UNRESTRICTED: §8.2 leaves the value surface open unless a caller closes it.
    expect(DEFAULT_TOKEN_POLICY.restrictionLevel).toBe('UNRESTRICTED');
    expect(() => read(`"${MIXED_SCRIPT}"`)).not.toThrow();
    expect(() => read(`{ name: ${MIXED_SCRIPT} }`)).not.toThrow();
  });

  it('refuses a mixed-script token once a caller states a level', () => {
    expect(() => read(MIXED_SCRIPT, tokenPolicy('SINGLE_SCRIPT'))).toThrow(
      TsonNameHygieneRefusedError,
    );
  });

  it('refuses a non-ASCII token under ASCII_ONLY, and admits an ASCII one', () => {
    const ascii = tokenPolicy('ASCII_ONLY');
    expect(() => read(cp(0x0430), ascii)).toThrow(TsonNameHygieneRefusedError);
    expect(() => read('plain', ascii)).not.toThrow();
  });

  it('reports the refusal under RESTRICTED_SCRIPT -- the only rule a value can break', () => {
    const { diagnostics } = readCollect(MIXED_SCRIPT, tokenPolicy('SINGLE_SCRIPT'));
    expect(diagnostics.map((d) => d.code)).toEqual(['RESTRICTED_SCRIPT']);
  });

  it('names the refused token exactly once in the message', () => {
    const { diagnostics } = readCollect(MIXED_SCRIPT, tokenPolicy('SINGLE_SCRIPT'));
    const message = diagnostics[0]?.message ?? '';
    expect(message).toContain(MIXED_SCRIPT);
    expect(message.split(MIXED_SCRIPT)).toHaveLength(2);
  });

  it('reaches a token nested inside a record, a map and an array alike', () => {
    const policy = tokenPolicy('ASCII_ONLY');
    const bad = cp(0x0430);
    expect(() => read(`{ k: ${bad} }`, policy)).toThrow(TsonNameHygieneRefusedError);
    expect(() => read(`{ "k" => ${bad} }`, policy)).toThrow(TsonNameHygieneRefusedError);
    expect(() => read(`[ ${bad} ]`, policy)).toThrow(TsonNameHygieneRefusedError);
  });

  it('is independent of the identifier policy: a value is judged by neither of the other two mechanisms', () => {
    // A lone confusable token is not a pair, and a token has no identifier profile -- so under a
    // policy that scans nothing, neither mechanism 1 nor 2 has any way to fire on it.
    expect(() => read(`{ name: ${MIXED_SCRIPT} }`)).not.toThrow();
  });
});
