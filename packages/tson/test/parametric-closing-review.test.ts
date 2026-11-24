/**
 * Closing applications of parametric records, held to [TSON-SCHEMA] §5.10, §5.2, §8.2 and §8.3 where an adversarial
 * review found the resolver short of them: the work closing in place does, the depth it may nest to, the applied
 * parent's edge through alias spellings, the regularity and bound rules through an alias head, and the deferred
 * argument checks' identity -- and, found by the same review, how a temporal bound is named in a coherence refusal.
 */
import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { resolveSchema, type SchemaResolverDeps } from '../src/compiler/schemaResolver.js';
import { createParametricMaterialiser } from '../src/compiler/parametricMaterialiser.js';
import { createHeldRecursion } from '../src/compiler/heldRecursion.js';
import { createRestatements } from '../src/compiler/restatements.js';
import { bootstrapKernel } from '../src/schema/bootstrap.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import { createDefinitionValueReader } from '../src/schema/namespaceReader.js';
import { linkSchema } from '../src/link/link.js';
import { META_TN } from '../src/stdlib/schemas.generated.js';
import { standardLibrary } from '../src/stdlib/index.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import { fieldMapOf } from '../src/schema/meta/bodies.js';
import type { Top, TypeExpr } from '../src/schema/meta/typedef.js';
import { supertypesOf } from '../src/schema/meta/typedef.js';
import { load, loadError } from './schema-read-helpers.js';

/** `r0 … r{n}`, each applying the next once per field name in `fields`, ending at `{ v: T }`. */
function chain(n: number, fields: readonly string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const body = fields.map((field) => `${field}: r${String(i + 1)}<T>`).join('  ');
    lines.push(`r${String(i)} => <T> { ${body} }`);
  }
  lines.push(`r${String(n)} => <T> { v: T }`);
  return lines.join('\n');
}

/** The type of `field` on the record `type` writes in place, or on the record body `type` itself. */
function fieldType(type: TypeExpr | Top | undefined, field: string): TypeExpr | undefined {
  const body: Top | undefined =
    type !== undefined && 'kind' in type && type.kind === 'inline'
      ? type.of
      : (type as Top | undefined);
  if (body?.kind !== 'record') return undefined;
  return body.fields.entries.get(field)?.type;
}

/** How many records closed in place `type` nests, following field `field` down. */
function depth(type: TypeExpr | Top | undefined, field: string): number {
  let count = 0;
  for (let at = fieldType(type, field); at?.kind === 'inline'; at = fieldType(at, field)) count++;
  return count;
}

