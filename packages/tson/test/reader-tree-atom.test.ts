import { describe, expect, it } from 'vitest';
import { atomTreeReader, atomTypeReader } from '../src/reader/tree/atom.js';
import { absentTreeReader } from '../src/reader/tree/absent.js';
import {
  bodyContextOver,
  collectingContextOver,
  stubIntType,
  stubTextType,
} from './reader-tree-helpers.js';
import { runSync } from '../src/io/bytes.js';

/**
 * `reader/tree/atom.ts`/`absent.ts` -- ported from `AtomTypeReader`/`AtomTreeReader`/`AbsentTreeReader`.
 */

describe('atomTypeReader -- the AtomType bridge (§5)', () => {
  it('reads a token through the atom, returning the host value', () => {
    const value = runSync(atomTypeReader(stubIntType(), 'int32').read(bodyContextOver('42')));
    expect(value).toBe(42);
  });

  it('reports TYPE_MISMATCH and returns undefined for a non-scalar core-value', () => {
    const { ctx, diagnostics } = collectingContextOver('[1]');
    const value = runSync(atomTypeReader(stubIntType(), 'int32').read(ctx));
    expect(value).toBeUndefined();
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('reports ATOM_CONSTRAINT_VIOLATION and returns undefined when the atom rejects the token (parse failure)', () => {
    const { ctx, diagnostics } = collectingContextOver('"not-a-number"');
    const value = runSync(atomTypeReader(stubIntType(), 'int32').read(ctx));
    expect(value).toBeUndefined();
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('reports ATOM_CONSTRAINT_VIOLATION and returns undefined when the atom rejects the value (validation failure)', () => {
    const { ctx, diagnostics } = collectingContextOver('99999');
    const value = runSync(atomTypeReader(stubIntType(10), 'int32').read(ctx));
    expect(value).toBeUndefined();
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('atomTreeReader -- wraps a delegate into a Value (§5)', () => {
  const intTreeReader = atomTreeReader(atomTypeReader(stubIntType(), 'int32'), 'int32');

  it('wraps a successful read into an AtomNode carrying the declared type-ref', () => {
    const value = runSync(intTreeReader.read(bodyContextOver('7')));
    expect(value).toEqual({
      kind: 'atom',
      value: 7,
      typeRef: 'int32',
      annotations: { values: [] },
    });
  });

  it('captures leading annotations onto the node', () => {
    const value = runSync(intTreeReader.read(bodyContextOver('@doc:"n" 7')));
    if (value.kind !== 'atom') throw new Error('unreachable');
    expect(value.annotations.values).toHaveLength(1);
    expect(value.annotations.values[0]?.name).toBe('doc');
  });

  it('a soft-failed delegate read yields AbsentNode -- the diagnostic carries the story, not the node', () => {
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    const value = runSync(intTreeReader.read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('absentTreeReader -- the void reader (§7.3)', () => {
  it('reads `_` into an AbsentNode', () => {
    const value = runSync(absentTreeReader('void').read(bodyContextOver('_')));
    expect(value).toEqual({ kind: 'absent', annotations: { values: [] } });
  });

  it('reports TYPE_MISMATCH for anything else, still yielding AbsentNode', () => {
    const { ctx, diagnostics } = collectingContextOver('42');
    const value = runSync(absentTreeReader('void').read(ctx));
    expect(value.kind).toBe('absent');
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('fully discards a mismatched container so the stream stays positioned', () => {
    const { ctx, diagnostics } = collectingContextOver('[1 2 3]');
    runSync(absentTreeReader('void').read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    // Nothing left to pull but document-end -- proves the whole array was skipped, not just its `[`.
    const trailing = runSync(ctx.next());
    expect(trailing.kind).toBe('document-end');
  });
});

describe('stubTextType (test fixture sanity)', () => {
  it('accepts any token verbatim', () => {
    const value = runSync(atomTypeReader(stubTextType(), 'text').read(bodyContextOver('"hi"')));
    expect(value).toBe('hi');
  });
});
