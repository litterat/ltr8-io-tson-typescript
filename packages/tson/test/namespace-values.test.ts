import { describe, expect, it } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonNameHygieneRefusedError,
} from '../src/core/errors.js';
import { createKindParser, createQualifiedNameParser } from '../src/atom/reference.js';
import { compile, validate } from '../src/compiler/compile.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import { readNamespaceInstance, writeNamespaceValue } from '../src/schema/namespaceReader.js';
import type { MetaValue, Namespace, Top } from '../src/schema/meta/typedef.js';
import { isNamespaceValue } from '../src/schema/meta/typedef.js';
import { standardLibrary } from '../src/stdlib/index.js';
import type { Tson } from '../src/config.js';
import type { LinkedSchema } from '../src/link/link.js';

const KERNEL = 'https://tson.io/2026/38/m/meta-kernel.tn';
const META = 'https://tson.io/2026/38/m/meta.tn';
const CORE = 'https://tson.io/2026/38/m/core.tn';
const LAYER = 'https://example.com/m/service.tn';

/** A meta layer in the shape §4.1 describes: records, and namespace types holding them. */
const SERVICE_LAYER = `!!id:"${LAYER}"
!!meta:"${KERNEL}"
!!import:"${META}"
{
  method      => { request?: kind<record>  response?: type_kind  errors?: [kind<record>] }
  rpc_method  => method & { idempotent?: boolean }
  http_verb   => !enum [GET POST]
  interface   => namespace & { key_type: = identifier  value_type: = method }
  rpcs        => namespace & { key_type: = identifier  value_type: = rpc_method }
  header_set  => { headers: {text => method} }
  header_sets => namespace & { key_type: = identifier  value_type: = header_set }
  service     => { extends?: [identifier]  methods: interface  note?: text }
  services    => namespace & { key_type: = identifier  value_type: = service }
  binding     => { method: ref<method>  verb: http_verb  route: text }
  bindings    => namespace & { key_type: = identifier  value_type: = binding }
}
`;

function withLayer(): Tson {
  const tson = standardLibrary();
  tson.resolveSchema(SERVICE_LAYER);
  return tson;
}

/** A schema the service layer governs, holding `body`'s entries. */
function governed(body: string, id = 'https://example.com/app.tn'): string {
  return `!!id:"${id}"\n!!meta:"${LAYER}"\n!!import:"${CORE}"\n{\n${body}\n}\n`;
}

function namespaceEntry(linked: LinkedSchema, name: string): Namespace<MetaValue> {
  const value: Top | undefined = linked.entries.get(name);
  if (value === undefined || !isNamespaceValue(value)) {
    throw new Error(`'${name}' is no namespace value`);
  }
  return value;
}

describe('a value of a meta layer’s namespace type ([TSON-SCHEMA] §4.1)', () => {
  it('§4.1: an entry applying a namespace type is the map its facets describe, a value and no type', () => {
    const linked = withLayer().resolveSchema(
      governed(`
        order  => { sku: text }
        orders => !interface {
          place => { request: order  response: order }
          @doc:"lists" list => !method { response: order }
        }`),
    );
    const orders = namespaceEntry(linked, 'orders');
    expect(orders.type).toBe('interface');
    expect([...orders.entries.keys()]).toEqual(['place', 'list']);
    expect(orders.keyAnnotations?.get('list')?.[0]?.name).toBe('doc');
    const place = orders.entries.get('place');
    expect(place).toMatchObject({ form: 'record' });
    if (place?.form !== 'record') throw new Error('unreachable');
    // A tag naming the position's own type is not kept: the value is read as that type.
    expect(orders.entries.get('list')).not.toHaveProperty('type');
    // §4.2: a name at a kind-typed slot is kept as written, beside the slot it fills.
    expect(place.fields.get('request')).toEqual({
      form: 'token',
      token: { text: 'order', form: 'UNQUOTED' },
      slot: expect.objectContaining({ role: 'kind', of: 'record' }) as unknown,
    });
    expect(linked.facts.get('orders')?.head).toBe('interface');
  });

  it('§7.2: a tag naming a strict subtype is kept, the tag resolved output writes', () => {
    const linked = withLayer().resolveSchema(
      governed(`
        order => { sku: text }
        api   => !interface { get => !rpc_method { response: order  idempotent: true } }`),
    );
    expect(namespaceEntry(linked, 'api').entries.get('get')).toMatchObject({
      form: 'record',
      type: 'rpc_method',
    });
  });

  it.each([
    ['a payload that is no map', `bad => !interface [ { response: order } ]`],
    ['a value that is no record of the value type', `bad => !interface { m => [order] }`],
    [
      'a key that is no value of the key type',
      `bad => !interface { "1st" => { response: order } }`,
    ],
    ['a field the record does not declare', `bad => !interface { m => { reply: order } }`],
    ['a required field left out', `bad => !bindings { b => { verb: GET  route: "/" } }`],
    [
      'an atom token outside its atom',
      `bad => !bindings { b => { method: x.y  verb: PUT  route: "/" } }`,
    ],
    [
      'a quoted token at a name slot',
      `bad => !bindings { b => { method: "x.y"  verb: GET  route: "/" } }`,
    ],
    [
      'an annotated name',
      `bad => !bindings { b => { method: @doc:"m" x.y  verb: GET  route: "/" } }`,
    ],
    ['a tagged name', `bad => !interface { m => { request: !record order } }`],
    [
      'a braced application at a kind-typed slot',
      `bad => !interface { m => { request: { name: box  arguments: [ { name: order } ] } } }`,
    ],
    ['a record-typed slot written as a name', `bad => !services { s => { methods: orders } }`],
  ])('§4.1, §5.12: refuses %s', (_label, entry) => {
    expect(() =>
      withLayer().resolveSchema(governed(`order => { sku: text }\nbox => <T> { v: T }\n${entry}`)),
    ).toThrow(/not valid data for/);
  });

  it('§8.3: resolved output writes the value as written, a value by name as the name', () => {
    const linked = withLayer().resolveSchema(
      governed(`
        order  => { sku: text }
        orders => !interface { place => { response: order } }
        routes => !bindings { post => { method: orders.place  verb: POST  route: "/orders" } }`),
    );
    const routes = namespaceEntry(linked, 'routes');
    const written = writeNamespaceValue(routes);
    expect(written.typeRef).toBe('bindings');
    const meta = withLayer().schemas.get('example.com/m/service.tn');
    if (meta === undefined) throw new Error('the layer is not registered');
    const reread = readNamespaceInstance('bindings', written, (name) => meta.entries.get(name));
    expect(reread).toEqual(routes);
  });
});

