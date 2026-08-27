export const meta = {
  name: 'tson-port-wave-4',
  description:
    'Wave 4 of the TSON port: linking, canonical identity and content hashing, plus the reader stack',
  whenToUse:
    'After Wave 3 resolves all three bundled schemas to match their fixtures. Produces reference validation, the registry, content hashing, and the four reader families.',
  phases: [
    { title: 'Foundations', detail: 'linking and identity, and the abstract reader base' },
    { title: 'Readers', detail: 'the three concrete reader families, concurrently' },
  ],
};

// The porter charter, carried in the script rather than looked up as a registered agent
// type. `.claude/agents/tson-porter.md` is only visible to a session that started AFTER it
// was committed, so a session that pulled it mid-run gets 'agent type not found' — which is
// how Wave 0's first run lost four of five agents. The charter travels with the wave script,
// which is the unit of review anyway, and `model: 'sonnet'` carries what the frontmatter said.
const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions. They are not negotiable and they are not
   suggestions.
2. \`PORT-PLAN.md\` — find your work package in the Part B wave tables. It names the Java sources you
   port, the TypeScript you produce, and what you may assume exists.
3. The spec sections your package implements:
   \`.references/ltr8-io-tson-java/spec/tson-part1-data.md\` and \`tson-part2-schema.md\`.
4. The Java sources named for your package, including their Javadoc. The Javadoc carries invariants
   and deliberate divergences that the code alone does not show.
5. The contract-layer types you import. They are frozen. If one is genuinely wrong, say so and stop —
   do not edit it, because other packages are building against it concurrently.

# How to port

**Idiomatic TypeScript, not transliterated Java.** Discriminated unions over class hierarchies, plain
functions over singleton objects, closures over \`MethodHandle\`. Same behaviour, same conformance,
different shape. A class-for-class translation is a failed port.

**Behaviour comes from the spec and the vectors, not from the Java's convenience.** Where the Java
leans on a JDK type this port has no equivalent for, read
\`.references/ltr8-io-tson-java/CONFORMANCE.md\` — it records where the reference is deliberately
stricter than the JDK, and those checks are the required behaviour.

**Never weaken a signature.** Anything that can starve for input returns \`Task<T>\` and is called with
\`yield*\`. Do not "simplify" one to a plain return type; it breaks every caller above it and the
suspension cannot be reintroduced locally.

**No regex in the grammar.** The number grammar is hand-written, one function per ABNF rule. The
reference states this explicitly for the benefit of ports.

**Zero runtime dependencies.** Not one, for any reason.

# Tests

Write tests from the **spec**, not by translating the Java tests. Read the Java tests to learn what
edge cases exist and what they assert, then write TypeScript tests that state those cases against the
spec section that requires them. Cite the section in the test name.

Run the shared vectors:

\`\`\`bash
npm run test:conformance
\`\`\`

**Your wave's brief says what the suite should do at your point in the port, and it governs.** In
early waves nothing can pass — \`test/conformance/sidecar.ts\` parses sidecars with this
implementation's own parser, so until the data parser lands every vector fails on the same throw.
There the thing to check is that the DISCOVERED count is still 146; a drop means the harness broke.

Do not modify the harness in \`test/conformance/\` to make a vector pass. If a vector looks wrong,
report it — it may be a genuine spec-feedback finding.

# Definition of done

These always, no exceptions:

\`\`\`bash
npm run typecheck          # clean
npm run lint               # clean, including the import/no-restricted-paths zones
npm run format:check       # clean
npm test                   # your unit tests pass
\`\`\`

Plus whatever your wave's brief states about \`npm run test:conformance\`. Nothing that was green
may go red, in any wave.

If a lint zone rule fires, fix the import, not the rule. The zones replace the reference
implementation's module system and carry real design weight.

# Report back

- Files created or changed.
- Which conformance vectors moved from failing to passing, by name.
- Every place the spec was ambiguous, underspecified, internally inconsistent, or plain wrong, with
  the interpretation you chose and why. Do not silently pick a reading — a resolved ambiguity is
  invisible again three sessions later unless it is written down.
- Anything you could not finish, stated plainly.`;

/**
 * Agents that error resolve to `null`, so a wave whose agents all died looks exactly like a wave
 * that ran cleanly and found nothing. Wave 0's first run reported "0 findings" while four of its
 * five agents had failed to start at all, and the run was reported as completed. Filtering nulls
 * away silently is what made that possible, so every stage counts them instead.
 */
