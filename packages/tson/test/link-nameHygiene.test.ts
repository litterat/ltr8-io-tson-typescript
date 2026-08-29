import { describe, expect, it } from 'vitest';

import { linkSchema } from '../src/link/link.js';
import type { ImportedSchema, Schema } from '../src/compiler/schemaResolver.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonNameHygieneRefusedError, TsonSchemaValidationError } from '../src/core/errors.js';
import {
  DEFAULT_NAME_POLICY,
  perSegment,
  withSkeletonDistinctness,
} from '../src/unicode/policy.js';
import { UTS39_VERSION } from '../src/unicode/uts39.js';
import type { Top } from '../src/schema/meta/typedef.js';
import type { RecordField } from '../src/schema/meta/bodies.js';
import type { TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

/**
 * `link/nameHygiene.ts`'s implementation of [TSON-SCHEMA] §11.4's schema-layer name-hygiene
 * scopes, checked at link time. Mirrors the reference implementation's
 * `ConfusableNameScopesTest` (`tson-compiler/.../ConfusableNameScopesTest.java`) case for case,
 * building `schema.meta` values directly the same way `link-link.test.ts` does rather than going
 * through the compiler (which is out of this module's scope).
 *
 * **Every confusable pair here is built from code points**, never typed literally -- the two
 * spellings are indistinguishable in an editor, so a literal would make the test unreviewable
 * and one careless paste away from asserting nothing (the Java original's own stated reason).
 */

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

/** Cyrillic а (U+0430) -- the character §9.4 opens with. */
const CYR_A = cp(0x0430);
/** Cyrillic А (U+0410), the capital. */
const CYR_CAP_A = cp(0x0410);
/**
 * `aec`'s whole-Cyrillic look-alike (а U+0430, е U+0435, с U+0441) -- unlike `CYR_A + 'dmin'`,
 * every character here shares one script, so mechanism 3 (§8.2's restriction level) is silent on
 * either spelling by itself and only mechanism 1 (skeleton distinctness) tells the pair apart.
 * `nameHygieneRefusal`'s own per-scope ordering (`unicode/policy.ts`) runs the per-name
 * mechanisms first and skeleton distinctness last, so a genuinely mixed-script pair like
 * `CYR_A + 'dmin'` gets refused by mechanism 3 before mechanism 1 ever sees it -- this pair is
 * what isolates mechanism 1 for a test that wants to assert its own message/mechanism.
 */
const AEC_CYRILLIC = cp(0x0430, 0x0435, 0x0441);

function ref(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function def(
  body: Top,
  options: { readonly supertypes?: readonly string[]; readonly subtypes?: readonly string[] } = {},
): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes: options.supertypes ?? [],
    subtypes: options.subtypes ?? [],
    body,
    annotations: [],
  };
}

const RECORD: Top = { kind: 'record', supertypes: [], fields: [], groups: [] };

function field(name: string, type: TypeRef): RecordField {
  return { name, type, state: 'REQUIRED', annotations: [] };
}

function record(fields: readonly RecordField[]): Top {
  return { kind: 'record', supertypes: [], fields, groups: [] };
}

function enumOf(members: readonly string[]): Top {
  return { kind: 'enum', members };
}

function choiceOf(variants: readonly TypeRef[]): Top {
  return { kind: 'choice', variants };
}

function schema(
  id: string,
  entries: Iterable<readonly [string, TypeDefinition]>,
  imports: readonly string[] = [],
): Schema {
  return {
    id,
    meta: 'https://tson.io/2026/34/m/meta-kernel.tn',
    imports,
    entries: new Map(entries),
    keyAnnotations: new Map(),
    bootstrap: false,
  };
}

function refusalOf(run: () => void): TsonNameHygieneRefusedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TsonNameHygieneRefusedError);
    return error as TsonNameHygieneRefusedError;
  }
  return expect.unreachable('expected a name-hygiene refusal');
}

