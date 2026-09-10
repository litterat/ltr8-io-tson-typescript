export const meta = {
  name: 'tson-rev35-stage-5',
  description:
    'Revision 35 Stage 5: scoped values (§7.8) — the governing schema switches on descent and reverts on exit — plus the Stage 4 findings its verify pass left open',
  whenToUse:
    'After Stage 4 is committed. The highest-risk stage: the port parses a scoped value and round-trips it, but nothing acts on it.',
  phases: [
    { title: 'Scoped', detail: 'the five class2/validate vectors nothing else can reach' },
    { title: 'Leftovers', detail: 'the Stage 4 verify findings, on disjoint files' },
    { title: 'Verify', detail: 'adversarial review of each package' },
    { title: 'Sweep', detail: 'measure and attribute what is still red' },
  ],
};

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This is a REVISION run, not a fresh port. The code exists and passes the previous revision's
vectors; your package moves it from 2026 Revision 34 to Revision 35. That changes how you read
everything below: you are looking for what the new spec text requires that the current code does
not do, and for what the current code does that the new spec text no longer allows.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions. They are not negotiable and they are not
   suggestions.
2. \`REVISION-35-PLAN.md\` — the whole plan, then your stage and your work package inside it. It
   says what moves and why. Your brief below is the authority where the two differ.
3. The spec sections your package implements, in the RE-VENDORED \`spec/\` at the repository root —
   \`spec/tson-part1-data.md\` and \`spec/tson-part2-schema.md\`. These are already Revision 35.
   Read the actual section text, not the revision summary at the top.
4. The Java reference at the new pin,
   \`.references/ltr8-io-tson-java/\`, including Javadoc. The Javadoc carries invariants and
   deliberate divergences the code alone does not show. \`.references/ltr8-io-tson-java/CONFORMANCE.md\`
   records where the reference is deliberately stricter than the JDK; those checks are the
   required behaviour, not the JDK's.
5. The conformance vectors your package should turn green, in
   \`.references/ltr8-io-tson-test-suite/tests/\`. Read the subject AND its \`-expected.tn\`
   sidecar. \`.references/ltr8-io-tson-test-suite/RUNNER.md\` is normative for runners.
6. The current TypeScript you are changing, and the contract-layer types it imports. Contract
   types are FROZEN for this stage. If one is genuinely wrong, say so and stop — do not edit it,
   because another package is compiling against it right now.

# How to port

**Idiomatic TypeScript, not transliterated Java.** Discriminated unions over class hierarchies,
plain functions over singleton objects, closures over \`MethodHandle\`. Same behaviour, same
conformance, different shape.

**Behaviour comes from the spec and the vectors, not from the Java's convenience**, and not from
what the code did last revision.

**Never weaken a signature.** Anything that can starve for input returns \`Task<T>\` and is called
with \`yield*\`. Do not "simplify" one to a plain return type; it breaks every caller above it and
the suspension cannot be reintroduced locally.

**No regex in the grammar.** The number grammar is hand-written, one function per ABNF rule, and
there is no \`RegExp\` in \`src/base/\`.

**The lexer decodes UTF-8 itself and is code-point addressed.** Never index a JS string by UTF-16
unit to derive a column or an offset.

**Zero runtime dependencies.** Not one, for any reason.

**Delete what the revision removes.** A revision that removes a rule is not served by leaving the
old code behind a flag. If Revision 35 deletes a form, delete the code that accepted it, and delete
the unit tests that asserted it — replacing them with tests that assert the new behaviour and cite
the new section.

# TSDoc

\`CLAUDE.md\`'s rule binds hardest on a revision run: **TSDoc documents current contract only, no
change history.** Never "changed in Revision 35", never "used to accept", never "renamed from". If
a design needs a WHY, state the current invariant and its rationale directly. When you change what
an exported type or function does, rewrite its TSDoc in the same edit, and re-cite the section —
a \`§\` citation that points at the old section number is worse than none.

# Tests

Write tests from the **spec**, not by translating the Java tests. Cite the section in the test name.

Run the shared vectors:

\`\`\`bash
npm run test:conformance
\`\`\`

At the Revision 35 corpus pin the suite discovers **277 subjects**. Whatever else moves, that number
must not drop: a run that discovers fewer has broken the harness rather than fixed anything, and
that is the finding ahead of any individual vector. **6 of the 277 fail as this stage begins**,
and they are named in the briefs. Nothing that is green may go red.

Do not modify the harness in \`test/conformance/\` to make a vector pass. If a vector looks wrong,
report it — it may be a genuine spec-feedback finding.

# Definition of done

These always, no exceptions:

\`\`\`bash
npm run typecheck          # clean
npm run lint               # clean, including the import/no-restricted-paths zones
npm run format:check       # clean
npm test                   # unit tests pass
npm run test:conformance    # 277 discovered; your vectors green; nothing regressed
\`\`\`

If a lint zone rule fires, fix the import, not the rule. The zones replace the reference
implementation's module system and carry real design weight.

# Report back

- Files created, changed or deleted.
- Which conformance vectors moved from failing to passing, by name, verified by running them.
- Every place the spec was ambiguous, underspecified, internally inconsistent, or plain wrong, with
  the interpretation you chose and why. Do not silently pick a reading.
- Anything you could not finish, stated plainly.`;

