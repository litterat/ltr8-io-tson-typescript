export const meta = {
  name: 'tson-rev35-stage-1',
  description:
    'Revision 35 Stage 1: the Part 1 data layer — escapes, trailing commas and field names, null as a string, one !bytes tag, and duration split from period',
  whenToUse:
    'After Stage 0 (the pin move and re-vendored spec/) is committed. Produces the five Part 1 work packages of REVISION-35-PLAN.md, whose gate is the Class 1 lexer, parser and vocabulary vectors green.',
  phases: [
    { title: 'Port', detail: 'one agent per work package, verified as each lands' },
    { title: 'Verify', detail: 'adversarial spec review of each package' },
    { title: 'Sweep', detail: 'measure the Class 1 vectors and name what is still red' },
  ],
};

// The porter charter travels with the wave script rather than being looked up as a registered
// agent type: `.claude/agents/tson-porter.md` is only visible to a session that started after it
// was committed, so a session that pulled it mid-run gets 'agent type not found'. The script is
// the unit of review anyway, and `model: 'sonnet'` carries what the frontmatter said.
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
that is the finding ahead of any individual vector. **88 of the 277 fail as this stage begins** —
that is the Stage 0 baseline and it is expected. Nothing in that baseline may get worse.

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

// Five packages. Only WP1.2's two halves collide — both live in compiler/cursor.ts — which is why
// they are one package rather than two. Everything else touches a disjoint set of files, so the
// pipeline verifies each as it lands rather than waiting for all five.
const PACKAGES = [
  {
    key: 'escapes',
    brief: `WP1.1 — Escapes (Part 1 §7.2.2).

Read §7.2.2 in full in \`spec/tson-part1-data.md\`, and §1.3's freeze paragraph, which names this
as the change that triggers the Class 1 lexer freeze. Nothing else in the lexer moves.

Three changes, all in \`packages/tson/src/lexer/lexer.ts\` and its neighbours:

1. \`\\/\` is REMOVED from the escape table. A solidus needs no escape and has none, so \`\\/\` is
   an invalid escape and a lexer error. \`decodeEscapeSequence\` accepts it today (case '/'), and
   must stop.

2. The braced character escape \`\\u{1*6HEXDIG}\` is ADDED, alongside the existing \`\\u4HEXDIG\`.
   The \`{\` after \`u\` decides the spelling at the first character, so the two never conflict. A
   brace form with no digits, more than six digits, or an unclosed brace is a lexer error. Note
   that the scanner half matters as well as the decoder half: \`lexSingleLineToken\` buffers a
   backslash plus exactly one following character and lets \`decodeAllEscapes\` do the rest, so
   check that a braced escape survives scanning intact in BOTH the single-line and multi-line
   forms, and that a \`"\` or a line terminator inside a malformed brace form is reported as the
   error it is rather than silently closing the token.

3. Surrogate-pair escapes go ENTIRELY. The pairing rule is deleted — there is no lead/trail
   combination step. The single remaining constraint is that an escape MUST denote a Unicode
   scalar value: in range, and not U+D800–U+DFFF. So \`"\\uD83D\\uDE00"\` is now TWO lexer errors
   where it used to be one emoji, and \`"\\u{1F600}"\` is the one spelling that reaches it by
   escape. \`\\u{110000}\` is out of range and an error.

The lexer is code-point addressed and decodes UTF-8 itself. A supplementary character reached by
\`\\u{…}\` must not disturb column or offset accounting — a decoded escape contributes to the token
VALUE, and the position of anything after it is a position in the SOURCE, which is where the six
hex digits and the braces actually sit.

Vectors: everything under \`tests/class1/lexer/\` naming an escape, a surrogate, or a solidus. Read
the sidecars — an error vector states a \`category\`, which for these is \`lexer\`, and the runner
asserts the category and never the position.

Do not touch \`compiler/cursor.ts\` (WP1.2 owns it), \`base/baseTypeResolver.ts\` (WP1.3),
\`atom/numeric/\` (WP1.4) or \`atom/temporal/\` (WP1.5).`,
  },
  {
    key: 'commas-and-field-names',
    brief: `WP1.2 — Trailing commas, and a field name is an identifier.

Both halves live in \`packages/tson/src/compiler/cursor.ts\`, which is why they are one package.
Read Part 1 §2.4, §2.5, §2.7, §2.8 and §7.7, and [TSON-SCHEMA] §12.1, in the re-vendored \`spec/\`.

**Half one — a comma may follow a value (§2.4, §7.4, and [TSON-SCHEMA] §12.1).**

§2.4 states it directly: \`[1, 2, 3,]\` and \`{ x: 1, }\` are legal. \`consumeSeparatorOrCloseCheck\`
throws on a trailing comma today; it must not. What stays a parse error, and the spec is explicit
that it needs no rule of its own because a comma is not a value: a comma that follows NOTHING
(\`[, 1]\`) and a comma that follows a COMMA (\`[1, , 2]\`). Read §2.4's paragraph on why this is
safe here and not in JSON — TSON has no elision, absence is spellable and occupies a slot, so
\`[1, 2,]\` is two elements and \`[1 2 _]\` is three. A doubled comma is a lost element, not two
elements, and reading it the other way is exactly the silent failure the format exists to catch.

The same rule applies throughout the series. The schema grammar's list productions take it too —
declarations, fields, groups, removal sets, parameters, arguments, tuple elements. Find every one
in \`packages/tson/src/compiler/schemaParser.ts\` and make sure it goes through the same separator
logic rather than a second hand-rolled copy of it.

**Half two — a field name is an identifier at every layer (§2.5, §2.8, §7.7).**

\`expectFieldNameToken\` accepts any bare token today. A field name must now:
  - have its decoded text NFC-normalised, and
  - match §7.7's identifier grammar,
for BOTH spellings. Quoting escapes a LEXICAL accident — it lets you write a name the token
grammar could not otherwise carry — it does not admit a broader name SET. So \`"has spaces"\` is
not a field name however it is quoted.

Use the existing identifier machinery rather than writing a second copy: the port has real
\`XID_Start\`/\`XID_Continue\` tables in \`packages/tson/src/unicode/xid.ts\` and NFC in
\`packages/tson/src/unicode/nfc.ts\`. \`CLAUDE.md\` is emphatic that the tables are authoritative
and the host is not consulted for these properties. Find where §7.7 is already implemented for
identifiers elsewhere and call it.

§7.7 rule 2's contextual rule at naming positions matters here and is easy to miss — read it.

**The §2.8 brace dispatch tightens with it.** The record interpretation of \`{ … }\` is selected
only when the FIRST value's decoded text is an identifier. Anything else is a map. This breaks
schemaless documents whose keys are not identifiers, and that is the intent — the spec's own
guidance is that those belong in a map.

Vectors: \`tests/class1/parser/\` and \`tests/class1/lexer/\` subjects naming commas, separators,
field names, identifiers, or the brace dispatch. Both \`valid\` and \`invalid\` buckets moved.

Do not touch \`lexer/lexer.ts\` (WP1.1 owns it), \`base/baseTypeResolver.ts\` (WP1.3),
\`atom/numeric/\` (WP1.4) or \`atom/temporal/\` (WP1.5). If the identifier check you need belongs in
a shared helper, put it where the existing identifier code lives and import it — do not copy it.`,
  },
  {
    key: 'null-is-a-string',
    brief: `WP1.3 — \`null\` is a string (Part 1 §4.1, §4.4, §4.5, §7.3).

Read §4 in full in \`spec/tson-part1-data.md\`. Revision 35 removes the JSON-superset claim and
with it \`null\` as a base value.

**Base type resolution loses its null class.** \`packages/tson/src/base/baseTypeResolver.ts\`
carries a \`kind: 'null'\` today. Resolution becomes three classes in order: boolean → number →
string. The bare word \`null\` is not special and resolves to the STRING \`"null"\`, exactly like
any other unmatched token. \`_\` is the format's one spelling of absence and stays so.

**Under a schema this tightens further, and it is easy to miss.** Revision 34 accepted \`null\` as
an equivalent spelling of \`_\` at a \`void\` position. Revision 35 does not: \`void\` admits \`_\`
alone, and \`null\` at a \`void\` position is a VALIDATION error. Two corpus vectors state exactly
this pair — find them under \`tests/class2/validate/\` (one \`valid\`, one \`invalid\`) and make
both pass. Search the whole tree for wherever the port special-cases the token \`null\` against
\`void\` or against absence, not just the base resolver.

**One thing to confirm and REPORT rather than guess.** §4.1's applicability condition is reworded
to key on the document header carrying no \`!!schema\`. Read that against §3.3 and §7.8 and answer:
does base type resolution still apply to the UNSCOPED values of a document that pushes a schema
scope on one element? The rewording reads as a simplification rather than a rule change, and the
answer is almost certainly yes, but the prose does not say so unambiguously. Implement the reading
you judge correct, say which you chose and why, and flag it as a spec finding — it is already on
the plan's list to report upstream and your reading is what gets reported.

Also sweep the value model and the writers: anything that can still PRODUCE a null base value, or
name one in a union, a table or a doc comment, is now wrong. \`base_value\` has three classes.

Vectors: \`tests/class1/resolver/\` and \`tests/class1/vocabulary/\` subjects naming \`null\`, plus
the two \`class2/validate/\` void vectors above.

Do not touch \`lexer/lexer.ts\` (WP1.1), \`compiler/cursor.ts\` (WP1.2), \`atom/numeric/binary.ts\`
or the base64/base32 modules (WP1.4), or \`atom/temporal/\` (WP1.5).`,
  },
  {
    key: 'bytes',
    brief: `WP1.4 — \`!bytes\` is the only binary tag (Part 1 §5.3).

Read §5.3 in \`spec/tson-part1-data.md\`.

\`!bytes\` is the one binary type annotation and its spelling is base64. \`!base64\`, \`!base64url\`,
\`!base32\` and \`!hex\` CEASE TO EXIST as Part 1 vocabulary — they are not deprecated aliases, they
are not accepted-and-warned, they are gone, and a document using one is an error at the vocabulary
layer.

The reasoning, which decides the shape of the fix: an alphabet is a SPELLING of an octet sequence,
not a kind of value. A schemaless document has no schema to carry a selector, so the alphabet moves
to the schema layer entirely, as \`bytes_type.encoding\`.

**Your half is the atom parser and the Part 1 vocabulary.** \`packages/tson/src/atom/numeric/binary.ts\`
becomes the \`bytes\` parser. The other alphabets do not vanish from the codebase — the schema layer
will select among them at \`bytes_type.encoding\` in a later stage — so keep the base64/base64url/
base32/hex DECODERS as decoders, reachable by an explicit alphabet argument, and remove only their
standing as Part 1 type annotations. Leave them in a shape a later stage can hand a selector to.

The meta-model half — \`BinaryType\` becoming \`BytesType\` with an \`encoding\` facet and no \`spec\`
field — is Stage 3 and is NOT yours. Do not edit \`packages/tson/src/schema/meta/\`.

Sweep for the four removed names everywhere they are registered as vocabulary: the atom registry,
\`atom/forType.ts\`, any type-name table, the writers (what does a byte string write AS now?), and
the CLI's help or docs if they enumerate the tags.

Vectors: \`tests/class1/vocabulary/\` subjects naming \`bytes\`, \`base64\`, \`base32\` or \`hex\`, in
both \`valid\` and \`invalid\` buckets. An \`invalid\` vector here states a \`category\`, and at the
vocabulary layer that category is \`resolver\` or \`validation\` and never "vocabulary" — assert what
the sidecar says.

Do not touch \`lexer/lexer.ts\` (WP1.1), \`compiler/cursor.ts\` (WP1.2),
\`base/baseTypeResolver.ts\` (WP1.3), \`atom/temporal/\` (WP1.5) or \`schema/meta/\` (Stage 3).`,
  },
  {
    key: 'duration-and-period',
    brief: `WP1.5 — \`duration\` and \`period\` (Part 1 §5.4). The largest Part 1 package.

Read §5.4 in full in \`spec/tson-part1-data.md\`, and RFC 3339 Appendix A's duration grammar.

One type becomes two, and the reason decides everything else: a month has no fixed length and a
second does, so \`min\`, \`max\` and \`multiple_of\` need a total order to be checkable at all. A
combined \`P1Y2M3DT4H5M6S\` has no total order and is now an ERROR under both types.

**\`duration\`** — RFC 3339 Appendix A's \`dur-date / dur-time / dur-week\`. No \`Y\` component, no
month \`M\` component. Value space is signed exact decimal SECONDS.
  - A standalone \`PnW\` is ACCEPTED, and a week is exactly 7 days, so \`P2W\`, \`P14D\` and
    \`PT336H\` are one value. \`P1W2D\` and \`P1WT1H\` are NOT durations — \`dur-week\` stands alone.
  - Canonical write is \`PTnHnMnS\`, so day and week spellings do not survive a round trip. The
    spec states that as intentional; do not try to preserve the written spelling.
  - Magnitude MUST NOT exceed 2^63−1 NANOSECONDS, symmetric for negatives, and a processor MUST
    represent the full range and reject outside it. "Represent the full range" is a real
    requirement in a language whose \`number\` cannot: use the port's existing exact decimal
    machinery (\`atom/numeric/decimal.ts\`, \`decimalMath.ts\`) or \`bigint\`, never a float.

**\`period\`** — \`P\` with a \`Y\` component, an \`M\` component, or both, and NOTHING else. Value
space is signed integer MONTHS. \`P1Y\` is 12 months.

**Fractional seconds are capped at 9 digits** across \`full-time\`, \`date-time\` and \`dur-time\`.
That is three places in \`atom/temporal/rfc3339.ts\` and its callers, not one.

**\`TsonDuration {period, clock}\` in \`packages/tson/src/value/types.ts\` GOES.** It exists only
because no host type covered the combined form, and the combined form no longer exists. A
\`duration\` value is an exact decimal count of seconds; a \`period\` value is an integer count of
months. Follow the deletion through every reader, writer, binding and test that names it. NOTE:
\`value/types.ts\` is a published type — rewrite its TSDoc in the same edit, and do not leave a
deprecated alias behind.

**This REVERSES an inherited strictness.** \`.references/ltr8-io-tson-java/CONFORMANCE.md\` records
rejecting \`PnW\` as the conservative reading. Revision 35 settles it the other way. Read that file
so you know which of its other entries still stand.

**Reclassification.** \`datetime\` and \`time\` are reclassified as INSTANT and TIME OF DAY, with
the offset preserved as written but NOT part of value identity. Implement the reclassification and
the offset-preserving read; the equality consequence is Stage 2's package and you should not build
a general equality contract here — but do leave the value model able to express "same instant,
different offset spelling", because Stage 2 needs it.

Vectors: \`tests/class1/vocabulary/\` subjects naming \`duration\` or \`period\`, both buckets. There
are many. Also register \`period\` wherever \`duration\` is registered as vocabulary.

Do not touch \`lexer/lexer.ts\` (WP1.1), \`compiler/cursor.ts\` (WP1.2),
\`base/baseTypeResolver.ts\` (WP1.3), \`atom/numeric/\` (WP1.4), \`reader/tree/equality.ts\`
(Stage 2) or \`schema/meta/\` (Stage 3).`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'vectorsGreen', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
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
  required: ['discovered', 'passing', 'failing', 'class1Failing', 'remaining'],
  properties: {
    discovered: { type: 'number' },
    passing: { type: 'number' },
    failing: { type: 'number' },
    class1Failing: {
      type: 'number',
      description: "failures under class1/ only — this stage's gate is that this reaches 0",
    },
    remaining: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vector', 'cause', 'owner'],
        properties: {
          vector: { type: 'string' },
          cause: { type: 'string', description: 'the actual reason, not the assertion message' },
          owner: {
            type: 'string',
            description:
              'which Stage 1 work package should have covered it, or the later stage that owns it',
          },
        },
      },
    },
  },
};

