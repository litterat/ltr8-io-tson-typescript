/**
 * [TSON-JSON] §3.4's out-of-band route through this package's own front door
 * (`readJsonTree`/`readJsonTreeAsync`/`validateJson`/`validateJsonAsync`, `json/facade.ts`): the
 * application supplies the schema and the root type, and the document is a bare value read
 * directly at that type. Ported from the Java reference's `JsonSchemaBindingTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonSchemaBindingTest.java`), adapted to this port's
 * function-based surface -- there is no `Json` instance to build a reader from (`json/index.ts`'s
 * own top note on why a schema-directed read here is a plain function over a
 * {@link JsonCompiledSchema}, never a stateful builder) -- and to this encoding's own error
 * posture, which `json/facade.ts` documents and this file locks in with tests rather than only
 * prose:
 *
 * - A schema-fetch failure (`aSchemaNothingSuppliesIsNotAVerdict`) is not portable: this port's
 *   `compileJsonSchema` takes an already-linked {@link LinkedSchema}, never a reference to fetch,
 *   so "a schema nothing supplies" is a question for `config.ts`'s `Tson.resolveSchema`/`preload`,
 *   entirely outside `json/`'s own zone (`eslint.config.js`).
 * - An undeclared root type (`anUndeclaredRootTypeNamesWhatIsDeclared`) is `TsonInternalError`
 *   here, not a collected diagnostic -- `json/facade.ts`'s own `rootReaderOf` throws it for the
 *   identical reason `facade/tree.ts`'s text-encoding `pickReader` does for the same mistake: the
 *   compiled schema is already fixed by the time a read starts, so naming an absent entry is the
 *   caller's own mistake, not something the document being read could have caused. `commands/
 *   validate.ts` (the CLI) reaches the same posture the Java's own comment describes for its CLI:
 *   it checks `--root` against the schema's own declared entries up front and reports a usage
 *   error before any file opens, rather than letting this reach a document-level diagnostic at
 *   all.
 * - A schema-fetch failure baked into a stateful reader (`aFailedBindingHandsBackNoTree`) and a
 *   schemaless reader that refuses to also carry a schema binding (`aSchemalessReaderRefusesToNameASchema`)
 *   both presuppose the `Json` builder's own object identity, which this port has no counterpart
 *   for: `parseJson`/`readJsonTree` are separate functions, never one object that could be asked
 *   for one behaviour or the other.
 * - A document that will not even parse (`aDocumentThatWillNotParseIsReportedThroughTheSameChannel`)
 *   and trailing content under a schema (`trailingContentIsRejectedUnderASchemaToo`) both collect
 *   a diagnostic here exactly as the Java expects, matching `facade/tree.ts`'s own TSON-text
 *   convention of routing a base-syntax failure through the receiver rather than throwing past it
 *   (`json/facade.ts`'s own top note).
 */
import { describe, expect, it } from 'vitest';

import { TsonInternalError, TsonReadError } from '../src/core/errors.js';
import {
  readJsonTree,
  readJsonTreeAsync,
  validateJson,
  validateJsonAsync,
} from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const ID = 'https://example.test/json-schema-binding.tn';

const SCHEMA = resolveUserSchema(`
!!id:"${ID}"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  person => { name: text  tries?: int32 ~ 0 }
  alias  => person
}
`);

function schema() {
  return compileJsonSchema(SCHEMA);
}

