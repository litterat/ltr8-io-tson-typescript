/**
 * [TSON-SCHEMA] §2.2.3: an import stands at the importer's governing level -- both schemas on an
 * `!!import` edge name the meta-kernel as their `!!meta`, or neither does, judged per edge.
 */
import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import { standardLibrary } from '../src/stdlib/index.js';

const KERNEL = 'https://tson.io/2026/38/m/meta-kernel.tn';
const META = 'https://tson.io/2026/38/m/meta.tn';
const CORE = 'https://tson.io/2026/38/m/core.tn';

function schema(id: string, meta: string, imports: readonly string[], body: string): string {
  const header = imports.map((uri) => `!!import:"${uri}"`).join('\n');
  return `!!id:"https://example.test/${id}.tn"\n!!meta:"${meta}"\n${header}\n{\n${body}\n}\n`;
}

function loadError(source: string): string | undefined {
  try {
    standardLibrary().resolveSchema(source);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    return (error as Error).message;
  }
}

describe('an import stands at the importer’s governing level (§2.2.3)', () => {
  it('an ordinary schema importing the meta-kernel is refused', () => {
    expect(loadError(schema('ordinary', META, [KERNEL], 'p => { a: text }'))).toMatch(
      /stands at the importer's governing level.*through its !!meta/s,
    );
  });

  it('a kernel-governed schema importing an ordinary library is refused', () => {
    expect(loadError(schema('layer', KERNEL, [META, CORE], 'p => { a: text }'))).toMatch(
      /stands at the importer's governing level.*declares the vocabulary its constructors use/s,
    );
  });

  it('an ordinary schema importing an ordinary library, and a meta layer importing meta.tn, load', () => {
    expect(loadError(schema('ordinary', META, [CORE], 'p => { a: text }'))).toBeUndefined();
    expect(loadError(schema('layer', KERNEL, [META], 'p => { a: text }'))).toBeUndefined();
  });

  it('is judged per edge: a meta layer reached through an ordinary schema’s import is refused', () => {
    const tson = standardLibrary();
    tson.resolveSchema(schema('layer', KERNEL, [META], 'hdr => { name: text }'));
    expect(() =>
      tson.resolveSchema(
        schema('ordinary', META, ['https://example.test/layer.tn'], 'r => { h: hdr }'),
      ),
    ).toThrow(/stands at the importer's governing level/);
  });
});