function requireAgents(results, expected, what) {
  const ok = results.filter((r) => r !== null);
  const lost = expected - ok.length;
  if (lost > 0) {
    log(
      `WARNING: ${String(lost)} of ${String(expected)} ${what} agents returned nothing. Their results are MISSING, not empty.`,
    );
  }
  if (ok.length === 0) {
    throw new Error(
      `every ${what} agent failed; aborting rather than reporting an empty result as success`,
    );
  }
  return ok;
}

const SCOPED = {
  key: 'scoped-values',
  brief: `Stage 5 — scoped values ([TSON-SCHEMA] §7.8, [TSON-DATA] §2.3, §3.3).

\`REVISION-35-PLAN.md\` calls this the highest-risk stage and it is right: the port parses a
scoped value and round-trips it through every reader and writer, but **nothing acts on it** — no
code switches the governing schema on descent and reverts on exit. Revision 35 makes that a real
feature and rebuilds the vocabulary around it.

Read §7.8 in full, and \`scoped\`'s own \`@doc\` in \`spec/m/meta.tn\`, which states the model
more precisely than the prose. Stage 3 already landed the TYPES: \`Scoped\` and \`ScopeKind\` in
\`packages/tson/src/schema/meta/typedef.ts\` replace \`Extern\`/\`UnknownType\`. What is missing
is every behaviour behind them — \`compiler/compile.ts\` throws
\`TsonNotImplementedError: '<name>' is a 'scoped' instance (§7.8) -- no compiled reader exists\`.

The vocabulary:

    scope_kind => !enum [LOCAL EXTERN]
    scoped     => sum & { scope: set<scope_kind>  schemas: {uri => [type_name;1..]?; 1..}? }

Core declares \`declared\` (\`[LOCAL]\`), \`extern\` (\`[EXTERN]\`), \`dynamic\`
(\`[LOCAL EXTERN]\`), and the templates \`extern_of<S>\` and \`extern_type<S, T>\`.

**Dispatch is uniform, by declared \`scope\` membership and value shape:**
- \`!!schema\` present on the value → EXTERN;
- \`!type\` alone → LOCAL;
- neither → a **validation error in every mode**.

**\`dynamic\` is narrower than the \`unknown\` it replaces.** The value must still name a type
and validate against it IN FULL, drawn from either namespace. Revision 34's \`unknown\` accepted
any well-formed value with no constraint; do not carry that leniency forward.

**Which positions admit a nested \`!!schema\` is now derived STRUCTURALLY** — from whether the
position's type resolves to a \`scoped\` instance carrying EXTERN — replacing Revision 34's fixed
list of permissive types. Find that list and delete it.

**A schemaless document opens no schema scope of its own**, so a nested \`!!schema\` inside one is
a validation error.

**\`schemas\` narrows the foreign namespaces.** Absent means any foreign schema; a keyed map means
those schemas; a key's absent value means every type that schema declares, where a list means those
types. Keys are compared by CANONICAL IDENTITY ([TSON-DATA] §2.2.1), so a pinned key and an
unpinned \`!!schema\` in the data match, and each pin is verified by the loader on its own. One
coherence rule: \`schemas\` requires EXTERN in \`scope\`.

**The foreign-schema count is a §9.1 limit, defaulting to 16**, which needs a lookup seam the
compiler can hand to each compile it performs.

**Your five vectors**, under \`.references/ltr8-io-tson-test-suite/tests/class2/validate/\`:
- \`valid/a-scoped-value-read-against-the-schema-it-names\`
- \`invalid/a-declared-position-opening-a-foreign-scope\`
- \`invalid/a-nested-schema-at-a-position-that-is-not-scoped\`
- \`invalid/a-scoped-value-naming-no-type\`
- \`invalid/an-extern-position-naming-no-schema\`

plus the \`scoped-host.tn\` / \`scoped-claim.tn\` fixtures those vectors' sidecars name. If the
harness does not register those fixtures, **report it** — you may not edit \`test/conformance/\`,
and pulling that forward is the manager's call, not yours.

Read each sidecar before you start: an \`invalid\` vector states a \`category\`, and at the
Class 2 validate layer that category is decided from the phase, never from whichever internal
diagnostic fired.

Do not touch \`compiler/atomChecks.ts\`, \`atomNarrowing.ts\`, \`atom/network/\`,
\`compiler/templates.ts\` or \`core/limits.ts\` — the other package owns those.`,
};

