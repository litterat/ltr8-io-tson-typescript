import { describe, expect, it } from 'vitest';

import { linkSchema } from '../src/link/link.js';
import type { ImportedSchema, Schema } from '../src/compiler/schemaResolver.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { Top, TypeRef } from '../src/schema/meta/typedef.js';
import { entry, fieldMapOf, subtypesIn } from './model-fixtures.js';

function ref(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function def(
  body: Top,
  options: { readonly supertypes?: readonly string[]; readonly subtypes?: readonly string[] } = {},
): Top {
  return entry(body, options.supertypes ?? [], options.subtypes ?? []);
}

const RECORD: Top = {
  kind: 'record',
  fields: fieldMapOf([]),
  groups: [],
  extension: 'OPEN',
};

function schema(
  id: string,
  entries: Iterable<readonly [string, Top]>,
  imports: readonly string[] = [],
): Schema {
  return {
    id,
    meta: 'https://tson.io/2026/38/m/meta-kernel.tn',
    imports,
    entries: new Map(entries),
    keyAnnotations: new Map(),
    facts: new Map(),
    bootstrap: false,
  };
}

describe('linkSchema: a schema with no imports', () => {
  it('links to exactly its own entries, with subtypes populated', () => {
    const s = schema('https://x/s.tn', [
      ['top', def(RECORD)],
      ['widget', def(RECORD, { supertypes: ['top'] })],
    ]);
    const linked = linkSchema(s);
    expect([...linked.entries.keys()].sort()).toEqual(['top', 'widget']);
    expect(subtypesIn(linked.entries.get('top'))).toEqual(['widget']);
    expect(linked.origins.get('top')).toBe('x/s.tn');
    expect(linked.origins.get('widget')).toBe('x/s.tn');
  });

  it('throws asking for a loader when the document declares !!import but none was supplied', () => {
    const s = schema('https://x/s.tn', [], ['https://x/base.tn']);
    expect(() => linkSchema(s)).toThrow(TsonSchemaValidationError);
  });
});

describe('linkSchema: the diamond case (§2.2.3)', () => {
  // base <- (mid_a, mid_b) <- top: `top` imports both mid_a and mid_b, each of which imports
  // base -- so `base` is reached by two routes and must unify rather than conflict.
  function linkedBase(): { entries: ReadonlyMap<string, Top>; id: string } {
    const base = schema('https://x/base.tn', [['base_type', def(RECORD)]]);
    const linked = linkSchema(base);
    return { entries: linked.entries, id: linked.id };
  }

  function importedFrom(linked: { entries: ReadonlyMap<string, Top>; id: string }): ImportedSchema {
    return { entries: linked.entries, originOf: () => linked.id };
  }

  it('unifies a schema reached through two different !!import routes instead of conflicting', () => {
    const base = linkedBase();

    const midA = schema(
      'https://x/mid-a.tn',
      [['widget_a', def(RECORD, { supertypes: ['base_type'] })]],
      ['https://x/base.tn'],
    );
    const linkedMidA = linkSchema(midA, { resolveImport: () => importedFrom(base) });

    const midB = schema(
      'https://x/mid-b.tn',
      [['widget_b', def(RECORD, { supertypes: ['base_type'] })]],
      ['https://x/base.tn'],
    );
    const linkedMidB = linkSchema(midB, { resolveImport: () => importedFrom(base) });

    const top = schema('https://x/top.tn', [], ['https://x/mid-a.tn', 'https://x/mid-b.tn']);
    const linkedTop = linkSchema(top, {
      resolveImport: (uri) =>
        uri.includes('mid-a')
          ? {
              entries: linkedMidA.entries,
              originOf: linkedMidA.origins.get.bind(linkedMidA.origins) as (n: string) => string,
            }
          : {
              entries: linkedMidB.entries,
              originOf: linkedMidB.origins.get.bind(linkedMidB.origins) as (n: string) => string,
            },
    });

    // base_type arrived via two routes and must appear exactly once, with both widgets' subtypes unioned.
    expect([...linkedTop.entries.keys()].sort()).toEqual(['base_type', 'widget_a', 'widget_b']);
    expect([...subtypesIn(linkedTop.entries.get('base_type'))].sort()).toEqual([
      'widget_a',
      'widget_b',
    ]);
  });

  it('rejects two genuinely different schemas declaring the same name', () => {
    const midA = schema('https://x/mid-a.tn', [['clash', def(RECORD)]]);
    const linkedMidA = linkSchema(midA);
    const midB = schema('https://x/mid-b.tn', [['clash', def(RECORD)]]);
    const linkedMidB = linkSchema(midB);

    const top = schema('https://x/top.tn', [], ['https://x/mid-a.tn', 'https://x/mid-b.tn']);
    expect(() =>
      linkSchema(top, {
        resolveImport: (uri) =>
          uri.includes('mid-a')
            ? { entries: linkedMidA.entries, originOf: () => linkedMidA.id }
            : { entries: linkedMidB.entries, originOf: () => linkedMidB.id },
      }),
    ).toThrow(/declared by two different schemas/u);
  });

  it('a repeated !!import of one identity contributes nothing twice', () => {
    const base = linkedBase();
    const top = schema(
      'https://x/top.tn',
      [],
      ['https://x/base.tn', 'https://x/base.tn?sha256=' + 'a'.repeat(64)],
    );
    let calls = 0;
    const linked = linkSchema(top, {
      resolveImport: () => {
        calls++;
        return importedFrom(base);
      },
    });
    expect(calls).toBe(1); // the second (differently-pinned) mention of the same identity is skipped
    expect([...linked.entries.keys()]).toEqual(['base_type']);
  });
});

describe('linkSchema: local-vs-import collision', () => {
  it('drops the local entry and reports/throws when a local name shadows an imported one', () => {
    const base = schema('https://x/base.tn', [['shared', def(RECORD)]]);
    const linkedBase = linkSchema(base);

    const top = schema('https://x/top.tn', [['shared', def(RECORD)]], ['https://x/base.tn']);
    const importedBase: ImportedSchema = {
      entries: linkedBase.entries,
      originOf: () => linkedBase.id,
    };

    expect(() => linkSchema(top, { resolveImport: () => importedBase })).toThrow(
      TsonSchemaValidationError,
    );

    const diagnostics = collector();
    const linked = linkSchema(top, { resolveImport: () => importedBase, receiver: diagnostics });
    expect(diagnostics.diagnostics).toHaveLength(1);
    // the import's own copy survives; the local one was dropped
    expect(linked.entries.get('shared')).toBe(linkedBase.entries.get('shared'));
  });
});

describe('linkSchema: reference validation runs over the whole merged namespace', () => {
  it('throws for an unresolved reference the local schema itself introduces', () => {
    const s = schema('https://x/s.tn', [
      ['widget', def({ kind: 'reference', target: ref('nowhere') })],
    ]);
    expect(() => linkSchema(s)).toThrow(TsonSchemaValidationError);
  });
});
