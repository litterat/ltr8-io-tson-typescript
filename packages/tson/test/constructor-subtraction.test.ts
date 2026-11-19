/**
 * [TSON-SCHEMA] §5.9 rule 8: subtraction breaks IS-A, and a subtracted record keeps no lineage --
 * so a subtracted construction headed by a constructor is no constructor: applying it builds a
 * value of the record it is, never a type.
 */
import { describe, expect, it } from 'vitest';

import { standardLibrary } from '../src/stdlib/index.js';
import { supertypesIn } from './model-fixtures.js';

const META = 'https://tson.io/2026/39/m/meta.tn';
const LAYER = 'https://example.test/subtracting-layer.tn';

describe('a subtracted constructor is not a constructor (§5.9 rule 8)', () => {
  const tson = standardLibrary();
  const layer = tson.resolveSchema(
    `!!id:"${LAYER}"\n!!import:"${META}"\n!schema {\n  plain => unicode.text_type - { normalization }\n}\n`,
  );

  it('its chain is empty, so it IS-A nothing, `top` included', () => {
    expect(supertypesIn(layer.entries.get('plain'))).toEqual([]);
  });

  it('applying it builds no type: it is an ordinary record, so `!plain {}` is a value of it, an entry that is no type (§4.1, §5.9 rule 8)', () => {
    const user = tson.resolveSchema(
      `!!id:"https://example.test/user.tn"\n!!import:"${LAYER}"\n!schema {\n  x => !plain {}\n}\n`,
    );
    const entry = user.entries.get('x');
    expect(entry !== undefined && 'kind' in entry && entry.kind === 'value_entry').toBe(true);
  });
});
