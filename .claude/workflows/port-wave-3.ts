export const meta = {
  name: 'tson-port-wave-3',
  description:
    'Wave 3 of the TSON port: schema resolution — definitions, template materialisation, flattening and the meta-kernel bootstrap',
  whenToUse:
    'After Wave 2 has all 146 conformance vectors green. Produces the resolver, and is gated on the three bundled schemas resolving to match their checked-in *-resolved.tn fixtures.',
  phases: [
    { title: 'Definitions', detail: 'the definition resolver, which everything else needs' },
    { title: 'Resolve', detail: 'template materialisation and the schema resolver, concurrently' },
    { title: 'Fixtures', detail: 'the three bundled schemas against their resolved fixtures' },
  ],
};

// Wave 3 is the first wave with ordering that is not an artefact of convenience. The definition
// resolver produces the structure the other two consume, so it is a genuine barrier — 14b and 14c
// cannot start on a guess about its output shape. Once it lands, 14b and 14c are independent of
// each other and run together.

const DEFINITION_RESOLVER = `Work package 14a (definition resolver). Produce
packages/tson/src/compiler/definitionResolver.ts and its neighbours.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/resolve/DefinitionResolver.java
and the classes it drives. This is the largest single piece of Part 2 (~1900 TS lines) and the rest
of Wave 3 builds directly on its output, so shape it deliberately.

Read spec/tson-part2-schema.md's resolution chapter in full first. Composition, refinement,
constructor application and the resolution ORDER between them are all normative.

The one structural divergence from the Java, and the reason it is worth stating again here:
§5.6's atom refinement merge must run on the WIRE RECORD before binding. The Java achieves that by
having DefinitionResolver hold a TsonObjectWriter, which is why the writers cannot leave the
compiler module. Do not reproduce that. A Binding here is bidirectional by construction, so
bind/encode.ts exposes toCoreValue(binding, value) and the resolver merges on that — no text round
trip, no writer dependency. eslint's compiler-must-not-import-bind zone enforces the direction; if
it fires, the import is wrong, not the rule.

Diagnostics matter as much as results here. A schema that fails to resolve must say where and why,
against the SchemaLocation model in core/diagnostic.ts. "Resolution failed" is not a diagnostic.`;

const PARALLEL_PACKAGES = [
  {
    key: 'templates',
    brief: `Work package 14b (template materialisation). Produce
packages/tson/src/compiler/templates.ts.

Port the template half of the Java resolver. Templates materialise against arguments; the result
must be structurally identical to what the same declaration written out longhand resolves to, and
the *-resolved.tn fixtures are what proves it.

Materialisation is where recursion lives. A template that references itself, directly or through
another, must terminate with a diagnostic rather than a stack overflow — find the Java's guard and
port its semantics, not its mechanism.

Names generated during materialisation feed canonical identity and therefore content hashes, so
they must be deterministic across runs and independent of iteration order.`,
  },
  {
    key: 'schema-resolver',
    brief: `Work package 14c (schema resolver, flattening, meta-kernel bootstrap). Produce
packages/tson/src/compiler/schemaResolver.ts and packages/tson/src/schema/bootstrap.ts.

Three things:

1. The schema resolver proper — driving 14a over a whole document.
2. Flattening, per the spec's flattening rules.
3. The meta-kernel bootstrap. This is the interesting one: meta-kernel.tn describes the schema
   language in which meta-kernel.tn is written. Read the Java's bootstrap carefully before writing
   anything — the order in which the kernel's own declarations become available to resolve the
   kernel is the whole problem, and getting it subtly wrong produces a kernel that resolves to
   something plausible and wrong.

The checked-in fixtures are the target: spec/m/meta-kernel-resolved.tn (49 declarations),
spec/m/meta-resolved.tn (31), spec/m/core-resolved.tn (48). They are vendored byte for byte from
the reference implementation, digests included, so they apply unchanged.`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    contractSurface: {
      type: 'string',
      description:
        'for 14a: the exported shape later packages consume, so they need not guess at it',
    },
    specFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'issue', 'reading'],
        properties: {
          section: { type: 'string' },
          issue: { type: 'string' },
          reading: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const FIXTURE_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['schemas', 'allMatch'],
  properties: {
    allMatch: { type: 'boolean' },
    schemas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'expectedDeclarations', 'actualDeclarations', 'matchesFixture'],
        properties: {
          name: { enum: ['meta-kernel', 'meta', 'core'] },
          expectedDeclarations: { type: 'number' },
          actualDeclarations: { type: 'number' },
          matchesFixture: { type: 'boolean' },
          differences: {
            type: 'array',
            items: { type: 'string' },
            description: 'concrete differences against the fixture, not a summary',
          },
        },
      },
    },
  },
};

