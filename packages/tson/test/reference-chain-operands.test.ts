/**
 * [TSON-SCHEMA] §4.3's one-line rule, over every operand form that consumes a vocabulary body:
 * "The source of a refinement and every operand of a composition or subtraction MUST, **after
 * following its reference chain** (§8.3), be a definition whose body is a `!record`." §5.5 asks
 * the same of an atom refinement's source, and §7.2 asks it of *both* sides of a subsumption
 * check -- "after following both reference chains to their terminal entries".
 *
 * A reference is a hop, not a different type, so an alias to a record is an admissible operand.
 * What the walk does not do is launder a finished body: "an alias resolving to [a binding record
 * or a template instantiation] is *finished*" and admits neither operator.
 *
 * The walk decides only what an operand *is*. What the resolved entry records is the name the
 * author wrote, since §8.3 states a chain as written and collapses it nowhere -- which is what the
 * `supertypes` assertions below check.
 */
import { describe, expect, it } from 'vitest';
import { compile, validate } from '../src/compiler/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const HEAD = `!!id:"test://chain.tn"
!!meta:"https://tson.io/2026/35/m/meta.tn"
!!import:"https://tson.io/2026/35/m/core.tn"
`;

describe('§4.3/§5.5/§5.7: an operand is judged after following its reference chain (§8.3)', () => {
  it('a refinement source may be an alias to a record', () => {
    const linked = resolveUserSchema(`${HEAD}{
  base => { a: text  b: text }
  base_alias => base
  derived => base_alias ^ { a: text ~ "x" }
}`);
    expect(linked.entries.get('derived')?.supertypes).toContain('base_alias');
  });

  it('a composition operand may be an alias to a record', () => {
    const linked = resolveUserSchema(`${HEAD}{
  base => { a: text }
  base_alias => base
  derived => base_alias & { c: text }
}`);
    expect(linked.entries.get('derived')?.supertypes).toContain('base_alias');
  });

  it('an atom refinement source may be an alias to an atom instance', () => {
    const linked = resolveUserSchema(`${HEAD}{
  my_int => integer
  small => !my_int ^ { min: 0  max: 10 }
}`);
    expect(linked.entries.get('small')?.body).toMatchObject({ kind: 'integer_type' });
  });

  it('§7.2 follows both chains: an alias to a subtype is admitted at the supertype position', () => {
    const linked = resolveUserSchema(`${HEAD}{
  base => { a: text }
  derived => base & { b: text }
  d_alias => derived
  holder => { f: base }
}`);
    const compiled = compile(linked);
    const { diagnostics } = validate(
      compiled,
      'holder',
      new TextEncoder().encode('{ f: !d_alias { a: "x" b: "y" } }'),
    );
    expect(diagnostics).toEqual([]);
  });

  it('an alias to a binding record is still finished and refuses ^', () => {
    expect(() =>
      resolveUserSchema(`${HEAD}{
  made => !integer_type {}
  made_alias => made
  bad => made_alias ^ { c: text }
}`),
    ).toThrow(/finished|no vocabulary to tighten/);
  });
});