describe('§5.10 closing in place is a pure function of the application', () => {
  it('a record applying the next one twice per level closes 40 levels deep, each level closed once', () => {
    // The parametric records as the resolver leaves them, closed here by the materialiser alone: the work a closing
    // does is counted as the lookups of each head, which doubles per level where every closing starts afresh.
    const records = load(chain(40, ['a', 'b'])).entries;
    const asked = new Map<string, number>();
    const namespace = (name: string): Top | undefined => {
      asked.set(name, (asked.get(name) ?? 0) + 1);
      return records.get(name);
    };
    const materialiser = createParametricMaterialiser({
      namespace,
      facts: new Map(),
      applications: new Map(),
      heldRecursion: createHeldRecursion(namespace, () => false),
      resolving: () => undefined,
      restatements: createRestatements(new Map()),
      placeholder: () => ({
        kind: 'record',
        fields: fieldMapOf([]),
        groups: [],
        extension: 'OPEN',
      }),
      maxNestingDepth: 64,
    });
    const closed = materialiser.closedInPlace({
      kind: 'inline',
      head: 'meta.apply',
      of: {
        kind: 'apply',
        head: { name: 'r0', annotations: [] },
        arguments: [{ name: 'text', annotations: [] }],
      },
    });
    // Every level is closed in place, both fields alike, to the leaf.
    expect(depth(closed, 'a')).toBe(40);
    expect(depth(closed, 'b')).toBe(40);
    expect(fieldType(closed, 'a')).toEqual(fieldType(closed, 'b'));
    // The deepest head is reached from each of its two holders, a bounded number of times -- never 2^40.
    expect(asked.get('r40') ?? 0).toBeGreaterThan(0);
    expect(asked.get('r40') ?? 0).toBeLessThan(16);
  }, 30_000);

  it('a doubled chain closed through the front door gives the same record at every level', () => {
    const linked = load(`${chain(10, ['a', 'b'])}\nx => r0<text>`);
    const x = linked.entries.get('x');
    expect(depth(x, 'a')).toBe(10);
    expect(depth(x, 'b')).toBe(10);
    expect(fieldType(x, 'a')).toEqual(fieldType(x, 'b'));
  });

  it('a closing reused for a second spelling still records the application as that spelling writes it', () => {
    const linked = load('box => <T> { v: T }\nt => text\nholder => { a: box<text>  b: box<t> }');
    const holder = linked.entries.get('holder');
    const a = fieldType(holder, 'a');
    const b = fieldType(holder, 'b');
    expect(a).toEqual({ ...b, application: a?.kind === 'inline' ? a.application : undefined });
    expect(a?.kind === 'inline' && a.application?.arguments[0]?.name).toBe('text');
    // One closed record, each slot keeping the application as it was written there.
    expect(b?.kind === 'inline' && b.application?.arguments[0]?.name).toBe('t');
  });

  it('a reused closing keeps every verdict: a recursion with no declaration closing it is refused at each holder', () => {
    // `node<text>` closes in place twice per holder; the recursion inside it has nothing to tie to (§5.10.1).
    const message = loadError(
      'node => <T> { v: T  next?: node<T> }\nh1 => { a: node<text>  b: node<text> }',
    );
    expect(message).toMatch(/where no declaration is closing it/);
  });

  it('a reused closing keeps every verdict: an argument outside a bound along a doubled chain is refused', () => {
    const bounded = chain(12, ['a', 'b'])
      .replaceAll('<T>', '<T: text>')
      .replaceAll(/(r\d+)<T: text>/g, '$1<T>');
    expect(loadError(`${bounded}\nx => r0<text>`)).toBeUndefined();
    expect(loadError(`${bounded}\nx => r0<int32>`)).toMatch(/not a type that IS-A text/);
  }, 30_000);

  it('a doubled chain closed by a declaration ties its recursion to the declaration at every level', () => {
    const linked = load(
      'tree => <T> { v: T  l?: pair<T>  r?: pair<T> }\npair => <T> { x: tree<T>  y: tree<T> }\n' +
        'tree_text => tree<text>',
    );
    const pair = fieldType(linked.entries.get('tree_text'), 'l');
    expect(fieldType(pair, 'x')).toEqual({ name: 'tree_text', annotations: [] });
    expect(fieldType(pair, 'y')).toEqual({ name: 'tree_text', annotations: [] });
  });
});

// ── §5.2's nesting-depth limit on types written in place ──────────────────────────────────────

const KERNEL_URI = 'https://tson.io/2026/40/m/meta.tn';
const kernel = linkSchema(bootstrapKernel(encodeUtf8(META_TN)));

function resolverDeps(maxNestingDepth?: number): SchemaResolverDeps {
  return {
    readers: (lookup) => ({
      meta: createDefinitionMetaReader(lookup),
      value: createDefinitionValueReader(lookup),
    }),
    resolveImport: () => ({
      entries: kernel.entries,
      facts: kernel.facts,
      keyAnnotations: kernel.keyAnnotations,
      originOf: (entry) => kernel.origins.get(entry) ?? kernel.id,
      enumForms: kernel.enumForms,
      nameTypes: kernel.nameTypes,
    }),
    ...(maxNestingDepth === undefined ? {} : { maxNestingDepth }),
  };
}

