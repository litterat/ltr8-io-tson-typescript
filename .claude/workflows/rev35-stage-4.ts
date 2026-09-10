export const meta = {
  name: 'tson-rev35-stage-4',
  description:
    'Revision 35 Stage 4: the resolver and compiler — a reference is a hop, facets are enforced per kind, network facets are applied, a restatement\u2019s annotations merge, and the schema-side resource limits become refusals',
  whenToUse:
    "After Stage 3's gate is committed. Six work packages over compiler/ and link/, three of them sequential on definitionResolver.ts.",
  phases: [
    { title: 'Sequential', detail: 'the three packages that share definitionResolver.ts' },
    { title: 'Parallel', detail: 'the three that touch disjoint files' },
    { title: 'Verify', detail: 'adversarial review of each package' },
    { title: 'Sweep', detail: 'measure the vectors and name what is still red' },
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
that is the finding ahead of any individual vector. **14 of the 277 fail as this stage begins**,
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

/**
 * Agents that error resolve to `null`, so a stage whose agents all died looks exactly like a stage
 * that ran cleanly and found nothing. Count them instead of filtering them away silently.
 */
function requireAgents(results, expected, what) {
  const ok = results.filter((r) => r !== null);
  const lost = expected - ok.length;
  if (lost > 0) {
    log(
      `WARNING: ${String(lost)} of ${String(expected)} ${what} agents returned nothing. Their results are MISSING, not empty — do not read this stage as complete.`,
    );
  }
  if (ok.length === 0) {
    throw new Error(
      `every ${what} agent failed; aborting rather than reporting an empty result as success`,
    );
  }
  return ok;
}

// WP4.1, WP4.5+4.6 and WP4.8 all rewrite `compiler/definitionResolver.ts`, so they run in
// sequence. WP4.4, WP4.7 and WP4.9 touch disjoint files and run together afterwards.
const SEQUENTIAL = [
  {
    key: 'reference-is-a-hop',
    brief: `WP4.1 — a reference is a hop, not a rewrite ([TSON-SCHEMA] §8.3).

Read §8.3 in full in \`spec/tson-part2-schema.md\`, and \`reference\`'s own \`@doc\` in
\`spec/m/meta-kernel.tn\`, which states the rule in the voice the resolved output has to match.

**Delete \`packages/tson/src/compiler/referenceFlattener.ts\`.** §8.3's use-site flattening is
gone. A use site names what the author wrote, \`target\` names only the NEXT hop, and nothing is
rewritten in resolved output. The \`@alias\` annotation goes with it — out of the model, out of
\`schema/bindings.ts\`'s wire handling, and out of every doc comment that explains it. The kernel
no longer declares \`alias => @annotation text\` at all, so an \`@alias\` this port emits is a
name the governing meta does not have.

**Every rule that needed a terminal type still walks to one** — subsumption (§7.2), the choice-
variant void check (§5.4), refinement and composition sources (§4.3, §5.7, §5.9), atom refinement —
but the walk is EPHEMERAL rather than materialised. The reference implementation replaced four ad
hoc copies of that walk with ONE shared function; do the same rather than inlining it four times.
Find all four in this port before you write the shared one.

**A processor MAY collapse a chain, but only after linking, when compiling for reading.** That
makes chain-collapsing the compiler's business, not the resolver's. It also closes \`STATUS.md\`'s
recorded gap that diagnostics name the resolved entry rather than the alias the author wrote —
check that gap actually closes and update \`STATUS.md\` if it does.

Vector: \`class2/schema/valid/a-reference-is-stated-as-written\`, which currently fails on the
resolved-form comparison. Its sidecar states the resolved form the author's spelling must survive
into — read it before you start.

Do not touch \`atom/\`, \`link/nameHygiene.ts\`, or \`test/conformance/\`.`,
  },
  {
    key: 'facets',
    brief: `WP4.5 + WP4.6 — facet narrowing per kind, value-typed facets, and sparse member sets
([TSON-SCHEMA] §5.2, §5.7, §7.4).

These two work packages are one here because they are one mechanism seen from two sides: §5.7
decides how a facet may NARROW under refinement, §5.2/§7.4 decide how a facet's VALUE is read in
the first place, and both live in \`compiler/atomNarrowing.ts\`, \`atomChecks.ts\` and
\`atomCoherence.ts\`.

Read §5.7's "Value tightening is per facet kind" paragraph in full — it declares every kind once,
for every family — and §5.5's bulleted list of per-family value spaces.

**Seven vectors fail today and they are your measure.** Six of them report "the document is
invalid, but nothing was reported", which means the facet is stored and never checked:

- \`class2/validate/invalid/a-date-before-its-declared-minimum\`
- \`class2/validate/invalid/a-duration-below-its-declared-minimum\`
- \`class2/validate/invalid/a-duration-off-its-declared-step\`
- \`class2/validate/invalid/a-decimal-outside-a-sparse-member-set\`
- \`class2/validate/invalid/an-integer-outside-a-sparse-member-set\`
- \`class2/validate/invalid/a-value-off-its-declared-precision-grid\`

The seventh fails the other way and is the one that pins the semantics:
\`class2/validate/valid/a-precision-constrained-value-spelled-with-trailing-zeros\` currently
reports \`ATOM_CONSTRAINT_VIOLATION: '12:00:00.500Z' has 3 fractional-second digits, more than the
maximum 1\`. That reading is wrong. §5.5: "\`precision\` ... is a constraint on the *value*, not
on a spelling: \`precision: N\` admits a value that is a whole number of 10⁻ᴺ seconds ... a text
encoding may spell an admitted value with trailing zeros (\`12:00:00.500\` under
\`precision: 1\`) and writes at most N digits." So 0.500 s IS a whole number of tenths and is
admitted; 0.55 s is not. Fix the check to test the value against the grid, and the WRITER to emit
at most N digits.

**The facet kinds, each with its own narrowing rule (§5.7).** An ORDERED BOUND may move only
inward and needs a totally ordered value space, which every family carrying one now has. A STEP
(\`multiple_of\`) is strictly positive, tests the value's MAGNITUDE with the sign ignored, and may
tighten only to an integer multiple of the inherited step (15 under 5 tightens; 10 under 15 is an
error). A PERMISSION may go from granted to withdrawn, never back. A MEMBER SET may shrink to a
subset, never grow or replace, compared by the family's own value identity. A SELECTOR moves only
along the narrowing relation its members carry:

- \`integer_type.size\` — a width chain. \`!int8 ^ { size: { bits: 16 } }\` WIDENS and fails,
  whatever the arithmetic direction suggests.
- \`complex_type.component\` — a partial order: \`INTEGER ⊂ NUMBER ⊂ RATIONAL\`,
  \`FLOAT32 ⊂ FLOAT64\`, exact and approximate INCOMPARABLE (binary64 carries ±inf and NaN no
  exact decimal represents).
- \`float_type.format\` — its own order.
- \`bytes_type.encoding\` — **no relation at all**. A refinement may neither set nor change it, so
  \`hexbytes => !bytes ^ { encoding: HEX }\` is a resolver error. Another alphabet is another
  instance.

\`compiler/atomNarrowing.ts\`'s own doc comment says there is no generic helper for selector
facets because they are identity-only after being set. That comment is now WRONG for three of the
four, and the file is the right home for the relations. Rewrite the comment as part of the fix.

**A selector at the constructor's default is not thereby free** (§5.7): the relation is over
EFFECTIVE values, so an unwritten default and a written one refine identically, and there is no
"set-from-default" permission apart from the relation.

**Value-typed facets (§5.2, §7.4).** A \`value\`-typed facet is the token, uninterpreted, read by
the type the position hands it to — the resolver reads it under the atom the slot stands for, once
that atom is in scope, and STORES the result. \`1\` and \`1.0\` at \`decimal_type.min\` are one
number, not an integer beside a float. Base type resolution is explicitly NOT the fallback here; it
applies in schemaless documents only (§4.1). Note what this unblocks: \`atom/temporal/duration.ts\`
and \`period.ts\` currently carry a doc comment saying their bounds are not checked because the
model holds raw text. Land the reading, then land the check, and rewrite those comments.

**Sparse member sets follow from that.** \`integer_type.members\` and \`decimal_type.members\`
hold values read under the constrained atom BEFORE the set is formed, so \`[1 1.0]\` is a
duplicate caught at schema load. A body's facets must also COHERE — every member of \`members\`
satisfies the body's other facets, so \`{ members: [443], size: { bits: 8 } }\` fails — and that
check runs AGAIN at materialisation, when the members come from a template parameter.

Do not touch \`compiler/referenceFlattener.ts\` (the previous package deletes it),
\`atom/network/\` (WP4.7), \`link/\` beyond what a check needs, or \`test/conformance/\`.`,
  },
  {
    key: 'aliased-argument-identity',
    brief: `WP4.8 — aliased argument identity ([TSON-SCHEMA] §5.7, §8.2).

Read §8.2's identity rules. Of the three ways to name a type after another, only a REFERENCE is
transparent to template-application identity:

- \`box<user_id>\` over \`user_id => uuid\` denotes the same type as \`box<uuid>\` and mints
  the SAME entry.
- A refinement (\`box<!uuid ^ {}>\`) keeps its own.
- A fresh instance (\`box<!uuid_type {}>\`) keeps its own.

So argument identity follows reference chains to their TERMINAL entries when computing the
canonical application. WP4.1 has just built the shared ephemeral walk for exactly this; use it
rather than writing a second one.

This closes \`STATUS.md\`'s recorded gap that a value type-argument's identity compares spelling
rather than value equivalence — the same gap, now with the spec stating the rule. Stage 2 landed
the value-space contract that decides equivalence for a VALUE argument; this package is the TYPE
argument half. Check the gap actually closes and update \`STATUS.md\`.

Vector: \`class2/link/valid/an-application-mints-an-entry-of-its-own\` passes today and must keep
passing. Write the \`box<user_id>\`/\`box<uuid>\` unification as a unit test from §8.2, since no
corpus vector states it directly — say so in your report if that is a gap worth reporting upstream.

Do not touch \`atom/\`, \`link/nameHygiene.ts\`, or \`test/conformance/\`.`,
  },
];

const PARALLEL = [
  {
    key: 'restatement-annotations',
    brief: `WP4.4 — a restatement's annotations merge ([TSON-SCHEMA] §5.8).

This is a NEW RULE, not a rewording. Read §5.8.

A restated field — in composition or refinement, elided-type restatements included — carries its
OWN annotations in source order, FOLLOWED BY the inherited field's in source order. Nothing is
dropped. There is no per-name dedup. The restatement LEADS, which is what decides "first
occurrence" for a rule like \`@rest\`'s at-most-one-per-chain.

\`definitionResolver.ts\`'s \`resolveField\` takes only the restatement's own annotations today.

Vector: \`class2/schema/valid/composition-flattens-fields\` passes today and must keep passing;
its resolved-form sidecar is where a wrong merge order would show. Write the merge-order case as a
unit test from §5.8 — a field restated twice down a three-deep chain, each level annotated — since
the corpus does not state it directly.

Note §6's three annotation categories, which arrived with this revision: checked, representation
directive, advisory. \`@discriminator\` and \`@rest\` are CHECKED and a checked annotation has no
third outcome — it holds or the schema fails to load. \`@title\`, \`@examples\`, \`@read_only\`
and \`@write_only\` are advisory. If this port does not carry those categories yet, say so rather
than implementing §6 wholesale here.

Touch \`compiler/definitionResolver.ts\`'s \`resolveField\` and its neighbours only. Do not touch
\`atomNarrowing.ts\`, \`atomChecks.ts\`, \`atom/network/\` or \`test/conformance/\`.`,
  },
  {
    key: 'network-facets',
    brief: `WP4.7 — network facets are applied ([TSON-SCHEMA] §5.5).

Read §5.5's network bullet in full — it states the rule exactly and says why it must be decided
exactly rather than pairwise.

\`within\` and \`excluding\` exist as fields on \`Ipv4Type\`, \`Ipv6Type\`, \`Cidr4Type\` and
\`Cidr6Type\` today and are NEVER ENFORCED. Revision 35 states the semantics and adds a
schema-load obligation: **the pair MUST admit a value.**

- An ADDRESS is inside at least one \`within\` network when the field is present, and inside no
  \`excluding\` network.
- A NETWORK must be a subnet of at least one \`within\`, and must not **OVERLAP** any
  \`excluding\` — overlap, not containment, so a wider value cannot smuggle an excluded block
  through.
- Prefix bounds participate: a value must be a subnet of a \`within\` block so its prefix is at
  least that block's, and \`max_prefix\` caps it from above.
  \`{ within: ["10.0.0.0/24"]  excluding: ["10.0.0.5/32"]  max_prefix: 24 }\` admits almost every
  ADDRESS and no NETWORK at all.
- **Coherence MUST be decided EXACTLY, not pairwise.** CIDR blocks nest or are disjoint and never
  partly overlap, so an exclusion meeting a permitted block either contains it or lies wholly
  inside one of its halves, and the walk terminates at the address width. §5.5 is explicit that
  pairwise is wrong: \`10.0.0.0/9\` and \`10.128.0.0/9\` cover \`10.0.0.0/8\` by counting, and
  only the tiling case arises from a real edit. A prefix-tree cover is what makes this tractable.
- The diagnostic SHOULD say which cause it found — an exclusion covering everything permitted, or
  the largest block the bounds leave — since the two want different edits.

**A CIDR value becomes a network value rather than retained text**, which is what lets each family
judge its own facets. That is a representation change in \`atom/network/cidr4.ts\` and
\`cidr6.ts\`; follow it through the writers so a round trip still preserves the written spelling
where §3.2 requires it.

No corpus vector covers this yet — say so in your report. Write the tests from §5.5, citing it, and
include the \`{ within: ["10.0.0.0/8"]  excluding: ["10.0.0.0/8"] }\` case §5.5 names as
"\`{ min: 10  max: 3 }\` in another spelling", and the tiling case that defeats a pairwise check.

Touch \`atom/network/\` and the schema-load coherence path only. Do not touch
\`definitionResolver.ts\` (three other packages own it), \`atomNarrowing.ts\`, or
\`test/conformance/\`.`,
  },
  {
    key: 'resource-limits',
    brief: `WP4.9 — schema-side resource limits, and the expanded refusal report
([TSON-SCHEMA] §11.5, §2.2.3; [TSON-DATA] §8.1, §8.2, §9.1).

Read §11.5 and §9.1. This section has no Revision 34 analogue.

**Read \`REVISION-35-PLAN.md\`'s "Scope decisions" section before you write anything — it binds
this package.** The plan deliberately does NOT build all twelve of §9.1's limits: it builds the
MECHANISM and the depth limit, records the other eleven as gaps, and says why (a limit this port
enforces and the reference does not is a divergence nobody asked for). Follow that. Do not
implement the eleven.

What you build:

1. **The refusal machinery generalised.** §8.1's fifth outcome now covers RESOURCE LIMITS
   alongside name hygiene, rather than name hygiene alone. \`TsonNameHygieneRefusedError\` and
   \`core/diagnostic.ts\`'s \`isVerdict\` are shaped around hygiene being the only fifth-outcome
   cause; a limit refusal is the second. A limit refusal is reported with the LIMIT NAME and the
   CONFIGURED THRESHOLD.
2. **The depth limit at its spec default of 64**, where this port currently carries one depth bound
   defaulted to 512. Changing a default is a behaviour change — state it plainly in your report.
3. **The expanded refusal report, which is a new MUST.** A refusal-bearing report carries the UCD
   version, the IDENTIFIER POLICY and the TOKEN POLICY it was judged under, and a processor SHOULD
   make those available WITH NO DOCUMENT IN HAND. This port already exposes \`processorPolicy\`;
   check it against what §8.2 now requires and extend it.

**Nothing here may decide whether a document is VALID.** \`CLAUDE.md\` is emphatic: a refusal is a
fifth outcome reported apart from §8.1's four error categories, because the data behind it is data
Unicode declines to freeze, and a content-addressed document must mean the same thing forever.
Relaxation is a code decision the caller makes explicitly — never an environment variable.

Also confirm the conformance runner's rule still holds: "a non-verdict diagnostic never satisfies
an error vector", and \`core/diagnostic.ts\`'s \`isVerdict\` is the one list. If you add a
diagnostic code, decide which side of that line it falls on and say so.

Record the eleven unbuilt limits in \`STATUS.md\`'s known gaps, named, with §9.1's defaults.

Touch \`core/\`, \`config.ts\` and the limit-enforcement sites. Do not touch
\`definitionResolver.ts\`, \`atomNarrowing.ts\`, \`atom/network/\` or \`test/conformance/\`.`,
  },
];

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

const CONTEXT = `Stages 0 to 3 have landed. \`spec/\` at the repository root IS Revision 35 and
\`.references/\` is at the new pins. The Part 1 data layer is at Revision 35, equality is over
value spaces, and \`TypeDefinition\` is six fields with \`constructor\`, \`kind\`,
\`parameters\` and \`disjoint\` all DERIVED — \`isConstructor\`, \`typeKind\`,
\`typeParameters\` and \`choiceDisjoint\` in \`packages/tson/src/schema/meta/typedef.ts\` are
the single implementation of each, and you must call them rather than re-deriving.

\`packages/tson/src/schema/meta/\` is FROZEN. If something there is genuinely wrong, say so and
stop rather than editing it.

14 of 277 vectors fail entering this stage: 7 unenforced facets (yours), 5 scoped values (Stage 5),
2 resolved-output writing (Stage 6). Read \`spec/\`, not a cached memory of Revision 34.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`;

const VERIFY = `Adversarially review this work package of the TSON TypeScript port's move to 2026
Revision 35. Default to finding it UNSOUND: refute the claim that it implements the new spec text,
rather than confirming it.

Check, in this order:

1. Run the gates yourself. Do the claimed vectors actually pass? Did anything green go red? The
   suite must still discover 277 subjects.
2. Read the Revision 35 section text in \`spec/\` against what it actually wrote — the code, not
   its summary. Is every clause implemented, including ones the brief did not spell out?
3. **Did it DELETE what the revision removes**, or leave the old path reachable behind an alias, a
   flag, a fallback branch or a lenient default?
4. **Stale TSDoc and stale \`§\` citations.** \`CLAUDE.md\` forbids change history in TSDoc
   outright — no "Revision 34", no "used to", no "renamed from" — and requires the citation to be
   current. This is a first-class check, not a nit: the last two stages each left several.
5. Did it weaken a \`Task<T>\` signature, add a runtime dependency, put a \`RegExp\` in
   \`src/base/\`, or relax an ESLint zone rule instead of fixing an import?
6. Did it re-derive \`kind\`, \`isConstructor\`, \`typeParameters\` or \`choiceDisjoint\`
   locally instead of calling \`schema/meta/typedef.ts\`? A second copy is the defect.
7. Did it edit \`test/conformance/\` or \`packages/tson/src/schema/meta/\`? Neither is permitted.
8. Did it write a test that asserts whatever the code happens to produce, rather than what the spec
   requires? Check each new expected value against \`spec/\`.

Report only problems you can point at a file and line for.`;

log(
  `Revision 35 Stage 4: ${String(SEQUENTIAL.length)} sequential packages, then ${String(PARALLEL.length)} parallel. 14 of 277 failing at the start.`,
);

const sequential = [];
for (const pkg of SEQUENTIAL) {
  const port = await agent(`${PORTER}\n\n---\n\n${pkg.brief}\n\n${CONTEXT}`, {
    label: `port:${pkg.key}`,
    phase: 'Sequential',
    model: 'sonnet',
    schema: PORT_RESULT,
    effort: 'high',
  });
  sequential.push(port);
  log(
    port === null
      ? `${pkg.key}: returned nothing`
      : `${pkg.key}: ${port.status}, ${String(port.vectorsGreen.length)} vectors green`,
  );
}

const concurrent = await parallel(
  PARALLEL.map(
    (pkg) => () =>
      agent(
        `${PORTER}\n\n---\n\n${pkg.brief}\n\n${CONTEXT}\n\nThe three sequential packages (WP4.1, WP4.5+4.6, WP4.8) have already landed on \`definitionResolver.ts\`. Two other packages are running against this same tree right now; stay strictly inside the files your brief names.`,
        {
          label: `port:${pkg.key}`,
          phase: 'Parallel',
          model: 'sonnet',
          schema: PORT_RESULT,
          effort: 'high',
        },
      ),
  ),
);

const landed = requireAgents(
  [...sequential, ...concurrent],
  SEQUENTIAL.length + PARALLEL.length,
  'port',
);
log(
  `Stage 4 packages returned: ${String(landed.length)}/${String(SEQUENTIAL.length + PARALLEL.length)}`,
);

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

Stage 4's gate is the seven facet vectors green:
\`a-date-before-its-declared-minimum\`, \`a-duration-below-its-declared-minimum\`,
\`a-duration-off-its-declared-step\`, \`a-decimal-outside-a-sparse-member-set\`,
\`an-integer-outside-a-sparse-member-set\`, \`a-value-off-its-declared-precision-grid\`,
\`a-precision-constrained-value-spelled-with-trailing-zeros\` — plus
\`class2/schema/valid/a-reference-is-stated-as-written\` from WP4.1.

The five scoped-value vectors (Stage 5) and the two resolved-output ones (Stage 6) are expected
red. Attribute each remaining failure to the stage that owns it.

For every vector still failing, give the ACTUAL cause — read the failure, do not paraphrase the
assertion message. If the DISCOVERED count is not 277, the harness is broken and that is the
finding, ahead of anything about individual vectors.

Do not fix anything. Do not modify test/conformance/. This is a measurement.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'high' },
);

log(
  sweep === null
    ? 'Sweep returned nothing'
    : `Conformance: ${String(sweep.passing)}/${String(sweep.discovered)} passing, ${String(sweep.failing)} failing`,
);

return { stage: 4, sequential, concurrent, verdicts, sweep };
