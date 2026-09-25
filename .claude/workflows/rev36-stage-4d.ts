export const meta = {
  name: 'tson-rev36-stage-4d',
  description:
    'Revision 36 Stage 4d: close the JSON review findings, then port the rest of the reference JSON test suite case for case',
  whenToUse: 'After Stage 4c. Two sequential packages.',
  phases: [
    { title: 'Findings', detail: 'WP4F: the open review findings' },
    { title: 'Tests', detail: 'WP4G: the rest of the test port' },
    { title: 'Verify', detail: 'adversarial review of each package' },
    { title: 'Repair', detail: 'one repair round per package that failed review' },
    { title: 'Sweep', detail: 'measure the whole suite' },
  ],
};

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This package builds NEW code: TSON Part 3, the JSON encoding, published with 2026 Revision 36 at its
first revision. The rest of the port — Parts 1 and 2 — is complete at Revision 36 and passes all 328
conformance subjects. Part 3 is a second encoding of the same model: a JSON document read against a
TSON schema must decode to what the equivalent TSON text decodes to.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints bind this code exactly as they bind the text stack:
   **streaming** (memory proportional to nesting depth; nothing materialises a whole document to
   read part of it), **the lexer decodes UTF-8 itself and is code-point addressed** (never index a
   JS string by UTF-16 unit for a column or offset; malformed UTF-8 is an error, never U+FFFD),
   **\`Task<T>\` suspension** (anything that can starve for input is \`function*\` returning
   \`Task<T>\` and every call to one is \`yield*\`; \`runSync\` and \`runAsync\` in
   \`packages/tson/src/io/\` drive it; the grammar is written ONCE), **zero runtime dependencies**,
   **Node 24 and browsers** (no Node built-ins, no DOM lib).
2. \`REVISION-36-PLAN.md\`'s Stage 4 and Scope decisions.
3. \`spec/tson-part3-json.md\` — the whole document. It is short and every section matters.
4. The Java module \`.references/ltr8-io-tson-java/tson-json/\` and its design note
   \`.references/ltr8-io-tson-java/design/json-encoding.md\` (and any other JSON note under
   \`design/\`), including Javadoc. The Java is the structural template; Part 3 is the authority.
   The Java's tests under \`tson-json/src/test/\` are inline text blocks — schema, JSON, expected
   code and pointer — and port directly to table-driven vitest cases.
5. The TypeScript you reuse: \`io/\` (Task, drivers, utf8), \`core/\` (diagnostics, limits, positions,
   errors), \`unicode/\` (NFC, identifier grammar, policies), \`atom/\` (\`atomParserFor\` and the atom
   parsers — NOT \`compiler/atomBuilder.ts\`, which is tied to TSON events), \`value/\`,
   \`schema/meta/\`, \`link/\` (\`LinkedSchema\`, \`disjointness\`).

# Layout and zones

Everything lives under \`packages/tson/src/json/\`, exported as a \`./json\` subpath of
\`@ltr8/tson\`: \`package.json\` \`exports\`, the tsup entry list, \`check:package\`'s entrypoint
handling, and the browser-bundle test's list of subpaths all gain it. Add an ESLint
\`import/no-restricted-paths\` zone in \`eslint.config.js\` for \`packages/tson/src/json/**\` that
forbids importing \`lexer\`, \`stream\`, \`reader\`, \`compiler\`, \`tree\`, \`write\` and \`facade\` —
the TypeScript form of the reference's "tson-json has no dependency on tson-compiler". If you need
the reference-chain walk in \`compiler/referenceChain.ts\`, MOVE that file to \`link/\` (updating its
importers) rather than widening the zone; \`link/disjointness.ts\` already depends on it.

Idiomatic TypeScript: discriminated unions, plain functions, no class-for-class translation. Where
you mirror the Java's shape rather than TypeScript's on purpose, add an entry to \`IDIOM-DEBT.md\`
in its existing format — at minimum one for the parallel JSON stack itself, with the reference's
own trigger for ending it (a shared encoding-neutral layer, its BACKLOG's \`tson-encoding\`).

TSDoc documents current contract only, cites Part 3 as \`[TSON-JSON] §n\`, and says where this port
makes a choice Part 3 leaves open.

# Tests and done

Tests from the spec, citing the section in the test name. The conformance suite has no JSON
vectors; it must stay at 328/328 and your work must not touch \`test/conformance/\`.

\`\`\`bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance && npm run build
\`\`\`

# Report back

Files created; the public API you added, with signatures; test counts; every place Part 3 was
ambiguous, underspecified or inconsistent with Parts 1 and 2, with the reading you chose; where the
Java diverges from Part 3 and which you followed; anything unfinished, stated plainly.`;

