/**
 * [TSON-JSON] §3.3 and §8.1, with [TSON-SCHEMA] §5.4: the `$type` at a choice position names a
 * variant, or a type IS-A exactly one variant -- inline for a record, wrapper form for everything
 * else. A name meaning a variant selects it before any variant it only IS-A; a name IS-A more than
 * one variant and meaning none selects none. The cases of the Java reference's
 * `JsonChoiceSubtypeTagTest`, each stated against the Part 3 rule it needs.
 *
 * Where the text encoding's choice reader gives a verdict the two are compared, as
 * `json-cross-encoding-parity.test.ts` compares them: the code, and the data pointer to within the
 * `$type`/`$value` member a text annotation has no location for.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/json-choice-subtype-tag.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  shape  => abstract { name: text }
  round  => abstract shape & { r: int32 }
  disc   => round & { filled: boolean }
  circle => shape & { r: int32 }
  square => shape & { side: int32 }
  base   => { id: text }
  sub    => base & { extra: text }
  subsub => sub & { more: text }
  small  => !int32 ^ { max: 10 }
  a      => { x?: text }
  b      => { y?: text }
  both   => a & b & { }
  pet    => abstract { kind: text =?  name: text }
  dog    => pet & { kind?: = "dog" }
  cat    => pet & { kind?: = "cat" }
  shape_alias => shape
  tag     => { word: text }
  item    => ( text | shape )
  thing   => ( text | base )
  named   => ( base | sub )
  pair    => ( a | b )
  num     => ( int32 | text )
  pets    => ( text | pet )
  aliased => ( text | shape_alias )
  figure  => ( shape | tag )
  h => { i?: item  t?: thing  n?: named  p?: pair  u?: num  q?: pets  al?: aliased
         is?: [item]  im?: { text => item } }
  hb => { i: figure  s: shape }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

function json(
  root: string,
  body: string,
): { readonly diagnostics: readonly Diagnostic[]; readonly text: string } {
  const result = validateJson(body, { schema: JSON_SCHEMA, root });
  return {
    diagnostics: result.diagnostics,
    text: result.value === undefined ? '' : jsonValueToText(result.value),
  };
}

function tson(root: string, body: string): readonly Diagnostic[] {
  return validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root }).diagnostics;
}

/** The document is taken by both encodings, and the JSON read's value is returned. */
function accepted(tsonBody: string, jsonBody: string, root = 'h'): string {
  expect(tson(root, tsonBody), 'the text encoding').toEqual([]);
  const read = json(root, jsonBody);
  expect(read.diagnostics, 'the JSON encoding').toEqual([]);
  return read.text;
}

/** The JSON refusal is one problem, returned, with the text encoding's verdict beside it. */
function refused(tsonBody: string, jsonBody: string, root = 'h'): Diagnostic {
  const fromJson = json(root, jsonBody).diagnostics;
  expect(fromJson.length, `json: ${JSON.stringify(fromJson)}`).toBe(1);
  const refusal = fromJson[0];
  if (refusal === undefined) throw new Error('unreachable');
  const fromText = tson(root, tsonBody);
  expect(fromText.length, `text: ${JSON.stringify(fromText)}`).toBe(1);
  const text = fromText[0];
  if (text === undefined) throw new Error('unreachable');
  expect(refusal.code, 'the two encodings disagree').toBe(text.code);
  const path = text.path ?? '';
  expect(
    [path, `${path}/$type`, `${path}/$value`],
    `${refusal.path ?? ''} against ${path}`,
  ).toContain(refusal.path);
  return refusal;
}

describe('§3.3, §8.1: a variant’s subtype selects it, in both forms', () => {
  it('a subtype of an abstract variant selects it, inline and wrapped', () => {
    accepted(
      '{ i: !circle { name: "a"  r: 1 } }',
      '{"i": {"$type": "circle", "name": "a", "r": 1}}',
    );
    accepted(
      '{ i: !circle { name: "a"  r: 1 } }',
      '{"i": {"$type": "circle", "$value": {"name": "a", "r": 1}}}',
    );
  });

  it('a subtype of a concrete variant selects it, and the value is held to the subtype’s fields', () => {
    const read = accepted(
      '{ t: !sub { id: "x"  extra: "y" } }',
      '{"t": {"$type": "sub", "id": "x", "extra": "y"}}',
    );
    expect(read).toContain('"extra":"y"');
    expect(
      refused('{ i: !circle { name: "a" } }', '{"i": {"$type": "circle", "name": "a"}}').code,
    ).toBe('FIELD_REQUIRED');
  });

  it('a member two levels below an abstract variant selects it', () => {
    accepted(
      '{ i: !disc { name: "a"  r: 1  filled: true } }',
      '{"i": {"$type": "disc", "name": "a", "r": 1, "filled": true}}',
    );
  });

  it('an abstract subtype of a variant has no values: it selects the variant and is refused as itself', () => {
    refused('{ i: !round { name: "a"  r: 1 } }', '{"i": {"$type": "round", "name": "a", "r": 1}}');
  });

  it('a subtype of a variant that is reached through an alias selects it too', () => {
    accepted(
      '{ al: !circle { name: "a"  r: 1 } }',
      '{"al": {"$type": "circle", "name": "a", "r": 1}}',
    );
    accepted(
      '{ al: !circle { name: "a"  r: 1 } }',
      '{"al": {"$type": "circle", "$value": {"name": "a", "r": 1}}}',
    );
  });

  it('an atom refinement selects its base, and its facets are judged as itself', () => {
    accepted('{ u: !small 5 }', '{"u": {"$type": "small", "$value": 5}}');
    expect(refused('{ u: !small 50 }', '{"u": {"$type": "small", "$value": 50}}').code).toBe(
      'ATOM_CONSTRAINT_VIOLATION',
    );
  });

  it('a choice as an array element and as a map value takes a subtype tag', () => {
    accepted(
      '{ is: [ !circle { name: "a"  r: 1 }  "t" ]  im: { k => !square { name: "b"  side: 2 } } }',
      '{"is": [{"$type": "circle", "name": "a", "r": 1}, "t"], "im": {"k": {"$type": "square", "name": "b", "side": 2}}}',
    );
    refused(
      '{ is: [ "t"  !square { name: "b" } ] }',
      '{"is": ["t", {"$type": "square", "name": "b"}]}',
    );
  });
});