describe('values by name ([TSON-SCHEMA] §5.12)', () => {
  const FIXTURE = `
    order   => { sku: text }
    receipt => { total: int64 }
    orders  => !interface { place => { request: order  response: receipt } }
    shop    => !services {
      reads => { methods: { get => { response: order } } }
      sales => { extends: [reads]  methods: { place => { request: order } } }
    }
    hs      => !header_sets { h => { headers: { accept => { response: order } } } }
    rpc     => !rpcs { get => { response: order  idempotent: true } }
    api     => !interface { m => { errors: [order] } }`;

  function bind(method: string): () => LinkedSchema {
    return () =>
      withLayer().resolveSchema(
        governed(
          `${FIXTURE}\n    routes => !bindings { b => { method: ${method}  verb: POST  route: "/" } }`,
        ),
      );
  }

  it.each([
    ['a key of a namespace entry', 'orders.place'],
    ['a field of a record value, then a key of the namespace it holds', 'shop.sales.methods.place'],
    ['a value of a strict subtype, through its supertypes', 'rpc.get'],
  ])('§5.12: a qualified name reaches %s', (_label, name) => {
    expect(bind(name)).not.toThrow();
  });

  it.each([
    ['a first segment naming no entry', 'place', /is no entry of this schema/],
    ['a namespace entry itself, no value of the slot’s type', 'orders', /no 'method'/],
    ['a record type, no value', 'order', /no 'method'/],
    ['a further segment into a type entry', 'order.sku', /type entry admits no further segment/],
    ['a key the namespace lacks', 'orders.cancel', /has no key 'cancel'/],
    ['a field the record does not declare', 'shop.sales.calls.place', /has no field 'calls'/],
    ['a key the field’s namespace lacks', 'shop.sales.methods.cancel', /has no key 'cancel'/],
    [
      'a segment into a map that is no namespace',
      'hs.h.headers.accept',
      /map that is no namespace/,
    ],
    ['a segment through a list', 'api.m.errors.x', /a list, whose elements have no names/],
    ['a segment that is no field of a method', 'orders.place.nope', /has no field 'nope'/],
  ])('§5.12: refuses %s', (_label, name, message) => {
    expect(bind(name)).toThrow(message);
  });

  it('§5.12: an optional field the value does not hold is refused as not present, after the type is judged', () => {
    const extendsOf = () =>
      withLayer().resolveSchema(
        governed(
          `${FIXTURE}\n    rs => !services { s => { methods: { m => { response: order } } } }` +
            `\n    routes => !bindings { b => { method: rs.s.note  verb: POST  route: "/" } }`,
        ),
      );
    // `note` is text, so the name is wrong by type before it is wrong by presence.
    expect(extendsOf).toThrow(/no 'method'/);
  });

  it('§3.3.2: a kind-typed slot’s name resolves in the governed schema, never in the meta layer', () => {
    const named = (request: string) => () =>
      withLayer().resolveSchema(
        governed(`order => { sku: text }\nuser_id => uuid\nbox => <T> { v: T }\nalias => order
          orders => !interface { m => { request: ${request} } }`),
      );
    expect(named('order')).not.toThrow();
    expect(named('alias')).not.toThrow();
    expect(named('method')).toThrow(/no type declared in this schema/);
    expect(named('user_id')).toThrow(/built by 'uuid_type', which is no 'record'/);
    expect(named('box')).toThrow(/open entry/);
  });

  it('§4.1: a namespace entry is a member of no kind of types', () => {
    const response = () =>
      withLayer().resolveSchema(
        governed(`order => { sku: text }
          orders => !interface { m => { response: order } }
          other  => !interface { m => { response: orders } }`),
      );
    expect(response).toThrow(/a value and not a type/);
  });
});

