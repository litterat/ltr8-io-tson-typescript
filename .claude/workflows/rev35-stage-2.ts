export const meta = {
  name: 'tson-rev35-stage-2',
  description:
    'Revision 35 Stage 2: one value-space equality contract, replacing the structural deepEqual every equality, ordering and identity rule currently reaches',
  whenToUse:
    "After Stage 1's gate (the class1/ vectors green) is committed. Builds the §5.5 value-space clause the set duplicate rule, map-key identity, the FIXED check, value-argument identity and the pinned-reference digest all delegate to.",
  phases: [
    { title: 'Build', detail: 'the per-family value-space equality contract' },
    { title: 'Verify', detail: 'adversarially, family by family' },
    { title: 'Sweep', detail: 'measure the vectors and name what is still red' },
  ],
};

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This is a REVISION run, not a fresh port. The code exists and passes the previous revision's
vectors; your package moves it from 2026 Revision 34 to Revision 35. You are looking for what the
new spec text requires that the current code does not do, and for what the current code does that
the new spec text no longer allows.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions. They are not negotiable.
2. \`REVISION-35-PLAN.md\` — the whole plan, then your stage inside it. Your brief below is the
   authority where the two differ.
3. The spec sections your package implements, in the RE-VENDORED \`spec/\` at the repository root —
   \`spec/tson-part1-data.md\` and \`spec/tson-part2-schema.md\`. These are already Revision 35.
   Read the actual section text, not the revision summary at the top.
4. The Java reference at the new pin, \`.references/ltr8-io-tson-java/\`, including Javadoc.
   \`.references/ltr8-io-tson-java/CONFORMANCE.md\` records where the reference is deliberately
   stricter than the JDK; those checks are the required behaviour, not the JDK's.
5. The conformance vectors your package should turn green, in
   \`.references/ltr8-io-tson-test-suite/tests/\`. Read the subject AND its \`-expected.tn\`
   sidecar. \`.references/ltr8-io-tson-test-suite/RUNNER.md\` is normative for runners.
6. The current TypeScript you are changing.

# How to port

**Idiomatic TypeScript, not transliterated Java.** Discriminated unions over class hierarchies,
plain functions over singleton objects. Same behaviour, same conformance, different shape.

**Behaviour comes from the spec and the vectors**, not from the Java's convenience and not from
what the code did last revision.

**Never weaken a signature.** Anything that can starve for input returns \`Task<T>\` and is called
with \`yield*\`.

**No regex in the grammar**, and no \`RegExp\` in \`src/base/\`.

**Zero runtime dependencies.** Not one, for any reason.

**Delete what the revision removes.** Do not leave the old path reachable behind a flag or an alias.

# TSDoc

\`CLAUDE.md\`'s rule binds hardest on a revision run: **TSDoc documents current contract only, no
change history.** Never "changed in Revision 35", never "used to". State the current invariant and
its rationale directly, and re-cite the section — a \`§\` citation pointing at the old section
number is worse than none.

# Tests

Write tests from the **spec**, citing the section in the test name.

At the Revision 35 corpus pin the suite discovers **277 subjects**. That number must not drop: a run
that discovers fewer has broken the harness rather than fixed anything, and that is the finding
ahead of any individual vector.

Do not modify the harness in \`test/conformance/\` to make a vector pass. If a vector looks wrong,
report it.

# Definition of done

\`\`\`bash
npm run typecheck          # clean
npm run lint               # clean, including the import/no-restricted-paths zones
npm run format:check       # clean
npm test                   # unit tests pass
npm run test:conformance    # 277 discovered; your vectors green; nothing regressed
\`\`\`

If a lint zone rule fires, fix the import, not the rule.

# Report back

- Files created, changed or deleted.
- Which conformance vectors moved from failing to passing, by name, verified by running them.
- Every place the spec was ambiguous, underspecified, internally inconsistent, or plain wrong, with
  the interpretation you chose and why. Do not silently pick a reading.
- Anything you could not finish, stated plainly.`;

