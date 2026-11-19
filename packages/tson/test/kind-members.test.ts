import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { isKindMember } from '../src/link/kindMembers.js';
import type { ReferenceBody } from '../src/schema/meta/bodies.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { fieldTypeName, recordEntry } from './linked-entries.js';
import { supertypesOf, subtypesOf } from '../src/schema/meta/typedef.js';

/**
 * [TSON-SCHEMA] §4.2's `reference` over a constructor, a kind: the atom whose values are the names of the
 * entries whose value is of its `of`, its members computed at link over the whole closure.
 *
 * Each walk case the kernel's `reference` doc names is pinned on its own: a construction is a member, a
 * refinement of a member is one, a type built with another constructor is not, an ABSTRACT record base is a
 * member of `meta.ref<record>` with no values of its own, an instantiation is a member of its constructor's
 * kind where the template it closes is not, and a constructor, whose declaration is a record, is a member of
 * `meta.ref<record>` and `meta.type_ref`. Then `of`: any type or constructor of the schema's one namespace, a
 * type that is no constructor making the reference one that names values. Last, the kernel's `name_type`
 * slots, typed `meta.identifier_ref`, judged by membership.
 */

const HEADER = `!!id:"https://example.test/kinds.tn"
!!import:"https://tson.io/2026/39/m/meta.tn"
!!import:"https://tson.io/2026/39/m/core.tn"
!schema `;

function link(body: string): LinkedSchema {
  return standardLibrary().resolveSchema(HEADER + body);
}

function kind(linked: LinkedSchema, name: string): ReferenceBody {
  const body = linked.entries.get(name);
  if (body === undefined || !('kind' in body) || body.kind !== 'reference_type') {
    throw new Error(`'${name}' is no reference`);
  }
  return body;
}

function members(linked: LinkedSchema, name: string): readonly string[] {
  return kind(linked, name).index?.members ?? [];
}

function refusal(body: string, header = HEADER): string {
  try {
    standardLibrary().resolveSchema(header + body);
  } catch (error) {
    if (error instanceof TsonSchemaValidationError) return error.message;
    throw error;
  }
  throw new Error('expected the schema to be refused');
}

const IDS = `{
  stock_id    => !net.uuid_type {}
  customer_id => !net.uuid_type {}
  v4_stock_id => !stock_id ^ { version: 4 }
  sku         => text
  any_id      => !meta.reference_type { of: net.uuid_type }
}`;

