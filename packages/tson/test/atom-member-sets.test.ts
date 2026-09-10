import { describe, expect, it } from 'vitest';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const HEAD = `!!id:"test://m.tn"
!!meta:"https://tson.io/2026/35/m/meta.tn"
!!import:"https://tson.io/2026/35/m/core.tn"
`;
const load = (decls: string) => resolveUserSchema(`${HEAD}{ ${decls} }`);

describe('§7.4 member-set coherence', () => {
  it('refuses 80 and 0x50 as one member written twice', () => {
    expect(() => load('port => !integer ^ { members: [80 0x50] }')).toThrow(/more than once/);
  });
  it('refuses a literal repeat', () => {
    expect(() => load('n => !integer ^ { members: [1 1] }')).toThrow(/more than once/);
  });
  it('refuses 1 and 1.0 as one decimal member (§5.5)', () => {
    expect(() => load('d => !number ^ { members: [1 1.0] }')).toThrow(/more than once/);
  });
  it('refuses an empty integer member set', () => {
    expect(() => load('e => !integer ^ { members: [] }')).toThrow(/admits no value/);
  });
  it('refuses an empty decimal member set', () => {
    expect(() => load('e => !number ^ { members: [] }')).toThrow(/admits no value/);
  });
  it('admits a genuine set', () => {
    expect(() => load('ok => !integer ^ { members: [80 443 8080] }')).not.toThrow();
  });
  it('still refuses a member outside the body’s own facets', () => {
    expect(() =>
      load('bad => !integer ^ { members: [443]  size: { bits: 8  signed: false } }'),
    ).toThrow();
  });
});
