/**
 * Declaration messages for field groups and fixed facets.
 */
import { describe, expect, it } from 'vitest';

import { loadError } from './schema-read-helpers.js';

describe('declaration messages', () => {
  it('a group is described with its + and ?', () => {
    expect(
      loadError(`b => { ( a: text | c: text )+ }\nd => b & { ( a: text | c: text ) }`),
    ).toMatch(/\(a \| c\)\+/);
  });

  it('a default on a restated group member reports the default rule', () => {
    const message = loadError(`b => { ( a: text | c: text ) }\nd => b & { a?: text ~ x }`);
    expect(message).toMatch(/takes a default/);
    expect(message).not.toMatch(/loosens/);
  });

  it('a moved fixed facet says it is fixed at construction, and reads grammatically', () => {
    const message = loadError(
      `k => !identifier_type { exclude: "x" }\nk2 => !k ^ { exclude: "y" }`,
    );
    expect(message).toMatch(/fixed at construction/);
    expect(message).not.toMatch(/\ba exclude\b/);
  });
});
