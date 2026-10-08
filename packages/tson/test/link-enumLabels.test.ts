import { describe, expect, it } from 'vitest';
import { discriminationClassOf } from '../src/link/disjointness.js';
import { linkSchema } from '../src/link/link.js';
import type { ImportedSchema, Schema } from '../src/compiler/schemaResolver.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

// [TSON-SCHEMA] §7.4: an enum's `type` names a text family, each member is a value of it, and no
// two members are one value under its equality. A pinned `type` resolves in the governing meta; an
// author-written one in the schema's own namespace. §5.4: an enum's class is read from its `type`.

const HEAD = `
!!id:"https://example.test/enum-labels.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
`;

const HEADER_NAME = `
  header_name => !identifier_type { start: NONE  continue: NONE
    start_add: "abcdefghijklmnopqrstuvwxyz"  continue_add: "abcdefghijklmnopqrstuvwxyz0123456789-"
    normalization: NFKC_CASEFOLD }
`;

function schema(body: string) {
  return resolveUserSchema(`${HEAD}{\n${body}\n}`);
}

function loadFailure(body: string): string {
  try {
    schema(body);
  } catch (error) {
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    return (error as Error).message;
  }
  return expect.unreachable('expected the schema to fail to load');
}

describe('an enum’s class and form are read from its type (§7.4, §5.4)', () => {
  it('`!enum` is an enum of names, matched in the kernel identifier’s form (NFC): not a text enum', () => {
    const linked = schema('status => !enum [OPEN DONE]');
    expect(linked.textEnums.has('status')).toBe(false);
    expect(linked.enumForms.get('status')).toBe('NFC');
  });

  it('`!text_enum` is a text enum, string-class whatever its members spell', () => {
    const linked = schema('ports => !text_enum ["80" "443"]');
    expect(linked.textEnums.has('ports')).toBe(true);
    expect(discriminationClassOf('ports', linked.entries, linked.textEnums)).toBe('STRING');
  });

  it('an enum over a folding identifier family records that family’s form', () => {
    const linked = schema(
      `${HEADER_NAME}\n  safe_header => !enum_type { type: header_name  members: [Accept content-type] }`,
    );
    expect(linked.enumForms.get('safe_header')).toBe('NFKC_CASEFOLD');
    expect(linked.textEnums.has('safe_header')).toBe(false);
  });

  it('an enum over a text family keeps the family’s form but is a text enum', () => {
    const linked = schema(
      `charset => !text_type { normalization: NFKC_CASEFOLD }\n  names => !enum_type { type: charset  members: [UTF-8 ascii] }`,
    );
    expect(linked.enumForms.get('names')).toBe('NFKC_CASEFOLD');
    expect(linked.textEnums.has('names')).toBe(true);
  });

  it('a pinned type resolves in the governing meta, so a schema’s own `identifier` does not retype `!enum`', () => {
    const linked = schema(
      `identifier => !identifier_type { start: NONE  continue: NONE  start_add: "z"  continue_add: "z"  normalization: NFKC_CASEFOLD }\n  status => !enum [OPEN DONE]`,
    );
    expect(linked.enumForms.get('status')).toBe('NFC');
    expect(linked.textEnums.has('status')).toBe(false);
  });

  it('an author-written type resolves in the schema’s own namespace', () => {
    const linked = schema(
      `${HEADER_NAME}\n  safe_header => !enum_type { type: header_name  members: [accept] }`,
    );
    expect(linked.enumForms.get('safe_header')).toBe('NFKC_CASEFOLD');
  });

  it('carries an imported enum’s class and form to the importer', () => {
    const imported: ImportedSchema = {
      entries: new Map([
        [
          'ports',
          {
            supertypes: [],
            subtypes: [],
            annotations: [],
            body: { kind: 'enum' as const, type: 'text', members: ['80'] },
          },
        ],
      ]),
      originOf: () => 'https://example.test/imported.tn',
      textEnums: new Set(['ports']),
      enumForms: new Map([['ports', 'NFKC_CASEFOLD' as const]]),
    };
    const importer: Schema = {
      id: 'https://example.test/importer.tn',
      meta: 'https://tson.io/2026/37/m/meta.tn',
      imports: ['https://example.test/imported.tn'],
      entries: new Map(),
      keyAnnotations: new Map(),
      bootstrap: false,
    };
    const linked = linkSchema(importer, { resolveImport: () => imported });
    expect(linked.textEnums.has('ports')).toBe(true);
    expect(linked.enumForms.get('ports')).toBe('NFKC_CASEFOLD');
  });
});

describe('what an enum’s type obliges (§7.4)', () => {
  it('refuses a type that is not a text family', () => {
    expect(loadFailure('ports => !enum_type { type: integer  members: ["80" "443"] }')).toContain(
      'is not a text family',
    );
  });

  it('refuses a type that names nothing in scope', () => {
    expect(loadFailure('ports => !enum_type { type: nowhere  members: [a b] }')).toMatch(
      /nowhere|nothing in scope/,
    );
  });

  it('refuses two members that are one value under the type’s equality', () => {
    const message = loadFailure(
      `${HEADER_NAME}\n  safe_header => !enum_type { type: header_name  members: [Accept accept] }`,
    );
    expect(message).toContain('are one value');
  });

  it('refuses a member that is not a value of its type', () => {
    const message = loadFailure(
      `${HEADER_NAME}\n  safe_header => !enum_type { type: header_name  members: [9lives] }`,
    );
    expect(message).toContain("member '9lives' is not a value of its type 'header_name'");
  });

  it('reports every enum through a receiver rather than stopping at the first', () => {
    const diagnostics = collector();
    const linked = schema('ok => !enum [A]');
    const bad: Schema = {
      id: 'https://example.test/bad.tn',
      meta: linked.meta,
      imports: [],
      entries: new Map([
        [
          'one',
          {
            supertypes: [],
            subtypes: [],
            annotations: [],
            body: { kind: 'enum', type: 'integer', members: ['1'] },
          },
        ],
        [
          'two',
          {
            supertypes: [],
            subtypes: [],
            annotations: [],
            body: { kind: 'enum', type: 'nowhere', members: ['1'] },
          },
        ],
      ]),
      keyAnnotations: new Map(),
      bootstrap: false,
    };
    linkSchema(bad, { receiver: diagnostics });
    expect(
      diagnostics.diagnostics.filter((d) => d.code === 'SCHEMA_ERROR').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