function resolveCollecting(declarations: string, maxNestingDepth?: number) {
  const document = runSync(
    parseSchemaDocument(
      fromString(
        `!!id:"https://example.test/deep.tn" !!import:"${KERNEL_URI}"\n!schema {\n${declarations}\n}`,
      ),
    ),
  );
  const receiver = collector();
  const schema = resolveSchema(document, resolverDeps(maxNestingDepth), { receiver });
  return { schema, diagnostics: receiver.diagnostics };
}

describe('§5.2 a nesting-depth limit on types written in place bounds closing in place', () => {
  it('a 3000-deep chain of applications is a positioned resolver error at the declaration, never a host stack overflow', () => {
    const { diagnostics } = resolveCollecting(`${chain(3000, ['a'])}\nx => r0<text>`);
    expect(diagnostics).toHaveLength(1);
    const [only] = diagnostics;
    expect(only?.code).toBe('SCHEMA_ERROR');
    expect(only?.schemaPointer).toBe('/x');
    expect(only?.schemaPosition?.line).toBe(3004);
    expect(only?.message).toMatch(/more than 64 deep, past the configured nesting-depth limit/);
  }, 60_000);

  it('through the front door the same chain is refused as a schema validation error', () => {
    expect(() =>
      standardLibrary().resolveSchema(
        encodeUtf8(
          `!!id:"https://example.test/deep-front.tn"\n!!import:"https://tson.io/2026/40/m/core.tn"\n` +
            `!schema {\n${chain(3000, ['a'])}\nx => r0<text>\n}`,
        ),
      ),
    ).toThrow(TsonSchemaValidationError);
  }, 60_000);

  it('the limit is the configured nesting depth: a chain exactly as deep closes, one more is refused', () => {
    expect(resolveCollecting(`${chain(4, ['a'])}\nx => r0<text>`, 4).diagnostics).toEqual([]);
    const refused = resolveCollecting(`${chain(5, ['a'])}\nx => r0<text>`, 4).diagnostics;
    expect(refused.map((d) => d.schemaPointer)).toEqual(['/x']);
    expect(refused[0]?.message).toMatch(/more than 4 deep/);
  });

  it('a reused closing is held to the limit where it is reused, as a fresh one would be', () => {
    // `r2<T>` closes under `first` two deep and is reused under `deep` below three open closings: five in all.
    const declarations =
      `${chain(3, ['a'])}\n` +
      'w => <T> { first: r2<T>  deep: w1<T> }\nw1 => <T> { d: w2<T> }\nw2 => <T> { d: r1<T> }\n' +
      'x => w<text>';
    const refused = resolveCollecting(declarations, 4).diagnostics;
    expect(refused.map((d) => d.schemaPointer)).toEqual(['/x']);
    expect(resolveCollecting(declarations, 5).diagnostics).toEqual([]);
  });
});

// ── §8.2: an applied parent's edge, every argument's alias chain followed ──────────────────────

describe('§8.2 an applied parent reaches the declaration naming its application in any spelling', () => {
  it('an argument written through an alias reaches the edge the plain spelling does', () => {
    const linked = load(
      'pet => { name: text }\npet_of => <T> pet & { pet: T }\ndog_type => { bark: text }\n' +
        'dog_alias => dog_type\ndog_pet => pet_of<dog_type>\n' +
        'dog => pet_of<dog_alias> & { k: text }\ndog2 => pet_of<dog_type> & { k: text }',
    );
    expect(supertypesOf(linked.entries.get('dog2'))).toEqual(['dog_pet', 'pet']);
    expect([...supertypesOf(linked.entries.get('dog'))].sort()).toEqual(['dog_pet', 'pet']);
  });

  it('an imported declaration naming the application through an alias head is the same application', async () => {
    const base = `!!id:"https://example.test/pets.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  pet      => { name: text }
  pet_of   => <T> pet & { pet: T }
  pet_box  => pet_of
  dog_type => { bark: text }
  dog_pet  => pet_box<dog_type>
}`;
    const tson = standardLibrary({
      schemaSource: mapSchemaSource({ 'https://example.test/pets.tn': encodeUtf8(base) }),
    });
    const linked = await tson.loadSchema(`!!id:"https://example.test/kennel.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!!import:"https://example.test/pets.tn"
!schema {
  dog => pet_of<dog_type> & { k: text }
}`);
    expect([...supertypesOf(linked.entries.get('dog'))].sort()).toEqual(['dog_pet', 'pet']);
  });
});

