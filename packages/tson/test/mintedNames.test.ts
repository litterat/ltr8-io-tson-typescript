import { describe, expect, it } from 'vitest';

import { TsonInternalError } from '../src/core/errors.js';
import { createMintedNames } from '../src/compiler/mintedNames.js';

describe('MintedNames.claim', () => {
  it('returns true the first time a name is claimed', () => {
    const minted = createMintedNames();
    expect(minted.claim('array_text_deadbeef', 'A4:arrayf12:element_typev4:text')).toBe(true);
  });

  it('returns false when the same name arrives again from the same canonical rendering', () => {
    const minted = createMintedNames();
    const canonical = 'A4:arrayf12:element_typev4:text';
    expect(minted.claim('array_text_deadbeef', canonical)).toBe(true);
    expect(minted.claim('array_text_deadbeef', canonical)).toBe(false);
    // Any number of further arrivals of the same derivation are still the ordinary case.
    expect(minted.claim('array_text_deadbeef', canonical)).toBe(false);
  });

  it('throws when the same name is claimed from a different canonical rendering', () => {
    const minted = createMintedNames();
    minted.claim('array_text_deadbeef', 'A4:arrayf12:element_typev4:text');
    expect(() => minted.claim('array_text_deadbeef', 'A3:mapf8:key_typev4:text')).toThrow(
      TsonInternalError,
    );
  });

  it('tracks independent names independently', () => {
    const minted = createMintedNames();
    expect(minted.claim('a_1', 'canonical-a')).toBe(true);
    expect(minted.claim('b_2', 'canonical-b')).toBe(true);
    expect(minted.claim('a_1', 'canonical-a')).toBe(false);
    expect(minted.claim('b_2', 'canonical-b')).toBe(false);
  });

  it('one instance is independent of another (the per-phase discipline callers rely on)', () => {
    const desugarPhase = createMintedNames();
    const materialisationPhase = createMintedNames();
    // The same name derived from two different forms in two different instances is not this
    // module's concern -- each phase's own instance sees only its own claims.
    expect(desugarPhase.claim('array_text_deadbeef', 'form-a')).toBe(true);
    expect(materialisationPhase.claim('array_text_deadbeef', 'form-b')).toBe(true);
  });
});
