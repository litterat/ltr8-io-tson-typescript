import { describe, expect, it } from 'vitest';
import { buildAtomReader } from '../src/compiler/atomBuilder.js';
import type { Atom } from '../src/schema/meta/typedef.js';
import { runSync } from '../src/io/bytes.js';
import { bodyContextOver, collectingContextOver } from './reader-tree-helpers.js';

/**
 * `compiler/atomBuilder.ts` -- Wave 5's own bridge from a resolved `Atom` body to a compiled
 * leaf reader. Every case is exercised through a real event stream, matching this package's own
 * `reader/tree/*.test.ts` convention (`reader-tree-helpers.ts`'s own top note).
 */

describe('buildAtomReader -- integer_type (§5.6)', () => {
  it("reads and validates against a fixed-width instance, matching core.tn's own int8", () => {
    const atom: Atom = { kind: 'integer_type', size: { bits: 8n, signed: true } };
    const reader = buildAtomReader('int8', atom);
    expect(runSync(reader.read(bodyContextOver('42')))).toEqual({
      kind: 'atom',
      value: 42,
      typeRef: 'int8',
      annotations: { values: [] },
    });
  });

  it('reports ATOM_CONSTRAINT_VIOLATION for a value outside the declared width', () => {
    const atom: Atom = { kind: 'integer_type', size: { bits: 8n, signed: true } };
    const reader = buildAtomReader('int8', atom);
    const { ctx, diagnostics } = collectingContextOver('200');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- text_type / regex_type (§5.7)', () => {
  it('reads text_type as a plain string', () => {
    const reader = buildAtomReader('text', { kind: 'text_type' });
    expect(runSync(reader.read(bodyContextOver('"hello"')))).toEqual({
      kind: 'atom',
      value: 'hello',
      typeRef: 'text',
      annotations: { values: [] },
    });
  });

  it("reuses text_type's own length checks for regex_type, which composes the identical facets (§5.7)", () => {
    const atom: Atom = {
      kind: 'regex_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc9485',
      minLength: 3,
    };
    const reader = buildAtomReader('short_pattern', atom);
    const { ctx, diagnostics } = collectingContextOver('"ab"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- enum (§5.4, §9)', () => {
  it("reads an ordinary user enum as the member's own token text", () => {
    const reader = buildAtomReader('status', {
      kind: 'enum',
      members: ['PENDING', 'SHIPPED', 'DELIVERED'],
    });
    expect(runSync(reader.read(bodyContextOver('SHIPPED')))).toEqual({
      kind: 'atom',
      value: 'SHIPPED',
      typeRef: 'status',
      annotations: { values: [] },
    });
  });

  it('reports ATOM_CONSTRAINT_VIOLATION for a token that names no member', () => {
    const reader = buildAtomReader('status', { kind: 'enum', members: ['UP', 'DOWN'] });
    const { ctx, diagnostics } = collectingContextOver('SIDEWAYS');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('narrows core.tn\'s own boolean (!enum [true false]) to a real host boolean, not the strings "true"/"false"', () => {
    const reader = buildAtomReader('boolean', { kind: 'enum', members: ['true', 'false'] });
    expect(runSync(reader.read(bodyContextOver('true')))).toEqual({
      kind: 'atom',
      value: true,
      typeRef: 'boolean',
      annotations: { values: [] },
    });
    expect(runSync(reader.read(bodyContextOver('false')))).toEqual({
      kind: 'atom',
      value: false,
      typeRef: 'boolean',
      annotations: { values: [] },
    });
  });
});

describe('buildAtomReader -- unit (§4.2): value/token/void distinguished by name, not shape', () => {
  it('reads void as the absent sentinel only, rejecting a real token', () => {
    const reader = buildAtomReader('void', { kind: 'unit' });
    expect(runSync(reader.read(bodyContextOver('_')))).toEqual({
      kind: 'absent',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('reads value through base type resolution (§4), narrowing null to absent and everything else to its base value', () => {
    const reader = buildAtomReader('value', { kind: 'unit' });
    expect(runSync(reader.read(bodyContextOver('42')))).toEqual({
      kind: 'atom',
      value: 42n,
      annotations: { values: [] },
    });
    expect(runSync(reader.read(bodyContextOver('null')))).toEqual({
      kind: 'absent',
      annotations: { values: [] },
    });
    expect(runSync(reader.read(bodyContextOver('true')))).toEqual({
      kind: 'atom',
      value: true,
      annotations: { values: [] },
    });
  });

  it('reads token (and any other unnamed ~unit {} instance) as its own canonical lexeme, verbatim', () => {
    const reader = buildAtomReader('token', { kind: 'unit' });
    expect(runSync(reader.read(bodyContextOver('some_identifier')))).toEqual({
      kind: 'atom',
      value: 'some_identifier',
      typeRef: 'token',
      annotations: { values: [] },
    });
  });
});

describe('buildAtomReader -- every AtomValue member has a dispatch (structural, compile-time)', () => {
  it('complex_type builds without a constraints argument', () => {
    const reader = buildAtomReader('complex', { kind: 'complex_type', component: 'NUMBER' });
    expect(runSync(reader.read(bodyContextOver('1+2i')))).toMatchObject({ kind: 'atom' });
  });
});
