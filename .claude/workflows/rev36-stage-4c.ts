export const meta = {
  name: 'tson-rev36-stage-4c',
  description:
    'Revision 36 Stage 4c: Part 3 against the reference JSON test suite in full, the 9.4 categories, 3.3 at atom positions, and the CLI stdin kept TSON',
  whenToUse: 'After Stage 4b is committed. One package.',
  phases: [
    { title: 'Parity', detail: 'WP4E: the full test port and four findings' },
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
    key: 'json-parity',
    phase: 'Parity',
    brief: `WP4E — finish Part 3 against the reference's own test suite, and close four open findings.

\`src/json/\` is complete and green (\`git log --oneline -4\`). Its tests are much thinner than the
reference's, and thin tests are how the divergences below survived two reviews.

1. **Port the reference's JSON test suites IN FULL**, case for case, as table-driven vitest cases:
   \`CrossEncodingParityTest\` (52 cases — each asserts the SAME diagnostic codes and RFC 6901 pointers
   from this port's TEXT \`validate\` and its JSON read, with the legitimate divergences pinned
   explicitly; this is Part 3 §1.5's Class 3 equivalence check and the most important file),
   \`JsonTaggedValueReadTest\`, \`JsonSealedFamilyReadTest\`, \`JsonChoiceReadTest\`,
   \`JsonAliasTagReadTest\`, \`SealedFactoryEncodingParityTest\`, \`TemplateFamilyEncodingParityTest\`,
   and any other \`tson-json/src/test/\` file whose cases concern reading and are not yet ported.
   Skip only cases exercising Java-host binding (\`JsonObjectReader\` into Java classes, records,
   sealed interfaces) — list what you skipped and why. Where a ported case FAILS, the port is wrong
   unless Part 3 or Part 2 says otherwise: fix the code, and where Part 3 disagrees with the reference,
   follow Part 3, pin the case with a comment citing the section, and report it. Also: do the text-side
   halves of the parity cases agree with this port's text stack? A text-side mismatch is a finding
   against the text stack; fix it if it is a real bug and report it.
2. **§9.4's categories.** An unknown \`$\` name, a misplaced reserved member, \`$value\` outside a
   \`$type\`-led object and a non-reserved extra in a wrapper are RESOLVER-category errors (§3.2,
   §3.3, §9.4's table). Several sites report them as \`UNRECOGNIZED_FIELD\`, a validation code
   (\`reservedMembers.ts\`, \`record.ts\`, \`dispatchTag.ts\`, \`dispatchMember.ts\`,
   \`dispatchChoice.ts\`). Read what the reference reports for each and what \`core/diagnostic.ts\`
   maps to the resolver category, choose codes whose category is right, and assert the category in
   tests.
3. **§3.3 recognition at typed non-record positions.** \`{"n": {"$type": "int32", "$value": 1}}\` at an
   \`int32\` field reports \`NOT_IMPLEMENTED\` (\`atoms.ts\` \`reportUnreadable\`), and likewise at array
   and tuple positions. §3.3: at any typed position other than a map-typed one, an object whose first
   member is reserved is an annotation object — read the wrapper, check \`$type\` admissible, read
   \`$value\` at the position. Implement it unless the reference also leaves it a gap AND Part 3 lets
   it; say which.
4. **The CLI's standard input.** Since WP4D, \`cat data.tn | tson validate --schema s.tn --root person -\`
   reads stdin as JSON, so an invocation that worked before this revision now fails. The reference
   does the same, but this CLI shipped the TSON behaviour first. Keep it working: standard input is TSON
   unless the caller says otherwise, with a new \`--input tson|json\` option (default: by extension
   for files, \`tson\` for \`-\`) that forces the encoding; update \`--help\`, the CLI tests, the smoke
   script, README and \`skills/tson-ts/\`, and record the divergence from the reference in
   \`STATUS.md\`.

You are alone on the tree.`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'api', 'tests', 'specFindings', 'notes'],
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

return { stage: '4c', results, sweep };