log(
  `Revision 35 Stage 1: ${String(PACKAGES.length)} work packages. Baseline is 88 of 277 failing; the gate is every class1/ vector green.`,
);

const results = await pipeline(
  PACKAGES,
  (pkg) =>
    agent(
      `${PORTER}

---

${pkg.brief}

Stage 0 has already landed: \`spec/\` at the repository root IS Revision 35, \`.references/\` is at
the new pins, and \`packages/tson/src/stdlib/schemas.generated.ts\` is regenerated. Read \`spec/\`,
not a cached memory of Revision 34.

The other four Stage 1 packages are running against the same tree. Stay inside the files your brief
names. If you need a change in a file another package owns, report it — do not make it.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`,
      { label: `port:${pkg.key}`, phase: 'Port', model: 'sonnet', schema: PORT_RESULT },
    ),
  (port, pkg) => {
    if (port === null || port.status === 'blocked') return null;
    return agent(
      `Adversarially review work package "${pkg.key}" of the TSON TypeScript port's move from 2026
Revision 34 to Revision 35. Default to finding it UNSOUND: refute the claim that it implements the
new spec text, rather than confirming it.

Files claimed: ${port.filesWritten.join(', ')}
Vectors claimed green: ${port.vectorsGreen.join(', ') || '(none claimed)'}

Check, in this order:

1. Run the gates yourself. Do the claimed vectors actually pass? Did anything that was green before
   this package go red? A regression is blocking regardless of what else is true. The suite must
   still discover 277 subjects.
2. Read the Revision 35 section text in \`spec/\` at the repository root against what it actually
   wrote — the code, not its summary. Is every clause of the section implemented, including the
   ones the brief did not spell out?
3. **Did it DELETE what the revision removes, or did it leave the old path reachable?** A revision
   that removes a rule is not served by an alias, a flag, a fallback branch, or a lenient default.
   Look specifically for the old behaviour still being accepted somewhere the new code does not
   cover — a second parser, a writer, a CLI path, a binding.
4. **Stale TSDoc and stale \`§\` citations.** \`CLAUDE.md\` forbids change history in TSDoc and
   requires the section citation to be current. A doc comment describing Revision 34 behaviour on a
   function that now does something else is a real defect, not a nit.
5. Did it weaken any \`Task<T>\` signature to a plain return type? Did it introduce a \`RegExp\` in
   \`src/base/\`? Any new runtime dependency? Anything materialising a whole document?
6. Did it index a JS string by UTF-16 unit to derive a column or an offset?
7. Did it change \`test/conformance/\` to make a vector pass? Nothing in Stage 1 may.
8. Did it edit a file another Stage 1 package owns, or \`packages/tson/src/schema/meta/\`?

Report only problems you can point at a file and line for.`,
      { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT },
    );
  },
);

