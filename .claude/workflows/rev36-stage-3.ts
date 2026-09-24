export const meta = {
  name: 'tson-rev36-stage-3',
  description:
    'Revision 36 Stage 3: the behaviour the change log does not state -- ATOM_FORM_INVALID, UNKNOWN_TYPE_REF narrowed, value identity over scale and instants, !boolean, not judged, all-or-nothing reads, pin-checked registration',
  whenToUse:
    "After Stage 2's gate (328/328) is committed. Three sequential packages; they share subsumption.ts.",
  phases: [
    { title: 'Diagnostics', detail: 'WP3A: codes, identity, !boolean, not judged' },
    { title: 'Reads', detail: 'WP3B: all-or-nothing, pin-checked registration' },
    { title: 'Leftovers', detail: 'WP3C: what the Stage 2 review left open' },
    { title: 'Verify', detail: 'adversarial review of each package' },
    { title: 'Repair', detail: 'one repair round per package that failed review' },
    { title: 'Sweep', detail: 'measure the vectors and name what is still red' },
  ],
};

const START = args && args.startCommit ? args.startCommit : 'HEAD';
const FAILING = args && args.failing ? args.failing : '(see the sweep)';

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This is a REVISION run, not a fresh port. The code passed all 277 vectors of 2026 Revision 35, and
Stages 1 and 2 of the move to Revision 36 have landed (328/328 conformance): the four-fact \`record_field\` (\`optional\`,
\`voidable\`, \`role\`, \`value\`), the three-slot field grammar, and the definition marks and \`=?\`
lowered into \`RecordBody.extension\` / \`discriminators\`, the discriminated family judged and
dispatched, templates as family bases, declared applications as entries, enum profiles and text
member sets.
Your package builds on that model; you are looking for what the Revision 36 text requires that the
code does not do yet.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions.
2. \`REVISION-36-PLAN.md\` — the whole plan, then your work package. Your brief is the authority
   where the two differ.
3. \`spec/tson-rev36-changelog.md\` — the adjudicated changes with their reasoning. Your brief names
   the entries (#10, #13 …) that are yours; read their disposition rows in §2.
4. The spec sections your package implements, in \`spec/tson-part2-schema.md\` (Revision 36). Read
   the section text, not the summary. \`spec/m/meta-kernel.tn\`'s @doc text on \`record\`,
   \`record_extension_type\`, \`template\`, \`enum\` and \`text_type\` states rules too.
5. The Java reference at the new pin, \`.references/ltr8-io-tson-java/\`, including Javadoc. Your
   brief names the classes.
6. Your vectors in \`.references/ltr8-io-tson-test-suite/tests/\` — subject AND \`-expected.tn\`
   sidecar — and the fixture schemas under \`schemas/fixtures/\` they name. \`RUNNER.md\` is
   normative for runners.

# How to port

Idiomatic TypeScript, not transliterated Java. Behaviour comes from the spec and the vectors. Never
weaken a \`Task<T>\` signature. No \`RegExp\` in \`src/base/\`. The lexer is code-point addressed.
Zero runtime dependencies. \`packages/tson/src/schema/meta/\` is FROZEN: if something there is
genuinely wrong, say so and stop rather than editing it — call its derivations rather than
re-deriving (the omission derivation, \`typeKind\`, \`isConstructor\`, \`choiceDisjoint\`).

**Delete what the revision removes**, and replace tests of the old behaviour with tests of the new,
citing the section. **TSDoc documents current contract only** — never "Revision 35", "used to", "no
longer"; rewrite TSDoc in the same edit that changes behaviour, with current \`§\` citations.

# Tests and done

Write tests from the spec, citing the section in the test name. The suite discovers **328 subjects**;
that must not drop, and nothing green may go red. Do not modify \`test/conformance/\` beyond the one edit a brief explicitly permits. If a vector
looks wrong, report it.

\`\`\`bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance
\`\`\`

If a lint zone rule fires, fix the import, not the rule.

# Report back

Files changed; vectors moved to passing, by name, verified by running them; every spec ambiguity with
the reading you chose; anything unfinished, stated plainly.`;