describe('declarations of kinds, references and namespace types ([TSON-SCHEMA] §4.1, §4.2, §5.12)', () => {
  function layer(body: string): () => LinkedSchema {
    return () =>
      standardLibrary().resolveSchema(
        `!!id:"https://example.com/m/l.tn"\n!!meta:"${KERNEL}"\n!!import:"${META}"\n{\n${body}\n}\n`,
      );
  }

  it('§4.1: a namespace type declares nothing beside its three facets', () => {
    expect(
      layer(
        `m => { r?: text }\nis => namespace & { key_type: = identifier  value_type: = m  extends?: [text] }`,
      ),
    ).toThrow(/declares the field 'extends' beside them/);
  });

  it('§4.1: a namespace type that is not abstract pins its key and value types', () => {
    expect(layer(`keyed => namespace & { key_type: = identifier }`)).toThrow(
      /leaves its 'key_type' or 'value_type' open/,
    );
    expect(layer(`keyed => abstract namespace & { key_type: = identifier }`)).not.toThrow();
  });

  it('§4.1, §4.2: a namespace’s keys are names, so its key type is an identifier family', () => {
    expect(
      layer(`verb => !enum [GET POST]\nvm => namespace & { key_type: = verb  value_type: = text }`),
    ).toThrow(/no member of it/);
  });

  it('§4.2: a kind’s `of` names `type`, `namespace` or a constructor below either', () => {
    expect(layer(`o => { id: kind<reference> }`)).toThrow(
      /not 'type', 'namespace' or a constructor below either/,
    );
    expect(layer(`o => { id: kind<record>  n: kind<namespace> }`)).not.toThrow();
  });

  it('§5.12: a reference names a value of a type, never of a constructor', () => {
    expect(layer(`holder => { r: ref<record> }`)).toThrow(/write kind<record>/);
    expect(layer(`order => { id: text }\nholder => { r: ref<order> }`)).not.toThrow();
  });

  it('§2.2.2: only a kernel-governed schema declares a reference or a namespace type', () => {
    const ordinary = (body: string) => () =>
      standardLibrary().resolveSchema(
        `!!id:"https://example.com/o.tn"\n!!meta:"${META}"\n!!import:"${CORE}"\n{\n${body}\n}\n`,
      );
    expect(ordinary(`order => { id: text }\noref => !ref_type { of: order }`)).toThrow(
      /not governed by the meta-kernel/,
    );
    // The base kind is out of an ordinary schema's reach as a composition operand at all.
    expect(ordinary(`ns => namespace & { key_type: = identifier  value_type: = text }`)).toThrow(
      /'ns'/,
    );
  });
});

