/**
 * A port of the Java reference's `JsonBaseSyntaxDiagnosticTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonBaseSyntaxDiagnosticTest.java`) -- a document
 * that will not parse at all, reported through the read's own receiver rather than thrown past
 * it, exactly as `TsonDiagnostics.ofBaseSyntaxError` does for TSON text ([TSON-JSON] §9.4:
 * `json/facade.ts`'s own `readWholeDocument` catches a base-syntax error and reports it as
 * `VALIDATION_ERROR`).
 *
 * **What ports and what does not.** The reference's `JsonTreeReader`/`JsonObjectReader` pair
 * becomes this port's `validateJson` (collecting) and `readJsonTree` (fail-fast) -- there is no
 * `objectReader` here at all (`STATUS.md`'s own JSON section records the gap), so every
 * `JsonObjectReader`-only case is skipped, matching `json-front-door.test.ts`'s own precedent.
 * `WhatIsNotClassified`'s fault-injection case (a hand-written `JsonEventSource` that throws
 * `IllegalStateException` to prove a library fault reaches the caller untouched) has no
 * TypeScript analogue worth writing: there is no comparable seam to inject a fault at from a test
 * without reaching into internals, and the property it guards -- an unexpected `throw` propagates
 * rather than being coerced into a `Diagnostic` -- falls straight out of every reader here being
 * an ordinary `function*`/`try`/`catch` with no blanket exception-to-diagnostic conversion.
 *
 * **`ALimitRefusal` does not port as the reference states it.** This port's own resource-limit
 * refusal (`core/limits.ts`'s `TsonLimitRefusedError`) always throws, in a collecting read and a
 * fail-fast one alike -- `json/index.ts`'s own top note on `parseJsonCollecting` states this
 * directly ("a resource-limit refusal still throws... everything past either point is
 * unreachable by construction"), and `validateJson` inherits the same posture. The reference's
 * own `Diagnostic.Code.LIMIT_EXCEEDED` is instead *collected*, never thrown, which is the
 * property `is_classified_apart_from_a_syntax_error_and_is_not_a_verdict` exercises; this port's
 * `LIMIT_REFUSED` is never collected at all, so there is nothing there to classify apart from a
 * syntax error in a `Diagnostic[]` -- the two tests collapse into the one below, asserting the
 * throw itself, in both reading modes. `isVerdict('LIMIT_REFUSED')` is `false`, as the
 * reference's `Code.verdict()` is (Part 1 §9.1).
 */
import { describe, expect, it } from 'vitest';

import { isNameRefusal, isRefusal, isVerdict } from '../src/core/diagnostic.js';
import { TsonLimitRefusedError, TsonReadError } from '../src/core/errors.js';
import { parseJson, readJsonTree, validateJson } from '../src/json/index.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA = resolveUserSchema(`
!!id:"https://example.test/json-base-syntax.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  person => { name: text  age: int32 }
}
`);
const COMPILED = compileJsonSchema(SCHEMA);

describe('a collecting read', () => {
  it('reports a malformed document rather than throwing past the collector', () => {
    const result = validateJson('{"name": }', { schema: COMPILED, root: 'person' });
    expect(result.value, 'a document that does not parse yields no tree').toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
  });

  it('locates the failure at the trailing content, past a conforming value', () => {
    // A well-formed document immediately followed by trailing content ([TSON-JSON] §3.1: a JSON
    // document is one value): unlike the reference's own case, this port's base-syntax check
    // runs only after the one value is read whole, so a document whose *value* also disagrees
    // with the schema (the reference's own `[1] 2`, an array where `person` is a record) reports
    // that disagreement first -- a conforming value is what isolates the trailing-content error
    // as the read's only diagnostic.
    const result = validateJson('{"name": "Ada", "age": 1} 2', {
      schema: COMPILED,
      root: 'person',
    });
    const diagnostic = result.diagnostics[0];
    if (diagnostic === undefined) throw new Error('expected a diagnostic');
    expect(result.diagnostics.length).toBe(1);
    expect(diagnostic.dataPosition).toBeDefined();
    expect(diagnostic.dataPosition?.offset).toBeGreaterThan(0);
    expect(isVerdict(diagnostic.code), 'a syntax error is a verdict the sender can act on').toBe(
      true,
    );
  });

  it('keeps the value-level problems it found before the syntax failed', () => {
    const result = validateJson('{"name": 1, "age": "x", ', {
      schema: COMPILED,
      root: 'person',
    });
    expect(result.diagnostics.length).toBeGreaterThan(1);
    expect(result.diagnostics.at(-1)?.code).toBe('VALIDATION_ERROR');
  });
});

describe('a fail-fast read', () => {
  it('throws TsonReadError the way a value-level problem does', () => {
    let thrown: unknown;
    try {
      readJsonTree('{"name": }', { schema: COMPILED, root: 'person' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonReadError);
    const error = thrown as TsonReadError;
    expect(error.diagnostic.code).toBe('VALIDATION_ERROR');
    expect(error.diagnostic.dataPosition).toBeDefined();
  });
});

describe('a resource-limit refusal', () => {
  it(
    'always throws, never collected -- unlike the reference, where it is a collected, ' +
      "non-verdict diagnostic (this file's own top note has the full divergence)",
    () => {
      const deep = '['.repeat(5) + '1' + ']'.repeat(5);
      expect(() => parseJson(deep, { maxNestingDepth: 2 })).toThrow(TsonLimitRefusedError);
      expect(() =>
        validateJson(deep, { schema: COMPILED, root: 'person', maxNestingDepth: 2 }),
      ).toThrow(TsonLimitRefusedError);
    },
  );

  it('§9.1: a limit refusal is not a verdict, and is a refusal beside the name refusals', () => {
    expect(isVerdict('LIMIT_REFUSED')).toBe(false);
    expect(isRefusal('LIMIT_REFUSED')).toBe(true);
    expect(isNameRefusal('LIMIT_REFUSED')).toBe(false);
    expect(isRefusal('SCHEMA_NOT_FOUND')).toBe(false);
  });
});