describe('checkNameHygiene: the declared names of one schema', () => {
  it('refuses two declared names that read alike', () => {
    const s = schema('https://x/s.tn', [
      ['aec', def(RECORD)],
      [AEC_CYRILLIC, def(RECORD)],
    ]);
    const refused = refusalOf(() => linkSchema(s));
    expect(refused.mechanism).toBe('skeleton-distinctness');
    expect(refused.message).toContain('namespace');
    expect(refused.message).toContain("confusable with 'aec'");
  });

  it('leaves an ordinary schema of unrelated names unaffected', () => {
    const s = schema('https://x/s.tn', [
      ['order', def(RECORD)],
      ['customer', def(RECORD)],
      ['status', def(enumOf(['OPEN', 'ACTIVE', 'DONE']))],
    ]);
    expect(() => linkSchema(s)).not.toThrow();
  });
});

describe('checkNameHygiene: the field names of one record', () => {
  it('refuses two field names that read alike', () => {
    const s = schema('https://x/s.tn', [
      ['rec', def(record([field('admin', ref('rec')), field(CYR_A + 'dmin', ref('rec'))]))],
    ]);
    const refused = refusalOf(() => linkSchema(s));
    expect(refused.message).toContain('field names');
  });

  it('an outright duplicate field name is not reported as confusable -- the two are different defects', () => {
    // Mechanism 1 never fires on an identical repeated name (`unicode/skeleton.ts`'s own rule);
    // an outright duplicate is a different rule's concern, not this module's, and this scope
    // must stay silent about it rather than misreport it as a confusable pair.
    const s = schema('https://x/s.tn', [
      ['rec', def(record([field('admin', ref('rec')), field('admin', ref('rec'))]))],
    ]);
    expect(() => linkSchema(s)).not.toThrow();
  });
});

describe('checkNameHygiene: the members of one enum', () => {
  it('refuses two enum members that read alike', () => {
    const s = schema('https://x/s.tn', [['st', def(enumOf(['ACTIVE', CYR_CAP_A + 'CTIVE']))]]);
    const refused = refusalOf(() => linkSchema(s));
    expect(refused.message).toContain('enum members');
  });
});

describe('checkNameHygiene: a whole-script pair isolates mechanism 1', () => {
  it('refuses two declared names that no per-name mechanism can tell apart', () => {
    // Both spellings are single-script and every character is Identifier_Status=Allowed, so
    // mechanisms 2 and 3 pass each name alone; only skeleton distinctness relates the pair.
    const s = schema('https://x/whole-script.tn', [
      ['aec', def(enumOf(['A']))],
      [AEC_CYRILLIC, def(enumOf(['B']))],
    ]);
    const refused = refusalOf(() => linkSchema(s));
    expect(refused.mechanism).toBe('skeleton-distinctness');
  });
});

describe('checkNameHygiene: choice variants are not a scope of their own', () => {
  it('catches confusable choice variants as confusable declared names, one level up', () => {
    // `either`'s own variants (`admin` / CYR_A+`dmin`) are never inspected as a scope: the pair
    // is already caught as two confusable *declared* names before `either` is looked at at all.
    const s = schema('https://x/s.tn', [
      ['admin', def(RECORD)],
      [CYR_A + 'dmin', def(RECORD)],
      ['either', def(choiceOf([ref('admin'), ref(CYR_A + 'dmin')]))],
    ]);
    const diagnostics = collector();
    const linked = linkSchema(s, { receiver: diagnostics });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['NAME_HYGIENE_REFUSED']);
    // Reported against the declared name that collided, not against `either`.
    expect(diagnostics.diagnostics[0]?.schemaPointer).toBe(`/${CYR_A}dmin`);
    expect(linked.entries.size).toBe(3);
  });
});

