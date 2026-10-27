/**
 * [TSON-SCHEMA] §5.9 rule 8: subtraction breaks IS-A, and a subtracted record keeps no lineage --
 * so a subtracted construction headed by a constructor is no constructor, and applying it is
 * refused as not applicable.
 */
import { describe, expect, it } from 'vitest';

import { standardLibrary } from '../src/stdlib/index.js';
import { supertypesIn } from './model-fixtures.js';

const KERNEL = 'https://tson.io/2026/38/m/meta-kernel.tn';
const META = 'https://tson.io/2026/38/m/meta.tn';
const LAYER = 'https://example.test/subtracting-layer.tn';

describe('a subtracted constructor is not a constructor (§5.9 rule 8)', () => {
  const tson = standardLibrary();
  const layer = tson.resolveSchema(
    `!!id:"${LAYER}"\n!!meta:"${KERNEL}"\n!!import:"${META}"\n{\n  plain => text_type - { normalization }\n}\n`,
  );

  it('its chain is empty, so it IS-A nothing, `top` included', () => {
    expect(supertypesIn(layer.entries.get('plain'))).toEqual([]);
  });

  it('applying it is refused as naming no constructor', () => {
    expect(() =>
      tson.resolveSchema(
        `!!id:"https://example.test/user.tn"\n!!meta:"${LAYER}"\n{\n  x => !plain {}\n}\n`,
      ),
    ).toThrow(/does not resolve to a constructor/);
  });
});
