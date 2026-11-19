import { describe, expect, it } from 'vitest';

import { TsonReadError } from '../src/core/errors.js';
import { readTree, validate } from '../src/facade/tree.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A Class 1 processor rejects a schema document -- a root tagged `!schema` (§2.2) -- with a
 * categorised diagnostic rather than reading it as malformed data (§1.5, §8.1).
 */
describe('a schemaless read refuses a schema document (§1.5, §2.2)', () => {
  const SCHEMA = '!!id:"https://example.com/s.tn"\n@doc:"x"\n!schema { a => text }\n';

  it('readTree throws, and the cause is the unsupported-document error', () => {
    let thrown: unknown;
    try {
      readTree(bytesOf(SCHEMA));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonReadError);
    expect((thrown as Error).cause).toMatchObject({ name: 'TsonUnsupportedDocumentError' });
  });

  it('validate reports it as a diagnostic and withholds the value', () => {
    const result = validate(bytesOf(SCHEMA));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain('schema document');
  });

  it("a root tagged '!meta.schema' is data, and reads against nothing as an unknown type (§3.2)", () => {
    const result = validate(bytesOf('!meta.schema { }'));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it('a data document under imports reads schemaless, its field names left to the schema (§2.5)', () => {
    const tree = readTree(bytesOf('!!import:"https://example.com/s.tn"\n{ "first name": 1 }'));
    expect(tree.kind).toBe('record');
  });
});
