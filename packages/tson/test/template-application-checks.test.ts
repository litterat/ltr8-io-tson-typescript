/**
 * Template applications checked at the call site.
 */
import { describe, expect, it } from 'vitest';

import { loadError } from './schema-read-helpers.js';

describe('a template application is checked at the call site (§5.10)', () => {
  const v = `v => <N> !array { element_type: text  min_items: N }`;

  it('a declaration naming a constructor-template application is checked before materialising', () => {
    expect(loadError(`${v}\nx => v<"two">`)).toMatch(/binds 'N' to 'two'/);
    expect(loadError(`${v}\nx => { f: v<"two"> }`)).toMatch(/binds 'N' to 'two'/);
    expect(loadError(`${v}\nx => v<2>`)).toBeUndefined();
  });

  it('a literal type argument is refused at the writing declaration, not at a minted name', () => {
    const message = loadError(`boxed => <T> { a: T }\nx => boxed<3>`);
    expect(message).toMatch(/binds 'T' to the literal '3'/);
    expect(message).not.toMatch(/boxed_3/);
    expect(loadError(`boxed => <T> { a: T }\nx => { f: boxed<3> }`)).toMatch(/literal '3'/);
  });

  it('a parameter’s type names an earlier parameter only', () => {
    expect(loadError(`p => <T, V: T> { a: T  b?: T ~ V }`)).toBeUndefined();
    expect(loadError(`p => <V: T, T> { a: T  b?: T ~ V }`)).toMatch(/earlier parameter only/);
  });
});
