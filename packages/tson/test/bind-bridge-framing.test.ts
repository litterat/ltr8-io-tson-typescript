import { describe, expect, it } from 'vitest';
import { bridge, variant } from '../src/bind/combinators.js';
import { toDataValue } from '../src/bind/encode.js';
import type { Binding } from '../src/bind/binding.js';

/**
 * A bridge is transparent: it converts the host value and contributes no framing of its own, so
 * whatever framing its wire binding contributes is the framing of that position. Encoding a
 * bridge through the bare core-value path discards it — a bridge over a variant loses the
 * member's discriminating type-ref (§3.2), which is the only thing recording which member was
 * written.
 */
describe('bridge preserves the framing of the binding it wraps', () => {
  interface Tagged {
    readonly tag: string;
    readonly n: number;
  }
  const leaf: Binding<Tagged> = { kind: 'atom', typeRef: 'float64' } as never;

  // Discriminated by a property, which is the form variant() can resolve without a test().
  const shape = variant({ circle: leaf, square: leaf }, 'tag');

  it('keeps a variant member type-ref through a bridge', () => {
    const direct = toDataValue(shape, { tag: 'circle', n: 1.5 } as never);
    expect(direct.typeRef).toBe('circle');

    interface Host {
      readonly radius: number;
    }
    const wrapped = bridge<Host, Tagged>(
      shape,
      (host) => ({ tag: 'circle', n: host.radius }),
      (wire) => ({ radius: wire.n }),
    );

    const through = toDataValue(wrapped, { radius: 1.5 });
    // The whole point: routing through the bridge must not lose the discriminator.
    expect(through.typeRef).toBe('circle');
  });

  it('leaves an unframed wire binding unframed', () => {
    interface Host {
      readonly radius: number;
    }
    const wrapped = bridge<Host, Tagged>(
      leaf,
      (host) => ({ tag: 'circle', n: host.radius }),
      (wire) => ({ radius: wire.n }),
    );
    const encoded = toDataValue(wrapped, { radius: 2 });
    expect(encoded.typeRef).toBeUndefined();
    expect(encoded.annotations).toEqual([]);
  });
});