log('Wave 3: definition resolver, then templates and schema resolution together');

// A genuine barrier. 14b and 14c both consume 14a's output shape; starting them on an assumption
// about it would mean rewriting whichever one guessed wrong.
const definitions = await agent(
  `${DEFINITION_RESOLVER}

Read CLAUDE.md and ORCHESTRATION.md first. The contract layer is FROZEN. Waves 1 and 2 are done —
the lexer, parsers, desugarer, bind runtime and schema.meta bindings all exist and are yours to
build on.

In your report, state the exported surface other packages will consume precisely enough that they
do not have to guess at it. Two agents start from it the moment you finish.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance — and no conformance vector that was green may go red.`,
  {
    label: 'port:definition-resolver',
    phase: 'Definitions',
    agentType: 'tson-porter',
    schema: PORT_RESULT,
    effort: 'high',
  },
);

if (definitions === null || definitions.status === 'blocked') {
  log('Definition resolver did not land; Wave 3 cannot continue');
  return { wave: 3, definitions, resolved: [], fixtures: null };
}

const resolved = await parallel(
  PARALLEL_PACKAGES.map(
    (pkg) => () =>
      agent(
        `${pkg.brief}

Read CLAUDE.md first. The contract layer is FROZEN.

Work package 14a (the definition resolver) has just landed and is the base you build on. Its
author describes its exported surface as:

${definitions.contractSurface ?? '(not stated — read packages/tson/src/compiler/definitionResolver.ts directly)'}

Read the code rather than trusting that description where the two differ.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance — and no vector that was green may go red.`,
        {
          label: `port:${pkg.key}`,
          phase: 'Resolve',
          agentType: 'tson-porter',
          schema: PORT_RESULT,
        },
      ),
  ),
);

log(`Resolution packages returned: ${String(resolved.filter((r) => r !== null).length)}/2`);

// This wave's gate is not "did the agents finish" but "do the three bundled schemas resolve to
// exactly what the reference implementation resolved them to". Measure it directly.
const fixtures = await agent(
  `Verify Wave 3's gate: the three bundled schemas resolve to match their checked-in fixtures.

For each of spec/m/meta-kernel.tn, spec/m/meta.tn and spec/m/core.tn: resolve it with this
implementation and compare against spec/m/<name>-resolved.tn. Expected declaration counts are 49,
31 and 48 respectively.

The fixtures are vendored byte for byte from the reference implementation, content digests
included. A digest mismatch is a real failure, not a formatting artefact — it means this port
resolved to something structurally different.

Write this as a real test under packages/tson/test/ so it runs from now on, rather than checking
it once by hand.

Report concrete differences where they exist. "Does not match" is not a report; name the
declaration and the field.

Do not edit anything under spec/. Those files are vendored and vendored-spec.test.ts will catch
it if you do.`,
  { label: 'fixtures', phase: 'Fixtures', schema: FIXTURE_RESULT, effort: 'high' },
);

log(
  fixtures?.allMatch === true
    ? 'Wave 3 gate GREEN: all three bundled schemas match their fixtures'
    : 'Wave 3 gate RED: bundled schemas do not match their fixtures',
);

return { wave: 3, definitions, resolved, fixtures };
