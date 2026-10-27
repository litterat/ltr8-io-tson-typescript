/**
 * A port of the Java reference's `JsonNamespaceTypeTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonNamespaceTypeTest.java`): a value of a namespace
 * type ([TSON-SCHEMA] §4.1) is a JSON object read as the map the type describes, never as a record
 * of its facets. A field is typed by a namespace type only in a schema the meta-kernel governs,
 * since an import stands at the importer's governing level ([TSON-SCHEMA] §2.2.3).
 */
import { describe, expect, it } from 'vitest';

import type { Tson } from '../src/config.js';
import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { standardLibrary } from '../src/stdlib/index.js';

const META_TEXT = `!!id:"https://example.test/meta-headers.tn"
!!meta:"https://tson.io/2026/38/m/meta-kernel.tn"
!!import:"https://tson.io/2026/38/m/meta.tn"
{
  header_name => !identifier_type { continue_add: "-" }
  headers     => namespace & { key_type: = header_name  value_type: = text }
}
`;

const USER_TEXT = `!!id:"https://example.test/request.tn"
!!meta:"https://tson.io/2026/38/m/meta-kernel.tn"
!!import:"https://example.test/meta-headers.tn"
{
  request => { headers: headers }
}
`;

function withLayer(): Tson {
  const tson = standardLibrary();
  tson.resolveSchema(META_TEXT);
  return tson;
}

const COMPILED: JsonCompiledSchema = compileJsonSchema(withLayer().resolveSchema(USER_TEXT));

function read(compiled: JsonCompiledSchema, type: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema: compiled, root: type }).diagnostics;
}

describe('§4.1 a value of a namespace type is the map its facets describe', () => {
  it('§4.1: an object is read as the map', () => {
    expect(
      read(COMPILED, 'request', '{"headers": {"accept": "text/plain", "user-agent": "probe"}}'),
    ).toEqual([]);
  });

  it('§4.1: a key is judged by the key type', () => {
    expect(read(COMPILED, 'request', '{"headers": {"1st": "text/plain"}}')).toHaveLength(1);
  });

  it('§4.1: a value is judged by the value type', () => {
    expect(read(COMPILED, 'request', '{"headers": {"accept": 1}}')).toHaveLength(1);
  });

  /**
   * §4.1: an entry built with a namespace type is a value, not a type -- the schema declaring one
   * compiles, its types read, and a document read against the entry itself is refused rather than
   * thrown.
   */
  it('§4.1: a namespace entry compiles and types nothing', () => {
    const governed = compileJsonSchema(
      withLayer().resolveSchema(`!!id:"https://example.test/defaults.tn"
!!meta:"https://example.test/meta-headers.tn"
!!import:"https://tson.io/2026/38/m/core.tn"
{
  defaults => !headers { accept => "text/plain"  user-agent => "probe" }
  greeting => text
}
`),
    );
    expect(read(governed, 'greeting', '"hello"')).toEqual([]);
    expect(read(governed, 'defaults', '{"accept": "text/plain"}')).toHaveLength(1);
  });
});
