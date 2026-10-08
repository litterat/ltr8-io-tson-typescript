import { describe, expect, it } from 'vitest';

import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import {
  TsonBindMismatchError,
  TsonInternalError,
  TsonLimitRefusedError,
  TsonMissingBindingError,
  TsonNotImplementedError,
  TsonParseError,
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
import type { Top, TypeDefinition, TypeKind } from '../src/schema/meta/typedef.js';
import { isConstructor, typeKind, typeParameters } from '../src/schema/meta/typedef.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';

const META = '!!meta:"https://example.com/m.tn"';

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

/**
 * A minimal stand-in for the kernel's own constructor entries -- `typeKind`'s fourth branch
 * needs to look one up whenever a fixture resolves an *instance* (`integer => !integer_type {}`)
 * without this test file bothering to hand-build the kernel's own `integer_type`/`record`/...
 * declarations first. Covers exactly the constructor names this file's own fixtures apply.
 */
function stubConstructorKind(name: string): TypeKind | undefined {
  if (name === 'record' || name === 'array' || name === 'map' || name === 'tuple') return 'PRODUCT';
  if (name === 'choice' || name === 'scoped') return 'SUM';
  if (name === 'data') return 'DATA';
  if (name === 'value_type' || name === 'void_type' || name === 'enum' || name.endsWith('_type'))
    return 'ATOM';
  if (name === 'reference' || name === 'template') return 'PRODUCT'; // no base kind in their own chain (§4.1's own default)
  return undefined;
}

function stubConstructor(name: string): TypeDefinition | undefined {
  const kind = stubConstructorKind(name);
  if (kind === undefined) return undefined;
  const supertypes =
    kind === 'ATOM'
      ? ['atom', 'top']
      : kind === 'SUM'
        ? ['sum', 'top']
        : kind === 'DATA'
          ? ['data', 'top']
          : name === 'reference' || name === 'template'
            ? ['top']
            : ['product', 'top'];
  return {
    supertypes,
    subtypes: [],
    body: { kind: 'record', supertypes: [], fields: [], groups: [] },
    annotations: [],
  };
}

/** {@link typeKind}, looked up first against `entries` (the growing type-name namespace), then `structure` (the fixed structure namespace) -- the same two namespaces `harness()` itself hands a resolver -- then {@link stubConstructor} for a well-known kernel constructor name neither map bothered to seed. */
function kindOf(
  def: TypeDefinition,
  entries: ReadonlyMap<string, TypeDefinition>,
  structure: ReadonlyMap<string, TypeDefinition>,
): TypeKind {
  return typeKind(def, (name) => entries.get(name) ?? structure.get(name) ?? stubConstructor(name));
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
    const { resolver, entries, structure } = harness();

    const resolved = resolveOne(resolver, doc, 'integer_size');

    expect(kindOf(resolved, entries, structure)).toBe('PRODUCT');
    expect(isConstructor(resolved)).toBe(false);
    expect(resolved.supertypes).toEqual([]);
    expect(typeParameters(resolved)).toEqual([]);
    expect(resolved.annotations).toEqual([]);
    expect(isRecordBody(resolved.body)).toBe(true);
    if (!isRecordBody(resolved.body)) throw new Error('unreachable');
    expect(resolved.body.supertypes).toEqual([]);
    expect(resolved.body.fields).toEqual([
      {
        name: 'bits',
        type: { name: 'integer', arguments: [], annotations: [] },
        optional: false,
        voidable: false,
        role: 'FREE',
        annotations: [],
      },
      {
        name: 'signed',
        type: { name: 'boolean', arguments: [], annotations: [] },
        optional: false,
        voidable: false,
        role: 'FREE',
        annotations: [],
      },
    ]);
    expect(resolved.body.groups).toEqual([]);
  });

  it('`~` before a fresh record is a parse error -- there is no constructor marker at type-def position (§4.2, §12.1)', () => {
    // §12.1's own grammar note: "there is no constructor marker: an entry is a constructor by
    // being IS-A `top` (§4.2), and `~` is a special token with no role at type-def position."
    // The corpus states this by name (`class2/schema/invalid/a-constructor-marker-is-not-grammar`):
    // this fails in the parser, never by resolving to a non-constructor.
    expect(() => parse('widget => ~{ size: integer }')).toThrow(TsonParseError);
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
      optional: false,
      voidable: false,
      role: 'FREE',
      annotations: [],
    });
  });

  it('`name?: type ~ value` is optional with role DEFAULT, carrying the literal', () => {
    const doc = parse('t => { port?: integer ~ 8080 }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'port');
    expect(field.optional).toBe(true);
    expect(field.voidable).toBe(false);
    expect(field.role).toBe('DEFAULT');
    expect(field.value).toEqual({ text: '8080', form: 'UNQUOTED' });
  });

  it('`name: type = value` is a marker: unmarked name, role FIXED', () => {
    const doc = parse('t => { host: token = "prod.example.com" }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const host = fieldNamed(body, 'host');
    expect(host.optional).toBe(false);
    expect(host.role).toBe('FIXED');
  });

  it('`name?: type` is optional, non-voidable, role FREE, no value', () => {
    const doc = parse('t => { note?: token }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const note = fieldNamed(body, 'note');
    expect(note.optional).toBe(true);
    expect(note.voidable).toBe(false);
    expect(note.role).toBe('FREE');
  });

  it("`name: type?` is required (unmarked name) and voidable -- the type's own `?` (§5.2)", () => {
    const doc = parse('t => { note: token? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const note = fieldNamed(body, 'note');
    expect(note.optional).toBe(false);
    expect(note.voidable).toBe(true);
    expect(note.role).toBe('FREE');
  });

  it('`name?: type = value` is optional with role FIXED, carrying the literal, injected on omission', () => {
    const doc = parse('t => { flag?: boolean = false }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'flag');
    expect(field.optional).toBe(true);
    expect(field.voidable).toBe(false);
    expect(field.role).toBe('FIXED');
    expect(field.value).toEqual({ text: 'false', form: 'UNQUOTED' });
  });

  it("`name?: void?` may be omitted or written `_` and nothing else (§5.2's spelling for the retired `= _`)", () => {
    const doc = parse('t => { hidden?: void? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const field = fieldNamed(body, 'hidden');
    expect(field.optional).toBe(true);
    expect(field.voidable).toBe(true);
    expect(field.role).toBe('FREE');
    expect(field.value).toBeUndefined();
  });

  it('rejects a pin on a voidable type (`type? = value`, §5.2)', () => {
    const doc = parse('bad => { a?: token? = "x" }');
    const { resolver } = harness();
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });

  it('rejects a default on an unmarked name (`name: type ~ value`, §5.2)', () => {
    const doc = parse('bad => { a: token ~ "x" }');
    const { resolver } = harness();
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('always written');
  });

  it('the selector `=?` on an unmarked, non-voidable name resolves to role FREE with no value (§5.2)', () => {
    const doc = parse('t => { kind: token =? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    const kind = fieldNamed(body, 'kind');
    expect(kind.optional).toBe(false);
    expect(kind.voidable).toBe(false);
    expect(kind.role).toBe('FREE');
    expect(kind.value).toBeUndefined();
  });

  it('a parametric `=` inside a template stays on an unmarked name, held, with the parameter riding `value` (§5.7 open modifiers)', () => {
    const doc = parse('tmpl => <T> { element_type: type_ref = T }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 'tmpl').body;
    // Parameterised, so the body is held -- this exercises resolveField's own parametric branch
    // indirectly via holdIfOpen.
    expect('application' in body).toBe(true);
  });
});

// ── Composition (§5.8): top, atom, product, sum, reference ─────────────────────────────────

describe('composition (§5.8)', () => {
  it('a bare `top => {}` is a fresh, empty record', () => {
    const doc = parse('top => {}');
    const { resolver, entries, structure } = harness();
    const top = resolveOne(resolver, doc, 'top');
    expect(kindOf(top, entries, structure)).toBe('PRODUCT');
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
    const { resolver, entries, structure } = harness();
    resolveAll(resolver, entries, doc);

    const atomEntry = entries.get('atom');
    if (atomEntry === undefined) throw new Error('unreachable');
    expect(kindOf(atomEntry, entries, structure)).toBe('PRODUCT');
    expect(atomEntry.supertypes).toEqual(['top']);
    const productEntry = entries.get('product');
    const sumEntry = entries.get('sum');
    if (productEntry === undefined || sumEntry === undefined) throw new Error('unreachable');
    expect(kindOf(productEntry, entries, structure)).toBe('PRODUCT');
    expect(kindOf(sumEntry, entries, structure)).toBe('PRODUCT');
  });

  it('a type composing with `atom` is itself kind ATOM', () => {
    const doc = parse(`
      top  => {}
      atom => top & {}
      value_type => atom & {}
    `);
    const { resolver, entries, structure } = harness();
    resolveAll(resolver, entries, doc);
    const constructor = entries.get('value_type');
    if (constructor === undefined) throw new Error('unreachable');
    expect(kindOf(constructor, entries, structure)).toBe('ATOM');
    expect(entries.get('value_type')?.supertypes).toEqual(['atom', 'top']);
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
    expect(fieldNamed(fixed.body, 'access_pattern').role).toBe('FIXED');
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
    expect((error as TsonSchemaValidationError).message).toContain('backwards');
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
    expect(host.role).toBe('FIXED');
  });

  it("a restated field carries the restatement's own annotations, in source order, followed by the inherited field's, in source order -- through a three-deep chain (§5.8)", () => {
    // Each level restates `x`, adding its own annotation ahead of what it inherits: the
    // restatement leads, so the innermost declaration's annotation ends up first and the
    // original's last -- "nothing is dropped, no per-name dedup" (§5.8).
    const doc = parse(`
      base  => { @a1 x: token }
      mid   => base & { @a2 x: token }
      outer => mid & { @a3 x: token }
    `);
    const { resolver, entries } = harness();
    const base = resolver.resolve(declarationOf(doc, 'base'));
    entries.set('base', base);
    const mid = resolver.resolve(declarationOf(doc, 'mid'));
    entries.set('mid', mid);
    const outer = resolveOne(resolver, doc, 'outer');
    if (!isRecordBody(base.body) || !isRecordBody(mid.body) || !isRecordBody(outer.body)) {
      throw new Error('unreachable');
    }

    expect(fieldNamed(base.body, 'x').annotations).toEqual([{ name: 'a1' }]);
    expect(fieldNamed(mid.body, 'x').annotations).toEqual([{ name: 'a2' }, { name: 'a1' }]);
    expect(fieldNamed(outer.body, 'x').annotations).toEqual([
      { name: 'a3' },
      { name: 'a2' },
      { name: 'a1' },
    ]);
  });

  it("an elided-type restatement still merges its own annotations ahead of the inherited field's (§5.7, §5.8)", () => {
    const doc = parse(`
      config     => { @a1 host: token }
      production => config & { @a2 host: = "prod.example.com" }
    `);
    const { resolver, entries } = harness();
    entries.set('config', resolver.resolve(declarationOf(doc, 'config')));
    const production = resolveOne(resolver, doc, 'production');
    if (!isRecordBody(production.body)) throw new Error('unreachable');

    const host = fieldNamed(production.body, 'host');
    expect(host.type).toEqual({ name: 'token', arguments: [], annotations: [] });
    expect(host.annotations).toEqual([{ name: 'a2' }, { name: 'a1' }]);
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
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
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
    expect(thin.body.supertypes).toEqual([{ name: 'base', arguments: [], annotations: [] }]); // lineage kept
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
    expect(fieldNamed(thin.body, 'a').optional).toBe(false);
  });
});

// ── [TSON-SCHEMA] §11.5's "supertype chain" limit ───────────────────────────────────────────────

/** `base0 => {}`, `base1 => base0 & {}`, ..., `base{n} => base{n-1} & {}` -- a straight composition chain n levels deep. */
function compositionChain(depth: number): string {
  const lines = ['base0 => {}'];
  for (let i = 1; i <= depth; i++) {
    lines.push(`base${String(i)} => base${String(i - 1)} & {}`);
  }
  return lines.join('\n');
}

/** Resolves `base0..base{upTo}` in order into `entries`, the way `resolveAll` does for the whole document but stoppable partway through. */
function resolveChainUpTo(
  resolver: DefinitionResolver,
  doc: SchemaDocument,
  entries: Map<string, TypeDefinition>,
  upTo: number,
): void {
  for (let i = 0; i <= upTo; i++) {
    const name = `base${String(i)}`;
    entries.set(name, resolver.resolve(declarationOf(doc, name)));
  }
}

describe('§11.5\'s "supertype chain" limit', () => {
  it('a chain exactly at the default (64 transitive supertypes) resolves cleanly', () => {
    const doc = parse(compositionChain(64));
    const { resolver, entries } = harness();
    resolveChainUpTo(resolver, doc, entries, 63);
    const top = resolveOne(resolver, doc, 'base64');
    expect(top.supertypes).toHaveLength(64);
  });

  it('one level past the default (65 transitive supertypes) is a limit refusal, not a resolver error', () => {
    const doc = parse(compositionChain(65));
    const { resolver, entries } = harness();
    resolveChainUpTo(resolver, doc, entries, 64);
    const error = thrownBy(() => resolveOne(resolver, doc, 'base65'));
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('supertype-chain');
    expect((error as TsonLimitRefusedError).configuredThreshold).toBe(64);
  });

  it("the same limit applies through refinement's own transitive supertype chain (§5.7)", () => {
    const lines = ['base0 => {}'];
    for (let i = 1; i <= 65; i++) {
      lines.push(`base${String(i)} => base${String(i - 1)} ^ {}`);
    }
    const doc = parse(lines.join('\n'));
    const { resolver, entries } = harness();
    for (let i = 0; i <= 64; i++) {
      const name = `base${String(i)}`;
      entries.set(name, resolver.resolve(declarationOf(doc, name)));
    }
    const error = thrownBy(() => resolveOne(resolver, doc, 'base65'));
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('supertype-chain');
  });
});

// ── Field groups (§5.11) ─────────────────────────────────────────────────────────────────────

describe('field groups (§5.11)', () => {
  it("flattens each member to optional: true, role: FREE regardless of the group's own `optional`", () => {
    const doc = parse('t => { (a: token | b: token) }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'a')).toMatchObject({ optional: true, voidable: false, role: 'FREE' });
    expect(fieldNamed(body, 'b')).toMatchObject({ optional: true, voidable: false, role: 'FREE' });
    expect(body.groups).toEqual([{ members: [['a'], ['b']], optional: false }]);
  });

  it('an option holds several fields, and `?` on a member name marks it optional within its option (§5.11)', () => {
    const doc = parse('t => { (host: token  port?: token | socket: token) }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(body.groups).toEqual([
      { members: [['host', 'port'], ['socket']], optionalMembers: ['port'], optional: false },
    ]);
    expect(body.fields.map((f) => f.name)).toEqual(['host', 'port', 'socket']);
    expect(body.fields.every((f) => f.optional)).toBe(true);
  });

  it('`+` lowers to one option holding every member, each marked optional, on a group that is not optional (§5.11)', () => {
    const doc = parse('t => { (email: token | phone: token)+ }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(body.groups).toEqual([
      { members: [['email', 'phone']], optionalMembers: ['email', 'phone'], optional: false },
    ]);
  });

  it('a `?`-marked group is optional', () => {
    const doc = parse('t => { (a: token | b: token)? }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(body.groups[0]?.optional).toBe(true);
  });

  it('a bare restatement of both group members via ordinary field syntax leaves both governed by the group -- "no restated member is ever always present, so the rule an earlier revision needed against two always-present members of one group has nothing left to refuse" (§5.11) -- the schema loads cleanly, and a document with both present is validate\'s own concern, not the resolver\'s', () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { a: token  b: token }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const bad = resolveOne(resolver, doc, 'bad');
    if (!isRecordBody(bad.body)) throw new Error('unreachable');
    // Neither restated member moves off the group's own governance: a bare, unmarked restatement
    // through ordinary field syntax (not the group-restatement clause) still takes no name mark of
    // its own, so `optional` stays `true` for both -- the group, not the field, answers omission.
    expect(fieldNamed(bad.body, 'a')).toMatchObject({ optional: true, role: 'FREE' });
    expect(fieldNamed(bad.body, 'b')).toMatchObject({ optional: true, role: 'FREE' });
    expect(bad.body.groups).toEqual([{ members: [['a'], ['b']], optional: false }]);
  });

  it('a composition body restates an inherited group, tightening an optional group to one that must be chosen', () => {
    const doc = parse(`
      base     => { (a: token | b: token)? }
      required => base & { (a: token | b: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const required = resolveOne(resolver, doc, 'required');
    if (!isRecordBody(required.body)) throw new Error('unreachable');
    expect(required.body.groups).toEqual([{ members: [['a'], ['b']], optional: false }]);
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

  it('a fresh group\'s own member annotations are bound and kept (§5.11, §12.1: `*annotation field-name ws ":" ws type-ref`)', () => {
    const doc = parse('t => { (@a1 a: token | @a2 b: token) }');
    const { resolver } = harness();
    const body = resolveOne(resolver, doc, 't').body;
    if (!isRecordBody(body)) throw new Error('unreachable');
    expect(fieldNamed(body, 'a').annotations).toEqual([{ name: 'a1' }]);
    expect(fieldNamed(body, 'b').annotations).toEqual([{ name: 'a2' }]);
  });

  it("a restated group member carries the restatement's own annotations, in source order, followed by the inherited member's (§5.8, §5.11)", () => {
    const doc = parse(`
      base     => { (@a1 a: token | b: token) }
      restated => base & { (@a2 a: token | b: token) }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const restated = resolveOne(resolver, doc, 'restated');
    if (!isRecordBody(restated.body)) throw new Error('unreachable');
    expect(fieldNamed(restated.body, 'a').annotations).toEqual([{ name: 'a2' }, { name: 'a1' }]);
    // `b` carries no restated annotation of its own -- nothing is merged onto it, and the
    // inherited (empty) list survives untouched.
    expect(fieldNamed(restated.body, 'b').annotations).toEqual([]);
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

  it("a restated member narrowed to `void?` stays a member, taking no name mark of its own (§5.11, the spelling an earlier revision wrote '= _') -- void refines every type at a voidable position, so the member must already be voidable", () => {
    const doc = parse(`
      base => { (a: token? | b: token) }
      ok   => base & { a: void? }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const ok = resolveOne(resolver, doc, 'ok');
    if (!isRecordBody(ok.body)) throw new Error('unreachable');
    const a = fieldNamed(ok.body, 'a');
    expect(a.type).toEqual({ name: 'void', arguments: [], annotations: [] });
    expect(a.optional).toBe(true);
    expect(a.voidable).toBe(true);
    expect(a.role).toBe('FREE');
    // `a` stays a member -- the group is untouched by the restatement.
    expect(ok.body.groups).toEqual([{ members: [['a'], ['b']], optional: false }]);
  });

  it("a restated member's name mark may be dropped and never added -- adding one loosens its option (§5.11)", () => {
    const doc = parse(`
      base => { (a: token | b: token) }
      bad  => base & { a?: token }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('loosens its option');
  });

  it("a restated member that drops its option's '?' becomes required there (§5.11)", () => {
    const doc = parse(`
      base => { (a: token  b?: token | c: token) }
      sub  => base & { a: token  b: token }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const sub = resolveOne(resolver, doc, 'sub');
    if (!isRecordBody(sub.body)) throw new Error('unreachable');
    expect(sub.body.groups).toEqual([{ members: [['a', 'b'], ['c']], optional: false }]);
  });

  it("a restated member's default ('~') is refused -- a default is a value only omission reaches, and omission is the group's (§5.11)", () => {
    const doc = parse(`
      base => { (a: text | b: text) }
      bad  => base & { a: ~ "x" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
  });

  it("a restated member may take '=', checked when written and never injected -- omission still yields nothing, and the pin does not make the member always present (§5.11)", () => {
    const doc = parse(`
      base => { (a: text | b: text) }
      sub  => base & { a: = "x" }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const sub = resolveOne(resolver, doc, 'sub');
    if (!isRecordBody(sub.body)) throw new Error('unreachable');
    const a = fieldNamed(sub.body, 'a');
    expect(a).toMatchObject({ optional: true, voidable: false, role: 'FIXED' });
    expect(a.value?.text).toBe('x');
    // The member is still governed by the group, so it is never `fieldOmission`-`'INJECTED'` --
    // the reader must not manufacture `a` on omission just because it now carries a pinned value.
    expect(sub.body.groups).toEqual([{ members: [['a'], ['b']], optional: false }]);
  });

  it("a member reachable by refinement may not acquire the selector '=?' (§5.2, §5.11)", () => {
    const doc = parse(`
      base => { (a: text | b: text) }
      bad  => base & { a: =? }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('=?');
  });
});

describe('tightening entries never acquire a fresh selector (§5.2, §5.7)', () => {
  it("rejects '=?' on an ordinary (non-member) tightening entry -- a discriminator is declared once, at the base, and a restatement narrows an inherited field rather than minting a new one", () => {
    const doc = parse(`
      base => { k: text }
      bad  => base ^ { k: =? }
    `);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('=?');
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
    expect(fieldNamed(narrow.body, 'x').role).toBe('FIXED');
    expect(fieldNamed(narrow.body, 'y').role).toBe('FREE');
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
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
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

  it('`~` before a refinement head is likewise a parse error (§4.2, §12.1)', () => {
    expect(() =>
      parse(`
        base    => { x: token }
        derived => ~base ^ { x: token = "fixed" }
      `),
    ).toThrow(TsonParseError);
  });

  it('the definition mark is never inherited through refinement -- "the member is never inherited... and must be, or no concrete subtype of an abstract base could exist" holds for `^` exactly as it does for `&` (§5.2)', () => {
    const doc = parse(`
      p => abstract { x: token }
      q => p ^ {}
    `);
    const { resolver, entries } = harness();
    entries.set('p', resolver.resolve(declarationOf(doc, 'p')));
    const q = resolveOne(resolver, doc, 'q');
    if (!isRecordBody(q.body)) throw new Error('unreachable');
    expect(q.body.extension).toBe('OPEN');
    expect(q.body.discriminators).toBeUndefined();
  });

  it("a restatement pinning a discriminator field FIXED does not inherit the base's own discriminators -- the subtype is a member, not itself a further base", () => {
    const doc = parse(`
      pet => abstract { pet_type: text =?  name: text }
      dog => pet ^ { pet_type: = "dog" }
    `);
    const { resolver, entries } = harness();
    entries.set('pet', resolver.resolve(declarationOf(doc, 'pet')));
    const dog = resolveOne(resolver, doc, 'dog');
    if (!isRecordBody(dog.body)) throw new Error('unreachable');
    expect(dog.body.extension).toBe('OPEN');
    expect(dog.body.discriminators).toBeUndefined();
    expect(fieldNamed(dog.body, 'pet_type')).toMatchObject({ role: 'FIXED', optional: false });
  });

  it('restating a pinned field with a different spelling of the same value is not a change of pin -- `= 255` and `= 0xFF` collide as values (§5.5, §5.7)', () => {
    const doc = parse(`
      x => { n?: int32 = 255 }
      y => x ^ { n?: = 0xFF }
    `);
    const { resolver, entries } = harness();
    entries.set('x', resolver.resolve(declarationOf(doc, 'x')));
    expect(() => {
      resolveOne(resolver, doc, 'y');
    }).not.toThrow();
  });

  it('restating a pinned field with a genuinely different value is still refused (§5.7)', () => {
    const doc = parse(`
      x => { n?: int32 = 255 }
      y => x ^ { n?: = 254 }
    `);
    const { resolver, entries } = harness();
    entries.set('x', resolver.resolve(declarationOf(doc, 'x')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'y'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('different value');
  });

  it('restating a pinned text field with a different Unicode normalisation form of the same content is not a change of pin (§5.7: "text pins compare NFC-normalised")', () => {
    // "é" (é, NFC) vs "é" (e + combining acute, NFD) -- the same grapheme, two encodings.
    const doc = parse(`
      x => { n?: text = "café" }
      y => x ^ { n?: = "café" }
    `);
    const { resolver, entries } = harness();
    entries.set('x', resolver.resolve(declarationOf(doc, 'x')));
    expect(() => {
      resolveOne(resolver, doc, 'y');
    }).not.toThrow();
  });
});

// ── Definition marks: FINAL admits no subtype (§5.2, §5.9) ──────────────────────────────────────

describe('FINAL admits no subtype (§5.2)', () => {
  it('refuses composition onto a FINAL record', () => {
    const doc = parse(`
      reading    => final { sensor: token }
      calibrated => reading & { offset: token }
    `);
    const { resolver, entries } = harness();
    entries.set('reading', resolver.resolve(declarationOf(doc, 'reading')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'calibrated'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('FINAL');
  });

  it('refuses refinement of a FINAL record', () => {
    const doc = parse(`
      reading => final { sensor: token }
      named   => reading ^ { sensor?: token = "thermometer" }
    `);
    const { resolver, entries } = harness();
    entries.set('reading', resolver.resolve(declarationOf(doc, 'reading')));
    const error = thrownBy(() => resolveOne(resolver, doc, 'named'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('FINAL');
  });

  it('subtraction from a FINAL record is admissible -- it mints no IS-A edge, the one thing FINAL constrains (§5.9)', () => {
    const doc = parse(`
      reading => final { sensor: token  celsius: token }
      bare    => reading - { celsius }
    `);
    const { resolver, entries } = harness();
    entries.set('reading', resolver.resolve(declarationOf(doc, 'reading')));
    const bare = resolveOne(resolver, doc, 'bare');
    expect(bare.supertypes).toEqual([]); // IS-A broken, per §5.9's own resolution rule
    if (!isRecordBody(bare.body)) throw new Error('unreachable');
    expect(bare.body.fields.map((f) => f.name)).toEqual(['sensor']);
  });

  it("refuses 'final' beside a selector -- the members a selector implies could never exist under FINAL (§5.2)", () => {
    const doc = parse(`pet => final { pet_type: token =?  name: token }`);
    const { resolver } = harness();
    const error = thrownBy(() => resolveOne(resolver, doc, 'pet'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('final');
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
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
      annotations: [],
    });
    const resolved = resolveOne(resolver, doc, 't');
    expect(resolved.annotations).toEqual([{ name: 'doc', value: 'hello' }]);
  });

  // Direct port of `e33b2942`'s `DefinitionResolver.java:422-425` diff, onto this function's own
  // twin: `bindAtomInstance` (same file) already had this two-way catch; `bindAnnotationValue`'s
  // catch-all used to relabel both as `TsonNotImplementedError` (`NOT_IMPLEMENTED`) instead of
  // surfacing them as themselves (`BIND_MISMATCH`).
  it('propagates TsonMissingBindingError from the annotation value reader as itself, not TsonNotImplementedError', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver, structure } = harness({
      annotationValueReader: () => {
        throw new TsonMissingBindingError("no binding registered for 'doc'");
      },
    });
    structure.set('doc', {
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 't'));
    expect(error).toBeInstanceOf(TsonMissingBindingError);
    expect((error as Error).message).toContain("'t'");
  });

  it('propagates TsonBindMismatchError from the annotation value reader as itself, not TsonNotImplementedError', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver, structure } = harness({
      annotationValueReader: () => {
        throw new TsonBindMismatchError("'doc' and its binding disagree about its fields");
      },
    });
    structure.set('doc', {
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 't'));
    // TsonMissingBindingError extends TsonBindMismatchError, so this also guards against the
    // fix over-matching: a plain TsonBindMismatchError must not become a TsonMissingBindingError.
    expect(error).toBeInstanceOf(TsonBindMismatchError);
    expect(error).not.toBeInstanceOf(TsonMissingBindingError);
    expect((error as Error).message).toContain("'t'");
  });

  it('still relabels every other failure as TsonNotImplementedError (the catch-all is unchanged for anything else)', () => {
    const doc = parse('t => @doc:"hello" { x: token }');
    const { resolver, structure } = harness({
      annotationValueReader: () => {
        throw new Error('some unrelated failure');
      },
    });
    structure.set('doc', {
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 't'));
    expect(error).toBeInstanceOf(TsonNotImplementedError);
  });
});

// ── Template applications (§5.10) and constructor application/refinement (§5.5, §5.6) ──────

/** `!integer`'s constraint vocabulary in the structure namespace, and a minimal hand-rolled reader for it -- this work package's own test scaffolding stands in for a full compiled reader (a later work package's own concern), the same way the reference implementation's own isolated tests do. */
function integerTypeStructure(): TypeDefinition {
  const fields: RecordField[] = [
    {
      name: 'size',
      type: { name: 'integer_size', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
    {
      name: 'min',
      type: { name: 'integer', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
    {
      name: 'exclusive_min',
      type: { name: 'integer', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
    {
      name: 'max',
      type: { name: 'integer', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
    {
      name: 'exclusive_max',
      type: { name: 'integer', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
    {
      name: 'multiple_of',
      type: { name: 'integer', arguments: [], annotations: [] },
      optional: true,
      voidable: false,
      role: 'FREE',
      annotations: [],
    },
  ];
  return {
    // IS-A `top` through `atom` (hand-built rather than composed, for this test's own
    // simplified structure namespace) is what makes `isConstructor` true here.
    supertypes: ['atom', 'top'],
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
    const { resolver, entries, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    structure.set('integer_type', integerTypeStructure());

    const int8 = resolveOne(resolver, doc, 'int8');

    expect(kindOf(int8, entries, structure)).toBe('ATOM');
    expect(isConstructor(int8)).toBe(false);
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
      supertypes: [],
      subtypes: [],
      body: { kind: 'value_type' },
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
    structure.set('integer_type', integerTypeStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('not valid data for');
  });

  it('rejects a body whose own facets contradict each other (§7.2 coherence)', () => {
    const doc = parse('bad => !integer { min: 10  max: 3 }');
    const { resolver, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    structure.set('integer_type', integerTypeStructure());
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('contradict each other');
  });

  it("applies a constructor named through an alias in the structure namespace, reading the payload against the chain's terminal (§8.3)", () => {
    // alias_integer => integer, in the structure namespace itself -- a REFERENCE-kind entry
    // naming the real constructor `integer`. `!alias_integer { ... }` must read exactly as
    // `!integer { ... }` would: the meta-schema's own reader table is keyed by the constructor's
    // own name, so the value handed to it is re-typed to the terminal before binding.
    const doc = parse('int8 => !alias_integer { size: { bits: 8  signed: true } }');
    const { resolver, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    structure.set('integer_type', integerTypeStructure());
    structure.set('alias_integer', {
      source: { name: 'integer', arguments: [], annotations: [] },
      supertypes: [],
      subtypes: [],
      body: { kind: 'reference', target: { name: 'integer', arguments: [], annotations: [] } },
      annotations: [],
    });

    const int8 = resolveOne(resolver, doc, 'int8');

    // The author's own spelling survives in `source` -- the alias, not the terminal it names.
    expect(int8.source).toEqual({ name: 'alias_integer', arguments: [], annotations: [] });
    expect(int8.body).toEqual({
      kind: 'integer_type',
      size: { bits: 8n, signed: true },
    });
  });

  it('rejects a constructor alias whose own chain ends at a name the structure namespace does not declare (§8.3)', () => {
    const doc = parse('bad => !dangling { }');
    const { resolver, structure } = harness();
    structure.set('dangling', {
      source: { name: 'nowhere', arguments: [], annotations: [] },
      supertypes: [],
      subtypes: [],
      body: { kind: 'reference', target: { name: 'nowhere', arguments: [], annotations: [] } },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('does not declare');
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
    structure.set('integer_type', integerTypeStructure());
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
    structure.set('integer_type', integerTypeStructure());
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
    structure.set('integer_type', integerTypeStructure());
    entries.set('positive', resolver.resolve(declarationOf(doc, 'positive')));

    const error = thrownBy(() => resolveOne(resolver, doc, 'wider'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('widens rather than tightens');
  });

  it('rejects refining a constructor rather than an instance (did-you-mean constructor application)', () => {
    const doc = parse('bad => !integer ^ { min: 0 }');
    const { resolver, structure } = integerHarness();
    structure.set('integer', integerTypeStructure());
    structure.set('integer_type', integerTypeStructure());
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
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    });
    // `typeKind`'s fourth branch needs `record` itself to resolve, to derive `notatom`'s own
    // kind (PRODUCT) from what it is an instance of.
    entries.set('record', {
      supertypes: ['product', 'top'],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    });
    const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('not an atom-family instance');
  });

  // §5.5's own warning: the eligibility test is on the body, and on nothing else. Two readings
  // that look plausible both get it backwards -- these two tests each fail under one of them,
  // together pinning the check down to the body-shape test `isAtom` performs.
  it(
    'rejects refining a constructor found directly in the type-name namespace -- not an ' +
      'IS-A `atom` check and not a kind check (§3.3.1, §5.5)',
    () => {
      const doc = parse('bad => !integer_type ^ { min: 0 }');
      const { resolver, entries } = harness();
      // Shaped exactly like a real constructor would be: IS-A `atom` (so a check reading "IS-A
      // atom" -- `supertypes.includes('atom')` -- wrongly accepts it) and itself ATOM-kinded by
      // `typeKind`'s own third branch (so a kind check -- `typeKind(source) === 'ATOM'` --
      // wrongly accepts it too: a constructor's kind and its instances' kind are the same
      // literal, "true of the constructor, false of every instance" being the opposite of what
      // either reading tests for). Only a check on `body` itself -- is it an atom
      // *application*, not the vocabulary record describing one -- refuses this.
      entries.set('integer_type', {
        supertypes: ['atom', 'top'],
        subtypes: [],
        body: { kind: 'record', supertypes: [], fields: [], groups: [] },
        annotations: [],
      });
      const error = thrownBy(() => resolveOne(resolver, doc, 'bad'));
      expect(error).toBeInstanceOf(TsonSchemaValidationError);
      expect((error as TsonSchemaValidationError).message).toContain('not an atom-family instance');
    },
  );

  it(
    'accepts refining an instance with an empty supertypes chain -- not an IS-A `atom` check ' +
      '(§4.1: construction transfers no IS-A)',
    () => {
      const doc = parse('tighter => !integer ^ { max: 100 }');
      const { resolver, entries } = integerHarness();
      // `supertypes: []`, exactly as §4.1 states for every constructor-application result:
      // "construction transfers only the constructor's kind... the result records source: C
      // with empty supertypes." A check reading "IS-A atom" (`supertypes.includes('atom')`)
      // finds nothing here and wrongly refuses this legitimate refinement -- the opposite
      // mistake from the constructor case above, and why neither IS-A reading substitutes for
      // testing `body` directly.
      entries.set('integer', {
        supertypes: [],
        subtypes: [],
        source: { name: 'integer', arguments: [], annotations: [] },
        body: { kind: 'integer_type', min: -128n, max: 127n },
        annotations: [],
      });
      const tighter = resolveOne(resolver, doc, 'tighter');
      expect(tighter.body).toEqual({ kind: 'integer_type', min: -128n, max: 100n });
    },
  );

  it('reports a missing SourceBodyEncoder as a coverage gap, not a schema error', () => {
    const doc = parse(`
      int8 => !integer { min: -128 }
      big  => !int8 ^ { min: -500 }
    `);
    const { resolver, entries, structure } = harness({ definitionMetaReader: integerTypeReader });
    structure.set('integer', integerTypeStructure());
    structure.set('integer_type', integerTypeStructure());
    entries.set('int8', resolver.resolve(declarationOf(doc, 'int8')));
    expect(thrownBy(() => resolveOne(resolver, doc, 'big'))).toBeInstanceOf(
      TsonNotImplementedError,
    );
  });
});

// ── Instance/reference templates (§5.10) ────────────────────────────────────────────────────

function widgetStructure(): TypeDefinition {
  return {
    // IS-A `top` through `product` (hand-built, for this test's own simplified structure
    // namespace) is what makes `isConstructor` true here.
    supertypes: ['product', 'top'],
    subtypes: [],
    body: {
      kind: 'record',
      supertypes: [],
      fields: [
        {
          name: 'size',
          type: { name: 'integer', arguments: [], annotations: [] },
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
        {
          name: 'label',
          type: { name: 'token', arguments: [], annotations: [] },
          optional: false,
          voidable: false,
          role: 'FREE',
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
    expect(typeParameters(resolved)).toEqual(['T']);
    expect(isConstructor(resolved)).toBe(false);
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
    const { resolver, entries, structure } = harness();
    const resolved = resolveOne(resolver, doc, 'boxed_pair');
    expect(kindOf(resolved, entries, structure)).toBe('REFERENCE');
    expect(typeParameters(resolved)).toEqual([]);
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
    const { resolver, entries, structure } = harness();
    const resolved = resolveOne(resolver, doc, 'uuid_pair');
    // Open, so TEMPLATE by derivation regardless of what its held body applies (§8.1's own
    // "Open entries" text: "the entry's kind is TEMPLATE by derivation and it has none until it
    // closes") -- unlike a closed alias (the test above), which is REFERENCE-kind directly.
    expect(kindOf(resolved, entries, structure)).toBe('TEMPLATE');
    expect(typeParameters(resolved)).toEqual(['B']);
    expect('application' in resolved.body).toBe(true);
  });

  it('a bare reference (no arguments) resolves to a REFERENCE entry regardless of what the target itself is (§8.3)', () => {
    const doc = parse('type_name => token');
    const { resolver, entries, structure } = harness();
    const resolved = resolveOne(resolver, doc, 'type_name');
    expect(kindOf(resolved, entries, structure)).toBe('REFERENCE');
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
          elementType: { typeRef: { kind: 'simpleRef', name: 'text' }, voidable: false },
        },
      },
    };
    const { resolver } = harness();
    expect(thrownBy(() => resolver.resolve(declaration))).toBeInstanceOf(TsonNotImplementedError);
  });

  it('closing an application needs a whole-schema materialiser this resolver was not built with', () => {
    const doc = parse('closed => box_t<text> ^ {}');
    const { resolver } = harness();
    // `box_t<text>` is a fully-bound (closed) application at a refinement source position --
    // closing it to the entry it denotes needs a whole-schema materialiser (`ApplicationCloser`),
    // checked before this resolver would even look `box_t` up in the type-name namespace. (A
    // *composition* operand no longer takes this path at all: §5.8's last sentence subsumes a
    // closed application there structurally, via `openOperand`, and mints no entry -- see the
    // '§5.8 composition' describe block's own coverage.)
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
      // IS-A `top` (hand-built) is what reaches the record-shape check at all.
      supertypes: ['atom', 'top'],
      subtypes: [],
      body: { kind: 'value_type' },
      annotations: [],
    });
    expect(thrownBy(() => resolveOne(resolver, doc, 'bad'))).toBeInstanceOf(TsonInternalError);
  });
});

// ── Removal and restatement of field groups (§5.9 rule 7, §5.11) ─────────────────────────────

describe('removing a field-group member (§5.9 rule 7, §5.11 Removal)', () => {
  function resolveBody(source: string, name: string): RecordBody {
    const doc = parse(source);
    const { resolver, entries } = harness();
    entries.set('base', resolver.resolve(declarationOf(doc, 'base')));
    const resolved = resolveOne(resolver, doc, name);
    if (!isRecordBody(resolved.body)) throw new Error('unreachable');
    return resolved.body;
  }

  it('a member leaves its option, and an option left with several members stays (§5.11)', () => {
    const body = resolveBody(
      `base => { (host: token  port: token  extra?: token | socket: token) }
       thin => base - { extra }`,
      'thin',
    );
    expect(body.groups).toEqual([{ members: [['host', 'port'], ['socket']], optional: false }]);
    expect(body.fields.map((f) => f.name)).toEqual(['host', 'port', 'socket']);
  });

  it('an emptied option leaves the group, and the group left with one single-member option dissolves into the plain field (§5.11)', () => {
    const body = resolveBody(
      `base => { (a: token | b: token) }
       thin => base - { b }`,
      'thin',
    );
    expect(body.groups).toEqual([]);
    const a = fieldNamed(body, 'a');
    expect(a.optional).toBe(false);
    expect(a.role).toBe('FREE');
  });

  it("a dissolved optional group's survivor takes `?` on its name and keeps its own voidability (§5.11)", () => {
    const body = resolveBody(
      `base => { (a: token? | b: token)? }
       thin => base - { b }`,
      'thin',
    );
    expect(body.groups).toEqual([]);
    const a = fieldNamed(body, 'a');
    expect(a.optional).toBe(true);
    expect(a.voidable).toBe(true);
  });

  it('a bare group reduced to one option with an unmarked member becomes plain fields, marked members optional (§5.11)', () => {
    const body = resolveBody(
      `base => { (a: token  b?: token | c: token) }
       thin => base - { c }`,
      'thin',
    );
    expect(body.groups).toEqual([]);
    expect(fieldNamed(body, 'a').optional).toBe(false);
    expect(fieldNamed(body, 'b').optional).toBe(true);
  });

  it('removal leaves a `+` group that keeps two members, and dissolves one that falls to one (§5.11)', () => {
    const three = resolveBody(
      `base => { (a: token | b: token | c: token)+ }
       thin => base - { c }`,
      'thin',
    );
    expect(three.groups).toEqual([
      { members: [['a', 'b']], optionalMembers: ['a', 'b'], optional: false },
    ]);
    const two = resolveBody(
      `base => { (a: token | b: token)+ }
       thin => base - { b }`,
      'thin',
    );
    expect(two.groups).toEqual([]);
    expect(fieldNamed(two, 'a').optional).toBe(false);
  });

  it('removing every member drops the group with them (§5.11)', () => {
    const body = resolveBody(
      `base => { keep: token  (a: token | b: token) }
       thin => base - { a b }`,
      'thin',
    );
    expect(body.groups).toEqual([]);
    expect(body.fields.map((f) => f.name)).toEqual(['keep']);
  });
});