const LEFTOVERS = {
  key: 'stage-4-findings',
  brief: `Stage 4's verify pass left six findings open after the manager's own repair pass. Each is
quoted below with the evidence the reviewer gave; confirm each yourself before fixing it, and say
so plainly if one turns out not to hold.

**1. [TSON-SCHEMA] §11.5's five schema-side limits are not implemented, and the scope decision
cited as cover is about a different section.** \`REVISION-35-PLAN.md\`'s "Scope decisions" says to
record eleven of **[TSON-DATA] §9.1's twelve** document-side limits as gaps. §11.5's five are the
plan's WP4.9 deliverable and are named in it outright: import closure 64, entries per schema map
65,536, reference chain 64 hops, supertype chain 64, materialisation depth 64. §11.5 states them
"on the same terms, as part of the same policy and reported through the same surfaces", and
spec/tson-part2-schema.md:65 makes enforcing them a Class 2 MUST. Build all five.

\`ResourceLimitName\` in \`packages/tson/src/core/errors.ts\` is a closed union of
\`'nesting-depth'\` and must name them. Each is a counter at a site that already exists: the
import walk, the schema map, \`compiler/referenceChain.ts\`'s walk, the transitive supertype
chain, and materialisation. Exceeding one is a LIMIT REFUSAL naming the limit and the configured
threshold, never a resolver error — "the schema may be well-formed, load cleanly on the next
processor along, and be refused here because *this* deployment declined to spend the resources".
\`LIMIT_REFUSED\` already exists as a \`DiagnosticCode\` and the CLI already classifies a
refusal as a verdict; extend, do not re-invent.

**2. The limits policy is not reported.** §9.1: "The limits policy is reported beside the
identifier and token policies of §8.2, on the same terms: with any report that carries a refusal,
and SHOULD be reachable with no document in hand." \`Tson.limitsPolicy\` exists in
\`config.ts\` but stops at the library API — \`packages/cli/src/policyNode.ts\`'s
\`PolicyJson\` carries only \`identifier_policy\`, \`token_policy\` and
\`unicode_data_version\`, and that shape is what every validate/compile run's \`policy\` field
and \`tson policy\` both print. Carry the limits policy through both.

**3. \`float_type.format\`'s selector relation is a silent no-op for six of eight members.**
\`FLOAT_FORMAT_RANK\` is \`Record<FloatFormat, number>\` and \`FloatFormat\` is only
\`'BINARY32' | 'BINARY64'\`, while \`ieee_format\` in \`spec/m/meta.tn\` enumerates
BINARY16/32/64/128/256 and DECIMAL32/64/128. \`atomNarrowing.ts\`'s test is
\`rank(refined) > rank(source)\`, which is \`false\` whenever either rank is \`undefined\` — so
it passes by default where \`complexNarrows\` fails by default. Decide the relation over every
member \`meta.tn\` declares, and make an unknown member fail rather than pass.

**4. Facet coherence does not run again at materialisation.** §7.4: "at materialisation the same
rules run again over the operands that were parameters (§8.2)", and the plan states it as part of
WP4.6. \`compiler/templates.ts\`'s \`closeHeld\` calls \`deps.definitionMetaReader(target, value)\`
directly, bypassing \`definitionResolver.ts\`'s \`checkCoherent\` — the only call site of
\`checkAtomCoherence\` in the tree. Evidence: \`bounded => <N> !integer_type { min: N  max: 10 }\`
applied as \`bounded<20>\` resolves clean and mints a body whose bounds admit no value, which the
identical literal declaration correctly rejects.

**5. \`ipv4_type\`/\`ipv6_type\` and \`cidr4_type\`/\`cidr6_type\` disagree about the same
facet.** \`atomChecks.ts\`'s \`cidrNarrows\` does \`checkSubset(out, 'within', ...)\` for the
network families while the address families return \`[]\` unconditionally with a comment claiming
\`within\`/\`excluding\` are "neither of which is a narrowing relation". So
\`restricted => !ipv4 ^ { within: ["10.0.0.0/8"] }\` refined by \`^ { within: [] }\` widens to
every address while claiming IS-A and is accepted, where the identical edit on a \`cidr4\` is a
resolver error. §5.7 makes a member set shrink-only. One facet, one verdict — decide which and
make both families agree, citing §5.7.

**6. Group-member annotations are discarded, and §5.8's merge does not reach the group restatement
site.** §12.1 gives \`group-member = *annotation field-name ws ":" ws type-ref\`, and the parser
preserves them (\`ast/schema/fields.ts\`'s \`GroupMember.annotations\`, carried onto the wire
\`record_field\` by \`desugar.ts\`), but \`definitionResolver.ts\`'s \`resolveGroupMember\`
hardcodes \`annotations: []\` and \`restatesInheritedGroup\` never touches field annotations.
Apply §5.8's merge there too — the restatement's own annotations in source order, then the
inherited field's in source order.

**Also**: \`skills/tson-ts/references/diagnostics.md\` still places
\`TsonNameHygieneRefusedError\` as a direct child of \`TsonError\` and says so in prose;
\`TsonRefusedError\` now sits between them, and \`TsonLimitRefusedError\` (with
\`.limit\`/\`.configuredThreshold\`) appears nowhere. Its "Which error comes out of where" table
also still says \`validate\` throws "nothing, for any document". Fix all three.

And \`compiler/templates.ts\`'s module doc still says an instantiation entry "is keyed on the
flattened application recorded in \`source\`" and is "a pure function of a head and an argument
list, nothing else" — flattening is gone (§8.3) and the derived name now consults the namespace to
walk argument chains (§8.2). \`CLAUDE.md\` makes a stale contract doc a first-class defect.

Do not touch \`compiler/compile.ts\`'s scoped dispatch, \`reader/\`'s scope descent, or
\`test/conformance/\` — the other package owns the first two and nobody owns the third here.`,
};
const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'vectorsGreen', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    vectorsGreen: {
      type: 'array',
      items: { type: 'string' },
      description: 'vector names that moved from failing to passing, verified by running them',
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

const SWEEP = {
  type: 'object',
  additionalProperties: false,
  required: ['discovered', 'passing', 'failing', 'remaining'],
  properties: {
    discovered: { type: 'number' },
    passing: { type: 'number' },
    failing: { type: 'number' },
    remaining: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vector', 'cause', 'owner'],
        properties: {
          vector: { type: 'string' },
          cause: { type: 'string', description: 'the actual reason, not the assertion message' },
          owner: { type: 'string', description: 'the work package or later stage that owns it' },
        },
      },
    },
  },
};

