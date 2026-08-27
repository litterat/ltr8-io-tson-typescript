import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bootstrapMetaKernel, instanceBody } from '../src/schema/bootstrap.js';
import { TsonInternalError } from '../src/core/errors.js';
import type { EnumBody } from '../src/schema/meta/bodies.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';
import type { UriType } from '../src/schema/meta/atoms-text.js';
import type { Unit } from '../src/schema/meta/algebra.js';
import type { CoreValue } from '../src/ast/value.js';
import type { Reference, TypeDefinition } from '../src/schema/meta/typedef.js';
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

function entryOf(
  schema: { readonly entries: ReadonlyMap<string, TypeDefinition> },
  name: string,
): TypeDefinition {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`bootstrapped meta-kernel has no entry '${name}'`);
  return entry;
}

describe('bootstrapMetaKernel, against the real bundled meta-kernel.tn', () => {
  const schema = bootstrapMetaKernel(loadMetaKernelSource());

  it("carries meta-kernel's own !!id, !!meta (naming itself, §1.5) and bootstrap: true", () => {
    expect(schema.id).toMatch(/meta-kernel\.tn/);
    expect(schema.meta).toBe(schema.id.replace(/\?.*$/, ''));
    expect(schema.imports).toEqual([]);
    expect(schema.bootstrap).toBe(true);
  });

  // 49 authored declarations (bundled-schemas-parse.test.ts's own raw parse count) plus the 8
  // synthetic entries §5.3's sugar forms (`[type_name]`, `[record_field]`, ...) lift --
  // spec/m/meta-kernel-resolved.tn's own root map has exactly 57 entries (parsed with this
  // package's own data parser, not counted by hand -- PORT-PLAN.md's own "49" names the raw
  // declaration count, not the resolved entry count; see this session's own report).
  it('resolves to 57 entries -- 49 authored plus 8 desugar-lifted synthetics', () => {
    expect(schema.entries.size).toBe(57);
  });

  it("attaches no @synthetic marker -- the bootstrap route is deliberately unmarked (see this module's own doc)", () => {
    expect(schema.keyAnnotations.size).toBe(0);
  });

  it('resolves the four remaining base kinds composing directly with top, each kind: PRODUCT', () => {
    for (const name of ['atom', 'product', 'sum', 'data']) {
      const entry = entryOf(schema, name);
      expect(entry.kind).toBe('PRODUCT');
      expect(entry.supertypes).toEqual(['top']);
    }
  });

  it('resolves top itself with no supertypes and an empty record body', () => {
    const top = entryOf(schema, 'top');
    expect(top.kind).toBe('PRODUCT');
    expect(top.supertypes).toEqual([]);
    expect(top.body).toEqual({ kind: 'record', supertypes: [], fields: [], groups: [] });
  });

  it('resolves unit as a constructor composing with atom', () => {
    const unit = entryOf(schema, 'unit');
    expect(unit.kind).toBe('ATOM');
    expect(unit.constructor).toBe(true);
    expect(unit.supertypes).toEqual(['atom', 'top']);
  });

  it.each([
    ['value', 'unit'],
    ['token', 'unit'],
    ['void', 'unit'],
  ])('resolves %s as a bare, empty instance of unit (§5.5)', (name, target) => {
    const entry = entryOf(schema, name);
    expect(entry.kind).toBe('ATOM');
    expect(entry.source).toEqual({ name: target, arguments: [], annotations: [] });
    expect(entry.body).toEqual({ kind: 'unit' } satisfies Unit);
  });

  it('resolves boolean as !enum [true false] -- deferred to the second pass, since enum is declared later in the file', () => {
    const boolean = entryOf(schema, 'boolean');
    expect(boolean.kind).toBe('ATOM');
    expect(boolean.source).toEqual({ name: 'enum', arguments: [], annotations: [] });
    expect(boolean.body).toEqual({ kind: 'enum', members: ['true', 'false'] } satisfies EnumBody);
  });

  it('resolves integer as an unconstrained instance of integer_type', () => {
    const integer = entryOf(schema, 'integer');
    expect(integer.kind).toBe('ATOM');
    expect(integer.source).toEqual({ name: 'integer_type', arguments: [], annotations: [] });
    expect(integer.body).toEqual({ kind: 'integer_type' } satisfies IntegerType);
  });

  it('resolves uri as an instance of uri_type, whose own spec field is REQUIRED_FIXED to RFC 3986 (composed in, not written at the instance)', () => {
    const uri = entryOf(schema, 'uri');
    expect(uri.kind).toBe('ATOM');
    expect(uri.source).toEqual({ name: 'uri_type', arguments: [], annotations: [] });
    expect(uri.body).toEqual({
      kind: 'uri_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc3986',
    } satisfies UriType);
  });

  it('resolves array/set/map/tuple/record/choice/enum themselves as ordinary compositions with product/sum, not instances', () => {
    for (const name of ['array', 'map', 'tuple', 'record']) {
      const entry = entryOf(schema, name);
      expect(entry.kind).toBe('PRODUCT');
      expect(entry.constructor).toBe(true);
      expect(entry.supertypes).toContain('product');
    }
  });

  it("flattens a REFERENCE-kind alias (type_name => token) at every use site inside the array-of-type_name synthetic, keeping the author's own name as @alias (§8.3)", () => {
    // type_name itself: an unflattened, single-hop alias entry.
    const typeName = entryOf(schema, 'type_name');
    expect(typeName.kind).toBe('REFERENCE');
    expect((typeName.body as Reference).target).toEqual({
      name: 'token',
      arguments: [],
      annotations: [],
    });

    // The synthetic array instance meta-kernel's own `[type_name]?` (e.g. record.supertypes)
    // lifts to: its element_type must be flattened past type_name, onto token, carrying @alias.
    const synthetic = [...schema.entries.values()].find(
      (entry) =>
        entry.source?.name === 'array' &&
        'elementType' in entry.body &&
        entry.body.elementType.name === 'token' &&
        entry.body.elementType.annotations.some(
          (a) => a.name === 'alias' && a.value === 'type_name',
        ),
    );
    if (synthetic === undefined) {
      throw new Error('expected a synthetic array-of-type_name entry, flattened onto token');
    }
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

  it('returns undefined for a target none of the nine real constructors names', () => {
    expect(
      instanceBody(instanceOf('operation', { kind: 'empty-brace' }), 'operation'),
    ).toBeUndefined();
  });

  it('rejects a non-empty body for an empty-bodied target', () => {
    const badInstance = instanceOf('unit', { kind: 'array', elements: [] });
    expect(() => instanceBody(badInstance, 'unit')).toThrow(TsonInternalError);
  });

  it('rejects a non-array value for !enum', () => {
    const badInstance = instanceOf('enum', { kind: 'empty-brace' });
    expect(() => instanceBody(badInstance, 'enum')).toThrow(TsonInternalError);
  });
});