const BRIEF = `Stage 2 — one value-space equality contract ([TSON-SCHEMA] §5.5).

Read §5.5's "Facets with a stated meaning" paragraph and the bulleted list under it, in full, in
\`spec/tson-part2-schema.md\`. The clause it states is the whole package:

> A type denotes a value space. An encoding defines a lexical space over it and one canonical form
> per value. Equality, ordering, refinement, disjointness and content addressing are defined over
> value spaces only, never over spellings.

**Five rules delegate to it, and the spec names them.** Find each in this codebase and make it
reach one contract rather than its own comparison:

1. The set duplicate rule ([TSON-SCHEMA] §7.5) — \`packages/tson/src/reader/tree/array.ts\`, the
   \`uniqueItems\` \`seen\` list.
2. Map-key identity ([TSON-DATA] §2.6, [TSON-SCHEMA] §7.7) — \`packages/tson/src/reader/tree/map.ts\`,
   the \`seenKeys\` list. Note §2.6's layering: textual identity is the parser's minimum, decoded
   identity applies from base type resolution onward, and a DECLARED key type can only make MORE
   keys equal, never fewer. A type-aware duplicate under a schema is a Class 2 VALIDATION error,
   where the layers below it raise a resolver error — get the category right.
3. The check of a written value against a FIXED one ([TSON-SCHEMA] §5.2) —
   \`packages/tson/src/reader/tree/record.ts\`.
4. The identity of a value argument ([TSON-SCHEMA] §8.2) — the template-application identity path
   in \`packages/tson/src/compiler/\`. \`STATUS.md\` already records as a known gap that this
   compares spelling rather than value equivalence. Closing it here is in scope; the ALIASED
   argument half of §8.2 (following reference chains) is Stage 4 WP4.8 and is not.
5. The digest a pinned reference verifies ([TSON-SCHEMA] §10.2) — content addressing is over
   BYTES, and every identity rule above a digest is over value spaces.

**What is actually in the tree, so you do not chase a phantom.** \`packages/tson/src/reader/tree/equality.ts\`
is a structural \`deepEqual\` that both \`array.ts\` and \`map.ts\` reach through \`valuesEqual\`.
It already compares a \`Uint8Array\` by CONTENT, not by reference — \`REVISION-35-PLAN.md\` says
otherwise and the plan is wrong on that detail. The real defect is that the comparison is
STRUCTURAL over whatever host shape the decoder happened to produce, with no idea which type's
value space it is comparing in. Two spellings of one value that decode to two different host shapes
compare unequal, and that is the bug the new vectors catch. Establish the actual failure by running
the vectors before you design the fix, and report what you found.

**Per-family value spaces to implement**, each stated in §5.5's own bullet:

- **\`bytes\`** — an octet sequence. The RFC 4648 alphabet is a \`bytes_type\` SELECTOR that picks a
  spelling and can never change what two values compare as. Case in hex and padding in base64 are
  lexical: \`"abcd"\` and \`"ABCD"\` under \`HEX\` are one value. Length facets count OCTETS, so
  \`length: 32\` is a 32-byte digest whether it arrives as 64 hex characters, 44 base64 characters
  or 32 raw bytes.
- **The exact numeric tiers** — exact values with no scale. \`1\`, \`1.0\` and \`1.00\` are ONE
  value. \`rational\` is the fraction, so \`2/4\` and \`1/2\` are one value. [TSON-DATA] §4.3 already
  says \`255\` and \`0xFF\` are one value; make sure that holds across the tiers and not just within
  one decoder.
- **\`time\` and \`datetime\`** — INSTANTS. The offset is a spelling: \`2026-01-01T10:00:00+01:00\`
  and \`2026-01-01T09:00:00Z\` are one value, \`-00:00\` is the same instant as \`Z\`, and
  \`23:30:00-02:00\` is \`01:30:00Z\`. Both families are TOTALLY ORDERED, which the mandatory offset
  is what makes possible — the ordering matters as much as the equality, because §5.7's ordered
  bounds need it. TSON text PRESERVES the offset as written; only equality and ordering ignore it.
- **\`duration\` and \`period\`** — exact decimal seconds and integer months respectively (Stage 1
  built these). \`PT90M\`, \`PT1H30M\` and \`P0DT5400S\` are one value; \`PT0S\`, \`P0D\` and
  \`-PT0S\` are one value.

**Ordering, not only equality.** §5.7's ordered-bound facets ("a lower bound may rise, an upper
bound may fall") require the family's value space to be TOTALLY ORDERED, and §5.5 says every family
carrying a bound now is. A contract that answers only "equal?" leaves \`min\`/\`max\` unable to
compare an instant against a differently-spelled one. Two corpus vectors say so by name —
\`a-duration-bound-compares-the-value-not-the-token\` and \`a-duration-inside-its-declared-bounds\`.
Build comparison, and derive equality from it where the family is totally ordered.

**The vectors this stage owns**, under \`.references/ltr8-io-tson-test-suite/tests/class2/validate/\`:

- \`invalid/one-binary-map-key-stated-twice\`
- \`invalid/one-binary-value-twice-in-a-set\`
- \`valid/a-fixed-binary-field-given-the-value-it-declares\` — read this one carefully. The plan
  notes it is written deliberately so that a reference-equality implementation fails it in the
  direction that LOOKS like a pass. Understand why before you claim it green.
- \`valid/a-duration-bound-compares-the-value-not-the-token\`
- \`valid/a-duration-inside-its-declared-bounds\`
- \`valid/a-precision-constrained-value-spelled-with-trailing-zeros\`

plus the fixture schema \`validate-binary-identity.tn\` and \`validate-precision.tn\` if the harness
needs them registered — but you may NOT edit \`test/conformance/\`; if a fixture is unregistered,
report it as work for Stage 7 rather than doing it.

Some of these also depend on Stage 3's \`bytes_type\` and on Stage 4's facet work. Turn green what
this stage can, and for each you cannot, say plainly which later stage blocks it rather than
leaving it unexplained.

**Where the contract lives.** It is reached from the reader (\`src/reader/\`) and from the compiler
(\`src/compiler/\`), and it must not drag either into the other. Check \`eslint.config.js\`'s
\`import/no-restricted-paths\` zones before you pick a home; if a zone fires, the home is wrong, not
the rule. It must not reach \`src/schema/meta\`, which names no compiler type by design.

Do not edit \`packages/tson/src/schema/meta/\` (Stage 3 owns it), or
\`packages/tson/src/compiler/definitionResolver.ts\` beyond what value-argument identity needs
(Stage 4 rewrites it).`;

