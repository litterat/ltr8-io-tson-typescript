import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bootstrapMetaKernel, instanceBody } from '../src/schema/bootstrap.js';
import { TsonInternalError } from '../src/core/errors.js';
import type { EnumBody } from '../src/schema/meta/bodies.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';
import type { IdentifierType, IriType } from '../src/schema/meta/atoms-text.js';
import type { ValueType, VoidType } from '../src/schema/meta/algebra.js';
import type { CoreValue } from '../src/ast/value.js';
import type { ArrayBody } from '../src/schema/meta/bodies.js';
import type { Reference, Top } from '../src/schema/meta/typedef.js';
import {
  entryKind,
  isConstructor,
  isTemplateBody,
  supertypesOf,
  withoutChain,
} from '../src/schema/meta/typedef.js';
import { fieldMapOf } from '../src/schema/meta/bodies.js';
import type { Instance } from '../src/ast/schema/fields.js';

/**
 * The real, bundled meta-kernel source (§CLAUDE.md: "the three bundled schemas are loaded at
 * runtime, and every citation refers to the spec text, so both have to be readable without
 * network access") -- the same file `bundled-schemas-parse.test.ts` reads, and the target
 * `PORT-PLAN.md`'s Wave 3 gate is measured against.
 */
function loadMetaKernelSource(): Uint8Array {
  const path = fileURLToPath(new URL('../../../spec/m/meta-kernel.tn', import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function entryOf(schema: { readonly entries: ReadonlyMap<string, Top> }, name: string): Top {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`bootstrapped meta-kernel has no entry '${name}'`);
  return entry;
}

/** {@link entryKind} of `name`'s value, read off its chain (§4.1). */
function kindOf(schema: { readonly entries: ReadonlyMap<string, Top> }, name: string) {
  return entryKind(entryOf(schema, name));
}

describe('bootstrapMetaKernel, against the real bundled meta-kernel.tn', () => {
  const schema = bootstrapMetaKernel(loadMetaKernelSource());

  it("carries meta-kernel's own !!id, !!meta (naming itself, §1.5) and bootstrap: true", () => {
    expect(schema.id).toMatch(/meta-kernel\.tn/);
    expect(schema.meta).toBe(schema.id.replace(/\?.*$/, ''));
    expect(schema.imports).toEqual([]);
    expect(schema.bootstrap).toBe(true);
  });

  // meta-kernel's declaration count moves with every spec revision that adds or removes a
  // kernel-level type, so the resolved total is checked against the fixture: the 68
  // declarations the kernel writes plus the nine synthetics its container sugar lifts
  // (`meta-kernel-resolved.tn` lists exactly those nine).
  it('resolves to exactly as many entries as the bundled meta-kernel.tn declares plus its desugar-lifted synthetics', () => {
    expect(schema.entries.size).toBe(77);
  });

  it("attaches no @synthetic marker -- the bootstrap route is deliberately unmarked (see this module's own doc)", () => {
    expect(schema.keyAnnotations.size).toBe(0);
  });

  it('resolves the three base kinds through type, each abstract and itself kind PRODUCT (§4.1)', () => {
    for (const name of ['atom', 'product', 'sum']) {
      const entry = entryOf(schema, name);
      expect(kindOf(schema, name)).toBe('PRODUCT');
      expect(supertypesOf(entry)).toEqual(['top', 'type']);
      expect((entry as { readonly extension?: string }).extension).toBe('ABSTRACT');
    }
  });

  it('resolves type and namespace composing directly with top, each abstract (§4.1)', () => {
    for (const name of ['type', 'namespace']) {
      const entry = entryOf(schema, name);
      expect(supertypesOf(entry)).toEqual(['top']);
      expect((entry as { readonly extension?: string }).extension).toBe('ABSTRACT');
    }
  });

  it('resolves top itself with an empty chain and an empty, abstract record body', () => {
    const top = entryOf(schema, 'top');
    expect(kindOf(schema, 'top')).toBe('PRODUCT');
    expect(supertypesOf(top)).toEqual([]);
    expect(withoutChain(top)).toEqual({
      kind: 'record',
      fields: fieldMapOf([]),
      groups: [],
      extension: 'ABSTRACT',
    });
  });

  it.each([
    ['value_type', 'value'],
    ['void_type', 'void'],
  ])('resolves %s as a constructor composing with atom, with no vocabulary (§4.2)', (name) => {
    const constructor = entryOf(schema, name);
    expect(kindOf(schema, name)).toBe('ATOM');
    expect(isConstructor(constructor)).toBe(true);
    expect(supertypesOf(constructor)).toEqual(['atom', 'top', 'type']);
  });

  it('declares no unit: value and void are told apart by constructor, never by name (§4.2)', () => {
    expect(schema.entries.has('unit')).toBe(false);
  });

  it.each([
    ['value', 'value_type', { kind: 'value_type' } satisfies ValueType],
    ['void', 'void_type', { kind: 'void_type' } satisfies VoidType],
  ])('resolves %s as a bare, empty instance of %s (§5.5)', (name, target, body) => {
    const entry = entryOf(schema, name);
    expect(kindOf(schema, name)).toBe('ATOM');
    expect(schema.facts.get(name)?.head).toBe(target);
    expect(withoutChain(entry)).toEqual(body);
  });

  it('resolves identifier as the identifier_type instance { continue_add: "-" }, the profile of [TSON-DATA] §7.7 (§5.5)', () => {
    const entry = entryOf(schema, 'identifier');
    expect(kindOf(schema, 'identifier')).toBe('ATOM');
    expect(schema.facts.get('identifier')?.head).toBe('identifier_type');
    expect(withoutChain(entry)).toEqual({
      kind: 'identifier_type',
      spec: 'https://www.unicode.org/reports/tr31/',
      normalization: 'NFC',
      start: 'XID',
      continue: 'XID',
      continueAdd: '-',
    } satisfies IdentifierType);
  });

  it('resolves scheme_name as the second identifier_type instance, an ASCII_CASEFOLD profile over the ASCII base', () => {
    expect(entryOf(schema, 'scheme_name')).toMatchObject({
      kind: 'identifier_type',
      normalization: 'ASCII_CASEFOLD',
      start: 'ASCII',
      continue: 'ASCII',
      continueAdd: '+-.',
      exclude: '_',
    });
  });

  it('resolves boolean as !enum [true false] -- deferred to the second pass, since enum is declared later in the file', () => {
    const boolean = entryOf(schema, 'boolean');
    expect(kindOf(schema, 'boolean')).toBe('ATOM');
    expect(schema.facts.get('boolean')?.head).toBe('enum');
    expect(withoutChain(boolean)).toEqual({
      kind: 'enum',
      nameType: 'identifier',
      members: ['true', 'false'],
    } satisfies EnumBody);
  });

  it('resolves integer as an unconstrained instance of integer_type', () => {
    const integer = entryOf(schema, 'integer');
    expect(kindOf(schema, 'integer')).toBe('ATOM');
    expect(schema.facts.get('integer')?.head).toBe('integer_type');
    expect(withoutChain(integer)).toEqual({ kind: 'integer_type' } satisfies IntegerType);
  });

  it('resolves iri as an instance of iri_type that withdraws relative references, spec composed in from RFC 3987 (§5.5)', () => {
    const iri = entryOf(schema, 'iri');
    expect(kindOf(schema, 'iri')).toBe('ATOM');
    expect(schema.facts.get('iri')?.head).toBe('iri_type');
    expect(withoutChain(iri)).toEqual({
      kind: 'iri_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc3987',
      allowRelative: false,
      allowFragment: true,
      normalization: 'NONE',
    } satisfies IriType);
  });

  it('declares no uri: uri_type and uri belong to meta, which cannot construct what it declares (§3.3.1)', () => {
    expect(schema.entries.has('uri')).toBe(false);
    expect(schema.entries.has('uri_type')).toBe(false);
  });

  it('resolves array/set/map/tuple/record/choice/enum themselves as ordinary compositions with product/sum, not instances', () => {
    for (const name of ['array', 'map', 'tuple', 'record']) {
      const entry = entryOf(schema, name);
      expect(kindOf(schema, name)).toBe('PRODUCT');
      expect(isConstructor(entry)).toBe(true);
      expect(supertypesOf(entry)).toContain('product');
    }
  });

  it('leaves a REFERENCE-kind alias (type_name => identifier) exactly as written, at its own declaration and at every use site inside the array-of-type_name synthetic (§8.3)', () => {
    // type_name itself: a single-hop alias entry.
    const typeName = entryOf(schema, 'type_name');
    expect(kindOf(schema, 'type_name')).toBe('REFERENCE');
    expect((typeName as Reference).target).toEqual({
      name: 'identifier',
      arguments: [],
      annotations: [],
    });

    // A reference is a hop, not a rewrite: the synthetic array instance meta-kernel's own
    // `[type_name]?` (e.g. type_chain.supertypes) lifts to still names `type_name`, the entry the
    // author wrote -- nothing rewrites it onto `identifier`, and no `@alias` annotation appears
    // anywhere to say it did.
    const synthetic = [...schema.entries].find(
      ([name, entry]) =>
        schema.facts.get(name)?.head === 'array' &&
        !isTemplateBody(entry) &&
        entry.kind === 'array' &&
        entry.elementType.name === 'type_name',
    )?.[1];
    if (synthetic === undefined) {
      throw new Error('expected a synthetic array-of-type_name entry, naming type_name as written');
    }
    expect((synthetic as ArrayBody).elementType.annotations).toEqual([]);
  });
});

describe("instanceBody -- meta-kernel's own hand-written constructor switch", () => {
  function instanceOf(target: string, value: CoreValue): Instance {
    return {
      kind: 'instance',
      typeParams: [],
      value: { annotations: [], typeRef: target, coreValue: value },
    };
  }

  it("returns undefined for a target none of the kernel's real constructors names", () => {
    expect(
      instanceBody(instanceOf('operation', { kind: 'empty-brace' }), 'operation'),
    ).toBeUndefined();
  });

  it('rejects a non-empty body for an empty-bodied target', () => {
    const badInstance = instanceOf('void_type', { kind: 'array', elements: [] });
    expect(() => instanceBody(badInstance, 'void_type')).toThrow(TsonInternalError);
  });

  it('rejects an identifier_type instance that states a profile other than the one this implementation holds', () => {
    const badInstance = instanceOf('identifier_type', { kind: 'empty-brace' });
    expect(() => instanceBody(badInstance, 'identifier_type', 'identifier')).toThrow(
      TsonInternalError,
    );
  });

  it('rejects a non-array value for !enum', () => {
    const badInstance = instanceOf('enum', { kind: 'empty-brace' });
    expect(() => instanceBody(badInstance, 'enum')).toThrow(TsonInternalError);
  });
});
