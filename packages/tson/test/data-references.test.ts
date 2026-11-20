import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import type { Tson } from '../src/config.js';
import type { Diagnostic, DiagnosticCode } from '../src/core/diagnostic.js';
import { TsonSchemaFetchError, TsonParseError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * A reference in a data document ([TSON-SCHEMA] §4.2, §5.12, §8.2, [TSON-DATA] §2.2): a data document is read under
 * the one namespace its own `!!import`s merge into (§2.2.3), and a name at a reference slot is judged over that
 * namespace. A reference is a name: an argument list is schema grammar, which no data value spells.
 */

const META = '!!import:"https://tson.io/2026/40/m/meta.tn"';
const CORE = '!!import:"https://tson.io/2026/40/m/core.tn"';

const ORDERS = `!!id:"https://example.test/orders.tn"
${META}
${CORE}
!schema {
  order      => { id: text }
  rush_order => order & { by: text }
  customer   => { name: text }
  orders     => !meta.namespace { key_type: meta.identifier  value_type: order }
  order_ref  => meta.ref<order>
  pick       => { which: order_ref }
  o1         => !order { id: "A-1" }
  r1         => !rush_order { id: "R-1"  by: noon }
  c1         => !customer { name: Ada }
  book       => !orders { first => { id: "B-1" } }
  names      => set<text>
  box        => <T> { v: T }
  user_id    => uuid
  uid        => user_id
  holder     => { t: meta.type_ref }
}`;

const SHIPPING = `!!id:"https://example.test/shipping.tn"
${META}
${CORE}
!schema {
  parcel => { weight: int32 }
}`;

const CLASHING = `!!id:"https://example.test/clashing.tn"
${META}
${CORE}
!schema {
  parcel => { colour: text }
}`;

function instance(documents: Record<string, string> = {}): Tson {
  const encoded: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(documents)) encoded[id] = encodeUtf8(text);
  return standardLibrary({ schemaSource: mapSchemaSource(encoded) });
}

async function validated(
  tson: Tson,
  imports: readonly string[],
  body: string,
): Promise<readonly Diagnostic[]> {
  await tson.preload(imports);
  const header = imports.map((id) => `!!import:"${id}"\n`).join('');
  return tson.validateDocument(encodeUtf8(header + body)).diagnostics;
}

const ORDERS_ID = 'https://example.test/orders.tn';
const SHIPPING_ID = 'https://example.test/shipping.tn';
const CLASHING_ID = 'https://example.test/clashing.tn';
const ALL = { [ORDERS_ID]: ORDERS, [SHIPPING_ID]: SHIPPING, [CLASHING_ID]: CLASHING };

function codes(diagnostics: readonly Diagnostic[]): DiagnosticCode[] {
  return diagnostics.map((d) => d.code);
}

describe('a name at a reference over a type names a value of it (§4.2, §5.12)', () => {
  it.each([
    ['an entry whose value is of the type', 'o1'],
    ['an entry whose value is of a subtype', 'r1'],
    ['a key of a namespace value', 'book.first'],
  ])('%s is read', async (_label, name) => {
    expect(await validated(instance(ALL), [ORDERS_ID], `!pick { which: ${name} }`)).toEqual([]);
  });

  it.each([
    ['a value of another type', 'c1'],
    ['a type', 'order'],
    ['nothing', 'nope'],
    ['a key the namespace value does not hold', 'book.second'],
    ['a segment that is no identifier', 'book.1x'],
  ])('%s is refused as a constraint the value breaks', async (_label, name) => {
    const found = await validated(instance(ALL), [ORDERS_ID], `!pick { which: ${name} }`);
    expect(codes(found).length).toBeGreaterThan(0);
    for (const code of codes(found)) {
      expect(['ATOM_CONSTRAINT_VIOLATION', 'ATOM_FORM_INVALID']).toContain(code);
    }
  });
});

describe('a name at a reference over a constructor names a type (§4.2, §5.10)', () => {
  it('a completion is a type, named by its declaration', async () => {
    expect(await validated(instance(ALL), [ORDERS_ID], '!holder { t: names }')).toEqual([]);
  });

  it('an alias of a type is a member through its hops (§8.3)', async () => {
    expect(await validated(instance(ALL), [ORDERS_ID], '!holder { t: uid }')).toEqual([]);
  });

  it('an argument list is schema grammar, and no data value spells one ([TSON-DATA] §7.2.5)', async () => {
    const tson = instance(ALL);
    expect((await validated(tson, [ORDERS_ID], '!holder { t: set<text> }')).length).toBeGreaterThan(
      0,
    );
    // A quoted token is the reference its text spells, and that text is no name.
    const quoted = await validated(tson, [ORDERS_ID], '!holder { t: "set<text>" }');
    expect(codes(quoted)).toEqual(['ATOM_FORM_INVALID']);
  });

  it('a dependent type’s mark is schema grammar, and no data value spells one (§5.2)', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: "kind!" }');
    expect(codes(found)).toEqual(['ATOM_FORM_INVALID']);
  });

  it('a parametric record named bare is no member: no reference names one until it is applied (§5.10)', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: box }');
    expect(codes(found)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('a name that is no member of the kind is refused, naming the kind', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: nowhere }');
    expect(codes(found)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
    expect(found[0]?.message).toContain('is not a member of this kind');
  });
});