const CONTEXT = `Stages 0 to 4 have landed. \`spec/\` at the repository root IS Revision 35 and
\`.references/\` is at the new pins. \`packages/tson/src/schema/meta/\` is FROZEN -- import from
it, and if something there is genuinely wrong, say so and stop rather than editing it.

6 of 277 vectors fail entering this stage, all five scoped-value ones plus one resolved-output
vector Stage 6 owns. Read \`spec/\`, not a cached memory of Revision 34.

The other package in this wave is running against the same tree. Stay strictly inside the files
your brief names; if you need a change in one it owns, report it rather than making it.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`;

const VERIFY = `Adversarially review this work package of the TSON TypeScript port's move to 2026
Revision 35. Default to finding it UNSOUND: refute the claim that it implements the new spec text.

Check, in this order:

1. Run the gates yourself. Do the claimed vectors actually pass? Did anything green go red? The
   suite must still discover 277 subjects.
2. Read the Revision 35 section text in \`spec/\` against the code, not its summary. Is every
   clause implemented, including ones the brief did not spell out?
3. **Did it DELETE what the revision removes**, or leave the old path reachable behind an alias, a
   flag, a fallback branch or a lenient default? Revision 34's \`unknown\` accepted any
   well-formed value; \`dynamic\` must not.
4. **Stale TSDoc and stale \`§\` citations.** \`CLAUDE.md\` forbids change history in TSDoc
   outright -- no "Revision 34", no "used to", no "any more", no "renamed from" -- and requires the
   citation to be current. Every wave so far has left several; look for them specifically.
5. Did it weaken a \`Task<T>\` signature, add a runtime dependency, put a \`RegExp\` in
   \`src/base/\`, or relax an ESLint zone rule instead of fixing an import?
6. Did it re-derive \`kind\`, \`isConstructor\`, \`typeParameters\` or \`choiceDisjoint\`
   locally instead of calling \`schema/meta/typedef.ts\`, or write a second reference-chain walk
   beside \`compiler/referenceChain.ts\`? A second copy is the defect.
7. Did it edit \`test/conformance/\` or \`packages/tson/src/schema/meta/\`?
8. Did it write a test that asserts whatever the code happens to produce rather than what the spec
   requires? Check each new expected value against \`spec/\`. A self-referential assertion
   (\`expect(X).toBe(X)\`) pins nothing.

Report only problems you can point at a file and line for.`;

