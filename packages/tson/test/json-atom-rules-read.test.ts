/**
 * Rules of [TSON-DATA] §5 that [TSON-JSON] §5 reaches through the shared atom parsers, probed in
 * the JSON encoding and, where a text rule exists, asserted to give the same verdict in text:
 * `uri` and `iri` refuse a relative reference and `uri` anything beyond US-ASCII (§5.6), a leap
 * second is refused (§5.4), a set may be empty and `tuple1<T>` is a one-element array (§6.2, §6.3),
 * and a text enum's member is a string whatever it spells (§5.2).
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/json-atom-rules-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  link      => { u: uri }
  link_ref  => { u: uri_reference }
  ilink     => { u: iri }
  ilink_ref => { u: iri_reference }
  clock     => { t: time }
  stamp     => { t: datetime }
  tags      => { t: set<text> }
  single    => { t: tuple1<text> }
  maybe     => { t: voidable_tuple1<text> }
  answer    => !text_enum ["true" "false"]
  survey    => { reply?: answer ~ "true"  agreed?: boolean ~ true }
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

function jsonCodes(root: string, source: string): readonly string[] {
  return validateJson(source, { schema: JSON_SCHEMA, root }).diagnostics.map(
    (d: Diagnostic) => d.code,
  );
}

function textCodes(root: string, body: string): readonly string[] {
  return validateText(new TextEncoder().encode(body), {
    schema: TEXT_SCHEMA,
    root,
  }).diagnostics.map((d: Diagnostic) => d.code);
}

/** One verdict in both encodings, or both clean. */
function same(root: string, textBody: string, jsonBody: string): readonly string[] {
  const text = textCodes(root, textBody);
  expect(jsonCodes(root, jsonBody), `${root}: ${jsonBody}`).toEqual(text);
  return text;
}

describe('§5.6 uri and iri', () => {
  it('uri refuses a relative reference, uri_reference admits one', () => {
    expect(same('link', '{ u: "/a/b?c" }', '{"u": "/a/b?c"}')).not.toEqual([]);
    expect(same('link_ref', '{ u: "/a/b?c" }', '{"u": "/a/b?c"}')).toEqual([]);
    expect(
      same('link', '{ u: "https://example.test/a" }', '{"u": "https://example.test/a"}'),
    ).toEqual([]);
  });

  it('iri refuses a relative reference, iri_reference admits one', () => {
    expect(same('ilink', '{ u: "a/b" }', '{"u": "a/b"}')).not.toEqual([]);
    expect(same('ilink_ref', '{ u: "a/b" }', '{"u": "a/b"}')).toEqual([]);
  });

  it('uri admits nothing beyond US-ASCII, iri admits it', () => {
    const wide = 'https://example.test/é';
    expect(same('link', `{ u: "${wide}" }`, `{"u": "${wide}"}`)).not.toEqual([]);
    expect(same('ilink', `{ u: "${wide}" }`, `{"u": "${wide}"}`)).toEqual([]);
  });
});

describe('§5.4 a leap second is refused', () => {
  it('in a time and in a datetime, in both encodings', () => {
    expect(same('clock', '{ t: "23:59:60" }', '{"t": "23:59:60"}')).not.toEqual([]);
    expect(
      same('stamp', '{ t: "2016-12-31T23:59:60Z" }', '{"t": "2016-12-31T23:59:60Z"}'),
    ).not.toEqual([]);
    expect(same('clock', '{ t: "23:59:59Z" }', '{"t": "23:59:59Z"}')).toEqual([]);
  });
});

describe('§6.2, §6.3 containers', () => {
  it('a set may be empty', () => {
    expect(same('tags', '{ t: [] }', '{"t": []}')).toEqual([]);
  });

  it('tuple1<T> is a one-element array and refuses [], two elements and void', () => {
    expect(same('single', '{ t: [ "a" ] }', '{"t": ["a"]}')).toEqual([]);
    expect(same('single', '{ t: [] }', '{"t": []}')).not.toEqual([]);
    expect(same('single', '{ t: [ "a" "b" ] }', '{"t": ["a", "b"]}')).not.toEqual([]);
    expect(same('single', '{ t: [ _ ] }', '{"t": [null]}')).not.toEqual([]);
  });

  it('voidable_tuple1<T> admits [_] as the void sentinel’s spelling, null', () => {
    expect(same('maybe', '{ t: [ _ ] }', '{"t": [null]}')).toEqual([]);
  });
});

describe('§5.2 a text enum member is a string whatever it spells', () => {
  it('injects "true" and true as the defaults of a text enum and a boolean', () => {
    const result = validateJson('{}', { schema: JSON_SCHEMA, root: 'survey' });
    expect(result.diagnostics).toEqual([]);
    expect(result.value === undefined ? '' : jsonValueToText(result.value)).toBe(
      '{"reply":"true","agreed":true}',
    );
  });

  it('an enum position matches on content, not kind (§5.2): the literal true reaches member "true"', () => {
    expect(jsonCodes('survey', '{"reply": true}')).toEqual([]);
    expect(jsonCodes('survey', '{"reply": "false"}')).toEqual([]);
    expect(jsonCodes('survey', '{"reply": "maybe"}')).not.toEqual([]);
  });
});