describe('the members of a reference over a constructor (§4.2, §5.12)', () => {
  it('a construction and a refinement of one are members; the constructor and another family are not', () => {
    const linked = link(IDS);
    // core's own `uuid` is a member too: the closure is the schema's, imports included.
    expect(members(linked, 'any_id')).toEqual(['customer_id', 'stock_id', 'uuid', 'v4_stock_id']);
    expect(kind(linked, 'any_id').of.name).toBe('net.uuid_type');
  });

  it('the inline spelling closes to the same instance', () => {
    const linked = link(`{
      stock_id => !net.uuid_type {}
      order    => { id: meta.ref<net.uuid_type> }
    }`);
    const inline = kind(linked, fieldTypeName(recordEntry(linked, 'order'), 'id'));
    expect(inline.of.name).toBe('net.uuid_type');
    expect(inline.allowSibling).toBe(false);
    expect(inline.index?.members).toEqual(['stock_id', 'uuid']);
  });

  it('a brace record is built with record, and an ABSTRACT base is a member', () => {
    const linked = link(`{
      pet     => abstract { name: text }
      dog     => pet & { breed: text }
      records => !meta.reference_type { of: meta.record }
    }`);
    expect(members(linked, 'records')).toEqual(
      expect.arrayContaining(['dog', 'pet', 'meta.record_field']),
    );
  });

  it('an instantiation is a member of its constructor’s kind and a record template of its own (§5.10)', () => {
    const linked = link(`{
      tags  => set<text>
      sets  => !meta.reference_type { of: meta.set_type }
      boxed => <T> { v: T }
      box_t => boxed<text>
      recs  => !meta.reference_type { of: meta.record }
      tmpls => !meta.reference_type { of: meta.record_template }
    }`);
    // `set` is meta's template, a `template` body: no type, so no member. The kernel's own sets are members.
    const sets = members(linked, 'sets');
    expect(sets).toEqual(expect.arrayContaining(['tags', 'meta.enum_set']));
    expect(sets).not.toContain('set');
    const recs = members(linked, 'recs');
    expect(recs).toContain('box_t');
    expect(recs).not.toContain('boxed');
    const templates = members(linked, 'tmpls');
    expect(templates).toContain('boxed');
    expect(templates).not.toContain('box_t');
  });

  it('a base kind takes every construction below it', () => {
    const linked = link(`{
      stock_id => !net.uuid_type {}
      atoms    => !meta.reference_type { of: meta.atom }
    }`);
    expect(members(linked, 'atoms')).toEqual(
      expect.arrayContaining(['stock_id', 'uuid', 'text', 'int32', 'boolean']),
    );
    expect(members(linked, 'atoms')).not.toContain('set');
  });

  it('an alias of a member is a member through its hop (§8.3)', () => {
    const linked = link(`{
      stock_id => !net.uuid_type {}
      sku_id   => stock_id
      ids      => !meta.reference_type { of: net.uuid_type }
    }`);
    expect(members(linked, 'ids')).toEqual(['sku_id', 'stock_id', 'uuid']);
  });

  it('a kind is a member of itself where the walk says so, and nothing loops', () => {
    const linked = link(`{
      shape => (text | int32)
      atoms => !meta.reference_type { of: meta.atom }
      kinds => !meta.reference_type { of: meta.reference_type }
      ids   => meta.ref<net.uuid_type>
    }`);
    expect(members(linked, 'atoms')).toEqual(expect.arrayContaining(['atoms', 'kinds', 'ids']));
    expect(members(linked, 'atoms')).not.toContain('shape');
    expect(members(linked, 'kinds')).toEqual(
      expect.arrayContaining(['atoms', 'ids', 'kinds', 'meta.type_ref']),
    );
  });

  it('a member declared in an import is a member, and an import’s own kind is recomputed over the importer’s closure (§2.2.3)', () => {
    const tson = standardLibrary();
    tson.resolveSchema(`!!id:"https://example.test/kind-ids.tn"
!!import:"https://tson.io/2026/39/m/meta.tn"
!!import:"https://tson.io/2026/39/m/core.tn"
!schema {
  stock_id => !net.uuid_type {}
  some_id  => meta.ref<net.uuid_type>
}`);
    const linked = tson.resolveSchema(`!!id:"https://example.test/kinds.tn"
!!import:"https://tson.io/2026/39/m/meta.tn"
!!import:"https://example.test/kind-ids.tn"
!schema {
  customer_id => !net.uuid_type {}
  any_id      => meta.ref<net.uuid_type>
}`);
    expect(members(linked, 'any_id')).toEqual(['customer_id', 'stock_id', 'uuid']);
    expect(members(linked, 'some_id')).toEqual(['customer_id', 'stock_id', 'uuid']);
  });

  it('the admitted names are the linker’s judgement and never a field an author writes (§8.1)', () => {
    expect(
      refusal(`{
        stock_id => !net.uuid_type {}
        any_id   => !meta.reference_type { of: net.uuid_type  members: [sku] }
        sku      => text
      }`),
    ).toContain('members');
  });

  it('meta.type_ref holds the namespace types and the constructors, and no template (§4.1)', () => {
    const kernel = standardLibrary().schemas.get('tson.io/2026/39/m/meta.tn');
    if (kernel === undefined) throw new Error('the kernel is not registered');
    const held = members(kernel, 'meta.type_ref');
    expect(held).toEqual(
      expect.arrayContaining([
        'meta.field_map',
        'meta.schema',
        'meta.declared',
        'meta.set_type',
        'meta.record',
        'meta.alias',
        'meta.namespace',
        'meta.reference_type',
        'meta.top',
      ]),
    );
    expect(held).not.toContain('meta.ref');
  });

  it('meta.ref<namespace> holds every namespace type, the kernel root’s `schema` beside `meta.schema`', () => {
    const linked = standardLibrary().resolveSchema(`!!id:"https://example.test/kinds.tn"
!!import:"https://tson.io/2026/39/m/meta.tn"
!schema {
  api        => !meta.namespace { key_type: meta.identifier  value_type: text }
  namespaces => !meta.reference_type { of: meta.namespace }
}`);
    expect(members(linked, 'namespaces')).toEqual(['api', 'meta.schema', 'schema']);
  });

  it('a namespace type is a map and no record: IS-A map and product (§4.1)', () => {
    const linked = standardLibrary().resolveSchema(`!!id:"https://example.test/kinds.tn"
!!import:"https://tson.io/2026/39/m/meta.tn"
!schema {
  api        => !meta.namespace { key_type: meta.identifier  value_type: text }
  labels     => !meta.map { key_type: meta.identifier  value_type: text }
  types      => !meta.reference_type { of: meta.type }
  namespaces => !meta.reference_type { of: meta.namespace }
  records    => !meta.reference_type { of: meta.record }
  products   => !meta.reference_type { of: meta.product }
  maps       => !meta.reference_type { of: meta.map }
}`);
    for (const name of ['types', 'namespaces', 'products', 'maps']) {
      expect(members(linked, name), name).toEqual(expect.arrayContaining(['api', 'meta.schema']));
    }
    const records = members(linked, 'records');
    expect(records).not.toContain('api');
    expect(records).not.toContain('meta.schema');
    expect(records).not.toContain('meta.field_map');
    expect(members(linked, 'maps')).toEqual(expect.arrayContaining(['labels', 'meta.field_map']));
    expect(members(linked, 'namespaces')).not.toContain('labels');
    expect(members(linked, 'namespaces')).not.toContain('meta.field_map');
  });
});