const PACKAGES = [
  {
    key: 'diagnostics-identity',
    phase: 'Diagnostics',
    brief: `WP3A — diagnostics, value identity, \`!boolean\`, and "not judged".

These are behaviours the reference carries at the new pin that no single change-log line names, plus
three small change-log items. Each is small; do all of them. The Java reference is the authority
for the first three, and the spec for the rest.

1. **\`!boolean\` in the schemaless vocabulary** ([TSON-DATA] §5.5, change log #8).
   \`reader/schemaless/vocabulary.ts\` says in its TSDoc that \`!boolean\` is deliberately not
   registered; that is now wrong. It accepts exactly \`true\` and \`false\`, case-sensitive; any other
   token is the enum-member violation — a validation error. A typed position does not consult the
   form: \`!boolean "true"\` and \`!boolean true\` are one value. Unit tests from §5.5; confirm no
   Class 1 vocabulary vector regresses.
2. **\`ATOM_FORM_INVALID\`, a new diagnostic code** (Java \`tson-atom/.../AtomRefusal.java\`,
   commit 58b74e06; [TSON-DATA] §5.2, §8.1). A token the atom's GRAMMAR rejects is a *resolver*
   error, \`ATOM_FORM_INVALID\`; a parsed value outside the type's constraints stays
   \`ATOM_CONSTRAINT_VIOLATION\`, a *validation* error; a numeric value outside the target's range
   is a constraint violation, not \`TYPE_MISMATCH\`. Map it in ONE place. The split rides on the
   existing \`TsonAtomParseError\` / \`TsonAtomValidationError\` in \`core/errors.ts\`. Sites:
   \`reader/tree/atom.ts\`, \`reader/bind.ts\`, \`reader/schemaless/typeRefCheck.ts\`, and wherever
   else a \`TsonAtomTypeError\` becomes a diagnostic. Place the code in \`core/diagnostic.ts\` between
   \`UNKNOWN_TYPE_REF\` and \`ATOM_CONSTRAINT_VIOLATION\` as the Java orders it. \`test/conformance/validate.ts\`
   keeps category sets per code: add \`ATOM_FORM_INVALID\` to the resolver set — this is the ONE
   edit to \`test/conformance/\` you are permitted, and you must not change any other rule there.
   Update \`skills/tson-ts/references/diagnostics.md\` if it lists codes. Every conformance vector
   must still pass with its stated category.
3. **\`UNKNOWN_TYPE_REF\` means the name denotes nothing** (Java commits b54104b4, 8a7b956c;
   \`base/diagnostics/SubsumptionDiagnostics\`; §7.2). A name that RESOLVES but is not admissible —
   §7.2 subsumption, a choice variant, a union member — and a required tag that is absent are
   \`TYPE_MISMATCH\`. Sites today: \`compiler/subsumption.ts\`, \`compiler/choiceReader.ts\`,
   \`reader/bind.ts\`, \`bind/decode.ts\`, and any family dispatch reader Stage 2 added. A name that
   resolves to nothing stays \`UNKNOWN_TYPE_REF\` (\`typeRefCheck.ts\` is already right).
4. **Value identity** (Part 2 §5.5; [TSON-DATA] §2.6; §7.5; §5.2). Two gaps in
   \`reader/tree/equality.ts\` and \`base/numberNarrowing.ts\`'s exact decimal: (a) **scale is a
   spelling** — \`1\`, \`1.0\`, \`1.00\` are one \`number\`, and \`199.90\` / \`199.9\` one decimal, for
   set members, map keys and a FIXED check; normalise trailing zeros in the comparison, never in the
   stored value (Java \`ValueIdentity.java\`, commit b32e44d5). (b) **\`time\` and \`datetime\` compare as
   instants** — a datetime by UTC instant, a time by time-of-day in UTC (which wraps); the offset
   as written is preserved but is not identity (commit 8e1783f8). Ordering is already right; do
   not change it. If Stage 2 wrote its own pin-equality helper for families, make it and this one
   ONE function.
5. **Not judged** ([TSON-DATA] §8.1, Part 2 §10.1, §10.2; change log #19). The fifth outcome is
   *not judged*, with two members: a refusal (§8.2, §9.1) and an **unavailable schema**. The five
   \`SCHEMA_*\` fetch codes and \`isVerdict\` in \`core/diagnostic.ts\` already keep an unobtainable
   schema out of the four categories; check the TSDoc, the CLI's \`NOT_CHECKED\` outcome and its
   help text say *unavailable* / *not judged* in §8.1's terms, that the diagnostic is located at the
   reference, and that a pin MISMATCH (§10.2) stays a resolver error — it is a finding about
   obtained bytes. Change wording and TSDoc only where they are wrong; do not rename codes.

Stay out of \`link/recordExtension.ts\` and the family dispatch logic except to change a code.`,
  },
  {
    key: 'reads-registration',
    phase: 'Reads',
    brief: `WP3B — all-or-nothing reads, pin-checked registration, and a refused name's silence.

WP3A (codes and identity) has landed just before you.

1. **Every read is all-or-nothing** (Java commit 6b03992b; \`TsonTreeReader\`, \`ConstructionGuard\`,
   \`tson-base\` \`CountingReceiver\`; the reference's README and \`STRUCTURED-OUTPUT.md\`). In tree
   mode as in bind mode, a container whose contents reported anything is not built, and each facade
   counts diagnostics for the whole document — token-policy refusals included — and yields NO value
   when any was reported. Bind mode here already abandons per value (\`reader/bind.ts\`
   \`abandonedValue\`). Tree mode does not: \`facade/tree.ts\` \`validate\` returns a partial tree,
   \`compiler/compile.ts\`'s \`ValidationResult.value\` is always a \`Value\`, and
   \`compiler/subsumption.ts\` returns \`absentNode()\` as a placeholder for a refused value. After
   this package an absent node ALWAYS means a written \`_\`, never "something was refused here".
   Diagnostics are still ALL reported in one pass — the web demo's whole point is that one
   \`validate()\` call reports every fault (\`packages/tson/test/web-demo.test.ts\`); only the VALUE
   is withheld. Make the result type say so (\`value?\`, optional per CLAUDE.md's rule) and update
   every caller: the facade, the CLI, the web demo, tests. Read the reference's
   \`.references/ltr8-io-tson-java/STRUCTURED-OUTPUT.md\` for the contract as stated.
2. **A schema registered in-process is pin-checked like a fetched one** (Java commit 7513ae4b;
   \`TsonCompiledMetaRegistry\`, \`TsonContentHash.sha256IfAddressable\`; [TSON-DATA] §2.2.1, Part 2
   §10.2). Registering from source text verifies the document's own \`!!id\` \`?sha256=\` and records
   its hash; a later PINNED reference to that identity is verified against it. A single-line schema
   (no id-line terminator) loads, but no reference may pin it. \`validateSchema\` reports a pin
   failure rather than throwing. Today only a fetched reference is verified (\`config.ts\`
   \`preload\` → \`verifyContentHash\`; \`resolveSchema\` skips it). \`link/contentHash.ts\`.
3. **A name §8.2 refused draws no \`UNRECOGNIZED_FIELD\` beside its refusal** (Java commit
   f78f8a32; \`RecordAbstractReader\`). Where a record's field name is refused by the identifier or
   token policy, the reader must not ALSO report it as an unknown field; a \`FIELD_REQUIRED\` for
   the field the author meant still stands. Find where this port applies name hygiene to a record's
   field names on the schema-directed paths (\`reader/tree/record.ts\`, \`reader/bind.ts\`); if it
   applies it only on the schemaless path, say so in your report rather than building policy
   checks onto every read path — that wider gap is recorded as out of scope for this revision.`,
  },
  {
    key: 'stage-2-leftovers',
    phase: 'Leftovers',
    brief: `WP3C — what Stage 2's review left open. Each item was reproduced by the manager or by an
adversarial reviewer; each is a real defect against Revision 36, not a style point.

1. **A parametric pin closed at a composition operand keeps an unmarked name** (§5.7 "Open
   modifiers", §5.10). With \`pet => <N, T> { type: text = N  pet: T }\`, the declaration
   \`pd => pet<"dog", text>\` correctly resolves \`type\` to \`optional: true, role: FIXED\` — §5.7:
   "\`= P\` becomes optional and \`FIXED\` with the argument as its value … the name mark supplied by
   the closing". But \`dog => pet<"dog", text> & { breed: text }\` resolves \`dog.type\` to
   \`optional: false, role: FIXED\`: the composition-operand path (an application at an operand is
   subsumed where it stands and mints nothing, §5.8) skips the fixation's name mark. Make both paths
   share ONE fixation.
2. **A member-dispatched template family base is not read** (§5.10, §1.3). A record-bodied
   template whose selectors survive parameter erasure gets non-empty derived
   \`template.discriminators\`, but \`compiler/compile.ts\` / \`compiler/subsumption.ts\` throw
   \`TsonNotImplementedError\` when such a base is named at a type position. §5.10 says such a base
   dispatches exactly as a member-dispatched record does, over its instantiations, never reading the
   held body. Reuse the record family's member-dispatch reader; do not write a second. Java:
   \`reader/AbstractTemplateReader.java\` and its member-dispatch path.
3. **A FIXED check compares annotations as well as the value** (§5.2 "the FIXED check", §5.5).
   \`reader/tree/record.ts\` compares the written value's whole tree node, annotations included,
   against the pin, so \`pet_type: @doc:"x" dog\` never equals \`= "dog"\`. A pin is compared as a
   VALUE; annotations are not part of a value's identity.
4. **A text \`pattern\` is not enforced at read time** (§7.4, §5.5). \`atom/text/text.ts\` and
   \`compiler/atomBuilder.ts\` still carry TSDoc saying pattern enforcement waits for a regex matcher;
   \`regex/\` has one, and Stage 2 already uses it for member coherence. Enforce \`pattern\` for
   \`text_type\` and every family composing it (\`uri_type\`, \`email_type\`, \`regex_type\`) at read,
   as \`ATOM_CONSTRAINT_VIOLATION\`, and correct the TSDoc. Also: a \`uri_type\` / \`email_type\`
   member must satisfy the family's own facets (\`scheme\`, and parsing as a URI / address) — §7.4's
   "every member satisfies the body's other facets".
5. **\`a: void\` through an alias** (§5.2, §5.10.1). \`link/typeInhabitance.ts\` refuses a required,
   non-voidable \`void\` field only when the type is spelled \`void\`; follow the reference chain.

Stay out of \`src/json/\` if it exists.`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'vectorsGreen', 'passing', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    vectorsGreen: { type: 'array', items: { type: 'string' } },
    passing: { type: 'number', description: 'conformance subjects passing after your change' },
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
  required: ['discovered', 'passing', 'failing', 'unitGreen', 'remaining'],
  properties: {
    discovered: { type: 'number' },
    passing: { type: 'number' },
    failing: { type: 'number' },
    unitGreen: { type: 'boolean' },
    remaining: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vector', 'cause', 'owner'],
        properties: {
          vector: { type: 'string' },
          cause: { type: 'string' },
          owner: { type: 'string' },
        },
      },
    },
  },
};

