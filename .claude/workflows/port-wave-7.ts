export const meta = {
  name: 'tson-port-wave-7',
  description:
    'Wave 7 of the TSON port: the sweep — full conformance, packaging checks, browser bundle, docs, and a completeness critic',
  whenToUse:
    'After Wave 6. The last wave: verifies the whole port rather than building anything new, and says plainly what is still missing.',
  phases: [
    { title: 'Sweep', detail: 'independent checks across conformance, packaging, docs and memory' },
    { title: 'Critique', detail: 'what is still missing that none of the sweeps was looking for' },
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

// Nothing here is a work package. Every stage measures something already built, which is why they
// all run concurrently and none of them may fix what it finds — a sweep that repairs as it goes
// cannot report what the state actually was.

const SWEEPS = [
  {
    key: 'conformance',
    brief: `Run the full conformance suite and report it honestly.

npm run test:conformance. For every vector still failing, give the real cause — read the failure,
do not paraphrase the assertion — and name which work package owns it.

Then check the things a passing count hides:
- Is the discovered count still 146? A drop means the harness broke, and that finding outranks
  everything about individual vectors.
- Are utf-16 and utf-32 vectors SKIPPED rather than passing? A pass there means something is
  pretending to support an encoding it does not.
- Are the eight encoding: invalid-utf8 vectors fed raw bytes? Read the harness and confirm no
  TextDecoder round trip sits between the file and the lexer. A vector that passes for the wrong
  reason is worse than one that fails.
- On outcome: error, does the harness assert only the category, never the position?`,
  },
  {
    key: 'fixtures',
    brief: `Verify the resolver fixtures and the bundled schemas, independently of Wave 3's own test.

Resolve spec/m/meta-kernel.tn, meta.tn and core.tn and compare against their *-resolved.tn
fixtures: 49, 31 and 48 declarations respectively. Check content digests, not just structure — the
fixtures carry digests from the reference implementation and a structural match with a digest
mismatch means canonical identity disagrees.

Also confirm spec/ is still byte-identical to the pinned checkout (vendored-spec.test.ts covers
this; run it and confirm it is not silently skipping because .references/ is absent).

Re-run scripts/gen-unicode-tables.mjs and confirm a no-op diff. A diff means the checked-in table
and the host's Unicode version disagree, which is a real finding worth reporting with both
versions named.`,
  },
  {
    key: 'packaging',
    brief: `Verify what actually ships.

npm run build, then:
- npx publint on both packages.
- npx @arethetypeswrong/cli --pack on both packages. Dual ESM/CJS with correct types in both
  directions is the claim; check it rather than assuming tsup got it right.
- Every subpath entry resolves: '.', './bind', './tree', './regex', './schema'. Import each from
  ESM and require each from CJS against the BUILT package, not against src.
- Tree-shaking actually works. Bundle a program that imports only parse and confirm the compiler
  is absent from the output. This is the property the subpath entries exist for, and it is the one
  most likely to have quietly stopped holding.
- Zero runtime dependencies in @ltr8/tson. Check the built package.json, not the source.
- The CLI binary runs from the built output and its exit codes are 0 / 1 / 2 / 70 as specified.

Report what you found. Do not fix it.`,
  },
  {
    key: 'browser-and-memory',
    brief: `Verify the two claims that are easy to state and easy to quietly break.

Browser: build a bundle that reads Class 1 data with no schema compilation, and confirm it
contains no Node built-in, no compiler, and nothing from src/source/. Run it in the Chromium that
is already installed (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers; do not download a browser) and
confirm it parses a document correctly rather than merely loading.

Memory: streaming is non-negotiable and the claim is that memory is proportional to NESTING DEPTH,
not document size. Test it: read a very large flat document and a deeply nested one, measure, and
report the actual shape. If anything materialises a whole document to read part of it, name the
file. An allocation harness that reports a number nobody checks is not evidence — say what the
number should be and whether it is.`,
  },
  {
    key: 'docs',
    brief: `Bring README.md and STATUS.md to the state of the code, and check CLAUDE.md is still
true.

STATUS.md is the only checklist and it carries the conformance count. Update every box against
what actually passes, verified by running it — not against what the waves claimed. The count at
the top must be the real number.

README.md should show the flat API first (parse, readTree, validate, write), createTson second,
and say plainly what is and is not implemented. Every code sample must actually run; run them.

CLAUDE.md describes the code as it stands. Waves 1 to 6 have changed things — check each hard
constraint and each layering claim is still accurate, and correct anything that has drifted. In
particular: src/globals.d.ts said TextEncoder is declared because the package needs it, and work
package 2 was asked to remove that declaration once a hand-written encoder replaced it. Check
which is true now and make the file say that.

Do not overstate. A README that claims a feature the port does not have is the most expensive kind
of documentation error.`,
  },
];

const SWEEP_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'passed', 'findings'],
  properties: {
    key: { type: 'string' },
    passed: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'severity', 'evidence'],
        properties: {
          issue: { type: 'string' },
          severity: { enum: ['blocking', 'significant', 'minor'] },
          evidence: { type: 'string', description: 'the command output or file that shows it' },
        },
      },
    },
    metrics: {
      type: 'string',
      description: 'the concrete numbers this sweep produced, where it produced any',
    },
  },
};

