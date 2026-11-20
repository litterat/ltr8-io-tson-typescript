import { describe, expect, it } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonNameHygieneRefusedError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import { createReferenceParser, createQualifiedNameParser } from '../src/atom/reference.js';
import { compile, validate } from '../src/compiler/compile.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { writeNamespaceValue } from '../src/schema/namespaceReader.js';
import type { MetaValue, Namespace, Top } from '../src/schema/meta/typedef.js';
import { isValueEntry } from '../src/schema/meta/typedef.js';
import { standardLibrary } from '../src/stdlib/index.js';
import type { Tson } from '../src/config.js';
import type { LinkedSchema } from '../src/link/link.js';

const META = 'https://tson.io/2026/40/m/meta.tn';
const CORE = 'https://tson.io/2026/40/m/core.tn';
const LAYER = 'https://example.com/m/service.tn';

/**
 * A meta layer in the shape §4.1 describes: records, and namespace types holding them. A namespace type is
 * built with the kernel's `meta.namespace` constructor, `!meta.namespace { key_type: K  value_type: V }`, and
 * an entry built with one is a value (§4.1); a slot typed `meta.ref<meta.record>` holds a record type's name,
 * one typed `meta.ref<method>` a qualified name reaching a value of `method` (§4.2, §5.12).
 */
const SERVICE_LAYER = `!!id:"${LAYER}"
!!import:"${META}"
!schema {
  method      => { request?: meta.ref<meta.record>  response?: meta.type_ref  errors?: [meta.ref<meta.record>] }
  rpc_method  => method & { idempotent?: boolean }
  http_verb   => !enum [GET POST]
  interface   => !meta.namespace { key_type: meta.identifier  value_type: method }
  rpcs        => !meta.namespace { key_type: meta.identifier  value_type: rpc_method }
  header_set  => { headers: {text => method} }
  header_sets => !meta.namespace { key_type: meta.identifier  value_type: header_set }
  service     => { extends?: [meta.identifier]  methods: interface  note?: text }
  services    => !meta.namespace { key_type: meta.identifier  value_type: service }
  binding     => { method: meta.ref<method>  verb: http_verb  route: text }
  bindings    => !meta.namespace { key_type: meta.identifier  value_type: binding }
}
`;

function withLayer(): Tson {
  const tson = standardLibrary();
  tson.resolveSchema(SERVICE_LAYER);
  return tson;
}

/** A schema the service layer governs, holding `body`'s entries. */
function governed(body: string, id = 'https://example.com/app.tn'): string {
  return `!!id:"${id}"\n!!import:"${LAYER}"\n!!import:"${CORE}"\n!schema {\n${body}\n}\n`;
}

function namespaceEntry(linked: LinkedSchema, name: string): Namespace<MetaValue> {
  const value: Top | undefined = linked.entries.get(name);
  if (value === undefined || !isValueEntry(value) || value.value.form !== 'namespace') {
    throw new Error(`'${name}' is no namespace value`);
  }
  return value.value.value;
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
    // §4.2: a name at a type-name slot is kept as written, beside the slot it fills.
    expect(place.fields.get('request')).toEqual({
      form: 'token',
      token: { text: 'order', form: 'UNQUOTED' },
      slot: expect.objectContaining({ role: 'TYPE_NAME', of: 'meta.record' }) as unknown,
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
      'an annotated name',
      `bad => !bindings { b => { method: @doc:"m" x.y  verb: GET  route: "/" } }`,
    ],
    ['a tagged name', `bad => !interface { m => { request: !meta.record order } }`],
    ['a record-typed slot written as a name', `bad => !services { s => { methods: orders } }`],
  ])('§4.1, §5.12: refuses %s', (_label, entry) => {
    expect(() =>
      withLayer().resolveSchema(governed(`order => { sku: text }\nbox => <T> { v: T }\n${entry}`)),
    ).toThrow(/not valid data for|no value of the type/);
  });

  it('§2.4, §5.12: a quoted token at a name slot is the name it spells, judged as one', () => {
    expect(() =>
      withLayer().resolveSchema(
        governed(
          `order => { sku: text }\nbad => !bindings { b => { method: "x.y"  verb: GET  route: "/" } }`,
        ),
      ),
    ).toThrow(/'x' is no entry of this schema/);
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
    expect(written.coreValue.kind).toBe('map');
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

  it('§3.3.2: a type-name slot’s name resolves in the governed schema, never in the layer declaring the slot', () => {
    const named = (request: string) => () =>
      withLayer().resolveSchema(
        governed(`order => { sku: text }\nuser_id => uuid\nbox => <T> { v: T }\nalias => order
          orders => !interface { m => { request: ${request} } }`),
      );
    expect(named('order')).not.toThrow();
    expect(named('alias')).not.toThrow();
    expect(named('method')).not.toThrow(); // the layer's own `method` is in the one namespace, and is a record
    expect(named('user_id')).toThrow(/is no 'meta.record'/);
    expect(named('box')).toThrow(
      /is a parametric record, which denotes no type until it is applied/,
    );
  });

  it('§4.1: a namespace entry is a member of no reference over types', () => {
    const response = () =>
      withLayer().resolveSchema(
        governed(`order => { sku: text }
          orders => !interface { m => { response: order } }
          other  => !interface { m => { response: orders } }`),
      );
    expect(response).toThrow(/a value and not a type/);
  });

  it('§4.1, §8.3: an alias of a namespace entry is refused where it is declared, as its use would be', () => {
    const aliased = (uses: string) => () =>
      withLayer().resolveSchema(
        governed(`order => { sku: text }
          orders => !interface { m => { response: order } }
          o => orders
          ${uses}`),
      );
    expect(aliased('')).toThrow(/'o' names 'orders', which is a value and not a type/);
    expect(aliased('holder => { f: o }')).toThrow(TsonSchemaValidationError);
  });
});

