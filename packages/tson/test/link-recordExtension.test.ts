import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/**
 * `link/recordExtension.ts` -- §5.2's discriminated-family coherence, checked over a whole linked
 * namespace: a selector's declared type, and the family's pin distinctness (as values, as tuples
 * where a base marks several fields). The FINAL/composition/refinement refusal itself is
 * `definitionResolver.ts`'s own and is tested there (`definitionResolver.test.ts`'s "FINAL admits
 * no subtype" block); this file is the link-time family pass alone.
 */

function link(source: string): LinkedSchema {
  return resolveUserSchema(`
!!id:"test://record-extension.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  ${source}
}
`);
}

describe('the discriminated family (§5.2): direct members index and pin distinctly', () => {
  it('links a well-formed sealed family, indexing its members under the base (one level)', () => {
    const linked = link(`
      pet => abstract { pet_type: text =?  name: text }
      dog => pet & { pet_type?: = "dog"  breed: text }
      cat => pet & { pet_type?: = "cat"  indoor: boolean }
    `);
    const pet = linked.entries.get('pet');
    expect(pet).toBeDefined();
    expect(new Set(pet?.subtypes)).toEqual(new Set(['dog', 'cat']));
  });

  it('a grandchild sharing its parent pin is not a collision -- a family discriminates one level (§5.2)', () => {
    // `puppy` inherits `dog`'s own pin unchanged (§5.7's identity rule); it is `pet.subtypes`
    // transitively but not one of `pet`'s own direct members, and must not be compared against
    // `dog`'s pin as though it were a second, competing member.
    expect(() => {
      link(`
        pet   => abstract { pet_type: text =?  name: text }
        dog   => pet & { pet_type?: = "dog"  breed: text }
        cat   => pet & { pet_type?: = "cat"  indoor: boolean }
        puppy => dog & { weeks: int32 }
      `);
    }).not.toThrow();
  });

  it('refuses a member that leaves the discriminator unpinned', () => {
    expect(() => {
      link(`
        pet  => abstract { pet_type: text =?  name: text }
        bird => pet & { wings: int32 }
      `);
    }).toThrow(/does not pin/);
  });

  it('refuses two members pinning the discriminator to the same value', () => {
    expect(() => {
      link(`
        pet   => abstract { pet_type: text =?  name: text }
        dog   => pet & { pet_type?: = "dog"  breed: text }
        hound => pet & { pet_type?: = "dog"  scent: text }
      `);
    }).toThrow(/pairwise distinct/);
  });

  it('pins compare as values, not as tokens: `= 255` and `= 0xFF` collide (§4.3, §5.5, §5.7)', () => {
    expect(() => {
      link(`
        frame => abstract { opcode: int32 =?  payload: text }
        ping  => frame & { opcode?: = 255 }
        pong  => frame & { opcode?: = 0xFF }
      `);
    }).toThrow(/pairwise distinct/);
  });

  it('refuses a selector whose declared type is not an atom-family instance or an enum', () => {
    expect(() => {
      link(`
        holder => { x: text }
        pet    => abstract { pet_type: holder =?  name: text }
        dog    => pet & { pet_type?: holder = "x"  breed: text }
      `);
    }).toThrow(TsonSchemaValidationError);
  });

  it('admits a family whose selector type is an enum, matching members by member identity', () => {
    expect(() => {
      link(`
        pet_type => !enum [DOG CAT]
        pet      => abstract { pet_type: pet_type =?  name: text }
        dog      => pet & { pet_type?: = DOG  breed: text }
        cat      => pet & { pet_type?: = CAT  indoor: boolean }
      `);
    }).not.toThrow();
  });

  it("several discriminators are compared as a tuple, in the base's own declaration order", () => {
    // One field alone repeats across members; only the pair, taken together, is what must be
    // distinct.
    expect(() => {
      link(`
        frame => abstract { kind: text =?  version: int32 =?  payload: text }
        a     => frame & { kind?: = "x"  version?: = 1 }
        b     => frame & { kind?: = "x"  version?: = 2 }
      `);
    }).not.toThrow();

    expect(() => {
      link(`
        frame => abstract { kind: text =?  version: int32 =?  payload: text }
        a     => frame & { kind?: = "x"  version?: = 1 }
        b     => frame & { kind?: = "x"  version?: = 1 }
      `);
    }).toThrow(/pairwise distinct/);
  });

  it('a member reaching the base through an alias is still a direct member -- an alias is a reference hop, not a different type (§8.3)', () => {
    // `ba` is a plain reference alias of `b`; `m1 => ba & { ... }` composes onto `b` exactly as
    // `m1 => b & { ... }` would. `directMembers` must follow that chain, not compare the
    // `supertypes` ref's own spelling ('ba') against the base's name ('b') literally.
    expect(() => {
      link(`
        b  => abstract { k: text =?  x: text }
        ba => b
        m1 => ba & { y: text }
      `);
    }).toThrow(/does not pin/); // reached and checked -- not silently skipped

    // A schema where every member pins correctly, reached only through the alias, must link
    // clean -- `directMembers` finding `m1` (proven by the `does not pin` case above) is not
    // enough on its own if the pin-decode or distinctness pass then failed to use it.
    expect(() => {
      link(`
        b  => abstract { k: text =?  x: text }
        ba => b
        m1 => ba & { k?: = "z"  y: text }
      `);
    }).not.toThrow();
  });

  it('a member reaching the base through an alias still counts toward pin distinctness', () => {
    expect(() => {
      link(`
        b  => abstract { k: text =?  x: text }
        ba => b
        m1 => ba & { k?: = "z"  y: text }
        m2 => b  & { k?: = "z"  y2: text }
      `);
    }).toThrow(/pairwise distinct/);
  });

  it("pins compare as the field type's own decoded value, not as spelled tokens (§5.5): two distinct unquoted text pins do not collide even where a numeric-shaped token comparison would", () => {
    // `1` and `1.0` are two different `text` values -- collide only under a comparison that (like
    // the old token-level `pinTokensEqual`) treats every unquoted pair as numbers regardless of
    // the selector's own declared type.
    expect(() => {
      link(`
        frame => abstract { kind: text =?  payload: text }
        a     => frame & { kind?: = 1 }
        b     => frame & { kind?: = 1.0 }
      `);
    }).not.toThrow();
  });

  it("pins compare as the field type's own decoded value: an unquoted and a quoted spelling of the same text collide", () => {
    // A comparison keyed on token *form* (quoted vs. unquoted) rather than the decoded value
    // misses this collision entirely; decoded through `text`'s own parser both are the value
    // "dog".
    expect(() => {
      link(`
        pet => abstract { pet_type: text =?  name: text }
        dog => pet & { pet_type?: = dog }
        pup => pet & { pet_type?: = "dog" }
      `);
    }).toThrow(/pairwise distinct/);
  });
});