describe('a refinement of a reference narrows `of` (§4.2, §5.7)', () => {
  it('narrows `of` to the source’s or a type IS-A it, and is IS-A its source', () => {
    const linked = link(`{
      api        => !meta.namespace { key_type: meta.identifier  value_type: text }
      products   => !meta.reference_type { of: meta.product }
      maps       => !products ^ { of: meta.map }
      namespaces => !maps ^ { of: meta.namespace }
      records    => !meta.type_ref ^ { of: meta.record }
      same       => !products ^ {}
      order      => { id: text }
      big_order  => order ^ {}
      orders     => !meta.reference_type { of: order }
      big_orders => !orders ^ { of: big_order }
    }`);
    expect(supertypesOf(kind(linked, 'maps'))).toEqual(['products']);
    expect(supertypesOf(kind(linked, 'namespaces'))).toEqual(['maps', 'products']);
    expect(supertypesOf(kind(linked, 'meta.identifier_ref'))).toEqual([
      'meta.field_type_ref',
      'meta.type_ref',
    ]);
    expect(subtypesOf(kind(linked, 'meta.type_ref'))).toContain('meta.identifier_ref');
    expect(kind(linked, 'namespaces').of.name).toBe('meta.namespace');
    expect(kind(linked, 'big_orders').of.name).toBe('big_order');
    const namespaces = members(linked, 'namespaces');
    expect(namespaces).toContain('api');
    expect(namespaces).not.toContain('meta.field_map');
    expect(members(linked, 'products')).toEqual(
      expect.arrayContaining([...members(linked, 'maps')]),
    );
  });

  it('a refinement whose `of` widens the source’s is refused: it would admit names the source refuses', () => {
    const message = refusal(`{
      maps => !meta.reference_type { of: meta.map }
      wide => !maps ^ { of: meta.product }
    }`);
    expect(message).toContain("not a valid refinement of '!maps'");
    expect(message).toContain("of 'meta.product' is not 'meta.map' or IS-A it");
  });

  it('and so is one whose `of` is unrelated to the source’s, over constructors and over ordinary types', () => {
    expect(
      refusal(`{
        maps => !meta.reference_type { of: meta.map }
        odd  => !maps ^ { of: meta.record }
      }`),
    ).toContain("of 'meta.record' is not 'meta.map' or IS-A it");
    expect(
      refusal(`{
        order  => { id: text }
        orders => !meta.reference_type { of: order }
        texts  => !orders ^ { of: text }
      }`),
    ).toContain("of 'text' is not 'order' or IS-A it");
  });
});