// ── §8.3, §5.10: an alias of a parametric record is applied as it is ──────────────────────────

describe('§5.10.1 regularity and §5.10 passed-on bounds follow an alias head to its parametric record', () => {
  it('a recursion through an alias that permutes the parameters is refused, as the direct spelling is', () => {
    expect(loadError('swap => <A, B> { x?: swap<B, A> }')).toMatch(/does not pass 'A' through/);
    expect(loadError('swap => <A, B> { x?: sw<B, A> }\nsw => swap')).toMatch(
      /does not pass 'A' through/,
    );
  });

  it('a recursion through an alias that passes its parameters through unchanged is admitted', () => {
    expect(loadError('list => <T> { v: T  next?: ls<T> }\nls => list')).toBeUndefined();
  });

  it('a parameter passed to a bounded parameter through an alias head needs the bound, as the direct spelling does', () => {
    expect(loadError('boxed => <T: text> { v: T }\nrebox => <T> { b: boxed<T> }')).toMatch(
      /is written with no bound/,
    );
    expect(
      loadError('boxed => <T: text> { v: T }\nbx => boxed\nrebox => <T> { b: bx<T> }'),
    ).toMatch(/is written with no bound/);
    expect(
      loadError('boxed => <T: text> { v: T }\nbx => boxed\nrebox => <T: text> { b: bx<T> }'),
    ).toBeUndefined();
  });
});

// ── §5.10's deferred argument checks ──────────────────────────────────────────────────────────

describe('§5.10 a deferred argument check is one per argument identity', () => {
  it('a parameter and an entry spelled alike are two arguments, each checked', () => {
    const bounded: RecordBody = {
      kind: 'record',
      fields: fieldMapOf([]),
      groups: [],
      extension: 'OPEN',
      parameters: [{ name: 'T', bound: { name: 'int32', annotations: [] } }],
    } as unknown as RecordBody;
    const plain: Top = { kind: 'record', fields: fieldMapOf([]), groups: [], extension: 'OPEN' };
    const entries = new Map<string, Top>([
      ['boxed', bounded],
      ['T', plain],
      ['int32', plain],
    ]);
    const namespace = (name: string): Top | undefined => entries.get(name);
    const materialiser = createParametricMaterialiser({
      namespace,
      facts: new Map(),
      applications: new Map(),
      heldRecursion: createHeldRecursion(namespace, () => false),
      resolving: () => 'holder',
      restatements: createRestatements(new Map()),
      placeholder: () => plain,
      maxNestingDepth: 64,
    });
    materialiser.checkArguments('boxed', bounded, [{ name: 'T', annotations: [], param: true }]);
    materialiser.checkArguments('boxed', bounded, [{ name: 'T', annotations: [] }]);
    const reported: string[] = [];
    materialiser.checkDeferred((declaration, error) => {
      reported.push(`${declaration}: ${error.message}`);
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^holder: 'boxed<\.\.\.>' binds 'T' to 'T'/);
  });
});

// ── §5.5's coherence of two bounds meeting at one value ───────────────────────────────────────

describe('§5.5 two temporal bounds meeting at one value an exclusive end removes', () => {
  it('names the value they meet at, never a host object’s rendering', () => {
    const message = loadError(
      'tw => !time ^ { exclusive_min: "23:00:00Z"  max: "01:00:00+02:00" }',
    );
    expect(message).toMatch(/exclusive_min and max meet at /);
    expect(message).not.toContain('[object Object]');
    expect(message).toContain('"hour":23');
  });
});
