/**
 * A port of the Java reference's `JsonTaggedValueReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonTaggedValueReadTest.java`) -- [TSON-JSON] §3.2's
 * reserved namespace and §3.3's annotation object, at the position §6.1.5 defines them for: a
 * record, where `$type` is the JSON spelling of `!employee` at a `person` field.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/tagged-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  person   => { name: text }
  employee => person & { department: text }
  robot    => { serial: text }
  holder   => { who: person }
  boxed    => { count: int32 }
  lookup   => { text => int32 }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function problemsOf(typeName: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema: COMPILED, root: typeName }).diagnostics;
}

function accepted(typeName: string, json: string): string {
  const result = validateJson(json, { schema: COMPILED, root: typeName });
  expect(result.diagnostics, 'expected a clean read').toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

function refusal(typeName: string, json: string): Diagnostic {
  const problems = problemsOf(typeName, json);
  expect(problems.length, `expected exactly one problem, got ${JSON.stringify(problems)}`).toBe(1);
  const first = problems[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

// ── §6.1.5 subsumption ──────────────────────────────────────────────────────────────────────

describe('§6.1.5 subsumption', () => {
  it('a tag selects a subtype and the value validates as it', () => {
    expect(
      accepted('person', '{"$type": "employee", "name": "Ada", "department": "Engines"}'),
    ).toBe('{"name":"Ada","department":"Engines"}');
  });

  it('without a tag the value is exactly the position’s type: there is no structural recovery of a subtype', () => {
    expect(refusal('person', '{"name": "Ada", "department": "Engines"}').code).toBe(
      'UNRECOGNIZED_FIELD',
    );
  });

  it('the selected type is validated in full -- a missing field of the subtype is still missing', () => {
    const problem = refusal('person', '{"$type": "employee", "name": "Ada"}');
    expect(problem.code).toBe('FIELD_REQUIRED');
    expect(problem.path).toBe('/department');
  });

  it('§8.1: a tag is never wrong -- a redundant one restating the position’s own type changes nothing', () => {
    expect(accepted('person', '{"$type": "person", "name": "Ada"}')).toBe('{"name":"Ada"}');
  });

  it('§7.2: a tag may name this type or one of its subtypes, and nothing else', () => {
    const problem = refusal('person', '{"$type": "robot", "serial": "R2"}');
    expect(problem.code).toBe('TYPE_MISMATCH');
    expect(problem.expected).toContain('employee');
  });

  it('§3.3: $type leads its object, so one after the record’s own members is refused, not looked for', () => {
    const problem = refusal('person', '{"name": "Ada", "$type": "person"}');
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
    expect(problem.path).toBe('/$type');
    expect(problem.message).toContain('must lead its object');
  });

  it('a tag reaches a nested position too -- recognition is per object, not per document', () => {
    expect(
      accepted('holder', '{"who": {"$type": "employee", "name": "Ada", "department": "Engines"}}'),
    ).toBe('{"who":{"name":"Ada","department":"Engines"}}');
  });
});

// ── §3.3's wrapper form ─────────────────────────────────────────────────────────────────────

describe('§3.3 wrapper form', () => {
  it('the wrapper form annotates the value it holds', () => {
    expect(
      accepted(
        'person',
        '{"$type": "employee", "$value": {"name": "Ada", "department": "Engines"}}',
      ),
    ).toBe('{"name":"Ada","department":"Engines"}');
  });

  it('in wrapper form any member but the reserved three is a resolver error -- it is apparatus, not a record', () => {
    const problem = refusal('person', '{"$type": "person", "$value": {"name": "Ada"}, "stray": 1}');
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
    expect(problem.path).toBe('/stray');
  });

  it('a wrapper with no value is refused', () => {
    expect(problemsOf('person', '{"$type": "person", "$value": null}')[0]?.code).toBe(
      'TYPE_MISMATCH',
    );
  });
});

// ── §3.2's closed set ───────────────────────────────────────────────────────────────────────

describe('§3.2 closed set', () => {
  it('§3.2: the set is closed. There is no unknown-reserved-member category and no extension mechanism', () => {
    const problem = refusal('person', '{"$comment": "hi", "name": "Ada"}');
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
    expect(problem.path).toBe('/$comment');
  });

  it('§3.3: a wrapper admits nothing beside $value, so one following the record’s own members is refused', () => {
    const problem = refusal(
      'person',
      '{"$type": "person", "name": "Ada", "$value": {"name": "Ada"}}',
    );
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
    expect(problem.path).toBe('/$value');
  });

  it('§3.3: $value belongs to a wrapper, which leads with $type -- one without it is a resolver error', () => {
    expect(refusal('person', '{"$value": {"name": "Ada"}}').code).toBe('UNKNOWN_TYPE_REF');
  });

  it('§8.5 admits $schema only at a scoped position; §3.3 makes it a resolver error anywhere else', () => {
    const problem = refusal(
      'person',
      '{"$schema": "https://example.test/other.tn", "$type": "person", "name": "Ada"}',
    );
    expect(problem.code).toBe('UNKNOWN_TYPE_REF');
    expect(problem.path).toBe('/$schema');
  });

  it('§3.2’s carve-out: at a map position every member name is an ordinary key, $-initial or not', () => {
    expect(accepted('lookup', '{"$type": 1, "$comment": 2}')).toBe('{"$type":1,"$comment":2}');
  });
});

// ── The peek itself ─────────────────────────────────────────────────────────────────────────

describe('the peek itself', () => {
  it('an untagged object is unaffected by the peek', () => {
    expect(accepted('boxed', '{"count": 7}')).toBe('{"count":7}');
    expect(refusal('boxed', '{"count": "x"}').path).toBe('/count');
  });

  it('a peek over an object with a nested one leaves the cursor where it started, not inside one', () => {
    expect(accepted('holder', '{"who": {"name": "Ada"}}')).toBe('{"who":{"name":"Ada"}}');
  });
});