describe('checkNameHygiene: the merged namespace at !!import -- the sharpest scope', () => {
  it('refuses a name reached through !!import that is confusable with a locally-declared one, though each schema is clean alone', () => {
    const base = schema('https://x/base.tn', [['aec', def(RECORD)]]);
    const linkedBase = linkSchema(base); // clean alone: one name, mechanism 1 never fires solo

    // `top`'s own single declared name, checked with no import at all, is equally clean alone --
    // the same schema linked without the import that only matters once the two are merged.
    expect(() =>
      linkSchema(schema('https://x/top.tn', [[AEC_CYRILLIC, def(RECORD)]])),
    ).not.toThrow();

    const importedBase: ImportedSchema = {
      entries: linkedBase.entries,
      originOf: () => linkedBase.id,
    };
    const top = schema('https://x/top.tn', [[AEC_CYRILLIC, def(RECORD)]], ['https://x/base.tn']);
    expect(() => linkSchema(top, { resolveImport: () => importedBase })).not.toThrow(
      TsonSchemaValidationError,
    );
    expect(() => linkSchema(top, { resolveImport: () => importedBase })).toThrow(
      TsonNameHygieneRefusedError,
    );
  });
});

describe('checkNameHygiene: the rule never fires on a lone name', () => {
  it('admits two field names in different scripts that are not confusable with each other, under a per-segment policy', () => {
    // U+043F (Cyrillic п) and U+0430 (Cyrillic а) are distinct letters -- the two field names
    // below have different skeletons, so mechanism 1 stays silent regardless of policy; the
    // per-segment relaxation is what mechanism 3 needs to admit a single non-Latin-script
    // segment inside an otherwise-Latin name (`unicode/policy.ts`'s own `id_пользователя`
    // example).
    const s = schema('https://x/s.tn', [
      [
        'rec',
        def(
          record([field('id_' + cp(0x043f), ref('rec')), field('url_' + cp(0x0430), ref('rec'))]),
        ),
      ],
    ]);
    expect(() => linkSchema(s)).toThrow(TsonNameHygieneRefusedError); // the default whole-name level refuses one of them
    expect(() => linkSchema(s, { namePolicy: perSegment(DEFAULT_NAME_POLICY) })).not.toThrow();
  });
});

describe('checkNameHygiene: the policy is relaxable by the caller, and enforced by default', () => {
  it('relaxing skeleton distinctness admits what the default policy refuses', () => {
    const s = schema('https://x/s.tn', [
      ['aec', def(RECORD)],
      [AEC_CYRILLIC, def(RECORD)],
    ]);
    expect(() => linkSchema(s)).toThrow(TsonNameHygieneRefusedError);
    expect(() =>
      linkSchema(s, { namePolicy: withSkeletonDistinctness(DEFAULT_NAME_POLICY, false) }),
    ).not.toThrow();
  });
});

describe('checkNameHygiene: reporting', () => {
  it('is a fifth outcome -- never a TsonSchemaValidationError -- under fail-fast linking', () => {
    const s = schema('https://x/s.tn', [
      ['admin', def(RECORD)],
      [CYR_A + 'dmin', def(RECORD)],
    ]);
    try {
      linkSchema(s);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonNameHygieneRefusedError);
      expect(error).not.toBeInstanceOf(TsonSchemaValidationError);
    }
  });

  it('reports NAME_HYGIENE_REFUSED through a receiver, naming the UTS #39 version, and linking still completes', () => {
    const s = schema('https://x/s.tn', [
      ['admin', def(RECORD)],
      [CYR_A + 'dmin', def(RECORD)],
    ]);
    const diagnostics = collector();
    const linked = linkSchema(s, { receiver: diagnostics });
    expect(diagnostics.diagnostics.map((d) => d.code)).toEqual(['NAME_HYGIENE_REFUSED']);
    expect(diagnostics.diagnostics[0]?.message).toContain(UTS39_VERSION);
    expect(diagnostics.diagnostics[0]?.schemaId).toBe('https://x/s.tn');
    expect(linked.entries.size).toBe(2);
  });
});
