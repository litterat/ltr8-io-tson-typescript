import { describe, expect, it } from 'vitest';

import { computeSubtypes, unifySubtypes, withAddedSubtypes } from '../src/link/subtypes.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';

function def(supertypes: readonly string[], subtypes: readonly string[] = []): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes,
    subtypes,
    body: { kind: 'record', supertypes: [], fields: [], groups: [] },
    annotations: [],
  };
}

describe('computeSubtypes (§8.1: subtypes is the transitive inverse of supertypes)', () => {
  it('credits every local entry onto each of its own (already-transitive) supertypes', () => {
    // top <- product <- record <- widget (a straight chain, mirroring the meta-kernel's own shape).
    const entries = new Map<string, TypeDefinition>([
      ['top', def([])],
      ['product', def(['top'])],
      ['record', def(['product', 'top'])],
      ['widget', def(['record', 'product', 'top'])],
    ]);
    const result = computeSubtypes(entries, new Set(entries.keys()));
    expect(result.get('top')?.subtypes).toEqual(['product', 'record', 'widget']);
    expect(result.get('product')?.subtypes).toEqual(['record', 'widget']);
    expect(result.get('record')?.subtypes).toEqual(['widget']);
    expect(result.get('widget')?.subtypes).toEqual([]);
  });

  it('credits a local entry onto an imported supertype without mutating the import in place', () => {
    const importedTop = def([]);
    const entries = new Map<string, TypeDefinition>([
      ['top', importedTop],
      ['local_widget', def(['top'])],
    ]);
    const result = computeSubtypes(entries, new Set(['local_widget']));
    expect(result.get('top')?.subtypes).toEqual(['local_widget']);
    expect(importedTop.subtypes).toEqual([]); // the original object is untouched
  });

  it('returns the input map, copied but otherwise unchanged, when no local entry has a supertype', () => {
    const entries = new Map<string, TypeDefinition>([['top', def([])]]);
    const result = computeSubtypes(entries, new Set(['top']));
    expect(result.get('top')).toBe(entries.get('top')); // same reference: nothing was added
  });

  it('ignores a supertype name the merged namespace does not itself hold', () => {
    const entries = new Map<string, TypeDefinition>([['widget', def(['not_in_namespace'])]]);
    expect(() => computeSubtypes(entries, new Set(['widget']))).not.toThrow();
    expect(computeSubtypes(entries, new Set(['widget'])).size).toBe(1);
  });
});

describe('withAddedSubtypes', () => {
  it('unions with the existing list, preserving order, and keeps the same reference when nothing is new', () => {
    const original = def([], ['a', 'b']);
    expect(withAddedSubtypes(original, ['b'])).toBe(original);
    const grown = withAddedSubtypes(original, ['c', 'a']);
    expect(grown).not.toBe(original);
    expect(grown.subtypes).toEqual(['a', 'b', 'c']);
    expect(original.subtypes).toEqual(['a', 'b']); // untouched
  });
});

describe('unifySubtypes (the diamond case, §2.2.3)', () => {
  it('unions two routes to the same entry, keeping the incumbent reference when arriving adds nothing new', () => {
    const incumbent = def([], ['a', 'b']);
    const arriving = def([], ['a']);
    expect(unifySubtypes(incumbent, arriving)).toBe(incumbent);
  });

  it('unions in whatever the arriving route saw that the incumbent route could not', () => {
    const incumbent = def([], ['a']);
    const arriving = def([], ['a', 'b']);
    const unified = unifySubtypes(incumbent, arriving);
    expect(unified.subtypes).toEqual(['a', 'b']);
  });
});
