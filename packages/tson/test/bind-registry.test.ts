import { describe, expect, it } from 'vitest';
import { chain, registry } from '../src/bind/registry.js';
import type { AtomBinding, Binding } from '../src/bind/binding.js';

/**
 * `bind/registry.ts` -- `registry`/`chain`, the two ways to build a {@link BindingRegistry}
 * (`bind/binding.ts`'s own doc: the port of `DataNameBinder`/`DefaultDataNameBinder`). No
 * derivation happens here -- resolution is a name-to-`Binding` table lookup, so these tests state
 * exactly that lookup contract.
 */

function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

describe('registry() -- a fixed table keyed by schema type name', () => {
  it('resolves a registered name to its binding', () => {
    const intBinding = atomBinding<number>('int32');
    const reg = registry({ int32: intBinding });
    expect(reg.get('int32')).toBe(intBinding);
  });

  it('returns undefined for an unregistered name, deferring to first read', () => {
    const reg = registry({});
    expect(reg.get('nope')).toBeUndefined();
  });

  it('carries no profile when none is supplied', () => {
    const reg = registry({});
    expect(reg.profile).toBeUndefined();
  });

  it("carries the supplied profile, purely for a caller's own bookkeeping", () => {
    const reg = registry({}, { profile: 'wire-v2' });
    expect(reg.profile).toBe('wire-v2');
  });
});

describe('chain() -- first match wins across several registries', () => {
  it('tries each registry in order, returning the first hit', () => {
    const first = registry({ a: atomBinding('text') });
    const second = registry({ a: atomBinding('int32'), b: atomBinding('int32') });
    const chained = chain(first, second);
    expect(chained.get('a')).toBe(first.get('a'));
    expect(chained.get('b')).toBe(second.get('b'));
  });

  it('returns undefined when no registry in the chain has the name', () => {
    const chained = chain(registry({}), registry({}));
    expect(chained.get('missing')).toBeUndefined();
  });

  it('an empty chain always misses', () => {
    expect(chain().get('anything')).toBeUndefined();
  });
});