function requireAgents(results, expected, what) {
  const ok = results.filter((r) => r !== null);
  const lost = expected - ok.length;
  if (lost > 0) {
    log(
      `WARNING: ${String(lost)} of ${String(expected)} ${what} agents returned nothing. Their results are MISSING, not empty — do not read this wave as complete.`,
    );
  }
  if (ok.length === 0) {
    throw new Error(
      `every ${what} agent failed; aborting rather than reporting an empty result as success`,
    );
  }
  return ok;
}

// Two independent tracks, with one ordering inside the reader track: the abstract readers and the
// read context define the shape the three concrete families implement, so they go first. Linking
// shares nothing with any of them and runs alongside.

const FOUNDATIONS = [
  {
    key: 'linking',
    brief: `Work package 15 (linking, registry, canonical identity, content hashing). Produce
packages/tson/src/link/.

Port the linking half of .references/ltr8-io-tson-java/tson-compiler/ and the identity code
beside it. Four things:

0. **Populate \`subtypes\`.** Wave 3's fixture gate is red on this: every entry that has subtypes in
   spec/m/meta-kernel-resolved.tn has an empty list here. It is the reverse index over the whole
   resolved schema, which is why definitionResolver.ts deferred it to you rather than computing it
   per declaration — the reference builds it in TsonSchemaLinker. Verify against the fixture:
   \`top\` should carry 17 subtypes, \`atom\` 6, \`product\` 5, \`sum\` 1, \`text_type\` 2,
   \`atom_specification\` 2, \`array\` 1.
1. Reference validation — every type reference resolves, with a diagnostic naming the reference
   and its location when it does not.
2. Transitive !!import merge, including the diamond case where two imports reach the same schema.
3. Choice disjointness. Wave 1's regex package provides product-NFA disjointness for pattern
   choices; use it rather than approximating.
4. Canonical identity and content hashing. sha256 via crypto.subtle, which is present in Node 24
   and in browsers. It is async, and that is the reason the hashing path is async while nothing
   else in this layer is — do not make the whole layer async to hide it, and do not block on it.

Canonical identity is a serialisation, so it must be byte-stable: independent of map iteration
order, of insertion order, and of anything that could differ between runs or runtimes. The
*-resolved.tn fixtures carry digests produced by the reference implementation, and Wave 3's
fixture test is what will tell you whether this agrees with it.`,
  },
  {
    key: 'abstract-readers',
    brief: `Work package 16a (abstract readers and read context). Produce
packages/tson/src/reader/ — the base the three concrete reader families extend.

reader/contracts.ts is FROZEN: TypeReader<T> with read(ctx): Task<T>, ReadContext,
ValueReaderFactory and the registries are already declared. Implement against them.

Everything here is suspendable. read() returns Task<T>, every starving call is yield*. This is the
layer where a dropped suspension does the most damage, because three reader families are written
on top of whatever shape you establish.

ReadContext carries the schema, the diagnostics receiver and the position. Memory stays
proportional to nesting depth: nothing here may materialise a whole document to read part of it.

State the exported shape precisely in your report. Three agents build on it immediately.

**You also own the gap that blocks Wave 3's gate.** \`compiler/resolverTypes.ts\` declares
\`DefinitionMetaReader\` — \`(type: string, value: DataValue) => Top\` — and nothing implements it, so
\`meta.tn\` and \`core.tn\` do not resolve at all: they stop at the first constructor application with
"no compiled reader for '!enum': bind/ carries only the write direction". Provide the read
direction, so a data-value can be bound back into a \`schema/meta\` value through a Binding.
packages/tson/test/bundled-schemas-resolve.test.ts asserts today that meta and core fail for
exactly that reason; when you land this it will fail, and updating it to assert the real
comparison is part of your work package.`,
  },
];