describe('the name atoms ([TSON-SCHEMA] §4.2, §5.12)', () => {
  const qualified = createQualifiedNameParser('ref_order');

  it.each(['orders', 'orders.place_order', 'shop.orders.methods.place-order'])(
    '§5.12: %s is a qualified name',
    (text) => {
      expect(qualified.read({ text, form: 'unquoted' })).toBe(text);
    },
  );

  it.each(['.orders', 'orders.', 'orders.1x', ''])('§5.12: %s is no qualified name', (text) => {
    expect(() => qualified.read({ text, form: 'unquoted' })).toThrow(TsonAtomParseError);
  });

  it('§4.2: a kind’s value is a member where its names resolve, and the grammar alone elsewhere', () => {
    const kind = { kind: 'kind_type', of: 'uuid_type', members: ['customer_id', 'uuid'] } as const;
    expect(createKindParser('k', kind, true).read({ text: 'uuid', form: 'unquoted' })).toBe('uuid');
    expect(() => createKindParser('k', kind, true).read({ text: 'sku', form: 'unquoted' })).toThrow(
      TsonAtomValidationError,
    );
    expect(createKindParser('k', kind, false).read({ text: 'sku', form: 'unquoted' })).toBe('sku');
    expect(() =>
      createKindParser('k', kind, false).read({ text: 'a.b', form: 'unquoted' }),
    ).toThrow(TsonAtomParseError);
  });

  it('§4.2: a data document’s kind-typed field names a member of the kind', () => {
    const tson = standardLibrary();
    const linked = tson.resolveSchema(
      `!!id:"https://example.com/ids.tn"\n!!meta:"${META}"\n!!import:"${CORE}"\n{\n` +
        `customer_id => !uuid_type {}\nsku => text\nledger => { named: kind<uuid_type> }\n}\n`,
    );
    const compiled = compile(linked);
    expect(validate(compiled, 'ledger', encodeUtf8('{ named: customer_id }')).diagnostics).toEqual(
      [],
    );
    const refused = validate(compiled, 'ledger', encodeUtf8('{ named: sku }')).diagnostics;
    expect(refused.map((diagnostic) => diagnostic.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('a meta layer’s own constructor refining one of meta.tn’s ([TSON-SCHEMA] §4.2, §5.5)', () => {
  it('§5.5: reads its body through the constructor it refines, its own pins injected', () => {
    const tson = standardLibrary();
    const layer = tson.resolveSchema(
      `!!id:"https://example.com/m/e.tn"\n!!meta:"${KERNEL}"\n!!import:"${META}"\n{\n` +
        `spaced => !identifier_type { continue_add: " " }\n` +
        `spaced_enum => enum_type ^ { name_type?: = spaced }\n}\n`,
    );
    const read = createDefinitionMetaReader((name) => layer.entries.get(name));
    const body = read('spaced_enum', {
      annotations: [],
      typeRef: 'spaced_enum',
      coreValue: {
        kind: 'array',
        elements: [
          {
            value: {
              annotations: [],
              coreValue: { kind: 'token', text: 'New York', form: 'single-line' },
            },
          },
        ],
      },
    });
    expect(body).toMatchObject({ kind: 'enum', nameType: 'spaced', members: ['New York'] });
  });
});

describe('a namespace value’s names meet §8.2 at the read ([TSON-DATA] §8.2, [TSON-SCHEMA] §11.4)', () => {
  const CYRILLIC_PASS = 'раѕѕ'; // all-Cyrillic, a look-alike of `pass`
  const MIXED_PASS = 'pаss'; // Latin with a Cyrillic `а`

  function refusal(body: string): TsonNameHygieneRefusedError {
    try {
      withLayer().resolveSchema(governed(body));
    } catch (error) {
      if (error instanceof TsonNameHygieneRefusedError) return error;
      throw error;
    }
    throw new Error('expected a §8.2 refusal');
  }

  it('two keys of one namespace value that read alike are refused (skeleton distinctness)', () => {
    const error = refusal(
      `orders => !interface { pass => { response: text }  ${CYRILLIC_PASS} => { response: text } }`,
    );
    expect(error.mechanism).toBe('skeleton-distinctness');
  });

  it('a key mixing scripts is refused under the default restriction level', () => {
    const error = refusal(`orders => !interface { ${MIXED_PASS} => { response: text } }`);
    expect(error.mechanism).toBe('restriction-level');
  });

  it('an identifier-typed value inside the payload is a name and is judged too', () => {
    const error = refusal(
      `api => !services { shop => { extends: [${MIXED_PASS}]  methods: { list => { response: text } } } }`,
    );
    expect(error.mechanism).toBe('restriction-level');
    expect(error.names).toEqual([MIXED_PASS]);
  });

  it('single-script names that read alike only across scopes are admitted', () => {
    expect(() =>
      withLayer().resolveSchema(
        governed(
          `a => !interface { pass => { response: text } }\n b => !interface { ${CYRILLIC_PASS} => { response: text } }`,
        ),
      ),
    ).not.toThrow();
  });
});

describe('a diagnostic about a kind names the spelling the author wrote (§4.2, §8.2)', () => {
  it('a kind-typed slot of a meta layer’s record is named `kind<record>`, never its minted entry', () => {
    let message = '';
    try {
      withLayer().resolveSchema(governed('orders => !interface { place => { request: text } }'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("a member of 'kind<record>'");
    expect(message).not.toMatch(/kind_type_record_[0-9a-f]{8}/);
  });

  it('a field of the schema’s own typed by an inline kind is named as written', () => {
    let message = '';
    try {
      standardLibrary().resolveSchema(
        `!!id:"https://example.com/k.tn"\n!!meta:"${META}"\n!!import:"${CORE}"\n{\n  o => { k?: kind<record> = text }\n}\n`,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("is typed 'kind<record>'");
  });
});