describe('§8.1: which variant a name selects', () => {
  it('a name meaning a variant is selected before one it is only IS-A', () => {
    accepted(
      '{ n: !sub { id: "x"  extra: "y" } }',
      '{"n": {"$type": "sub", "id": "x", "extra": "y"}}',
    );
  });

  it('a name IS-A two variants and meaning neither selects none', () => {
    const refusal = refused('{ p: !both { } }', '{"p": {"$type": "both"}}');
    expect(refusal.code).toBe('TYPE_MISMATCH');
    expect(refusal.message).toContain('(a | b)');
    expect(
      refused(
        '{ n: !subsub { id: "x"  extra: "y"  more: "z" } }',
        '{"n": {"$type": "subsub", "id": "x", "extra": "y", "more": "z"}}',
      ).message,
    ).toContain('(base | sub)');
  });

  it('a name that is a type no variant has above it is refused', () => {
    const refusal = refused('{ i: !base { id: "x" } }', '{"i": {"$type": "base", "id": "x"}}');
    expect(refusal.message).toContain('nor a subtype of exactly one');
  });

  it('a name that resolves nowhere fails §7.2’s first step', () => {
    const refusal = json('h', '{"i": {"$type": "nowhere", "name": "a"}}').diagnostics;
    expect(refusal.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });
});

describe('§6.1.5, §8.1: a tag naming the abstract variant, and an untagged value', () => {
  it('a tag naming an abstract variant is refused without offering to omit it', () => {
    const refusal = refused(
      '{ i: !shape { name: "a" } }',
      '{"i": {"$type": "shape", "name": "a"}}',
    );
    expect(refusal.message).not.toContain('omit the tag');
  });

  it('an untagged record at a disjoint choice reads as at a position typed by its variant', () => {
    refused('{ i: { name: "a"  r: 1 } }', '{"i": {"name": "a", "r": 1}}');
    accepted('{ q: { kind: "dog"  name: "rex" } }', '{"q": {"kind": "dog", "name": "rex"}}');
  });

  it('a non-disjoint choice keeps its tag required', () => {
    refused('{ p: { x: "1" } }', '{"p": {"x": "1"}}');
    accepted('{ p: !a { x: "1" } }', '{"p": {"$type": "a", "x": "1"}}');
  });
});

describe('§6.1.5: a subtype below a sealed family’s variant is placed by the family’s selectors', () => {
  it('the family’s own name still dispatches on the discriminator it carries', () => {
    expect(json('h', '{"q": {"$type": "pet", "kind": "dog", "name": "rex"}}').diagnostics).toEqual(
      [],
    );
  });

  it('a member of the family, named by its own tag, is accepted where the discriminator agrees', () => {
    expect(json('h', '{"q": {"$type": "dog", "kind": "dog", "name": "rex"}}').diagnostics).toEqual(
      [],
    );
  });

  it('and refused where it contradicts the pin, as a FIXED check', () => {
    const found = json('h', '{"q": {"$type": "dog", "kind": "cat", "name": "rex"}}').diagnostics;
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('§8.1: a tag at a figure names the variant a choice of an abstract family and a record holds', () => {
  it('a subtype of the abstract variant is read as itself, and the variant itself is refused', () => {
    expect(
      json(
        'hb',
        '{"i": {"$type": "circle", "name": "c", "r": 2}, "s": {"$type": "circle", "name": "c", "r": 2}}',
      ).diagnostics,
    ).toEqual([]);
    expect(
      json(
        'hb',
        '{"i": {"$type": "shape", "name": "c"}, "s": {"$type": "circle", "name": "c", "r": 2}}',
      ).diagnostics.map((d) => d.code),
    ).toEqual(['VALIDATION_ERROR']);
  });
});
