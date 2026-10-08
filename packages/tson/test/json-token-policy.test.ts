/**
 * A port of the Java reference's `JsonScriptPolicyTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonScriptPolicyTest.java`) -- [TSON-DATA] §8.2's
 * token surface ("Values") on the JSON side, reached into this encoding by [TSON-JSON] §9.4: "the
 * token policy, when a deployment sets one, reaches map keys and string values". Exercises
 * `ReadJsonOptions.tokenPolicy` (`json/facade.ts`) and `json/schema/tokenHygiene.ts`, the two
 * pieces `STATUS.md`'s own "Known gaps" entry used to record as entirely unbuilt.
 *
 * The Java module rides its own event stream for the "checked exactly once, even under a peek"
 * property; this port achieves the same property from the call site instead
 * (`json/schema/tokenHygiene.ts`'s own top note explains why a stream-level hook is unnecessary
 * here), so this file's own `a_refusal_is_reported_once...` case exercises that call-site
 * property rather than a stream internal.
 *
 * `JsonObjectReader`'s own bind-mode methods (`.read(source, Class)`) have no analogue -- this
 * port has no JSON object binding at all (`STATUS.md`'s own JSON section); every case below reads
 * through `validateJson` against a tree-mode schema instead, asserting the diagnostics (and,
 * where the Java also asserts the bound value, the returned `JsonValue` tree).
 *
 * The Cyrillic character below is U+0430, written as an escape because a literal one is
 * indistinguishable from the ASCII letter it impersonates.
 */
import { describe, expect, it } from 'vitest';

import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import {
  DEFAULT_IDENTIFIER_POLICY,
  scriptPolicy,
  type ScriptPolicy,
} from '../src/unicode/policy.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const CYRILLIC_A = 'а';

const SCHEMA = resolveUserSchema(`
!!id:"https://example.test/token-policy-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  note   => { text: text }
  scores => { text => int32 }
}
`);
const COMPILED: JsonCompiledSchema = compileJsonSchema(SCHEMA);

function under(policy: ScriptPolicy | undefined, typeName: string, json: string) {
  return validateJson(json, {
    schema: COMPILED,
    root: typeName,
    identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
    ...(policy === undefined ? {} : { tokenPolicy: policy }),
  });
}

describe('JsonScriptPolicyTest', () => {
  it('a_string_value_whose_scripts_the_policy_refuses_is_refused', () => {
    const result = under(scriptPolicy('ASCII_ONLY'), 'note', `{"text": "p${CYRILLIC_A}ssword"}`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['RESTRICTED_SCRIPT']);
    expect(result.value).toBeUndefined();
  });

  it('the_default_scans_nothing_because_a_value_may_legitimately_be_anything', () => {
    // §8.2 leaves the token surface unrestricted until a deployment says otherwise, and requires
    // that saying so be code rather than ambient -- which is what the `tokenPolicy` option is.
    const result = under(undefined, 'note', `{"text": "p${CYRILLIC_A}ssword"}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual({
      kind: 'object',
      members: new Map([['text', { kind: 'string', value: `p${CYRILLIC_A}ssword` }]]),
    });
  });

  it('a_map_key_is_a_token_and_is_reached_by_this_policy', () => {
    // §9.4 names map keys explicitly. They are data, not names, so the *identifier* policy leaves
    // them alone -- this is the surface that does reach them.
    const result = under(scriptPolicy('ASCII_ONLY'), 'scores', `{"${CYRILLIC_A}": 1}`);
    expect(result.diagnostics.some((d) => d.code === 'RESTRICTED_SCRIPT')).toBe(true);
  });

  it('a_refusal_is_reported_once_even_though_the_stream_is_peeked_across', () => {
    // The annotation-object wrapper form (§3.3) peeks the value's opening event before an atom
    // reader ever calls `next()` on it -- so a plain `{"text": "..."}` field already exercises a
    // peeked-then-consumed value, the same property the Java module's own stream-riding design
    // exists for.
    const result = under(scriptPolicy('ASCII_ONLY'), 'note', `{"text": "${CYRILLIC_A}"}`);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.code).toBe('RESTRICTED_SCRIPT');
  });

  it('a_derived_reader_leaves_the_original_alone', () => {
    // No stateful "reader" object exists here to derive from and mutate (`ReadJsonOptions` is a
    // fresh, plain per-call object every time) -- ported as the structural fact that governs: the
    // same compiled schema read twice, once under a strict policy and once under none, reports
    // independently rather than one call's policy leaking into the other's.
    const strict = under(scriptPolicy('ASCII_ONLY'), 'note', `{"text": "${CYRILLIC_A}"}`);
    const lenient = under(undefined, 'note', `{"text": "${CYRILLIC_A}"}`);
    expect(strict.diagnostics.map((d) => d.code)).toEqual(['RESTRICTED_SCRIPT']);
    expect(lenient.diagnostics).toEqual([]);
    expect(lenient.value).toEqual({
      kind: 'object',
      members: new Map([['text', { kind: 'string', value: CYRILLIC_A }]]),
    });
  });
});
