import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bootstrapKernel } from '../src/schema/bootstrap.js';
import { TsonInternalError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import type { EnumBody } from '../src/schema/meta/bodies.js';
import type { IdentifierType, IriType } from '../src/schema/meta/atoms-text.js';
import type { Alias, Top } from '../src/schema/meta/typedef.js';
import { isConstructor, supertypesOf, withoutChain } from '../src/schema/meta/typedef.js';
import { isNestedMap } from '../src/schema/meta/schemaPaths.js';
import { entryClass } from './model-fixtures.js';

/**
 * The real, bundled kernel source (`spec/m/meta.tn`, vendored verbatim; CLAUDE.md: the bundled schemas
 * are loaded at runtime and every citation refers to the spec text, so both have to be readable
 * without network access) -- the same file `bundled-schemas-parse.test.ts` reads, and the document the
 * resolver gate (`bundled-schemas-resolve.test.ts`) compares against `spec/fixtures/meta-resolved.tn`.
 */
function loadKernelSource(): Uint8Array {
  const path = fileURLToPath(new URL('../../../spec/m/meta.tn', import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function entryOf(schema: { readonly entries: ReadonlyMap<string, Top> }, name: string): Top {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`bootstrapped kernel has no entry '${name}'`);
  return entry;
}

describe('bootstrapKernel, against the real bundled meta.tn (§3.4)', () => {
  const schema = bootstrapKernel(loadKernelSource());

  it("carries the kernel's own !!id, imports nothing, and is marked bootstrap (§3.4)", () => {
    expect(schema.id).toMatch(/\/m\/meta\.tn/);
    expect(schema.imports).toEqual([]);
    expect(schema.bootstrap).toBe(true);
  });

  it('resolves the six machinery maps as schema maps nested as entries of the root (§4.1)', () => {
    for (const map of ['numeric', 'unicode', 'net', 'atom', 'meta', 'binary']) {
      expect(isNestedMap(entryOf(schema, map)), `'${map}' is a nested map`).toBe(true);
      expect(entryClass(entryOf(schema, map))).toBe('VALUE');
    }
  });

  it('holds every machinery map member under its path, as one namespace holds them at every depth (§2.2.3)', () => {
    for (const path of [
      'meta.record',
      'meta.top',
      'numeric.integer_type',
      'unicode.text_type',
      'net.iri_type',
      'atom.ordering',
      'binary.bytes_type',
    ]) {
      expect(schema.entries.has(path), `'${path}' is an entry`).toBe(true);
    }
  });

  it('mints no entry for its container sugar: a form at a type slot stays where it is written (§4.2, §5.3)', () => {
    const minted = [...schema.entries.keys()].filter((name) => /_[0-9a-f]{8}$/.test(name));
    expect(minted).toEqual([]);
  });

  it('resolves the three base kinds through type, each abstract and itself kind PRODUCT (§4.1)', () => {
    for (const name of ['meta.atom', 'meta.product', 'meta.sum']) {
      const entry = entryOf(schema, name);
      expect(entryClass(entry)).toBe('PRODUCT');
      expect(supertypesOf(entry)).toEqual(['meta.top', 'meta.type']);
      expect((entry as { readonly extension?: string }).extension).toBe('ABSTRACT');
    }
  });

  it('resolves type composing directly with top, abstract (§4.1)', () => {
    const entry = entryOf(schema, 'meta.type');
    expect(supertypesOf(entry)).toEqual(['meta.top']);
    expect((entry as { readonly extension?: string }).extension).toBe('ABSTRACT');
  });

  it('resolves top itself with an empty chain and an empty, abstract record body', () => {
    const top = entryOf(schema, 'meta.top');
    expect(entryClass(top)).toBe('PRODUCT');
    expect(supertypesOf(top)).toEqual([]);
    expect(withoutChain(top)).toMatchObject({ kind: 'record', groups: [], extension: 'ABSTRACT' });
  });

  it('resolves alias composing top directly: a constructor with no chain of a type of its own (§4.1, §8.3)', () => {
    const alias = entryOf(schema, 'meta.alias');
    expect(isConstructor(alias)).toBe(true);
    expect(supertypesOf(alias)).toEqual(['meta.top']);
  });

  it('resolves void as a bare, empty instance of the void_type constructor (§5.5)', () => {
    const entry = entryOf(schema, 'void');
    expect(entryClass(entry)).toBe('ATOM');
    expect(schema.facts.get('void')?.head).toBe('meta.void_type');
    expect(withoutChain(entry)).toEqual({ kind: 'void_type' });
  });

  it('resolves void_type as a constructor composing with atom, with no vocabulary (§4.2)', () => {
    const constructor = entryOf(schema, 'meta.void_type');
    expect(entryClass(constructor)).toBe('ATOM');
    expect(isConstructor(constructor)).toBe(true);
    expect(supertypesOf(constructor)).toEqual(['meta.atom', 'meta.top', 'meta.type']);
  });

  it('declares no value type and no unit: void is told apart by constructor, never by name (§4.2)', () => {
    expect(schema.entries.has('value')).toBe(false);
    expect(schema.entries.has('unit')).toBe(false);
  });

  it('resolves identifier as the identifier_type instance { continue_add: "-" }, the profile of [TSON-DATA] §7.7 (§5.5)', () => {
    const entry = entryOf(schema, 'meta.identifier');
    expect(entryClass(entry)).toBe('ATOM');
    expect(schema.facts.get('meta.identifier')?.head).toBe('unicode.identifier_type');
    expect(withoutChain(entry)).toEqual({
      kind: 'identifier_type',
      spec: 'https://www.unicode.org/reports/tr31/',
      normalization: 'NFC',
      start: 'XID',
      continue: 'XID',
      continueAdd: '-',
    } satisfies IdentifierType);
  });

  it('resolves boolean as !enum [true false]: the completion of the incomplete entry enum, built by meta.enum_type (§5.5)', () => {
    const boolean = entryOf(schema, 'boolean');
    expect(entryClass(boolean)).toBe('ATOM');
    expect(schema.facts.get('boolean')?.head).toBe('meta.enum_type');
    expect(withoutChain(boolean)).toEqual({
      kind: 'enum',
      nameType: 'meta.identifier',
      members: ['true', 'false'],
    } satisfies EnumBody);
  });

  it('resolves integer as an unconstrained instance of numeric.integer_type', () => {
    const integer = entryOf(schema, 'integer');
    expect(entryClass(integer)).toBe('ATOM');
    expect(schema.facts.get('integer')?.head).toBe('numeric.integer_type');
    expect(withoutChain(integer)).toEqual({ kind: 'integer_type' });
  });

  it('resolves iri as an instance of net.iri_type that withdraws relative references, spec composed in from RFC 3987 (§5.5)', () => {
    const iri = entryOf(schema, 'iri');
    expect(entryClass(iri)).toBe('ATOM');
    expect(schema.facts.get('iri')?.head).toBe('net.iri_type');
    expect(withoutChain(iri)).toEqual({
      kind: 'iri_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc3987',
      allowRelative: false,
      allowFragment: true,
      normalization: 'NONE',
    } satisfies IriType);
  });

  it('declares the two schema-map entries a document tags its root with: `schema` an alias of meta.schema (§2.2, §9)', () => {
    const alias = entryOf(schema, 'schema') as Alias;
    expect(alias.kind).toBe('alias');
    expect(alias.target.name).toBe('meta.schema');
  });

  it('leaves an alias exactly as written: meta.type_name stays a hop to meta.identifier, never a rewrite (§8.3)', () => {
    const typeName = entryOf(schema, 'meta.type_name') as Alias;
    expect(entryClass(typeName)).toBe('ALIAS');
    expect(typeName.target).toEqual({ name: 'meta.identifier', annotations: [] });
  });

  it('holds `set` as an alias of the incomplete entry `meta.set_type`, which leaves `element_type` absent (§5.5, §9)', () => {
    const set = entryOf(schema, 'set') as Alias;
    expect(entryClass(set)).toBe('ALIAS');
    expect(set.target.name).toBe('meta.set_type');
    const setType = entryOf(schema, 'meta.set_type');
    expect(setType.kind === 'incomplete' && setType.head).toBe('meta.array');
    expect(setType.kind === 'incomplete' && setType.absent).toEqual(['element_type']);
  });

  it('refuses a source naming an import: the kernel imports nothing (§3.4)', () => {
    const importing = encodeUtf8(
      '!!id:"https://example.test/k.tn"\n!!import:"https://example.test/o.tn"\n!schema { a => {} }\n',
    );
    expect(() => bootstrapKernel(importing)).toThrow(TsonInternalError);
  });

  it('refuses a source with no !!id (§3.4)', () => {
    expect(() => bootstrapKernel(encodeUtf8('!schema { a => {} }\n'))).toThrow(TsonInternalError);
  });
});