describe('JSON schema binding ([TSON-JSON] §3.4)', () => {
  it('a conforming document validates with no diagnostics', () => {
    const result = validateJson('{"name": "Ada", "tries": 1}', {
      schema: schema(),
      root: 'person',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toBeDefined();
  });

  it('§6.1.3: a missing REQUIRED_DEFAULT member injects, so decoded output is fully populated', () => {
    const read = readJsonTree('{"name": "Ada"}', { schema: schema(), root: 'person' });
    expect(jsonValueToText(read)).toBe('{"name":"Ada","tries":0}');
  });

  it('a non-conforming document is reported rather than thrown', () => {
    const result = validateJson('{"tries": 1}', { schema: schema(), root: 'person' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('FIELD_REQUIRED');
    expect(result.diagnostics[0]?.path).toBe('/name');
  });

  it('a document that will not even parse is reported through the same channel, not thrown -- matching the Java reference’s aDocumentThatWillNotParseIsReportedThroughTheSameChannel', () => {
    const result = validateJson('{"name": ', { schema: schema(), root: 'person' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.code).toBe('VALIDATION_ERROR');
  });

  it('a fail-fast read raises for a non-conforming document', () => {
    expect(() => readJsonTree('{"tries": 1}', { schema: schema(), root: 'person' })).toThrow(
      TsonReadError,
    );
  });

  it('an undeclared root type is a caller mistake, thrown eagerly, never a collected diagnostic', () => {
    expect(() => readJsonTree('{}', { schema: schema(), root: 'persno' })).toThrow(
      TsonInternalError,
    );
    expect(() => validateJson('{}', { schema: schema(), root: 'persno' })).toThrow(
      TsonInternalError,
    );
  });

  it('§3.1: the pull past the root value rejects trailing content under a schema too -- matching the Java reference’s trailingContentIsRejectedUnderASchemaToo, a collected diagnostic rather than a throw', () => {
    const result = validateJson('{"name": "Ada"} 2', { schema: schema(), root: 'person' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('an alias is a usable root type -- [TSON-SCHEMA] §8.3’s collapse, reached through the front door', () => {
    const result = validateJson('{"name": "Ada"}', { schema: schema(), root: 'alias' });
    expect(result.diagnostics).toEqual([]);
  });

  it('the schemaless door is untouched: parseJson consults no schema and JSON null is a plain tree node', async () => {
    const { parseJson } = await import('../src/json/index.js');
    expect(jsonValueToText(parseJson('{"a": null}'))).toBe('{"a":null}');
  });

  it('the async front door agrees with the sync one', async () => {
    async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
      await Promise.resolve(); // a genuine microtask boundary, not just a shape
      yield bytes;
    }
    const bytes = new TextEncoder().encode('{"name": "Ada"}');
    const value = await readJsonTreeAsync(one(bytes), { schema: schema(), root: 'person' });
    expect(jsonValueToText(value)).toBe('{"name":"Ada","tries":0}');

    const result = await validateJsonAsync(one(bytes), { schema: schema(), root: 'person' });
    expect(result.diagnostics).toEqual([]);
  });

  // [TSON-JSON] §9.4: "The identifier policy reaches every $type, and every member name read as
  // a field name that matches no declared field" -- unlike the text encoding's own schema-governed
  // read (`facade/tree.ts`'s own top note: "consults neither directly"), a JSON schema-directed
  // read applies `options.identifierPolicy` itself.
  describe('§9.4: the identifier policy reaches an unmatched member name', () => {
    // U+0430 CYRILLIC SMALL LETTER A in place of the ASCII 'a' -- a look-alike for 'name', matching
    // no declared field of `person`.
    const LOOK_ALIKE = '{"nаme": "Ada"}';

    it('is refused under the default policy (Highly Restrictive) rather than reported as an unrecognised field', () => {
      const result = validateJson(LOOK_ALIKE, { schema: schema(), root: 'person' });
      expect(result.value).toBeUndefined();
      expect(result.diagnostics.some((d) => d.code === 'RESTRICTED_SCRIPT')).toBe(true);
      expect(result.diagnostics.some((d) => d.code === 'UNRECOGNIZED_FIELD')).toBe(false);
    });

    it('an explicit UNRESTRICTED policy admits the look-alike name, which then reports as an unrecognised field instead', async () => {
      const { DEFAULT_NAME_POLICY } = await import('../src/unicode/policy.js');
      const result = validateJson(LOOK_ALIKE, {
        schema: schema(),
        root: 'person',
        identifierPolicy: { ...DEFAULT_NAME_POLICY, restrictionLevel: 'UNRESTRICTED' },
      });
      expect(result.diagnostics.some((d) => d.code === 'RESTRICTED_SCRIPT')).toBe(false);
      expect(result.diagnostics.some((d) => d.code === 'UNRECOGNIZED_FIELD')).toBe(true);
    });
  });
});
