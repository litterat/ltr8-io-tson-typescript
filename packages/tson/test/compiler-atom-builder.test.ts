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
    const reader = buildAtomReader('text', { kind: 'text_type', normalization: 'NONE' });
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
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc9485',
      minLength: 3n,
    };
    const reader = buildAtomReader('short_pattern', atom);
    const { ctx, diagnostics } = collectingContextOver('"ab"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('enforces text_type.members at read: a value outside the set is ATOM_CONSTRAINT_VIOLATION (§7.4, §5.7, #22)', () => {
    const atom: Atom = { kind: 'text_type', normalization: 'NONE', members: ['SE', 'NO', 'DK'] };
    const reader = buildAtomReader('nordic', atom);
    expect(runSync(reader.read(bodyContextOver('SE')))).toEqual({
      kind: 'atom',
      value: 'SE',
      typeRef: 'nordic',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('FI');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it("counts length in Unicode code points, not UTF-16 code units, matching the kernel's own text_type doc (§5.7, §7.4)", () => {
    const atom: Atom = { kind: 'text_type', normalization: 'NONE', length: 1n, members: ['😀'] };
    const reader = buildAtomReader('emoji', atom);
    // U+1F600 is one code point and a UTF-16 surrogate pair (`.length` is 2); a reader that
    // counted UTF-16 units would refuse the type's own only declared member.
    expect(runSync(reader.read(bodyContextOver('"😀"')))).toEqual({
      kind: 'atom',
      value: '😀',
      typeRef: 'emoji',
      annotations: { values: [] },
    });
  });

  it("reuses text_type's own members enforcement for regex_type, through the same asTextConstraints composition as its length facets", () => {
    const atom: Atom = {
      kind: 'regex_type',
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc9485',
      members: ['[a-z]+', '[0-9]+'],
    };
    const reader = buildAtomReader('pattern_member', atom);
    const { ctx, diagnostics } = collectingContextOver('"[A-Z]+"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- text_type/regex_type/uri_type/email_type pattern (§7.4, §5.5)', () => {
  it('enforces text_type.pattern at read: a value the I-Regexp pattern does not match is ATOM_CONSTRAINT_VIOLATION', () => {
    const atom: Atom = { kind: 'text_type', normalization: 'NONE', pattern: '[a-z]+' };
    const reader = buildAtomReader('lower', atom);
    expect(runSync(reader.read(bodyContextOver('"abc"')))).toEqual({
      kind: 'atom',
      value: 'abc',
      typeRef: 'lower',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"ABC"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it("reuses text_type's own pattern enforcement for regex_type, through the same asTextConstraints composition as its length/members facets", () => {
    const atom: Atom = {
      kind: 'regex_type',
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc9485',
      pattern: '[0-9]+',
    };
    const reader = buildAtomReader('digits', atom);
    const { ctx, diagnostics } = collectingContextOver('"abc"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('enforces uri_type.pattern at read, on top of its own URI grammar', () => {
    const atom: Atom = {
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc3986',
      pattern: 'https://.*',
    };
    const reader = buildAtomReader('https_only', atom);
    expect(runSync(reader.read(bodyContextOver('"https://example.com/"')))).toEqual({
      kind: 'atom',
      value: 'https://example.com/',
      typeRef: 'https_only',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"http://example.com/"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('enforces email_type.pattern at read, on top of its own address grammar', () => {
    const atom: Atom = {
      kind: 'email_type',
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc5322',
      pattern: '.*@example\\.com',
    };
    const reader = buildAtomReader('example_only', atom);
    expect(runSync(reader.read(bodyContextOver('"a@example.com"')))).toEqual({
      kind: 'atom',
      value: 'a@example.com',
      typeRef: 'example_only',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"a@other.example"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- uri_type / email_type members (§7.4, §5.7, #22)', () => {
  it('enforces uri_type.members even though it has no createTextParser-backed reader of its own', () => {
    const atom: Atom = {
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc3986',
      members: ['https://a.example/', 'https://b.example/'],
    };
    const reader = buildAtomReader('allowed_uri', atom);
    expect(runSync(reader.read(bodyContextOver('"https://a.example/"')))).toEqual({
      kind: 'atom',
      value: 'https://a.example/',
      typeRef: 'allowed_uri',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"https://c.example/"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('enforces email_type.members the same way', () => {
    const atom: Atom = {
      kind: 'email_type',
      normalization: 'NONE',
      spec: 'https://www.rfc-editor.org/rfc/rfc5322',
      members: ['a@example.com'],
    };
    const reader = buildAtomReader('allowed_email', atom);
    expect(runSync(reader.read(bodyContextOver('"a@example.com"')))).toEqual({
      kind: 'atom',
      value: 'a@example.com',
      typeRef: 'allowed_email',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"b@example.com"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- enum (§5.4, §9)', () => {
  it("reads an ordinary user enum as the member's own token text", () => {
    const reader = buildAtomReader('status', {
      kind: 'enum',
      members: ['PENDING', 'SHIPPED', 'DELIVERED'],
      type: 'identifier',
    });
    expect(runSync(reader.read(bodyContextOver('SHIPPED')))).toEqual({
      kind: 'atom',
      value: 'SHIPPED',
      typeRef: 'status',
      annotations: { values: [] },
    });
  });

  it('reports ATOM_CONSTRAINT_VIOLATION for a token that names no member', () => {
    const reader = buildAtomReader('status', {
      kind: 'enum',
      members: ['UP', 'DOWN'],
      type: 'identifier',
    });
    const { ctx, diagnostics } = collectingContextOver('SIDEWAYS');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('narrows core.tn\'s own boolean (!enum [true false]) to a real host boolean, not the strings "true"/"false"', () => {
    const reader = buildAtomReader('boolean', {
      kind: 'enum',
      members: ['true', 'false'],
      type: 'identifier',
    });
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

describe('buildAtomReader -- value_type and void_type (§4.2): told apart by constructor, never by name', () => {
  it('reads a void_type instance as the void sentinel only, rejecting a real token', () => {
    const reader = buildAtomReader('void', { kind: 'void_type' });
    expect(runSync(reader.read(bodyContextOver('_')))).toEqual({
      kind: 'void',
      annotations: { values: [] },
    });
    const { ctx, diagnostics } = collectingContextOver('"nope"');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it("rejects the unquoted token 'null' at a void position -- void admits '_' and nothing else ([TSON-SCHEMA] §7.3)", () => {
    const reader = buildAtomReader('void', { kind: 'void_type' });
    const { ctx, diagnostics } = collectingContextOver('null');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it('reads value through base type resolution (§4), narrowing every token to its base value -- including the unquoted token "null", an ordinary string (§4.4)', () => {
    const reader = buildAtomReader('value', { kind: 'value_type' });
    expect(runSync(reader.read(bodyContextOver('42')))).toEqual({
      kind: 'atom',
      value: 42n,
      annotations: { values: [] },
    });
    expect(runSync(reader.read(bodyContextOver('null')))).toEqual({
      kind: 'atom',
      value: 'null',
      annotations: { values: [] },
    });
    expect(runSync(reader.read(bodyContextOver('true')))).toEqual({
      kind: 'atom',
      value: true,
      annotations: { values: [] },
    });
  });

  it('recognises both by constructor: an instance under any other name reads the same', () => {
    const nothing = buildAtomReader('nothing', { kind: 'void_type' });
    expect(runSync(nothing.read(bodyContextOver('_')))).toEqual({
      kind: 'void',
      annotations: { values: [] },
    });
    const anything = buildAtomReader('anything', { kind: 'value_type' });
    expect(runSync(anything.read(bodyContextOver('42')))).toMatchObject({
      kind: 'atom',
      value: 42n,
    });
  });

  it('a type named void or value whose body is another constructor is read by that body, not the name', () => {
    const reader = buildAtomReader('void', { kind: 'text_type', normalization: 'NONE' });
    expect(runSync(reader.read(bodyContextOver('some_text')))).toMatchObject({
      kind: 'atom',
      value: 'some_text',
    });
  });
});

describe('buildAtomReader -- identifier_type (§5.5, §7.7)', () => {
  it("reads an identifier family's token as its text, with text_type's facets", () => {
    const reader = buildAtomReader('token', {
      kind: 'identifier_type',
      spec: 'https://www.unicode.org/reports/tr31/',
      normalization: 'NFC',
      start: 'XID',
      continue: 'XID',
      continueAdd: '-',
      maxLength: 20n,
    });
    expect(runSync(reader.read(bodyContextOver('some_identifier')))).toMatchObject({
      kind: 'atom',
      value: 'some_identifier',
    });
    const { ctx, diagnostics } = collectingContextOver('a_name_far_too_long_to_fit');
    runSync(reader.read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });
});

describe('buildAtomReader -- every AtomValue member has a dispatch (structural, compile-time)', () => {
  it('complex_type builds without a constraints argument', () => {
    const reader = buildAtomReader('complex', { kind: 'complex_type', component: 'NUMBER' });
    expect(runSync(reader.read(bodyContextOver('1+2i')))).toMatchObject({ kind: 'atom' });
  });
});