const BUILD_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'filesWritten', 'vectorsGreen', 'vectorsBlocked', 'specFindings', 'notes'],
  properties: {
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: {
      type: 'array',
      items: { type: 'string' },
      description: 'every file created, changed or deleted',
    },
    vectorsGreen: {
      type: 'array',
      items: { type: 'string' },
      description: 'vector names that moved from failing to passing, verified by running them',
    },
    vectorsBlocked: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vector', 'blockedBy'],
        properties: {
          vector: { type: 'string' },
          blockedBy: {
            type: 'string',
            description: 'the later stage that must land first, and why',
          },
        },
      },
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
          reading: { type: 'string', description: 'the interpretation chosen, and why' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['sound', 'problems'],
  properties: {
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

const SWEEP = {
  type: 'object',
  additionalProperties: false,
  required: ['discovered', 'passing', 'failing', 'class1Failing', 'remaining'],
  properties: {
    discovered: { type: 'number' },
    passing: { type: 'number' },
    failing: { type: 'number' },
    class1Failing: { type: 'number' },
    remaining: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vector', 'cause', 'owner'],
        properties: {
          vector: { type: 'string' },
          cause: { type: 'string', description: 'the actual reason, not the assertion message' },
          owner: { type: 'string', description: 'the stage that owns it' },
        },
      },
    },
  },
};

log('Revision 35 Stage 2: one package, the value-space equality contract.');

const build = await agent(
  `${PORTER}

---

${BRIEF}

Stage 0 and Stage 1 have landed: \`spec/\` at the repository root IS Revision 35, \`.references/\`
is at the new pins, \`null\` is a string, \`!bytes\` is the one binary tag, and \`duration\` and
\`period\` are two atoms. Read \`spec/\` and the current source, not a cached memory of Revision 34.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`,
  {
    label: 'build:value-space',
    phase: 'Build',
    model: 'sonnet',
    schema: BUILD_RESULT,
    effort: 'high',
  },
);

if (build === null) {
  throw new Error(
    'the value-space package returned nothing; aborting rather than reporting success',
  );
}

