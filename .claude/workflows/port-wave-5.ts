export const meta = {
  name: 'tson-port-wave-5',
  description:
    'Wave 5 of the TSON port: the schema compiler and the writers, gated on a user schema validating real data three schemas deep',
  whenToUse:
    'After Wave 4. Produces the compiler that turns a resolved schema into a validating reader, and the emit/writer side.',
  phases: [
    { title: 'Build', detail: 'compiler and writers, concurrently' },
    { title: 'Prove', detail: 'a user schema importing core.tn, validating real data end to end' },
  ],
};

// Compiler and writers share nothing: one turns a resolved schema into a validating reader, the
// other turns values back into text. They meet only at the gate.

const PACKAGES = [
  {
    key: 'compiler',
    brief: `Work package 17 (compiler). Produce packages/tson/src/compiler/compile.ts and the
CompiledSchema surface.

Turn a resolved schema into something that validates data efficiently — the reader is built once
per schema, not rebuilt per document. That is the whole point of a compile step, and a "compiler"
that re-walks the schema for every value has not compiled anything.

The zone rule stands and is structural: compiler/ must not import bind/. bind/encode.ts exposes
toCoreValue so the resolver merges on the wire record without reaching for a writer. If the zone
fires, the import is wrong.

Diagnostics are the deliverable as much as the validation is. A document that fails validation
must say which field, at which position, against which type, using the SchemaLocation model in
core/diagnostic.ts. Read spec/tson-part2-schema.md's diagnostics section — the categories are
normative and the conformance suite's sidecars assert on them.`,
  },
  {
    key: 'writers',
    brief: `Work package 18 (emit and writers). Produce packages/tson/src/write/.

Port the writer half of the Java. Streaming emit, with the optional !!id / !!schema header per
§7.1's document header classification.

Round-tripping is the property that matters: parse then write then parse must reach the same value.
Test it against the conformance suite's valid vectors — every one of them is a document this
implementation can already read, which makes them free round-trip cases.

Writing is where canonical form and human-readable form diverge. Be explicit about which one each
entry point produces, because canonical output feeds content hashing and must be byte-stable while
readable output may not be.

The writers live in write/, not in compiler/. In the Java they cannot leave tson-compiler because
DefinitionResolver holds a TsonObjectWriter; that dependency is gone here by construction and this
is where it stays gone.`,
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

const GATE = {
  type: 'object',
  additionalProperties: false,
  required: ['compiles', 'validatesValid', 'rejectsInvalid', 'roundTrips', 'details'],
  properties: {
    compiles: { type: 'boolean', description: 'the user schema compiled, three schemas deep' },
    validatesValid: { type: 'boolean', description: 'conforming data was accepted' },
    rejectsInvalid: {
      type: 'boolean',
      description: 'non-conforming data was rejected with a diagnostic naming field and position',
    },
    roundTrips: { type: 'boolean', description: 'parse -> write -> parse reached the same value' },
    details: { type: 'string', description: 'what was built and what actually happened' },
  },
};

log('Wave 5: compiler and writers');

const results = await parallel(
  PACKAGES.map(
    (pkg) => () =>
      agent(
        `${pkg.brief}

Read CLAUDE.md and ORCHESTRATION.md first. The contract layer is FROZEN. Waves 1 to 4 are done:
lexer, parsers, desugarer, resolver, linking, identity, hashing and the reader stack all work.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance — and no conformance vector that was green may go red.`,
        {
          label: `port:${pkg.key}`,
          phase: 'Build',
          agentType: 'tson-porter',
          schema: PORT_RESULT,
          effort: 'high',
        },
      ),
  ),
);

if (results.every((r) => r === null || r.status === 'blocked')) {
  log('Neither package landed; the gate cannot be measured');
  return { wave: 5, results, gate: null };
}

// The gate is a scenario, not a checklist: three schemas deep is where import resolution, template
// materialisation, linking and compilation all have to be simultaneously right. Any one of them
// wrong shows up here and nowhere earlier.
const gate = await agent(
  `Prove Wave 5's gate end to end, as a real test committed under packages/tson/test/ rather than
a one-off check.

Build a scenario three schemas deep:
1. A user schema that imports spec/m/core.tn, which itself imports the schemas beneath it.
2. Compile it with this implementation.
3. Validate a conforming document. It must be accepted, and reading it must produce the values the
   document actually carries — not merely "no error".
4. Validate a non-conforming document. It must be rejected with a diagnostic naming the field, the
   position and the type it violated. A bare "invalid" is a failure of this gate.
5. Round-trip: parse the conforming document, write it, parse the result, and compare. Do this for
   both the canonical and the readable writer entry points if they differ.

Use the vendored spec/m/*.tn — do not fetch anything, and do not edit anything under spec/.

Report what actually happened, including anything that only half worked. A gate that is reported
green and is not is worse than a red one.`,
  { label: 'gate', phase: 'Prove', schema: GATE, effort: 'high' },
);

log(
  gate?.compiles === true && gate.validatesValid && gate.rejectsInvalid && gate.roundTrips
    ? 'Wave 5 gate GREEN: compiles, validates, rejects and round-trips three schemas deep'
    : 'Wave 5 gate RED',
);

return { wave: 5, results, gate };