describe('declarations of references and namespace types ([TSON-SCHEMA] §4.1, §4.2, §5.12)', () => {
  function layer(body: string): () => LinkedSchema {
    return () =>
      standardLibrary().resolveSchema(
        `!!id:"https://example.com/m/l.tn"\n!!import:"${META}"\n!schema {\n${body}\n}\n`,
      );
  }

  it('§4.1: a namespace type pins its key and value types, both resolving in the schema’s namespace', () => {
    expect(
      layer(
        `m => { r?: text }\nis => !meta.namespace { key_type: meta.identifier  value_type: m }`,
      ),
    ).not.toThrow();
    expect(
      layer(`is => !meta.namespace { key_type: meta.identifier  value_type: nowhere }`),
    ).toThrow(/nowhere/);
  });

  it('§5.12: a reference over a constructor names the types built with it, over a type the values of it', () => {
    expect(layer(`holder => { r: meta.ref<meta.record> }`)).not.toThrow();
    expect(layer(`order => { id: text }\nholder => { r: meta.ref<order> }`)).not.toThrow();
  });

  it('§4.2: a reference whose `of` resolves to nothing is refused', () => {
    expect(layer(`holder => { r: meta.ref<nowhere> }`)).toThrow(/nowhere/);
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

  it('§4.2: a reference over a constructor reads a member where its names resolve, and the grammar alone elsewhere', () => {
    const reference = {
      kind: 'ref',
      of: { name: 'net.uuid_type', annotations: [] },
      index: {
        namesTypes: true,
        members: ['customer_id', 'net.uuid_type'],
        aliases: new Map<string, string>(),
        entries: new Map<string, unknown>(),
        shown: [],
      },
    } as const;
    expect(
      createReferenceParser('k', reference, true).read({ text: 'net.uuid_type', form: 'unquoted' }),
    ).toBe('net.uuid_type');
    expect(() =>
      createReferenceParser('k', reference, true).read({ text: 'sku', form: 'unquoted' }),
    ).toThrow(TsonAtomValidationError);
    expect(
      createReferenceParser('k', reference, false).read({ text: 'sku', form: 'unquoted' }),
    ).toBe('sku');
    expect(() =>
      createReferenceParser('k', reference, false).read({ text: 'a..b', form: 'unquoted' }),
    ).toThrow(TsonAtomParseError);
  });

  it('§2.4, §7.1: a quoted token at a reference position is the reference its text spells', () => {
    const reference = {
      kind: 'ref',
      of: { name: 'net.uuid_type', annotations: [] },
      index: {
        namesTypes: true,
        members: ['customer_id', 'net.uuid_type'],
        aliases: new Map<string, string>(),
        entries: new Map<string, unknown>(),
        shown: [],
      },
    } as const;
    const parser = createReferenceParser('k', reference, true);
    expect(parser.read({ text: 'customer_id', form: 'single-line' })).toBe(
      parser.read({ text: 'customer_id', form: 'unquoted' }),
    );
    expect(parser.read({ text: 'net.uuid_type', form: 'single-line' })).toBe('net.uuid_type');
  });

  it('§4.1, [TSON-JSON] §5.6: text spelling an application or a dependent type is no reference, quoted or not', () => {
    const reference = {
      kind: 'ref',
      of: { name: 'net.uuid_type', annotations: [] },
      index: {
        namesTypes: true,
        members: ['customer_id'],
        aliases: new Map<string, string>(),
        entries: new Map<string, unknown>(),
        shown: [],
      },
    } as const;
    for (const judges of [true, false]) {
      for (const form of ['unquoted', 'single-line'] as const) {
        for (const text of ['set<text>', 'kind!']) {
          expect(() => createReferenceParser('k', reference, judges).read({ text, form })).toThrow(
            TsonAtomParseError,
          );
        }
      }
    }
  });

  it('§4.2: a data document’s reference-typed field names a member of the reference', () => {
    const tson = standardLibrary();
    const linked = tson.resolveSchema(
      `!!id:"https://example.com/ids.tn"\n!!import:"${CORE}"\n!schema {\n` +
        `customer_id => !net.uuid_type {}\nsku => text\nledger => { named: meta.ref<net.uuid_type> }\n}\n`,
    );
    const compiled = compile(linked);
    expect(validate(compiled, 'ledger', encodeUtf8('{ named: customer_id }')).diagnostics).toEqual(
      [],
    );
    const refused = validate(compiled, 'ledger', encodeUtf8('{ named: sku }')).diagnostics;
    expect(refused.map((diagnostic) => diagnostic.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
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

describe('a diagnostic about a reference names the spelling the author wrote (§4.2, §8.2)', () => {
  it('a reference slot of a layer’s record is named as written, never its minted entry', () => {
    let message = '';
    try {
      withLayer().resolveSchema(governed('orders => !interface { place => { request: text } }'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('meta.ref<meta.record>');
    expect(message).not.toMatch(/reference_type_record_false_[0-9a-f]{8}/);
  });
});
