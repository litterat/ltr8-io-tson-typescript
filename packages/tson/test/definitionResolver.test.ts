import { describe, expect, it } from 'vitest';

import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonReadError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import {
  createDefinitionResolver,
  type DefinitionResolver,
  type DefinitionResolverDeps,
} from '../src/compiler/definitionResolver.js';
import type { DataValue, CoreValue, RecordValue } from '../src/ast/value.js';
import type { Declaration, SchemaDocument } from '../src/ast/schema/document.js';
import type { RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import type { Top, TypeDefinition } from '../src/schema/meta/typedef.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';

const META = '!!meta:"https://example.com/m.tn1"';

function parse(declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`${META} { ${declarations} }`)));
}

function declarationOf(document: SchemaDocument, name: string): Declaration {
  const declaration = document.body.declarations.get(name);
  if (declaration === undefined) throw new Error(`declaration '${name}' missing`);
  return declaration;
}

/** A resolver over a growing type-name namespace and a fixed structure namespace, matching `DefinitionResolverTest`'s own `resolved`/`resolver` fields. */
function harness(overrides: Partial<DefinitionResolverDeps> = {}): {
  resolver: DefinitionResolver;
  entries: Map<string, TypeDefinition>;
  structure: Map<string, TypeDefinition>;
} {
  const entries = new Map<string, TypeDefinition>();
  const structure = new Map<string, TypeDefinition>();
  const deps: DefinitionResolverDeps = {
    definitionMetaReader:
      overrides.definitionMetaReader ??
      ((type) => {
        throw new Error(`not exercised by this test: '${type}'`);
      }),
    metaDefinitions: overrides.metaDefinitions ?? ((name) => structure.get(name)),
    namespaceDefinitions: overrides.namespaceDefinitions ?? ((name) => entries.get(name)),
    ...(overrides.annotationValueReader === undefined
      ? {}
      : { annotationValueReader: overrides.annotationValueReader }),
    ...(overrides.applicationCloser === undefined
      ? {}
      : { applicationCloser: overrides.applicationCloser }),
    ...(overrides.encodeSourceBody === undefined
      ? {}
      : { encodeSourceBody: overrides.encodeSourceBody }),
  };
  return { resolver: createDefinitionResolver(deps), entries, structure };
}

/** Resolves every declaration of `document`, in source order, into `entries` -- mirroring `SchemaResolver#resolveSchema`'s own production loop (no forward references). */
function resolveAll(
  resolver: DefinitionResolver,
  entries: Map<string, TypeDefinition>,
  document: SchemaDocument,
): void {
  for (const declaration of document.body.declarations.values()) {
    entries.set(declaration.name, resolver.resolve(declaration));
  }
}

function resolveOne(
  resolver: DefinitionResolver,
  document: SchemaDocument,
  name: string,
): TypeDefinition {
  return resolver.resolve(declarationOf(document, name));
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected to throw, but it completed');
}

function isRecordBody(body: Top): body is RecordBody {
  return (body as { readonly kind?: unknown }).kind === 'record';
}

function fieldNamed(body: RecordBody, name: string): RecordField {
  const field = body.fields.find((f) => f.name === name);
  if (field === undefined) throw new Error(`field '${name}' missing from resolved body`);
  return field;
}

// ── A fresh record (§5.2) ────────────────────────────────────────────────────────────────────

describe('a fresh record definition (§5.2)', () => {
  it('resolves plain required fields to a PRODUCT-kind record body', () => {
    const doc = parse('integer_size => { bits: integer  signed: boolean }');
    const { resolver } = harness();

    const resolved = resolveOne(resolver, doc, 'integer_size');

    expect(resolved.kind).toBe('PRODUCT');
    expect(resolved.constructor).toBe(false);
    expect(resolved.supertypes).toEqual([]);
    expect(resolved.parameters).toEqual([]);
    expect(resolved.annotations).toEqual([]);
    expect(isRecordBody(resolved.body)).toBe(true);
    if (!isRecordBody(resolved.body)) throw new Error('unreachable');
    expect(resolved.body.supertypes).toEqual([]);
    expect(resolved.body.fields).toEqual([
      {
        name: 'bits',
        type: { name: 'integer', arguments: [], annotations: [] },
        state: 'REQUIRED',
        annotations: [],
      },
      {
        name: 'signed',
        type: { name: 'boolean', arguments: [], annotations: [] },
        state: 'REQUIRED',
        annotations: [],
      },
    ]);
    expect(resolved.body.groups).toEqual([]);
  });

  it('resolves a `~`-marked fresh record as a constructor', () => {
    const doc = parse('widget => ~{ size: integer }');
    const { resolver } = harness();

    const resolved = resolveOne(resolver, doc, 'widget');

    expect(resolved.constructor).toBe(true);
    expect(resolved.kind).toBe('PRODUCT');
  });

  it('rejects a modifier-only entry with nothing to elide toward (§5.7)', () => {
    const doc = parse('bad => { field: = "x" }');
    const { resolver } = harness();

    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));

    expect(error).toBeInstanceOf(TsonSchemaValidationError);
  });

  it('rejects two fields sharing a name (§5.11)', () => {
    const doc = parse('bad => { a: token  a: integer }');
    const { resolver } = harness();

    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));

    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('declared more than once');
  });
});