log('Revision 35 Stage 5: scoped values, and the Stage 4 findings still open. 6 of 277 failing.');

const packages = [SCOPED, LEFTOVERS];
const ports = await parallel(
  packages.map(
    (pkg) => () =>
      agent(`${PORTER}\n\n---\n\n${pkg.brief}\n\n${CONTEXT}`, {
        label: `port:${pkg.key}`,
        phase: pkg.key === 'scoped-values' ? 'Scoped' : 'Leftovers',
        model: 'sonnet',
        schema: PORT_RESULT,
        effort: 'high',
      }),
  ),
);

const landed = requireAgents(ports, packages.length, 'port');
log(`Stage 5 packages returned: ${String(landed.length)}/${String(packages.length)}`);

const verdicts = await parallel(
  landed.map(
    (port) => () =>
      agent(
        `${VERIFY}\n\nWork package: "${port.key}"\nFiles claimed: ${port.filesWritten.join(', ')}\nVectors claimed green: ${port.vectorsGreen.join(', ') || '(none claimed)'}`,
        { label: `verify:${port.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
      ),
  ),
);

const sweep = await agent(
  `Run \`npm run test:conformance\` and \`npm test\` and report the real numbers for the TSON port
at 2026 Revision 35.

Stage 5's gate is the five scoped-value vectors green:
\`a-scoped-value-read-against-the-schema-it-names\`,
\`a-declared-position-opening-a-foreign-scope\`,
\`a-nested-schema-at-a-position-that-is-not-scoped\`, \`a-scoped-value-naming-no-type\`,
\`an-extern-position-naming-no-schema\`.

\`class2/schema/valid/choice-of-two-records\` and the two \`bundled-schemas-resolve\` unit
failures are Stage 6's (resolved-output writing) and are expected red.

For every vector still failing, give the ACTUAL cause -- read the failure, do not paraphrase the
assertion message -- and attribute it to the stage that owns it. If the DISCOVERED count is not
277, the harness is broken and that is the finding, ahead of anything about individual vectors.

Do not fix anything. Do not modify test/conformance/. This is a measurement.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'high' },
);

log(
  sweep === null
    ? 'Sweep returned nothing'
    : `Conformance: ${String(sweep.passing)}/${String(sweep.discovered)} passing, ${String(sweep.failing)} failing`,
);

return { stage: 5, ports, verdicts, sweep };