const PACKAGES = [
  {
    key: 'json-findings',
    phase: 'Findings',
    brief: `WP4F — close the open findings against \`src/json/\` and the text stack's family reader.

The JSON stack is green but an adversarial review of the last pass found the defects below, and the
repair pass that started on them stopped part-way — its edits are in the working tree
(\`git status\`, \`git diff\`). Read them, keep what is right, and finish. Each item names a file; each
is a real defect against the spec, not a style point.

1. **Choice \`$type\` admissibility** (\`json/schema/dispatchChoice.ts\`). A \`$type\` naming a SUBTYPE
   of a variant, or an alias of one, is sent straight to that subtype's reader. Part 3 §3.3: at a
   choice position \`$type\` MUST be admissible as "a variant of it", and §10.4 makes variant
   membership the bound. Read what Part 2 §7.2 and the text stack's \`compiler/choiceReader.ts\` admit
   (an alias of a variant is the variant — §8.3 — so admit that; a subtype of a variant: read §7.2
   and §5.4 and decide, and make text and JSON agree), then make JSON match the spec.
2. **Reserved-member violations are not \`UNKNOWN_TYPE_REF\`** (\`reservedMembers.ts\`, \`record.ts\`,
   \`dispatchTag.ts\`, \`dispatchMember.ts\`, \`dispatchChoice.ts\`). An unknown \`$foo\`, a misplaced
   \`$type\`, extra members in a wrapper and \`$schema\` at a non-scoped position were all given
   \`UNKNOWN_TYPE_REF\`, a code that means "the name denotes nothing". They are resolver-category
   errors (§9.4's table). Read what the reference reports for each (\`tson-json/.../ReservedMembers.java\`,
   \`Tags.java\`, \`JsonDiagnostics.java\`) and what \`core/diagnostic.ts\` offers; pick codes whose
   meaning and category both fit, and if no existing code fits, say so in your report rather than
   inventing one.
3. **A repeated undeclared member** (\`record.ts\`): \`{"name":"a","zzz":1,"zzz":2}\` and an NFC-equal
   pair report two \`UNRECOGNIZED_FIELD\` and no \`DUPLICATE_FIELD\`. Duplicate identity (§3.1) is
   judged before closure, for every member name.
4. **A missing discriminator is one rule in both encodings.** The reference's
   \`aMissingDiscriminatorIsOneRuleInBothAndJsonSaysWhereItGoes\` asserts a single \`FIELD_REQUIRED\` at
   \`/p/pet_type\` from BOTH encodings. This port's TEXT stack reports differently, and the parity test
   pins that as a divergence. It is a text-stack bug: fix \`compiler/subsumption.ts\`'s member-dispatch
   reader, and turn the pinned divergence into an ordinary parity assertion.
5. **The 52nd parity case.** \`bothTreesKeepWhichSpellingOfAbsenceArrived\` (Java
   \`CrossEncodingParityTest\` lines ~235–248: \`_\` and \`null\` both stand as the absent node in the
   tree, and an unwritten field is missing from it) was dropped. Port it, and fix whichever stack
   fails it.
6. **TSDoc and docs.** \`unicode/policy.ts\` claims a STATUS.md gap entry that does not exist — add
   the entry (a joiner outside a shaping context in a JSON member name reports \`UNRECOGNIZED_FIELD\`
   with no refusal) or fix the claim. \`packages/cli/src/commands/validate.ts\`'s module TSDoc and
   STATUS.md narrate CLI history ("an earlier revision of this CLI…") — state the current contract:
   stdin is TSON unless \`--input json\`, and this differs from the reference, which reads stdin as
   JSON when bound. \`dispatchTag.ts\`'s cross-reference to where \`dispatchMember.ts\` reports a
   self-tag is stale.

You are alone on the tree.`,
  },
  {
    key: 'json-test-port',
    phase: 'Tests',
    brief: `WP4G — port the rest of the reference's JSON test suite, case for case.

\`src/json/\` is complete. Eight of the reference's JSON test files have been ported case for case
(\`packages/tson/test/json-*.test.ts\`), and doing so found five real bugs. The rest were covered only
"in spirit" by tests written before, never checked against the Java. Port them now, as table-driven
vitest cases, each case keeping the Java method's name in its title:

\`JsonContainerReadTest\`, \`JsonMapReadTest\`, \`JsonAtomReadTest\`, \`JsonBaseSyntaxDiagnosticTest\`,
\`JsonIdentifierPolicyTest\`, \`JsonTokenPolicyTest\`, \`AllOrNothingReadTest\`, \`CollectingJsonReadTest\`,
\`JsonFrontDoorTest\`, \`JsonTreeWriterTest\`, \`lexer/JsonLexerTest\`, \`stream/JsonStreamTest\`,
\`tree/JsonValueTest\`, \`JsonTest\` — all under \`.references/ltr8-io-tson-java/tson-json/src/test/\`.
Check \`git status\` first: a previous pass may have started some (\`json-base-syntax-diagnostic.test.ts\`
exists). Where an existing TS test file already covers a Java file, EXTEND it with the missing cases
rather than creating a parallel file. Skip only Java-host object binding (\`JsonObjectReader\` into
Java classes, \`JsonObjectWriterTest\`, allocation/perf harnesses) and list what you skipped.

Where a ported case FAILS, the port is wrong unless Part 3 or Part 2 says otherwise: fix the code;
where Part 3 disagrees with the reference, follow Part 3, pin the case with a comment citing the
section, and report it. Every fix gets the ported case as its regression test.

You are alone on the tree.`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'tests', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    api: { type: 'string', description: 'the public API added, with signatures' },
    tests: { type: 'string', description: 'test files and counts' },
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
  required: ['key', 'sound', 'gatesGreen', 'problems'],
  properties: {
    key: { type: 'string' },
    sound: { type: 'boolean' },
    gatesGreen: { type: 'boolean' },
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
  required: ['discovered', 'passing', 'unitGreen', 'buildGreen', 'failures'],
  properties: {
    discovered: { type: 'number' },
    passing: { type: 'number' },
    unitGreen: { type: 'boolean' },
    buildGreen: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } },
  },
};

