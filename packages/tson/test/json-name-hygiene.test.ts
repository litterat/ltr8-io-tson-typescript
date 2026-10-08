/**
 * A port of the Java reference's `JsonNameHygieneTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonNameHygieneTest.java`) -- [TSON-DATA] §8.2's
 * name hygiene at the schema-directed JSON positions [TSON-JSON] §9.4 gives it.
 *
 * A refusal is not a verdict, and the two halves are asserted separately, exactly as the
 * conformance corpus's `refused/` vectors do: that something *was* refused, under one of the
 * three codes that mean policy, and that *nothing* was reported in one of §8.1's four categories.
 *
 * The confusable characters are written as escapes and never literally, per this project's own
 * rule: a literal Cyrillic `a` beside a Latin one is invisible to whoever reads the test next.
 */
import { describe, expect, it } from 'vitest';

import { isVerdict, type Diagnostic } from '../src/core/diagnostic.js';
import { TsonReadError } from '../src/core/errors.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { readJsonTree, validateJson, type ReadJsonOptions } from '../src/json/facade.js';
import { parseJson } from '../src/json/index.js';
import { jsonValueToText } from '../src/json/write.js';
import { DEFAULT_NAME_POLICY, permitting } from '../src/unicode/policy.js';
import { scriptNamed } from '../src/unicode/uts39.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/** U+0430 CYRILLIC SMALL LETTER A -- the Latin `a`'s look-alike, and §8.2's whole point. */
const CYRILLIC_A = 'а';

/** The three codes that mean policy, one per §8.2 rule. Which fired is what a consumer routes on. */
const POLICY = new Set(['CONFUSABLE_NAMES', 'RESTRICTED_CHARACTER', 'RESTRICTED_SCRIPT']);