const landed = requireAgents(results, PACKAGES.length, 'port/verify');
log(`Stage 1 packages returned: ${String(landed.length)}/${String(PACKAGES.length)}`);

// The gate is a number, so end by measuring it rather than by asking whether every agent felt
// finished. A stage where every package reports success and the count is still short is exactly
// the case this phase exists to make visible.
const sweep = await agent(
  `Run \`npm run test:conformance\` and report the real numbers for the TSON port at 2026 Revision 35.

Stage 1's gate is: every vector under \`class1/\` green. \`class2/\` vectors are EXPECTED red until
Stage 6 and are not a failure of this stage — count them, name them, but attribute them to the
stage that owns them (Stage 2 value-space equality, Stage 3 the schema model, Stage 4 the
resolver, Stage 5 scoped values, Stage 6 resolved-output writing).

For every vector still failing, give the ACTUAL cause — read the failure, do not paraphrase the
assertion message — and say which work package or later stage should cover it.

The baseline entering this stage was 88 failing of 277 discovered. If the DISCOVERED count is not
277, the harness is broken and that is the finding, ahead of anything about individual vectors.

Do not fix anything. Do not modify test/conformance/. This is a measurement.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'high' },
);

log(
  sweep === null
    ? 'Sweep returned nothing'
    : `Conformance: ${String(sweep.passing)}/${String(sweep.discovered)} passing, ${String(sweep.failing)} failing (${String(sweep.class1Failing)} under class1/)`,
);

return { stage: 1, results, sweep };
