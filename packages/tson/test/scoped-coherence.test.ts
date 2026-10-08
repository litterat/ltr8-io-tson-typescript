/**
 * [TSON-SCHEMA] §7.8's one coherence rule, stated in `scoped`'s own `@doc` in `spec/m/meta.tn`:
 * "One coherence rule, of the family a resolver already runs over `min_items`/`max_items`:
 * `schemas` requires EXTERN in `scope`."
 */
import { describe, expect, it } from 'vitest';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const HEAD = `!!id:"test://scoped.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
`;
const load = (decls: string) => resolveUserSchema(`${HEAD}{ claim => { id: text }\n  ${decls} }`);

describe('§7.8: `schemas` requires EXTERN in `scope`', () => {
  it('refuses a LOCAL-only scope that names foreign schemas', () => {
    expect(() =>
      load('bad => !scoped { scope: [LOCAL]  schemas: { "https://example.com/a.tn" => [claim] } }'),
    ).toThrow(/does not admit EXTERN/);
  });

  it('admits the same `schemas` once EXTERN is in scope', () => {
    expect(() =>
      load('ok => !scoped { scope: [EXTERN]  schemas: { "https://example.com/a.tn" => [claim] } }'),
    ).not.toThrow();
  });

  it('admits a LOCAL-only scope that names no schemas', () => {
    expect(() => load('ok => !scoped { scope: [LOCAL] }')).not.toThrow();
  });

  // §7.8: "a key's absent value is every type that schema declares where a list is those types".
  it('admits a key whose value is absent -- every type that schema declares', () => {
    const linked = load(
      'any => !scoped { scope: [EXTERN]  schemas: { "https://example.com/a.tn" => _ } }',
    );
    const body = linked.entries.get('any')?.body;
    expect(body).toMatchObject({ kind: 'scoped' });
    // Absent and the empty list are the same list, and the reader reads both as "any type".
    expect(
      (body as { schemas: ReadonlyMap<string, readonly string[]> }).schemas.get(
        'https://example.com/a.tn',
      ),
    ).toEqual([]);
  });
});
