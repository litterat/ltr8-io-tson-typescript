/**
 * A type written in place has no name, and a parametric record is no type a value is read against
 * ([TSON-JSON] §3.3, §3.4, §1.6 item 23; [TSON-SCHEMA] §4.2, §5.10, §7.2), read through the JSON encoding.
 *
 * The cases of the Java reference's `JsonRecordInPlaceReadTest` that state these rules, with the
 * text encoding's verdict beside each where the text reader gives one.
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
!!id:"https://example.test/json-in-place.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  order      => { id: text }
  page       => <T> { items: [T]  size?: int32 ~ 10 }
  order_page => page<order>
  holder => {
    p:       page<order>
    ps?:     [page<order>]
    byName?: {text => page<order>}
    tags?:   [text]
    pair?:   [text int32]
    kind?:   meta.ref<net.uuid_type>
  }
  shipment => {
    at:      { x: int32  y: int32 }
    lines?:  [{ sku: text  qty: int32 }]
    by?:     ( text | { name: text  email: text } )
  }
  folded    => !unicode.identifier_type { normalization: NFKC_CASEFOLD }
  named_of  => <T> !meta.record { name_type: folded  fields: { name => { type: T } } }
  tagged    => { body: named_of<text> }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

function json(root: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema: JSON_SCHEMA, root }).diagnostics;
}

function text(root: string, body: string): readonly Diagnostic[] {
  return validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root }).diagnostics;
}

function only(found: readonly Diagnostic[]): Diagnostic {
  expect(found.length, `expected exactly one problem, got ${JSON.stringify(found)}`).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

describe('§3.3: a type written in place has no name, so no $type names it', () => {
  it('a $type at a record written in place is refused, whatever it names', () => {
    // A declared record of the same shape, at the value.
    expect(only(json('holder', '{"p": {"$type": "order_page", "items": []}}')).path).toBe('/p');
    // The application's own text is no type's name, and no qualified name either (§3.3): refused at the member.
    const text = only(json('holder', '{"p": {"$type": "page<order>", "items": []}}'));
    expect(text.path).toBe('/p/$type');
  });

  it('a name that resolves is not admitted (TYPE_MISMATCH); one that resolves nowhere fails §7.2’s first step', () => {
    expect(only(json('holder', '{"p": {"$type": "order_page", "items": []}}')).code).toBe(
      'TYPE_MISMATCH',
    );
    expect(only(json('holder', '{"p": {"$type": "nowhere", "items": []}}')).code).toBe(
      'UNKNOWN_TYPE_REF',
    );
  });

  it('the refusal is the text encoding’s: one problem at the value, with the same code', () => {
    const fromText = only(text('holder', '{ p: !order_page { items: [] } }'));
    const fromJson = only(json('holder', '{"p": {"$type": "order_page", "items": []}}'));
    expect(fromJson.code).toBe(fromText.code);
    expect(fromJson.path).toBe(fromText.path);
  });

  it('a wrapper at a record written in place is refused too, and its $value is not read', () => {
    const refused = only(json('holder', '{"p": {"$type": "order_page", "$value": {"items": []}}}'));
    expect(refused.path).toBe('/p');
  });

  it('an array in place refuses a $type restating its own text, an alias-free name and any other', () => {
    expect(
      only(json('holder', '{"p": {"items": []}, "tags": {"$type": "holder", "$value": []}}')).path,
    ).toBe('/tags');
    expect(
      only(json('holder', '{"p": {"items": []}, "tags": {"$type": "text", "$value": []}}')).code,
    ).toBe('TYPE_MISMATCH');
  });

  it('a tuple and a reference in place refuse a $type as well', () => {
    expect(
      only(json('holder', '{"p": {"items": []}, "pair": {"$type": "holder", "$value": ["a", 1]}}'))
        .path,
    ).toBe('/pair');
    expect(
      only(json('holder', '{"p": {"items": []}, "kind": {"$type": "uuid", "$value": "uuid"}}'))
        .path,
    ).toBe('/kind');
  });

  it('an element, a map value and a field of a record in place read the same way', () => {
    expect(
      only(json('holder', '{"p": {"items": []}, "ps": [{"$type": "order_page", "items": []}]}'))
        .path,
    ).toBe('/ps/0');
    expect(
      only(
        json(
          'holder',
          '{"p": {"items": []}, "byName": {"k": {"$type": "order_page", "items": []}}}',
        ),
      ).path,
    ).toBe('/byName/k');
  });

  it('an $import at a position written in place is the refusal every value position gives it', () => {
    const refused = only(
      json('holder', '{"p": {"$import": ["https://example.test/x.tn"], "items": []}}'),
    );
    expect(refused.code).toBe('SCOPE_NOT_ADMITTED');
    expect(refused.path).toBe('/p/$import');
  });

  it('an untagged value at each position written in place reads, with the record’s default', () => {
    const read = validateJson(
      '{"p": {"items": [{"id": "a"}]}, "ps": [{"items": []}], "tags": ["t"]}',
      {
        schema: JSON_SCHEMA,
        root: 'holder',
      },
    );
    expect(read.diagnostics).toEqual([]);
    expect(read.value === undefined ? '' : jsonValueToText(read.value)).toContain('"size":10');
  });

  it('a record written at a field, an element, a map value and a choice’s variant reads untagged', () => {
    expect(
      json(
        'shipment',
        '{"at": {"x": 1, "y": 2}, "lines": [{"sku": "a", "qty": 1}], "by": {"name": "n", "email": "e"}}',
      ),
    ).toEqual([]);
    expect(json('shipment', '{"at": {"x": 1, "y": 2}, "by": "b"}')).toEqual([]);
  });

  it('a refusal inside a record written in place is located by its path', () => {
    expect(only(json('shipment', '{"at": {"x": "one", "y": 2}}')).path).toBe('/at/x');
    expect(only(json('shipment', '{"at": {"x": 1, "y": 2}, "lines": [{"sku": "a"}]}')).path).toBe(
      '/lines/0/qty',
    );
  });

  it('a choice written in place still takes a $type naming a variant of it', () => {
    expect(
      json('shipment', '{"at": {"x": 1, "y": 2}, "by": {"$type": "text", "$value": "b"}}'),
    ).toEqual([]);
  });
});

describe('§3.3, §3.4: a parametric record is no type a value is read against', () => {
  it('a root type supplied out of band naming one is refused as a type, with no value read', () => {
    const refused = only(json('page', '{"items": []}'));
    expect(refused.code).toBe('TYPE_MISMATCH');
    expect(refused.message).toContain('parametric record');
  });

  it('a $type at a root supplied out of band names it no better', () => {
    expect(only(json('page', '{"$type": "page", "items": []}')).code).toBe('TYPE_MISMATCH');
  });

  it('a $type naming one at a declared position is a validation error, inline form and wrapper alike', () => {
    const declared = compileJsonSchema(
      resolveUserSchema(`
!!id:"https://example.test/json-declared-parametric.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  box    => <T> { v: T }
  holder => { any: meta.declared }
}
`),
    );
    const refusals = (body: string) =>
      validateJson(body, { schema: declared, root: 'holder' }).diagnostics;
    const inline = only(refusals('{"any": {"$type": "box", "v": 1}}'));
    expect(inline.code).toBe('TYPE_MISMATCH');
    expect(inline.path).toBe('/any');
    const wrapped = only(refusals('{"any": {"$type": "box", "$value": {"v": 1}}}'));
    expect(wrapped.code).toBe('TYPE_MISMATCH');
  });

  it('the application a declaration names is the type: its name takes the value', () => {
    const named = compileJsonSchema(
      resolveUserSchema(`
!!id:"https://example.test/json-named-application.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  box      => <T> { v: T }
  text_box => box<text>
  holder   => { any: meta.declared }
}
`),
    );
    const read = (body: string, root: string) =>
      validateJson(body, { schema: named, root }).diagnostics;
    expect(read('{"any": {"$type": "text_box", "v": "a"}}', 'holder')).toEqual([]);
    expect(read('{"v": "a"}', 'text_box')).toEqual([]);
  });
});

describe('§5.2: a record in place with its own name_type reads its names in that type', () => {
  it('a member the name type holds equal to a field is that field, in both encodings', () => {
    expect(json('tagged', '{"body": {"NAME": "x"}}')).toEqual([]);
    expect(text('tagged', '{ body: { NAME: "x" } }')).toEqual([]);
    expect(json('tagged', '{"body": {"name": "x"}}')).toEqual([]);
  });

  it('two members that are one name under the type are the duplicate error, in both encodings', () => {
    const fromJson = only(json('tagged', '{"body": {"NAME": "x", "name": "y"}}'));
    const fromText = only(text('tagged', '{ body: { NAME: "x"  name: "y" } }'));
    expect(fromJson.code).toBe(fromText.code);
  });

  it('a member that is no field of it is a closure error, in both encodings', () => {
    const fromJson = only(json('tagged', '{"body": {"name": "x", "plain": "y"}}'));
    const fromText = only(text('tagged', '{ body: { name: "x"  plain: "y" } }'));
    expect(fromJson.code).toBe(fromText.code);
  });
});