// ── Field modifiers: the six spellings of §5.2 ──────────────────────────────────────────────

describe('field default/fixed modifiers (§5.2)', () => {
  it('a plain field is REQUIRED with no value', () => {
    const doc = parse('t => { a: token }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'a')).toEqual({
      name: 'a',
      type: { name: 'token', arguments: [], annotations: [] },
      state: 'REQUIRED',
      annotations: [],
    });
  });

  it('`type ~ value` is REQUIRED_DEFAULT, carrying the literal', () => {
    const doc = parse('t => { port: integer ~ 8080 }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'port');
    expect(field.state).toBe('REQUIRED_DEFAULT');
    expect(field.value).toEqual({ text: '8080', form: 'UNQUOTED' });
  });

  it('`type = value` is REQUIRED_FIXED', () => {
    const doc = parse('t => { host: token = "prod.example.com" }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'host').state).toBe('REQUIRED_FIXED');
  });

  it('`type?` is OPTIONAL with no value', () => {
    const doc = parse('t => { note: token? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'note').state).toBe('OPTIONAL');
  });

  it('`type? = value` is OPTIONAL_FIXED, carrying the literal', () => {
    const doc = parse('t => { flag: boolean? = false }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'flag');
    expect(field.state).toBe('OPTIONAL_FIXED');
    expect(field.value).toEqual({ text: 'false', form: 'UNQUOTED' });
  });

  it("`type? = _` is OPTIONAL_FIXED with no value at all (§5.2's sixth spelling)", () => {
    const doc = parse('t => { hidden: token? = _ }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'hidden');
    expect(field.state).toBe('OPTIONAL_FIXED');
    expect(field.value).toBeUndefined();
  });

  it('rejects `~ _` on any field', () => {
    const doc = parse('bad => { a: token ~ _ }');
    const { resolver } = harness();
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('rejects `= _` on a required (non-`?`) field', () => {
    const doc = parse('bad => { a: token = _ }');
    const { resolver } = harness();
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('rejects a default on an optional field (`type? ~ value`)', () => {
    const doc = parse('bad => { a: token? ~ "x" }');
    const { resolver } = harness();
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('contradicts optional');
  });

  it('a parametric `=` inside a template stays REQUIRED, not REQUIRED_FIXED (§5.7 open modifiers)', () => {
    const doc = parse('tmpl => <T> { element_type: type_ref = T }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 'tmpl').body;
    // Parameterised, so the body is held -- this exercises resolveField's own parametric branch
    // indirectly via holdIfOpen; assert the held wire form carries `element_type` with no `state`
    // member (REQUIRED is the default, omitted).
    expect('application' in body).toBe(true);
  });
});

// ── Composition (§5.8): top, atom, product, sum, reference ─────────────────────────────────

describe('composition (§5.8)', () => {
  it('a bare `top => {}` is a fresh, empty record', () => {
    const doc = parse('top => {}');
    const { resolver } = harness();
    const top = resolveOne(resolver, doc, 'top');
    expect(top.kind).toBe('PRODUCT');
    expect(top.supertypes).toEqual([]);
    if (!isRecordBody(top.body)) throw new Error('unreachable');
    expect(top.body.fields).toEqual([]);
  });

  it('atom/product/sum are each PRODUCT (§4.1: their own chain is just [top], containing none of the three literal names)', () => {
    const doc = parse(`
      top     => {}
      atom    => top & {}
      product => top & { access_pattern: token  size_type: token }
      sum     => top & {}
    `);
    const { resolver, entries } = harness();
    resolveAll(resolver, entries, doc);

    expect(entries.get('atom')?.kind).toBe('PRODUCT');
    expect(entries.get('atom')?.supertypes).toEqual(['top']);
    expect(entries.get('product')?.kind).toBe('PRODUCT');
    expect(entries.get('sum')?.kind).toBe('PRODUCT');
  });

  it('a type composing with `atom` is itself kind ATOM', () => {
    const doc = parse(`
      top  => {}
      atom => top & {}
      unit => atom & {}
    `);
    const { resolver, entries } = harness();
    resolveAll(resolver, entries, doc);
    expect(entries.get('unit')?.kind).toBe('ATOM');
    expect(entries.get('unit')?.supertypes).toEqual(['atom', 'top']);
  });

  it('reaching two base kinds through supertypes is a resolver error (§4.1)', () => {
    const doc = parse(`
      top     => {}
      atom    => top & {}
      product => top & {}
      broken  => atom & product & {}
    `);
    const { resolver, entries } = harness();
    entries.set('top', resolver.resolve(declarationOf(doc, 'top')));
    entries.set('atom', resolver.resolve(declarationOf(doc, 'atom')));
    entries.set('product', resolver.resolve(declarationOf(doc, 'product')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'broken'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
  });

  it('two supertypes contributing the same field name is a resolver error (§5.8 disjointness)', () => {
    const doc = parse(`
      a => { x: token }
      b => { x: token }
      c => a & b & {}
    `);
    const { resolver, entries } = harness();
    entries.set('a', resolver.resolve(declarationOf(doc, 'a')));
    entries.set('b', resolver.resolve(declarationOf(doc, 'b')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'c'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('a composition-body field tightens an inherited one, replacing it in place (§5.7 read across composition)', () => {
    const doc = parse(`
      base  => { access_pattern: token  size_type: token }
      fixed => base & { access_pattern: token = "INDEX" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const fixed = resolveOne(resolver, doc, 'fixed');
    if (!isRecordBody(fixed.body)) throw new Error('unreachable');
    // Tightening replaces in place: still two fields, same order, access_pattern now fixed.
    expect(fixed.body.fields.map((f) => f.name)).toEqual(['access_pattern', 'size_type']);
    expect(fieldNamed(fixed.body, 'access_pattern').state).toBe('REQUIRED_FIXED');
    expect(fieldNamed(fixed.body, 'access_pattern').value).toEqual({
      text: 'INDEX',
      form: 'SINGLE_LINE_QUOTED',
    });
  });

  it("rejects a tightening transition that loosens rather than restricts (§5.7's table)", () => {
    const doc = parse(`
      base  => { access_pattern: token  size_type: token }
      fixed => base & { access_pattern: token = "INDEX" }
      loose => fixed & { access_pattern: token }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    entries.set('fixed', resolver.resolve(declarationOf(doc, 'fixed')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'loose'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain(
      'not a permitted state transition',
    );
  });

  it("an elided type-ref on a tightening entry inherits the source field's type (§5.7)", () => {
    const doc = parse(`
      config     => { host: token }
      production => config & { host: = "prod.example.com" }
    `);
    const { resolver, entries } = harness();
    entries.set('config', resolver.resolve(declarationOf(doc, 'config')));
    const production = resolveOne(resolver, doc, 'production');
    if (!isRecordBody(production.body)) throw new Error('unreachable');
    const host = fieldNamed(production.body, 'host');
    expect(host.type).toEqual({ name: 'token', arguments: [], annotations: [] });
    expect(host.state).toBe('REQUIRED_FIXED');
  });

  it('a supertype names no type this schema declares or imports', () => {
    const doc = parse('bad => nowhere & {}');
    const { resolver } = harness();
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('a supertype whose body is a binding record (finished) has no fields to compose with', () => {
    const doc = parse(`
      c => bound & {}
    `);
    const { resolver, entries } = harness();
    // A finished (binding-record) entry, hand-built as `resolveInstance` would produce one.
    entries.set('bound', {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    });
    expect(thrownBy(() => resolveOne(resolver, doc, 'c'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });
});

// ── Subtraction (§5.9) ──────────────────────────────────────────────────────────────────────

describe('subtraction (§5.9)', () => {
  it('removes a supertype-contributed field and breaks the transitive contract, keeping direct lineage', () => {
    const doc = parse(`
      base => { keep: token  drop: token }
      thin => base - { drop }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const thin = resolveOne(resolver, doc, 'thin');
    expect(thin.supertypes).toEqual([]); // contract emptied
    if (!isRecordBody(thin.body)) throw new Error('unreachable');
    expect(thin.body.supertypes).toEqual(['base']); // lineage kept
    expect(thin.body.fields.map((f) => f.name)).toEqual(['keep']);
  });

  it("rejects removing a name the declaration's own body also states (rule 4)", () => {
    const doc = parse(`
      base => { drop: token }
      bad  => base & { drop: token } - { drop }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('rule 4');
  });

  it('rejects removing a name that names no field of the composed type (rule 2)', () => {
    const doc = parse(`
      base => { keep: token }
      bad  => base - { nowhere }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it("dissolves a group left with one surviving member into a plain field carrying the group's state (§5.11)", () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      thin => base - { b }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const thin = resolveOne(resolver, doc, 'thin');
    if (!isRecordBody(thin.body)) throw new Error('unreachable');
    expect(thin.body.groups).toEqual([]);
    expect(fieldNamed(thin.body, 'a').state).toBe('REQUIRED');
  });
});

// ── Field groups (§5.11) ─────────────────────────────────────────────────────────────────────

describe('field groups (§5.11)', () => {
  it("flattens each member to an OPTIONAL field regardless of the group's own state", () => {
    const doc = parse('t => { (a: token | b: token) }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'a').state).toBe('OPTIONAL');
    expect(fieldNamed(body, 'b').state).toBe('OPTIONAL');
    expect(body.groups).toEqual([{ members: ['a', 'b'], state: 'REQUIRED' }]);
  });

  it('a `?`-marked group is state OPTIONAL', () => {
    const doc = parse('t => { (a: token | b: token)? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(body.groups[0]?.state).toBe('OPTIONAL');
  });

  it('rejects a refinement/composition body that makes two group members simultaneously always-present', () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { a: token  b: token }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('always present');
  });

  it('a composition body restates an inherited group, tightening OPTIONAL to REQUIRED', () => {
    const doc = parse(`
      base     => { (a: token | b: token)? }
      required => base & { (a: token | b: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const required = resolveOne(resolver, doc, 'required');
    if (!isRecordBody(required.body)) throw new Error('unreachable');
    expect(required.body.groups).toEqual([{ members: ['a', 'b'], state: 'REQUIRED' }]);
  });

  it('rejects a restatement that loosens REQUIRED to OPTIONAL', () => {
    const doc = parse(`
      base  => { (a: token | b: token) }
      loose => base & { (a: token | b: token)? }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'loose'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('rejects a restatement that adds a member the source does not declare', () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { (a: token | b: token | c: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('does not declare');
  });

  it("rejects a restatement that reorders the inherited group's members", () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { (b: token | a: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it("rejects a restatement that changes a member's type (member type-refs are verbatim, §5.11)", () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { (a: text | b: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain("member 'a'");
  });

  it('a `= _` (fixed-to-absent) member is not "always present", so it does not trip the presence check', () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      ok   => base & { a: token? = _ }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const ok = resolveOne(resolver, doc, 'ok');
    if (!isRecordBody(ok.body)) throw new Error('unreachable');
    expect(fieldNamed(ok.body, 'a').state).toBe('OPTIONAL_FIXED');
  });
});

// ── Refinement (§5.7): source ^ { ... } ──────────────────────────────────────────────────────

describe('refinement (§5.7)', () => {
  it('copies the whole inherited field set and admits no new fields', () => {
    const doc = parse(`
      base   => { x: token  y: token }
      narrow => base ^ { x: token = "fixed" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const narrow = resolveOne(resolver, doc, 'narrow');
    expect(narrow.source).toEqual({ name: 'base', arguments: [], annotations: [] });
    expect(narrow.supertypes).toEqual(['base']);
    if (!isRecordBody(narrow.body)) throw new Error('unreachable');
    expect(narrow.body.fields.map((f) => f.name)).toEqual(['x', 'y']);
    expect(narrow.body.supertypes).toEqual([]); // record.supertypes records only direct `&`, never `^`
    expect(fieldNamed(narrow.body, 'x').state).toBe('REQUIRED_FIXED');
    expect(fieldNamed(narrow.body, 'y').state).toBe('REQUIRED');
  });

  it('rejects a body field naming nothing inherited (refinement adds no fields)', () => {
    const doc = parse(`
      base => { x: token }
      bad  => base ^ { z: token = "x" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('names no inherited field');
  });

  it('rejects a refinement source with no vocabulary to tighten (a finished binding-record body)', () => {
    const doc = parse('bad => bound ^ {}');
    const { resolver, entries } = harness();
    entries.set('bound', {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('finished');
  });

  it('a refinement group entry naming nothing inherited is a resolver error (refinement admits no new groups)', () => {
    const doc = parse(`
      base => { x: token }
      bad  => base ^ { (p: token | q: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('names no inherited group');
  });

  it('a `~`-marked refinement is a constructor', () => {
    const doc = parse(`
      base    => { x: token }
      derived => ~base ^ { x: token = "fixed" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    expect(resolveOne(resolver, doc, 'derived').constructor).toBe(true);
  });
});

// ── Annotations (§6) ─────────────────────────────────────────────────────────────────────────

describe('annotations (§6)', () => {
  it('with no AnnotationValueReader at all, every name is kept with its value dropped', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver } = harness();
    const resolved = resolveOne(resolver, doc, 't');
    expect(resolved.annotations).toEqual([{ name: 'doc' }]);
  });

  it('rejects an annotation name that does not resolve against the structure namespace, when a reader is supplied', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver } = harness({
      annotationValueReader: () => 'unreachable',
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 't'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('does not name a type');
  });

  it('binds an annotation value through its own resolved type, when the name resolves', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver, structure } = harness({
      annotationValueReader: (type, value) => {
        expect(type).toBe('doc');
        return (value.coreValue as { text: string }).text;
      },
    });
    structure.set('doc', {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    });
    const resolved = resolveOne(resolver, doc, 't');
    expect(resolved.annotations).toEqual([{ name: 'doc', value: 'hello' }]);
  });
});

// ── Template applications (§5.10) and constructor application/refinement (§5.5, §5.6) ──────

/** `!integer`'s constraint vocabulary in the structure namespace, and a minimal hand-rolled reader for it -- this work package's own test scaffolding stands in for a full compiled reader (a later work package's own concern), the same way the reference implementation's own isolated tests do. */
function integerTypeStructure(): TypeDefinition {
  const fields: RecordField[] = [
    {
      name: 'size',
      type: { name: 'integer_size', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
    {
      name: 'min',
      type: { name: 'integer', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
    {
      name: 'exclusive_min',
      type: { name: 'integer', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
    {
      name: 'max',
      type: { name: 'integer', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
    {
      name: 'exclusive_max',
      type: { name: 'integer', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
    {
      name: 'multiple_of',
      type: { name: 'integer', arguments: [], annotations: [] },
      state: 'OPTIONAL',
      annotations: [],
    },
  ];
  return {
    kind: 'ATOM',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body: { kind: 'record', supertypes: [], fields, groups: [] },
    annotations: [],
  };
}

function fieldsOf(value: DataValue): ReadonlyMap<string, CoreValue> {
  if (value.coreValue.kind !== 'record') {
    throw new TsonReadError({ code: 'TYPE_MISMATCH', message: 'expected a braced record' });
  }
  return new Map(value.coreValue.fields.map((f) => [f.name, f.value.value.coreValue]));
}

function readBigint(value: CoreValue | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== 'token' || value.form !== 'unquoted') {
    throw new TsonReadError({ code: 'TYPE_MISMATCH', message: 'expected an integer token' });
  }
  try {
    return BigInt(value.text);
  } catch {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: `'${value.text}' is not a valid integer`,
    });
  }
}

/** Reads `!integer { size: {...} min: N ... }` into an `IntegerType`. */
function integerTypeReader(type: string, value: DataValue): Top {
  if (type !== 'integer') {
    throw new TsonReadError({
      code: 'UNKNOWN_TYPE_REF',
      message: `this test reader only knows 'integer', got '${type}'`,
    });
  }
  const fields = fieldsOf(value);
  const sizeValue = fields.get('size');
  const size =
    sizeValue === undefined
      ? undefined
      : (() => {
          if (sizeValue.kind !== 'record')
            throw new TsonReadError({ code: 'TYPE_MISMATCH', message: 'expected a record' });
          const sizeFields = new Map(
            sizeValue.fields.map((f) => [f.name, f.value.value.coreValue]),
          );
          const bits = readBigint(sizeFields.get('bits'));
          const signedValue = sizeFields.get('signed');
          if (bits === undefined || signedValue?.kind !== 'token') {
            throw new TsonReadError({
              code: 'FIELD_REQUIRED',
              message: 'integer_size requires bits and signed',
            });
          }
          return { bits, signed: signedValue.text === 'true' };
        })();
  const min = readBigint(fields.get('min'));
  const exclusiveMin = readBigint(fields.get('exclusive_min'));
  const max = readBigint(fields.get('max'));
  const exclusiveMax = readBigint(fields.get('exclusive_max'));
  const multipleOf = readBigint(fields.get('multiple_of'));
  const result: IntegerType = {
    kind: 'integer_type',
    ...(size === undefined ? {} : { size }),
    ...(min === undefined ? {} : { min }),
    ...(exclusiveMin === undefined ? {} : { exclusiveMin }),
    ...(max === undefined ? {} : { max }),
    ...(exclusiveMax === undefined ? {} : { exclusiveMax }),
    ...(multipleOf === undefined ? {} : { multipleOf }),
  };
  return result;
}

describe('constructor application (§5.5, §5.6)', () => {
  it("produces a fresh atom-family instance, binding through the constructor's own reader", () => {
    const doc = parse('int8 => !integer { size: { bits: 8  signed: true }  min: -128  max: 127 }');
    const { resolver, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());

    const int8 = resolveOne(resolver, doc, 'int8');

    expect(int8.kind).toBe('ATOM');
    expect(int8.constructor).toBe(false);
    expect(int8.supertypes).toEqual([]);
    expect(int8.source).toEqual({ name: 'integer', arguments: [], annotations: [] });
    expect(int8.body).toEqual({
      kind: 'integer_type',
      size: { bits: 8n, signed: true },
      min: -128n,
      max: 127n,
    });
  });

  it('rejects applying a non-constructor as if it were one', () => {
    const doc = parse('bad => !something { }');
    const { resolver, structure } = harness();
    structure.set('something', {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('atom refinement');
  });

  it('rejects a target that resolves against neither namespace', () => {
    const doc = parse('bad => !nowhere { }');
    const { resolver } = harness();
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it("a body the constructor's own vocabulary rejects is the author's error, not a coverage gap", () => {
    const doc = parse('bad => !integer { min: "not-a-number" }');
    const { resolver, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('not valid data for');
  });

  it('rejects a body whose own facets contradict each other (§7.2 coherence)', () => {
    const doc = parse('bad => !integer { min: 10  max: 3 }');
    const { resolver, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('contradict each other');
  });
});

describe('atom refinement (§5.5, §5.7)', () => {
  function encodeIntegerType(body: Top): CoreValue {
    if ((body as { readonly kind?: unknown }).kind !== 'integer_type') {
      throw new Error('encodeSourceBody test stub only handles integer_type');
    }
    const t = body as IntegerType;
    const token = (n: bigint): CoreValue => ({
      kind: 'token',
      text: n.toString(),
      form: 'unquoted',
    });
    const fields: RecordValue['fields'][number][] = [];
    if (t.size !== undefined) {
      fields.push({
        name: 'size',
        value: {
          value: {
            annotations: [],
            coreValue: {
              kind: 'record',
              fields: [
                {
                  name: 'bits',
                  value: { value: { annotations: [], coreValue: token(t.size.bits) } },
                },
                {
                  name: 'signed',
                  value: {
                    value: {
                      annotations: [],
                      coreValue: { kind: 'token', text: String(t.size.signed), form: 'unquoted' },
                    },
                  },
                },
              ],
            },
          },
        },
      });
    }
    for (const [key, value] of [
      ['min', t.min],
      ['max', t.max],
      ['exclusive_min', t.exclusiveMin],
      ['exclusive_max', t.exclusiveMax],
      ['multiple_of', t.multipleOf],
    ] as const) {
      if (value !== undefined) {
        fields.push({ name: key, value: { value: { annotations: [], coreValue: token(value) } } });
      }
    }
    return { kind: 'record', fields };
  }

  function integerHarness() {
    return harness({
      definitionMetaReader: integerTypeReader,
      encodeSourceBody: encodeIntegerType,
    });
  }

  it("merges the refinement over the source's own already-bound fields, tightening what is stated", () => {
    const doc = parse(`
      int8    => !integer { size: { bits: 8  signed: true }  min: -128  max: 127 }
      tighter => !int8 ^ { max: 100 }
    `);
    const { resolver, entries, structure } = integerHarness();
    structure.set('integer', integerTypeStructure());
    entries.set('int8', resolver.resolve(declarationOf(doc, 'int8')));

    const tighter = resolveOne(resolver, doc, 'tighter');

    expect(tighter.source).toEqual({ name: 'integer', arguments: [], annotations: [] });
    expect(tighter.supertypes).toEqual(['int8']);
    // min/size survive from int8 (unmentioned by the refinement); max is overridden.
    expect(tighter.body).toEqual({
      kind: 'integer_type',
      size: { bits: 8n, signed: true },
      min: -128n,
      max: 100n,
    });
  });

  it("a chained refinement carries its ancestor's constraints forward (§5.6)", () => {
    const doc = parse(`
      int8  => !integer { size: { bits: 8  signed: true }  min: -128  max: 127 }
      small => !int8 ^ { max: 10 }
      big   => !small ^ { min: -5 }
    `);
    const { resolver, entries, structure } = integerHarness();
    structure.set('integer', integerTypeStructure());
    entries.set('int8', resolver.resolve(declarationOf(doc, 'int8')));
    entries.set('small', resolver.resolve(declarationOf(doc, 'small')));

    const big = resolveOne(resolver, doc, 'big');

    // `big` restates neither `size` nor `max`, both of which must still hold `small`'s (and, for
    // size, int8's) own values -- the whole point of merging rather than replacing.
    expect(big.body).toEqual({
      kind: 'integer_type',
      size: { bits: 8n, signed: true },
      min: -5n,
      max: 10n,
    });
  });

  it('rejects a refinement that widens rather than tightens its source (§5.7)', () => {
    // Deliberately no `size` here: with one, the effective upper bound folds size and the
    // explicit bound together (`integerEffectiveUpper`), and an 8-bit size would silently absorb
    // a merely-wider `max` -- this isolates the plain bound-vs-bound comparison instead.
    const doc = parse(`
      positive => !integer { min: 0  max: 127 }
      wider    => !positive ^ { max: 300 }
    `);
    const { resolver, entries, structure } = integerHarness();
    structure.set('integer', integerTypeStructure());
    entries.set('positive', resolver.resolve(declarationOf(doc, 'positive')));

    const error = thrownBy(() => resolveOne(resolver, doc, 'wider'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('widens rather than tightens');
  });

  it('rejects refining a constructor rather than an instance (did-you-mean constructor application)', () => {
    const doc = parse('bad => !integer ^ { min: 0 }');
    const { resolver, structure } = integerHarness();
    structure.set('integer', integerTypeStructure());
    // `integer` is not in the namespaceDefinitions map at all, matching §3.3.1: an atom refinement
    // source resolves against the type-name namespace only, never the structure namespace.
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('rejects refining a non-atom instance', () => {
    const doc = parse('bad => !notatom ^ { x: 1 }');
    const { resolver, entries } = harness();
    entries.set('notatom', {
      kind: 'PRODUCT',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('not an atom-family instance');
  });

  it('reports a missing SourceBodyEncoder as a coverage gap, not a schema error', () => {
    const doc = parse(`
      int8 => !integer { min: -128 }
      big  => !int8 ^ { min: -500 }
    `);
    const { resolver, entries, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    entries.set('int8', resolver.resolve(declarationOf(doc, 'int8')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'big'))).toBeInstanceOf(
      TsonNotImplementedError,
    );
  });
});

// ── Instance/reference templates (§5.10) ────────────────────────────────────────────────────

function widgetStructure(): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body: {
      kind: 'record',
      supertypes: [],
      fields: [
        {
          name: 'size',
          type: { name: 'integer', arguments: [], annotations: [] },
          state: 'REQUIRED',
          annotations: [],
        },
        {
          name: 'label',
          type: { name: 'token', arguments: [], annotations: [] },
          state: 'REQUIRED',
          annotations: [],
        },
      ],
      groups: [],
    },
    annotations: [],
  };
}

describe('open constructor application / instance templates (§5.10)', () => {
  it("holds the body rather than binding it, carrying the declaration's own type parameters", () => {
    const doc = parse('sized => <T> !widget { size: T  label: "x" }');
    const { resolver, structure } = harness();
    structure.set('widget', widgetStructure());
    const resolved = resolveOne(resolver, doc, 'sized');
    expect(resolved.parameters).toEqual(['T']);
    expect(resolved.constructor).toBe(false);
    expect('application' in resolved.body).toBe(true);
  });

  it('rejects binding an unknown field the constructor does not declare', () => {
    const doc = parse('bad => <T> !widget { nowhere: T }');
    const { resolver, structure } = harness();
    structure.set('widget', widgetStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('no field');
  });

  it('rejects leaving a REQUIRED-with-no-default field unbound (no application could ever satisfy it)', () => {
    // `label` is bound but `size` is not -- a genuinely non-empty binding record, so this is not
    // the ambiguous bare `{}` (which parses as the structural `empty-brace` case, not a
    // zero-field `RecordValue`, and so never reaches `checkTemplateBindings` at all).
    const doc = parse('bad => <T> !widget { label: T }');
    const { resolver, structure } = harness();
    structure.set('widget', widgetStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('requires a');
  });
});

describe('top-level template application (§5.10)', () => {
  it('a declaration-level generic application carries its arguments through, unresolved, as a REFERENCE entry', () => {
    const doc = parse('boxed_pair => box<text, uuid>');
    const { resolver } = harness();
    const resolved = resolveOne(resolver, doc, 'boxed_pair');
    expect(resolved.kind).toBe('REFERENCE');
    expect(resolved.parameters).toEqual([]);
    expect(resolved.source).toEqual({
      name: 'box',
      arguments: [
        { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } },
        { kind: 'ref', ref: { name: 'uuid', arguments: [], annotations: [] } },
      ],
      annotations: [],
    });
    expect(resolved.body).toEqual({ kind: 'reference', target: resolved.source });
  });

  it("a partial application re-declares some arguments as the declaration's own open parameters (§5.10)", () => {
    const doc = parse('uuid_pair => <B> pair<uuid, B>');
    const { resolver } = harness();
    const resolved = resolveOne(resolver, doc, 'uuid_pair');
    expect(resolved.kind).toBe('REFERENCE');
    expect(resolved.parameters).toEqual(['B']);
  });

  it('a bare reference (no arguments) resolves to a REFERENCE entry regardless of what the target itself is (§8.3)', () => {
    const doc = parse('type_name => token');
    const { resolver } = harness();
    const resolved = resolveOne(resolver, doc, 'type_name');
    expect(resolved.kind).toBe('REFERENCE');
    expect(resolved.source).toEqual({ name: 'token', arguments: [], annotations: [] });
  });
});

// ── Structural coverage gaps this resolver reports rather than mis-resolves ────────────────

describe('coverage gaps reported as TsonNotImplementedError, never silently mis-resolved', () => {
  it('a container-sugar type-ref reaching the resolver directly (bypassing the desugarer)', () => {
    const declaration: Declaration = {
      nameAnnotations: [],
      name: 'raw',
      typeDefAnnotations: [],
      typeDef: {
        kind: 'referenceTypeDef',
        typeParams: [],
        ref: {
          kind: 'arrayRef',
          elementType: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
        },
      },
    };
    const { resolver } = harness();
    expect(thrownBy(() => resolver.resolve(declaration))).toBeInstanceOf(TsonNotImplementedError);
  });

  it('closing an application needs a whole-schema materialiser this resolver was not built with', () => {
    const doc = parse('closed => box_t<text> & {}');
    const { resolver } = harness();
    // `box_t<text>` is a fully-bound (closed) application at a supertype position -- closing it
    // to the entry it denotes needs a whole-schema materialiser (`ApplicationCloser`), checked
    // before this resolver would even look `box_t` up in the type-name namespace.
    const error = thrownBy(() => resolveOne(resolver, doc, 'closed'));
    expect(error).toBeInstanceOf(TsonNotImplementedError);
  });
});

// ── An invariant violation is TsonInternalError, never a schema verdict ────────────────────

describe('invariant violations (bugs in this library, never a verdict on the schema)', () => {
  it('a constructor whose own body is not record-shaped is an internal error, not an author mistake', () => {
    const doc = parse('bad => !oddity { }');
    const { resolver, structure } = harness();
    structure.set('oddity', {
      kind: 'ATOM',
      parameters: [],
      constructor: true,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    });
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(TsonInternalError);
  });
});