describe('what `of` names decides what a reference admits (§4.2)', () => {
  it('a kind of alias admits nothing, and a required field typed by it is uninhabited (§5.10.1)', () => {
    expect(refusal('{ order => { id: meta.ref<meta.alias> } }')).toContain(
      'can never be satisfied',
    );
  });

  it('a reference over top names every type', () => {
    const linked = link(`{
      order => { id: text }
      tops  => !meta.reference_type { of: meta.top }
    }`);
    expect(members(linked, 'tops')).toEqual(
      expect.arrayContaining(['order', 'text', 'meta.record', 'tops']),
    );
  });

  it('an `of` naming a type that is no constructor names values, and holds no type’s name', () => {
    const linked = link(`{
      stock_id => !net.uuid_type {}
      ids      => !meta.reference_type { of: stock_id }
    }`);
    const ids = kind(linked, 'ids');
    expect(ids.index?.namesTypes).toBe(false);
    expect(ids.index?.members).toEqual([]);
  });

  it('a schema may declare a name the kernel holds under a map, and no name the kernel holds at its root (§2.2.3)', () => {
    expect(link('{ uuid_type => text }').entries.has('uuid_type')).toBe(true);
    expect(refusal('{ meta => text }')).toContain("'meta' collides");
  });

  it('an empty kind admits no value and is refused as uninhabited (§5.10.1)', () => {
    expect(
      refusal(
        `{
          pick_type => meta.atom & {}
          ids => !meta.reference_type { of: pick_type }
        }`,
        `!!id:"https://example.test/kinds.tn"\n!!import:"https://tson.io/2026/39/m/meta.tn"\n!schema `,
      ),
    ).toContain('can never be satisfied');
  });

  it('a default at a reference over a constructor must name a member (§5.2)', () => {
    expect(() =>
      link(`{
        stock_id => !net.uuid_type {}
        ledger   => { named?: meta.ref<net.uuid_type> ~ stock_id }
      }`),
    ).not.toThrow();
    expect(
      refusal(`{
        stock_id => !net.uuid_type {}
        sku      => text
        ledger   => { named?: meta.ref<net.uuid_type> ~ sku }
      }`),
    ).toContain("'sku'");
  });
});

describe('the kernel’s name_type slots, typed meta.identifier_ref (§4.2, §5.2)', () => {
  it('holds the kernel’s identifier families and the aliases beside them', () => {
    const meta = standardLibrary().schemas.get('tson.io/2026/39/m/meta.tn');
    if (meta === undefined) throw new Error('the kernel is not registered');
    expect(members(meta, 'meta.identifier_ref')).toEqual([
      'meta.field_name',
      'meta.identifier',
      'meta.param_name',
      'meta.type_name',
      'net.scheme_name',
    ]);
  });

  it('an instantiation of a template over identifier_type is a name type', () => {
    const linked = link(`{
      words_of => <C: text> !unicode.identifier_type { continue_add: "-"  medial: C }
      spaced   => words_of<" ">
      cities   => !meta.enum_type { name_type: spaced  members: ["New York" Sydney] }
    }`);
    const heads = (name: string): string | undefined => linked.facts.get(name)?.head;
    expect(
      isKindMember('spaced', 'unicode.identifier_type', (name) => linked.entries.get(name), heads),
    ).toBe(true);
  });

  it('a constructor pinning name_type pins a value of the slot’s kind, judged where the pin is written', () => {
    const header = `!!id:"https://example.test/kinds.tn"\n!!import:"https://tson.io/2026/39/m/meta.tn"\n!schema `;
    expect(() =>
      standardLibrary().resolveSchema(
        header +
          `{
            text_identifier => !unicode.identifier_type { continue_add: " " }
            text_enum       => meta.enum_type ^ { name_type?: = text_identifier }
          }`,
      ),
    ).not.toThrow();
    expect(
      refusal(
        `{
          phrase      => !unicode.text_type { normalization: NFC }
          phrase_enum => meta.enum_type ^ { name_type?: = phrase }
        }`,
        header,
      ),
    ).toContain("'phrase'");
  });

  it('a name type that is no member keeps its diagnostic', () => {
    expect(
      refusal('{ ports => !meta.enum_type { name_type: integer  members: ["80" "443"] } }'),
    ).toContain('identifier');
  });
});