log(
  `Build: ${build.status}, ${String(build.filesWritten.length)} files, ${String(build.vectorsGreen.length)} vectors green`,
);

const verdict = await agent(
  `Adversarially review the TSON TypeScript port's Stage 2 value-space equality contract
([TSON-SCHEMA] §5.5). Default to finding it UNSOUND: refute the claim that equality is now over
value spaces rather than spellings.

Files claimed: ${build.filesWritten.join(', ')}
Vectors claimed green: ${build.vectorsGreen.join(', ') || '(none claimed)'}

Check, in this order:

1. Run the gates yourself. Do the claimed vectors actually pass? Did anything green before this
   package go red? The suite must still discover 277 subjects.
2. Read §5.5's bulleted list in \`spec/tson-part2-schema.md\` and test EACH family's stated
   consequence yourself, by writing the case rather than by reading the code:
   - \`"abcd"\` and \`"ABCD"\` under \`HEX\` are one value; base64 padding is lexical.
   - \`1\`, \`1.0\` and \`1.00\` are one value; \`2/4\` and \`1/2\` are one rational; \`255\` and
     \`0xFF\` are one value — ACROSS tiers, not only within one decoder.
   - \`2026-01-01T10:00:00+01:00\` and \`2026-01-01T09:00:00Z\` are one value; \`-00:00\` equals
     \`Z\`; \`23:30:00-02:00\` is \`01:30:00Z\`.
   - \`PT90M\`, \`PT1H30M\` and \`P0DT5400S\` are one value; \`PT0S\`, \`P0D\` and \`-PT0S\` are one.
3. **Is it ORDERING, or only equality?** §5.7's ordered bounds need a total order. A contract that
   answers only "equal?" cannot compare an instant against a differently-spelled one at a \`min\`.
   Find a bound comparison that still compares tokens.
4. **Did all five delegating rules actually get rewired**, or only the two that had vectors? Check
   the set duplicate rule, map-key identity, the FIXED check, value-argument identity and the
   pinned-reference digest each reach the one contract. A second, private comparison left behind
   anywhere is the defect this stage exists to remove.
5. Is the map-key rule's LAYERING right — textual, then decoded, then declared-type — and does the
   declared-type layer raise a Class 2 VALIDATION error where the layers below raise a resolver
   error?
6. Stale TSDoc and stale \`§\` citations. \`CLAUDE.md\` forbids change history in TSDoc and requires
   the citation to be current.
7. Did it weaken a \`Task<T>\` signature, add a runtime dependency, put a \`RegExp\` in
   \`src/base/\`, or relax an ESLint zone rule instead of fixing an import?
8. Did it edit \`test/conformance/\` or \`packages/tson/src/schema/meta/\`? Neither is permitted.

Report only problems you can point at a file and line for.`,
  { label: 'verify:value-space', phase: 'Verify', schema: VERDICT, effort: 'high' },
);

const sweep = await agent(
  `Run \`npm run test:conformance\` and report the real numbers for the TSON port at 2026 Revision 35.

Stage 2's gate is: every \`class1/\` vector still green, and the six \`class2/validate/\` vectors
this stage owns green unless a later stage genuinely blocks them —
\`one-binary-map-key-stated-twice\`, \`one-binary-value-twice-in-a-set\`,
\`a-fixed-binary-field-given-the-value-it-declares\`,
\`a-duration-bound-compares-the-value-not-the-token\`, \`a-duration-inside-its-declared-bounds\`,
\`a-precision-constrained-value-spelled-with-trailing-zeros\`.

For every vector still failing, give the ACTUAL cause — read the failure, do not paraphrase the
assertion message — and attribute it to the stage that owns it (Stage 3 the schema model, Stage 4
the resolver and compiler, Stage 5 scoped values, Stage 6 resolved-output writing).

If the DISCOVERED count is not 277, the harness is broken and that is the finding, ahead of
anything about individual vectors.

Do not fix anything. Do not modify test/conformance/. This is a measurement.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'high' },
);

log(
  sweep === null
    ? 'Sweep returned nothing'
    : `Conformance: ${String(sweep.passing)}/${String(sweep.discovered)} passing, ${String(sweep.failing)} failing (${String(sweep.class1Failing)} under class1/)`,
);

return { stage: 2, build, verdict, sweep };
