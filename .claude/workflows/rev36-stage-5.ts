export const meta = {
  name: 'tson-rev36-stage-5',
  description:
    'Revision 36 Stage 5: the sweep — /2026/36/ identities everywhere, version 0.36.0, STATUS, CLAUDE, IDIOM-DEBT, README, the skill and the web demo brought to Revision 36, and the full CI list green',
  whenToUse: 'After Stage 4b is committed. One package, then an independent review.',
  phases: [
    { title: 'Sweep', detail: 'identities, versions, docs' },
    { title: 'Verify', detail: 'independent review against the CI list and the docs' },
    { title: 'Repair', detail: 'one repair round if needed' },
  ],
};

const BRIEF = `You are finishing the TSON TypeScript port's move to 2026 Revision 36. Every behavioural
stage has landed (\`git log --oneline -12\`): the four-fact record_field, families, templates, enum
profiles, the reference's unstated behaviour, and Part 3 (the JSON encoding under \`./json\`).
Conformance is 328/328. This package is the sweep — no behaviour changes — and it ends with the
FULL CI list in \`CLAUDE.md\`'s "Build and test" section green, in order.

Read \`CLAUDE.md\`, \`REVISION-36-PLAN.md\` (Stage 5, Scope decisions, To report upstream) and
\`spec/tson-rev36-changelog.md\` §4 first.

1. **Identities.** \`git grep -n -e '2026/35' -e 'Revision 35'\` outside \`spec/\` and
   \`REVISION-35-PLAN.md\` and \`.claude/workflows/rev35-*\`: move every current-state reference to
   \`/2026/36/\` / Revision 36 — tests, \`README.md\`, \`packages/tson/src/config.ts\`,
   \`skills/tson-ts/\`, \`examples/web-demo/\`, \`STATUS.md\`. Historical mentions that are genuinely
   about Revision 35 (the plan file, the old workflow scripts) stay.
2. **Spelling.** Any TSON schema text in docs, the skill, examples, CLI \`init-example\` output or
   README still written in Revision 35's field grammar (\`a: T?\` meaning an omittable key, \`= _\`,
   \`@discriminator\`, \`@rest\`) is re-spelled in the three-slot form (\`a?: T\`, \`a?: void?\`, \`=?\`
   with \`abstract\`). Run every example you touch through the CLI to prove it still compiles.
3. **Versions.** Both packages to 0.36.0, and the CLI's dependency on \`@ltr8/tson\` to match; keep
   \`package-lock.json\` consistent WITHOUT running \`npm install\` (read CLAUDE.md's lockfile section —
   edit the workspace version fields in the lockfile by hand, then \`npm ci\` must succeed and
   \`npm run check:lockfile\` must pass).
4. **STATUS.md**: 328/328 at the Revision 36 pin, with the per-layer breakdown recounted from the
   suite; the Part 1 and Part 2 checklists updated for what Revision 36 added (three-slot fields,
   record extension and families, type_ref supertypes, template family bases, declared applications,
   enum profile, text members, class stability, !boolean, ATOM_FORM_INVALID, value identity, not
   judged, all-or-nothing reads, pin-checked registration); a Part 3 section for the JSON encoding
   with its recorded gaps; known gaps refreshed — remove any Revision 35 gap now closed, add what
   REVISION-36-PLAN.md's Scope decisions record (token policy only on the schemaless path, §9.1 limits
   beyond depth, the Part 3 gaps). Read the Stage 1–4 commit messages for the findings.
5. **CLAUDE.md**: the Project section lists Part 3 and its URL; \`spec/\` holds three parts and the
   change log; the "Spec feedback" note quoting \`enum_set\` as \`!set_type { element_type: identifier }\`
   becomes \`text\`; the Layering section gains the \`src/json\` zone and why; the Build-and-test and
   Conformance sections' counts are 328. Keep its voice: current state, present tense, no history.
6. **IDIOM-DEBT.md**: confirm Stage 4 registered the parallel JSON stack; add anything else this run
   mirrored from the Java on purpose.
7. **ORCHESTRATION.md**: its wave table and counts are the original port's; make any count or file
   name that is presented as current read correctly (328, \`REVISION-36-PLAN.md\`), without rewriting
   its history.
8. **README.md** and \`skills/tson-ts/\` (SKILL.md and references): Revision 36 throughout, the
   ValidationResult's optional value, ATOM_FORM_INVALID in the code table, the JSON front door and
   \`tson validate\` on \`.json\`, and nothing claiming TSON is a JSON superset.
9. **Stale TSDoc.** \`git grep -n -e 'Revision 35' -e 'no longer' -e 'used to' -e 'change log #' -- packages\`
   and fix every instance that narrates history rather than stating current contract (CLAUDE.md).

Then run, in order, and all must pass: \`./scripts/fetch-references.sh\`, \`npm ci\`,
\`npm run typecheck\`, \`npm run lint\`, \`npm run format:check\`, \`npm run check:lockfile\`,
\`npm run check:unicode\`, \`npm test\`, \`npm run test:conformance\`, \`npm run build\`,
\`npm run check:package\`, \`npm run smoke:cli\`, \`npm run demo:web\`.

Do not modify \`spec/\` or \`test/conformance/\` beyond the identity table. Report files changed, the
result of each CI command, and anything you could not make green.`;

const RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'ci', 'filesWritten', 'notes'],
  properties: {
    status: { enum: ['complete', 'partial', 'blocked'] },
    ci: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'green'],
        properties: { command: { type: 'string' }, green: { type: 'boolean' } },
      },
    },
    filesWritten: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['sound', 'ciGreen', 'problems'],
  properties: {
    sound: { type: 'boolean' },
    ciGreen: { type: 'boolean' },
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

phase('Sweep');
const sweep = await agent(BRIEF, {
  label: 'sweep',
  phase: 'Sweep',
  model: 'sonnet',
  schema: RESULT,
  effort: 'high',
});

phase('Verify');
const verdict = await agent(
  `Independently review the Revision 36 sweep of the TSON TypeScript port (\`git diff HEAD\`). Default to
finding it incomplete. Run the full CI list in CLAUDE.md's "Build and test" section yourself, in order.
Then: \`git grep -n -e '2026/35' -e 'Revision 35'\` outside spec/, REVISION-35-PLAN.md and the rev35
workflow scripts — anything current-state left? Is any TSON schema text in docs, the skill, README,
examples or the CLI's init-example still in Revision 35's field grammar — try compiling each with the
built CLI? Does STATUS.md's count and per-layer breakdown match what the suite reports? Does anything
still claim TSON is a JSON superset? Does TSDoc narrate history? Is the lockfile consistent (npm ci,
check:lockfile)? Report only problems you can point at a file and line for.\n\nThe sweeper reported: ${JSON.stringify(sweep)}`,
  { label: 'verify', phase: 'Verify', schema: VERDICT, effort: 'high' },
);

let repair = null;
const serious = verdict === null ? [] : verdict.problems.filter((p) => p.severity !== 'minor');
if (
  verdict === null ||
  !verdict.ciGreen ||
  serious.length > 0 ||
  (sweep && sweep.status !== 'complete')
) {
  phase('Repair');
  repair = await agent(
    `${BRIEF}\n\n---\n\nA first pass did most of this; its work is in the tree. You are the REPAIR pass. Its report:\n${JSON.stringify(sweep)}\n\nA reviewer found:\n${JSON.stringify(verdict)}\n\nFix every problem, blocking to minor, and leave the full CI list green.`,
    { label: 'repair', phase: 'Repair', model: 'sonnet', schema: RESULT, effort: 'high' },
  );
}

return { stage: 5, sweep, verdict, repair };