const READERS = [
  {
    key: 'tree-readers',
    brief: `Work package 16b (tree readers). Produce the readers that build packages/tson/src/tree/
nodes from the event stream.

tree/nodes.ts is FROZEN. RecordNode, MapNode, ArrayNode, TupleNode, AtomNode, AbsentNode and
MissingNode already exist, along with RFC 6901 pointer support.

MissingNode carries the failed pointer — that is its whole reason for existing, and a reader that
returns undefined instead of a MissingNode loses the information a caller needs to report what it
asked for. A pointer at a document root is undefined, not '', because '' is itself a valid RFC
6901 pointer meaning exactly the root.`,
  },
  {
    key: 'bind-readers',
    brief: `Work package 16c (bind readers). Produce the readers that drive Binding descriptors.

Consume the Binding<T> union from bind/binding.ts and Wave 1's combinators. The descriptors are
authored, never derived — there is no reflection here and none is being added.

Strictness is a real axis: what happens on an unknown field, a missing optional, a type mismatch.
Read the Java's strictness handling and port its semantics. Where it leans on a JDK behaviour with
no JS equivalent, say so and state what you chose.

Infer<> must keep holding: the type a binding reads must equal the type it infers.`,
  },
  {
    key: 'schemaless-readers',
    brief: `Work package 16d (schemaless reading and type-reference checks). Produce the readers
that work without a compiled schema, plus the type-reference checking that runs when there is one.

Schemaless reading is what makes @ltr8/tson useful for Class 1 data in a browser that never
compiles a schema. It must not pull the compiler in — check the bundle, not just the imports, and
remember that the subpath entries exist precisely so this is possible.

Type-reference checks validate a value against a resolved type reference, with diagnostics that
name the reference and the location.`,
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
      description: 'for 16a: the exported shape the concrete reader families implement against',
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

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'sound', 'problems'],
  properties: {
    key: { type: 'string' },
    sound: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'claim', 'severity'],
        properties: {
          file: { type: 'string' },
          claim: { type: 'string' },
          severity: { enum: ['blocking', 'significant', 'minor'] },
        },
      },
    },
  },
};

const SHARED = `Read CLAUDE.md and ORCHESTRATION.md first. The contract layer is FROZEN. Waves 1
to 3 are done: the lexer, parsers, desugarer, bind runtime, resolver and the three bundled schemas
all work, and Wave 3's fixture test proves the last of those.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance — and no conformance vector that was green may go red. A regression is
blocking regardless of what else the package achieved.`;

log('Wave 4: linking and the abstract readers, then the three reader families');

const foundations = await parallel(
  FOUNDATIONS.map(
    (pkg) => () =>
      agent(
        `${PORTER}

---

${pkg.brief}\n\n${SHARED}`,
        {
          label: `port:${pkg.key}`,
          phase: 'Foundations',
          model: 'sonnet',
          schema: PORT_RESULT,
          effort: 'high',
        },
      ),
  ),
);

// By POSITION, not by the agent's self-reported `key`. parallel() preserves input order, and
// FOUNDATIONS[1] is the abstract readers. Matching on a key the schema types only as `string`
// let an agent that called itself 'wp16a-abstract-readers' read as "did not land", which
// silently skipped all three reader families while reporting the wave complete.
const abstractReaders = foundations[FOUNDATIONS.findIndex((f) => f.key === 'abstract-readers')];

if (abstractReaders == null || abstractReaders.status === 'blocked') {
  log('Abstract readers did not land; the concrete reader families cannot start');
  return { wave: 4, foundations, readers: [] };
}

const readers = await pipeline(
  READERS,
  (pkg) =>
    agent(
      `${PORTER}

---

${pkg.brief}

Work package 16a (abstract readers and read context) has landed. Its author describes the surface
you implement against as:

${abstractReaders.contractSurface ?? '(not stated — read packages/tson/src/reader/ directly)'}

Read the code where that description and the code differ.

${SHARED}`,
      { label: `port:${pkg.key}`, phase: 'Readers', model: 'sonnet', schema: PORT_RESULT },
    ),
  (port, pkg) => {
    if (port === null || port.status === 'blocked') return null;
    return agent(
      `Adversarially review work package "${pkg.key}" of the TSON TypeScript port. Default to
finding it UNSOUND.

Files claimed: ${port.filesWritten.join(', ')}

Check:
1. Run every gate yourself, including conformance. Did anything regress?
2. Did it weaken a Task<T> signature? This is the reader stack — that is the failure that costs
   the most to undo.
3. Does anything materialise a whole document, or hold memory beyond nesting depth? Construct a
   deeply nested and a very long document and look at the actual behaviour.
4. For schemaless reading: does it pull the compiler in? Check the built bundle, not the imports.
5. Any new runtime dependency?

Report only problems you can point at a file and line for.`,
      { label: `verify:${pkg.key}`, phase: 'Readers', schema: VERDICT },
    );
  },
);

log(
  `Wave 4 complete: ${String(readers.filter((r) => r !== null).length)}/${String(READERS.length)} reader families verified`,
);

return { wave: 4, foundations, readers };