const SCHEMA_SOURCE = `
!!id:"https://example.test/hygiene-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  account => { password: text  note?: text? }
  circle  => { radius: float64 }
  square  => { side: float64 }
  shape   => ( circle | square )
  holder  => { outline: shape }
  lookup  => { text => int32 }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function problemsOf(
  typeName: string,
  source: string,
  identifierPolicy?: ReadJsonOptions['identifierPolicy'],
): readonly Diagnostic[] {
  return validateJson(source, {
    schema: COMPILED,
    root: typeName,
    ...(identifierPolicy === undefined ? {} : { identifierPolicy }),
  }).diagnostics;
}

/** The refusal, asserting the other half too: nothing was reported as invalid. */
function refusal(typeName: string, source: string): Diagnostic {
  const problems = problemsOf(typeName, source);
  const policy = problems.filter((d) => POLICY.has(d.code));
  expect(
    policy.length,
    `expected exactly one policy refusal, got ${JSON.stringify(problems)}`,
  ).toBe(1);
  expect(
    problems.filter((d) => !POLICY.has(d.code)),
    "§8.2: a refusal MUST NOT be reported in any of §8.1's four categories, so nothing else fires",
  ).toEqual([]);
  const first = policy[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

// ── The case the rule exists for ────────────────────────────────────────────────────────────

describe('the case the rule exists for', () => {
  it('a look-alike field name is refused rather than called unknown', () => {
    const lookAlike = `p${CYRILLIC_A}ssword`;
    const problem = refusal('account', `{"password": "s3cret", "${lookAlike}": "evil"}`);
    expect(POLICY.has(problem.code)).toBe(true);
    expect(problem.path).toBe(`/${lookAlike}`);
  });

  it('a restricted character in a field name is refused', () => {
    expect(refusal('account', '{"password": "s3cret", "no te": 1}').code).toBe(
      'RESTRICTED_CHARACTER',
    );
  });

  it('§9.4 reaches every $type too: a look-alike variant name is refused, not called no variant', () => {
    const problem = refusal(
      'holder',
      `{"outline": {"$type": "cir${CYRILLIC_A}le", "radius": 1.0}}`,
    );
    expect(POLICY.has(problem.code)).toBe(true);
  });

  it('a refusal is a verdict but not an invalidity, and names the name it refused (JsonIdentifierPolicyTest)', () => {
    const lookAlike = `n${CYRILLIC_A}me`;
    const problem = refusal('account', `{"password": "s3cret", "${lookAlike}": "x"}`);
    // The mixed-script name refuses under the restriction-level mechanism specifically -- not
    // merely "some policy code", which the shared `refusal` helper above already narrows to.
    expect(problem.code).toBe('RESTRICTED_SCRIPT');
    // Pinned to `core/diagnostic.ts`'s own documented, codebase-wide convention: "a refusal *is* a
    // verdict ({@link isVerdict}) -- the processor looked and declined... though not a validity
    // one" -- applied identically to both encodings, not a JSON-only choice. Worth flagging rather
    // than silently carrying over (`CLAUDE.md`'s own spec-feedback rule): [TSON-JSON] §9.4 reads
    // the other way for a name-hygiene refusal ("not judged... never a verdict on the document"),
    // and Part 1's own §8.1 is the section that would have to settle which reading governs
    // `isVerdict`, `core/diagnostic.ts` being shared infrastructure well outside this file's own
    // JSON-only scope to relitigate.
    expect(isVerdict(problem.code), 'the processor looked and declined').toBe(true);
    expect(problem.actual).toBe(`'${lookAlike}'`);
  });

  it('a fail-fast read throws it like any other problem (JsonIdentifierPolicyTest)', () => {
    const lookAlike = `n${CYRILLIC_A}me`;
    let thrown: unknown;
    try {
      readJsonTree(`{"password": "s3cret", "${lookAlike}": "x"}`, {
        schema: COMPILED,
        root: 'account',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TsonReadError);
    expect((thrown as TsonReadError).diagnostic.code).toBe('RESTRICTED_SCRIPT');
  });
});

// ── The reach, which is narrower than "every name" ──────────────────────────────────────────

describe('the reach, narrower than "every name"', () => {
  it('a matched field name is not judged again', () => {
    expect(problemsOf('account', '{"password": "s3cret"}')).toEqual([]);
  });

  it('§3.2: at a map position every member name is an ordinary key -- data, under the token policy', () => {
    expect(problemsOf('lookup', `{"p${CYRILLIC_A}ssword": 1}`)).toEqual([]);
  });

  it('even a key outside the identifier profile is an ordinary key at a map position (JsonIdentifierPolicyTest)', () => {
    // U+00AD SOFT HYPHEN: inside the grammar's continue set, outside the identifier profile --
    // `RESTRICTED_CHARACTER`'s own trigger at a record position, an ordinary byte at a map one.
    expect(problemsOf('lookup', '{"na­me": 1}')).toEqual([]);
  });

  it('a conforming document draws nothing, so the check costs an ordinary read no verdict', () => {
    expect(problemsOf('account', '{"password": "s3cret", "note": "hi"}')).toEqual([]);
  });
});

// ── The policy is configuration, and relaxing it is code ────────────────────────────────────

describe('the policy is configuration, and relaxing it is code', () => {
  it('§8.2 requires a relaxation be a code decision: an unrestricted policy draws the ordinary closure verdict instead', () => {
    const unrestricted = { ...DEFAULT_NAME_POLICY, restrictionLevel: 'UNRESTRICTED' as const };
    const problems = problemsOf(
      'account',
      `{"password": "s3cret", "p${CYRILLIC_A}ssword": "evil"}`,
      unrestricted,
    );
    expect(problems.length, JSON.stringify(problems)).toBe(1);
    expect(problems[0]?.code).toBe('UNRECOGNIZED_FIELD');
    expect(POLICY.has(problems[0]?.code ?? '')).toBe(false);
  });

  /** The schemaless door applies nothing: it holds no position, so a member name is not a field name. */
  it('the schemaless read judges no name', () => {
    const source = `{"p${CYRILLIC_A}ssword": 1}`;
    const value = parseJson(source);
    expect(jsonValueToText(value)).toBe(source.replace(': ', ':'));
  });

  it('naming the scripts a deployment expects admits them -- a mixed Latin/Cyrillic name is Highly Restrictive by default and refused, but not once both scripts are permitted', () => {
    const latin = scriptNamed('Latin');
    const cyrillic = scriptNamed('Cyrillic');
    if (latin === undefined || cyrillic === undefined) throw new Error('unreachable');
    const bilingual = permitting(DEFAULT_NAME_POLICY, latin, cyrillic);
    const lookAlike = `p${CYRILLIC_A}ssword`;
    expect(refusal('account', `{"password": "s3cret", "${lookAlike}": "evil"}`).code).toBe(
      'RESTRICTED_SCRIPT',
    );
    const problems = problemsOf(
      'account',
      `{"password": "s3cret", "${lookAlike}": "evil"}`,
      bilingual,
    );
    expect(problems.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });
});

// ── Names that read alike, at the one position that draws a rule from it ────────────────────

describe('names that read alike (mechanism 1) reach only what has a set to be a member of', () => {
  const lookAlike = `p${CYRILLIC_A}yment`;
  const bilingual = (() => {
    const latin = scriptNamed('Latin');
    const cyrillic = scriptNamed('Cyrillic');
    if (latin === undefined || cyrillic === undefined) throw new Error('unreachable');
    return permitting(DEFAULT_NAME_POLICY, latin, cyrillic);
  })();

  it('two names that read alike are accepted at a map position -- they are two keys, not a name set (§4.1: form is not meaning)', () => {
    expect(problemsOf('lookup', `{"payment": 1, "${lookAlike}": 2}`, bilingual)).toEqual([]);
  });

  it('at a record position, the look-alike simply arrives as a member the type does not declare -- the ordinary closure verdict, needing nothing extra from mechanism 1', () => {
    const problems = problemsOf('account', `{"password": "1", "${lookAlike}": 2}`, bilingual);
    expect(problems.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });
});