const VERIFY = `Adversarially review one work package of the TSON TypeScript port's new JSON encoding
(TSON Part 3, \`spec/tson-part3-json.md\`). Default to finding it UNSOUND.

1. Run \`npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance && npm run build && npm run check:package && npm run smoke:cli\`
   yourself. Conformance must still be 328/328.
2. Read the Part 3 sections the brief cites against the CODE. Every MUST implemented? Probe it:
   write a few throwaway inputs (a lone surrogate escape, a BOM, a duplicate member after NFC, a
   number with 40 digits, \`1.0\` at an integer position, an undeclared member, a look-alike member
   name) and check what actually happens. Delete your probes afterwards.
3. **The hard constraints.** Does anything call \`JSON.parse\`, \`TextDecoder\`, or index a JS
   string by UTF-16 unit for a column or offset? Is anything that can starve for input NOT a
   \`Task<T>\` generator — is there a second, async-only copy of any grammar? Does anything buffer a
   whole document, or a whole object, where the spec bounds lookahead? Any Node built-in, runtime
   dependency, or DOM type?
4. **Zones and reuse.** Does \`src/json/\` import \`lexer\`, \`stream\`, \`reader\`, \`compiler\`,
   \`tree\`, \`write\` or \`facade\`? Was an ESLint zone relaxed rather than an import fixed? Is there a
   second copy of something the port already has — value identity, the omission derivation,
   disjointness, NFC, the identifier grammar?
5. Stale or history-bearing TSDoc; tests asserting what the code produces rather than what Part 3
   requires; the \`./json\` subpath missing from package.json exports, the tsup entries, or the
   browser-bundle test.

Report only problems you can point at a file and line for. Set gatesGreen from what you ran.`;

const results = [];
for (const pkg of PACKAGES) {
  const port = await agent(`${PORTER}\n\n---\n\n${pkg.brief}`, {
    label: `port:${pkg.key}`,
    phase: pkg.phase,
    model: 'sonnet',
    schema: PORT_RESULT,
    effort: 'high',
  });
  if (port === null) {
    log(`${pkg.key}: returned nothing — stopping, the next package builds on it`);
    results.push({ key: pkg.key, port: null });
    break;
  }
  log(`${pkg.key}: ${port.status}`);

  const verdict = await agent(
    `${VERIFY}\n\nWork package brief:\n${pkg.brief}\n\nThe porter claims: status ${port.status}; API ${port.api}; tests ${port.tests}; notes: ${port.notes}`,
    { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
  );

  let repair = null;
  const serious = verdict === null ? [] : verdict.problems.filter((p) => p.severity !== 'minor');
  if (verdict === null || !verdict.gatesGreen || serious.length > 0 || port.status !== 'complete') {
    log(`${pkg.key}: repair — ${String(serious.length)} serious problems`);
    repair = await agent(
      `${PORTER}\n\n---\n\n${pkg.brief}\n\n---\n\nA first porter has done most of this package; its work is in the tree. You are the REPAIR pass. Its report:\n${JSON.stringify(port, null, 2)}\n\nAn adversarial reviewer found:\n${JSON.stringify(verdict, null, 2)}\n\nFix every blocking and significant problem, and anything left unfinished, until the definition of done holds. Do not undo correct work.`,
      {
        label: `repair:${pkg.key}`,
        phase: 'Repair',
        model: 'sonnet',
        schema: PORT_RESULT,
        effort: 'high',
      },
    );
  }
  results.push({ key: pkg.key, port, verdict, repair });
}

const sweep = await agent(
  `Run \`npm run typecheck\`, \`npm run lint\`, \`npm run format:check\`, \`npm test\`,
\`npm run test:conformance\` and \`npm run build\` for the TSON TypeScript port and report the real
numbers. Conformance must be 328 discovered and 328 passing. List every failure by name with its
actual cause. Fix nothing.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'medium' },
);

return { stage: '4d', results, sweep };
