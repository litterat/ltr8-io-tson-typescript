/**
 * `json/index.ts`/`json/facade.ts` as a front door, ported from the Java reference's
 * `JsonFrontDoorTest` (`tson-json/src/test/java/io/ltr8/tson/json/JsonFrontDoorTest.java`) and
 * adapted the way `json-schema-binding.test.ts`'s own top note explains: this port has no `Json`
 * instance carrying one configuration two readers share -- `parseJson`/`parseJsonAsync`/
 * `parseJsonCollecting`/`readJsonTree`/`readJsonTreeAsync`/`validateJson`/`validateJsonAsync` are
 * plain functions, each taking its own options, matching `facade/tree.ts`'s own `readTree`/
 * `validate` shape rather than the reference's stateful builder. So the Java cases that test *one
 * configuration object reaching two readers built from it* (`both_readers_carry_the_configuration_the_front_door_holds`,
 * `a_front_door_built_from_one_configuration_is_untouched_by_another`, `the_bound_is_stated_once_and_both_readers_carry_it`'s
 * "stated once" half, `the_binding_the_front_door_holds_reaches_the_object_reader`) have no
 * analogue here: every call already states its own options, so there is no second call to leave
 * untouched. What ports directly is the *behavioural* content of each case -- a limit applied and
 * reported as a refusal, both fail-fast and collecting reads treating "any problem" as "no value",
 * and the schemaless functions' own round-trip -- restated over this port's own per-call surface.
 * There is no `objectReader` here at all (`STATUS.md`'s JSON section records the gap): this
 * package reads a schema-governed JSON document into a {@link JsonValue} tree, never into a bound
 * host object, matching `json/facade.ts`'s own top note on why a schemaless read returns
 * `JsonValue` rather than `tree/nodes.ts`'s `Value`.
 */
import { describe, expect, it } from 'vitest';

import { TsonLimitRefusedError, TsonReadError } from '../src/core/errors.js';
import {
  parseJson,
  parseJsonAsync,
  parseJsonCollecting,
  readJsonTree,
  validateJson,
} from '../src/json/index.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToDisplayString, jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA = resolveUserSchema(`
!!id:"https://example.test/json-front-door.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  person => { name: text  tries?: int32 ~ 0 }
}
`);

describe('the schemaless front door (parseJson/parseJsonAsync/parseJsonCollecting)', () => {
  it('parses and renders a value with no schema in view', () => {
    expect(jsonValueToText(parseJson('[1]'))).toBe('[1]');
    expect(jsonValueToDisplayString(parseJson('[1]'))).toBe('[\n  1\n]');
  });

  it('a duplicate member name throws -- [TSON-JSON] §3.1, the fail-fast door', () => {
    expect(() => parseJson('{"a": 1, "a": 2}')).toThrow(TsonReadError);
  });

  it('the collecting door hands back no value for the identical document, a DUPLICATE_FIELD diagnostic instead', () => {
    const result = parseJsonCollecting('{"a": 1, "a": 2}');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_FIELD']);
  });

  it('the async door agrees with the sync one over a chunked source', async () => {
    const bytes = new TextEncoder().encode('[1, 2, 3]');
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (const b of bytes) {
        await Promise.resolve(); // a genuine microtask boundary between chunks, not just a shape
        yield new Uint8Array([b]);
      }
    }
    const value = await parseJsonAsync(chunks());
    expect(jsonValueToText(value)).toBe(jsonValueToText(parseJson(bytes)));
  });

  it('a nesting-depth refusal reaches a fail-fast caller as a limit refusal, not a verdict on the document', () => {
    const deep = '['.repeat(5) + '1' + ']'.repeat(5);
    expect(() => parseJson(deep, { maxNestingDepth: 2 })).toThrow(TsonLimitRefusedError);
  });
});

describe('the two schema-directed readers agree that a collecting read with problems hands back nothing', () => {
  const schema = compileJsonSchema(SCHEMA);

  it('readJsonTree throws for a non-conforming document', () => {
    expect(() => readJsonTree('{"tries": "x"}', { schema, root: 'person' })).toThrow(TsonReadError);
  });

  it('validateJson collects the identical problem and hands back no value', () => {
    const result = validateJson('{"tries": "x"}', { schema, root: 'person' });
    expect(result.value).toBeUndefined();
    // Two problems, not just "some": the type mismatch itself, and the `name` REQUIRED member the
    // read never got as far as reading because `tries`'s own value failed first.
    expect(result.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH', 'FIELD_REQUIRED']);
    expect(result.diagnostics[0]?.path).toBe('/tries');
  });
});