describe('a data document reads under the namespace its imports merge into (§2.2.3, [TSON-DATA] §2.2)', () => {
  it('several imports are one namespace over their closures', async () => {
    const tson = instance(ALL);
    expect(await validated(tson, [ORDERS_ID, SHIPPING_ID], '!parcel { weight: 3 }')).toEqual([]);
    // The same set in any spelling is the same namespace, compiled once.
    expect(await validated(tson, [SHIPPING_ID, ORDERS_ID], '!pick { which: o1 }')).toEqual([]);
  });

  it('a name two imports declare differently refuses the whole namespace', async () => {
    const found = await validated(
      instance(ALL),
      [SHIPPING_ID, CLASHING_ID],
      '!parcel { weight: 3 }',
    );
    expect(codes(found)).toEqual(['SCHEMA_ERROR']);
  });

  it('a root type-ref naming no type of the closure is an unknown type', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!nothing { a: 1 }');
    expect(codes(found)).toEqual(['UNKNOWN_TYPE']);
  });

  it('a qualified root tag walks into a schema map, and finds no member there', async () => {
    const tson = instance({
      'https://example.test/geo.tn': `!!id:"https://example.test/geo.tn"
${META}
${CORE}
!schema {
  geo => !schema {
    address => { street: text }
  }
}`,
    });
    expect(
      await validated(tson, ['https://example.test/geo.tn'], '!geo.address { street: x }'),
    ).toEqual([]);
    expect(
      codes(await validated(tson, ['https://example.test/geo.tn'], '!geo.region { street: x }')),
    ).toEqual(['UNKNOWN_TYPE']);
  });

  it('a document that imports a schema and states no root type-ref has no type to read as', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '{ a: 1 }');
    expect(codes(found)).toEqual(['VALIDATION_ERROR']);
  });

  it('an import that is not registered is refused as a schema this instance will not supply, never thrown', () => {
    // A read fetches nothing, so the instance refuses what it does not hold -- the reference's own
    // `SchemaSource.registeredOnly` miss -- which is no verdict on the document or on the schema.
    const tson = instance(ALL);
    const found = tson.validateDocument(
      encodeUtf8(`!!import:"https://example.test/orders.tn"\n!pick { which: o1 }`),
    );
    expect(codes(found.diagnostics)).toEqual(['SCHEMA_NOT_PERMITTED']);
  });

  it('a document with no import has no schema and reads schemaless', () => {
    const found = instance().validateDocument(encodeUtf8('{ a: 1 }'));
    expect(found.diagnostics).toEqual([]);
  });

  it('readDocument throws at the first problem', async () => {
    const tson = instance(ALL);
    await tson.preload([ORDERS_ID]);
    expect(() =>
      tson.readDocument(encodeUtf8(`!!import:"${ORDERS_ID}"\n!pick { which: c1 }`)),
    ).toThrow();
    expect(tson.readDocument(encodeUtf8(`!!import:"${ORDERS_ID}"\n!pick { which: o1 }`)).kind).toBe(
      'record',
    );
  });
});

describe('preload obtains a schema with what it names (§2.2.3)', () => {
  it('a schema’s own imports are fetched and resolved first, in dependency order', async () => {
    const tson = standardLibrary({
      schemaSource: mapSchemaSource({
        'https://example.test/top.tn': encodeUtf8(`!!id:"https://example.test/top.tn"
${META}
!!import:"https://example.test/middle.tn"
!schema { top => { m: middle } }`),
        'https://example.test/middle.tn': encodeUtf8(`!!id:"https://example.test/middle.tn"
${META}
${CORE}
!schema { middle => { n: int32 } }`),
      }),
    });
    await tson.preload(['https://example.test/top.tn']);
    expect(tson.schemas.has('example.test/top.tn')).toBe(true);
    expect(tson.schemas.has('example.test/middle.tn')).toBe(true);
  });

  it('a document that is no schema is refused as an import, by the test that classifies a document', async () => {
    const tson = standardLibrary({
      schemaSource: mapSchemaSource({
        'https://example.test/data.tn': encodeUtf8(
          '!!id:"https://example.test/data.tn"\n{ price: 10 }\n',
        ),
      }),
    });
    await expect(tson.preload(['https://example.test/data.tn'])).rejects.toThrow(TsonParseError);
  });

  it('a schema the source cannot supply is a fetch failure naming it', async () => {
    const tson = standardLibrary({ schemaSource: mapSchemaSource({}) });
    await expect(tson.preload(['https://example.test/missing.tn'])).rejects.toThrow(
      TsonSchemaFetchError,
    );
  });
});