const CRITIQUE = {
  type: 'object',
  additionalProperties: false,
  required: ['shippable', 'gaps', 'rationale'],
  properties: {
    shippable: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gap', 'why', 'severity'],
        properties: {
          gap: { type: 'string' },
          why: { type: 'string', description: 'why it was missed, not just what it is' },
          severity: { enum: ['blocking', 'significant', 'minor'] },
        },
      },
    },
    rationale: { type: 'string' },
  },
};

log(`Wave 7: ${String(SWEEPS.length)} sweeps over the finished port`);

const sweeps = await parallel(
  SWEEPS.map(
    (sweep) => () =>
      agent(
        `${PORTER}

---

${sweep.brief}

Read CLAUDE.md and ORCHESTRATION.md first.

You are MEASURING, not repairing. The exception is the docs sweep, which is expected to edit
README.md, STATUS.md and CLAUDE.md — and even there, do not change code to make a document true.

Report what you actually observed. A sweep that reports green because it did not look hard is the
failure mode this wave exists to prevent.`,
        {
          label: `sweep:${sweep.key}`,
          phase: 'Sweep',
          model: 'sonnet',
          schema: SWEEP_RESULT,
        },
      ),
  ),
);

const observed = sweeps.filter((s) => s !== null);
const findings = observed.flatMap((s) => s.findings);
log(
  `Sweeps returned: ${String(observed.length)}/${String(SWEEPS.length)}, ${String(findings.length)} findings`,
);

// A completeness critic rather than a summariser. Every sweep above was looking for something
// specific, which means the gaps most likely to survive this wave are the ones none of them was
// pointed at.
const critique = await agent(
  `Decide whether this TSON port is shippable, and say what is missing.

The sweeps reported:

${JSON.stringify(observed, null, 2)}

Do not summarise that. Ask what none of them was looking for:
- A spec area with no test at all. Read spec/tson-part1-data.md and tson-part2-schema.md section
  by section and find one.
- A claim in CLAUDE.md, README.md or PORT-PLAN.md that nothing verifies.
- A layer whose only evidence is a conformance vector that would pass for the wrong reason.
- Something a work package reported as done that no sweep re-checked independently.
- Anything the port silently does not implement, where a caller would get a wrong answer rather
  than an error. That is the worst category and it is the one no green test reports.

Verify what you claim before claiming it — spot-check the code, do not reason from the reports.

Then decide: shippable, or not, and why.`,
  { label: 'critique', phase: 'Critique', schema: CRITIQUE, effort: 'high' },
);

log(
  critique?.shippable === true
    ? `Port assessed shippable, with ${String(critique.gaps.length)} noted gaps`
    : `Port NOT shippable: ${String(critique?.gaps.length ?? 0)} gaps`,
);

return { wave: 7, sweeps, critique };
