/**
 * The `scoped.schemas` key type.
 */
import { describe, expect, it } from 'vitest';

import { loadError } from './schema-read-helpers.js';

describe('a `scoped.schemas` key is a schema_identity (§7.8, change log §8.2 item 9)', () => {
  it('refuses a key that carries a fragment', () => {
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "https://a.test/x.tn#f" => _ } }`),
    ).toMatch(/fragment/);
  });

  it('admits an absolute or a relative identity', () => {
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "https://a.test/x.tn" => _ } }`),
    ).toBeUndefined();
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "lib/x.tn" => _ } }`),
    ).toBeUndefined();
  });
});