const VERIFY = `Adversarially review one work package of the TSON TypeScript port's move to 2026
Revision 36. Default to finding it UNSOUND: try to refute the claim that it implements the new text.

1. Run \`npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance\`
   yourself. 328 discovered? The claimed vectors green? Anything that was green gone red?
2. Read the Revision 36 section text the brief cites (\`spec/tson-part2-schema.md\`) against the
   CODE, not the report. Every clause implemented, including ones the brief did not spell out?
   Compare with the Java class the brief names where the spec is terse.
3. Did it leave an old path reachable behind a flag, fallback or lenient default?
4. Stale TSDoc or \`§\` citations — "Revision 35", "used to", "no longer", a comment describing
   what the code did before. First-class, not a nit.
5. Weakened \`Task<T>\`, a runtime dependency, RegExp in src/base/, relaxed ESLint zone, an edit to
   \`schema/meta/\`, or to \`test/conformance/\` beyond the one edit the brief permits?
6. A local re-derivation of something \`schema/meta/\` already derives — omission, kind,
   constructorness, disjointness?
7. Tests asserting what the code happens to produce rather than what the spec requires.

Report only problems you can point at a file and line for. Set gatesGreen from what you ran.`;

log(`Revision 36 Stage 3 from ${START}. Entering: ${FAILING}`);

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
    log(`${pkg.key}: returned nothing — stopping, later packages build on it`);
    results.push({ key: pkg.key, port: null });
    break;
  }
  log(`${pkg.key}: ${port.status}, ${String(port.passing)} passing`);

  const verdict = await agent(
    `${VERIFY}\n\nWork package brief:\n${pkg.brief}\n\nThe porter claims: status ${port.status}; files ${port.filesWritten.join(', ')}; vectors green ${port.vectorsGreen.join(', ') || '(none)'}; notes: ${port.notes}`,
    { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
  );

  let repair = null;
  const serious = verdict === null ? [] : verdict.problems.filter((p) => p.severity !== 'minor');
  if (verdict === null || !verdict.gatesGreen || serious.length > 0 || port.status !== 'complete') {
    log(`${pkg.key}: repair — ${String(serious.length)} serious problems`);
    repair = await agent(
      `${PORTER}\n\n---\n\n${pkg.brief}\n\n---\n\nA first porter has done most of this package; its work is in the tree. You are the REPAIR pass. Its report:\n${JSON.stringify(port, null, 2)}\n\nAn adversarial reviewer found:\n${JSON.stringify(verdict, null, 2)}\n\nFix every blocking and significant problem, and anything left unfinished, until the definition of done holds and the package's vectors are green. Do not undo correct work.`,
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
  `Run \`npm test\` and \`npm run test:conformance\` for the TSON port at 2026 Revision 36 and report
the real numbers. Stage 3's gate is 328/328 and unit green. For every failing vector give the ACTUAL cause — read
the failure — and the owner (WP3A, WP3B, or an earlier stage). DISCOVERED must be 328, or the harness is broken and that is the finding. List any failing
unit test. Fix nothing.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'medium' },
);

return { stage: 2, results, sweep };
