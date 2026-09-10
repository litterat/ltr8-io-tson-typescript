export const meta = {
  name: 'tson-rev35-stage-3',
  description:
    'Revision 35 Stage 3: rebuild the schema model, and with it the applicability rule that replaces the field it deletes — TypeDefinition loses four fields, an entry is a constructor by IS-A top, TemplateBody holds text, BinaryType becomes BytesType, Extern and UnknownType become Scoped',
  whenToUse:
    "After Stage 1's gate is committed. Runs BEFORE Stage 2, which the plan orders first but which cannot be measured until the kernel resolves again. src/schema/meta is the frozen contract layer every later stage compiles against, so it must be complete before Stage 4 fans out.",
  phases: [
    { title: 'Model', detail: 'rebuild src/schema/meta and the bindings that read it' },
    { title: 'Applicability', detail: 'WP4.2 — what `!C {}` may apply is an entry that IS-A top' },
    { title: 'Verify', detail: 'adversarially, against the kernel and meta declarations' },
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
3. The spec sections your package implements, in the RE-VENDORED \`spec/\` at the repository root.
   These are already Revision 35. Read the actual section text, not the revision summary.
4. \`spec/m/meta-kernel.tn\`, \`spec/m/meta.tn\` and \`spec/m/core.tn\` — the three live bundled
   schemas, at Revision 35. Their \`@doc\` blocks are normative-adjacent prose written for exactly
   this job, and they are more precise about the model than the spec prose is.
5. The Java reference at the new pin, \`.references/ltr8-io-tson-java/\`, including Javadoc.
6. The conformance vectors, in \`.references/ltr8-io-tson-test-suite/tests/\`.
7. The current TypeScript you are changing.

# How to port

**Idiomatic TypeScript, not transliterated Java.** Discriminated unions over class hierarchies.

**Behaviour comes from the spec and the bundled schemas**, not from what the code did last revision.

**Never weaken a signature.** Anything that can starve for input returns \`Task<T>\` and is called
with \`yield*\`.

**Zero runtime dependencies.** Not one, for any reason.

**Optionality is \`readonly x?: T\`**, never \`readonly x: T | undefined\`.
\`exactOptionalPropertyTypes\` is on and the distinction is meaningful.

**Tree nodes take a \`Node\` suffix**; the \`Tson\` prefix is for errors only.

**Delete what the revision removes.** Do not leave the old path reachable behind a flag or an alias.

# TSDoc

\`CLAUDE.md\`'s rule binds hardest here, because this layer is almost entirely TSDoc: **TSDoc
documents current contract only, no change history.** Never "changed in Revision 35", never "used
to be \`BinaryType\`", never "renamed from". State the current invariant and its rationale directly,
and re-cite the section — a \`§\` citation pointing at the old section number is worse than none.
When you edit an exported type, clean up its TSDoc in the same edit.

# Tests

Write tests from the **spec** and from the bundled schemas, citing the section in the test name.

At the Revision 35 corpus pin the suite discovers **277 subjects**. That number must not drop.

Do not modify the harness in \`test/conformance/\`. If a vector looks wrong, report it.

# Definition of done

\`\`\`bash
npm run typecheck          # clean
npm run lint               # clean, including the import/no-restricted-paths zones
npm run format:check       # clean
npm test                   # unit tests pass
npm run test:conformance    # 277 discovered; nothing regressed
\`\`\`

If a lint zone rule fires, fix the import, not the rule.

# Report back

- Files created, changed or deleted.
- Which conformance vectors moved, by name, verified by running them.
- Every place the spec was ambiguous, underspecified, internally inconsistent, or plain wrong, with
  the interpretation you chose and why. Do not silently pick a reading.
- Anything you could not finish, stated plainly.`;

const BRIEF = `Stage 3 — the schema model. This lands ALONE, and Stage 4's nine packages compile
against what you produce. \`packages/tson/src/schema/meta/\` is the frozen contract layer, and
\`ORCHESTRATION.md\`'s rule that no agent may edit a contract type another agent is building against
only works if the contract is COMPLETE before the fan-out. Leave nothing for Stage 4 to add here.

Read Part 2 §4.1, §4.2, §5.4, §5.5, §5.10, §6, §7.4, §7.8 and §8.1 in \`spec/tson-part2-schema.md\`,
and read \`spec/m/meta-kernel.tn\` and \`spec/m/meta.tn\` end to end. The kernel's \`@doc\` blocks
state the model more precisely than the prose does and you should treat them as the specification
of these types.

Remember the zone rule that gives this layer its shape: \`src/schema/meta\` may import ONLY itself,
\`src/core\` and \`src/annotations\`. It names no compiler type — that is what lets the schema model
ship to a browser that never compiles a schema, and why it carries local stand-ins (its own
\`Token\` mirroring \`ast.TokenValue\`, its own \`SourcePosition\` that the compiler's \`Position\`
satisfies). Keep it that way. If a zone rule fires, the import is wrong, not the rule.

## \`TypeDefinition\` loses four fields

The kernel now declares it as exactly:

    type_definition => {
      source:      type_ref?
      supertypes:  [type_name]?
      subtypes:    [type_name]?
      body:        top
    }

- **\`constructor\`** — the \`~\` marker is gone from the notation. An entry is a constructor if it
  IS-A \`top\` (§4.1, §4.2), which is DERIVED from its supertypes, not stored. Every \`~atom &\`,
  \`~product &\`, \`~sum &\` in the old kernel is now a bare \`atom &\`, \`product &\`, \`sum &\`.
- **\`parameters\`** — an entry's parameters are its BODY's (§5.10). Openness is a fact of
  \`body\`'s shape, not a separate field.
- **\`kind\`** — not resolver output (§4.1, §8.1). \`type_kind\` is gone from the kernel entirely.
  A consumer DERIVES it, by this four-branch rule, in this order:
    1. body is a \`!template\` → TEMPLATE;
    2. else the body's constructor head is \`reference\` → REFERENCE;
    3. else the entry IS-A \`top\` → the base kind named in its own supertypes, or PRODUCT if none;
    4. else the kind of the entry the body's constructor head names.
  \`kind\` restated what \`supertypes\` and \`body\` already determine, and was the one thing a
  document could be LIED to about. Provide the derivation as a function over the model — that is
  what Stage 4's resolver and Stage 6's writer will both call — and do NOT reintroduce a stored
  field, a cache keyed on mutable state, or a \`kind\` parameter threaded through construction.
- **\`disjoint\`** — moves onto \`ChoiceBody\` (§5.4). A variant list is the only thing it is a fact
  about, and an entry with no variants has nowhere to put it, so "recorded on every choice and
  absent on every other definition" becomes STRUCTURAL rather than a rule a document could break.
  The kernel now has \`choice => sum & { variants: [type_ref]  disjoint: boolean? }\`.

## Bodies and constructors

- **\`TemplateBody\` becomes \`{ parameters: string[], template: string }\`.** This is a real change
  of REPRESENTATION, not a rename: the held application is carried as TEXT. The kernel declares

      template => top & { parameters: [param_name]  template: text }

  and the kernel's \`@doc\` on it explains why, at length — read it. The short version: a parameter
  stands wherever a token stands (\`min_items: N\` as readily as \`element_type: T\`), so a body
  carrying one is not typed by any constructor's own record shape until it closes. Comparison for
  identity is over the PARSED form of that text (§5.10, §8.2), so whitespace is free — but the
  parse belongs to Stage 4's \`heldBody.ts\`, not here. Here, the body holds a string.
- **\`BinaryType\` → \`BytesType\`.** \`encoding\` is a selector facet of type \`bytes_encoding\`
  (\`!enum [BASE64 BASE64URL BASE32 HEX]\`) defaulting to \`BASE64\`, and there is NO \`spec\`
  field: RFC 4648 governs spellings, not octets. Facets are \`length\`, \`min_length\`,
  \`max_length\`, all \`non_negative_integer?\`. Read \`bytes_type\`'s \`@doc\` in \`spec/m/meta.tn\`
  in full — it states why the selector is a facet rather than an annotation, and that it is NOT
  refinable, which Stage 4 WP4.5 enforces and your model must be able to express.
- **\`Extern\` and \`UnknownType\` → \`Scoped\` and \`ScopeKind\` (§7.8).** One kernel/meta
  constructor replaces both:

      scope_kind => !enum [LOCAL EXTERN]
      scoped     => sum & { scope: set<scope_kind>  schemas: {uri => [type_name;1..]?; 1..}? }

  Core declares \`declared\` (\`[LOCAL]\`), \`extern\` (\`[EXTERN]\`), \`dynamic\`
  (\`[LOCAL EXTERN]\`), and the templates \`extern_of<S>\` and \`extern_type<S, T>\`. Model the
  types here; the BEHAVIOUR — dispatch, the governing-schema switch on descent — is Stage 5 and is
  not yours. Note \`scoped\` carries no \`disjoint\`: it is a sum but not a choice.
- **\`DurationType\` narrows to seconds; new \`PeriodType\` over months.** Both are
  \`atom & atom_specification &\` with \`spec\` FIXED to RFC 3339 Appendix A, the §5.11 bound group
  \`( min: value | exclusive_min: value )?\` and \`( max: value | exclusive_max: value )?\`, and
  \`multiple_of: value?\`. \`duration_type\` additionally carries \`precision: non_negative_integer?\`;
  \`period_type\` does not. Note the bounds are \`value\`-typed — the kernel's escape hatch — which
  Stage 4 WP4.6 reads under the constrained atom. Model that faithfully.
- **\`IntegerType.members\` and \`DecimalType.members\`** — sparse member sets. The kernel gains
  \`integer_member_set => !set_type { element_type: integer }\`, \`non_negative_integer => !integer ^ { min: 0 }\`,
  and \`set_type\` (renamed from \`set\`, since the bare name is now meta's \`set<T>\` template).
  \`integer_type\` gains \`members: integer_member_set?\` and \`multiple_of\` becomes
  \`non_negative_integer?\`. Sweep every counting facet in the kernel and meta — lengths, item
  counts, digit counts, bit widths, prefix lengths, precision — onto \`non_negative_integer\`,
  because the kernel now does and the model must match the schema it reads.
- **\`set_type\`'s \`min_items\` defaults to 1**, restated with its type and WITHOUT the \`?\`,
  because a defaulted field cannot be optional — the restatement moves it from OPTIONAL to
  REQUIRED_DEFAULT, which is a tightening. Read \`set_type\`'s \`@doc\`; \`enum_set\` is now
  \`!set_type { element_type: identifier }\` with no explicit \`min_items\` because it inherits it.

## Annotations

§6 now names THREE annotation categories — checked, representation directive, advisory — and a
checked annotation has NO third outcome: it holds or the schema fails to load.

- IN as **checked**: \`@discriminator\`, \`@rest\`. (\`@disjoint\` is also a checked assertion.)
- IN as **representation directives**: \`@rest\` and \`@discriminator\` are named as directives in
  \`meta.tn\`'s own header — read §6 and \`spec/m/meta.tn\` and get the categorisation right rather
  than taking this brief's word for it.
- IN as **advisory**: \`@title\`, \`@examples\`, \`@read_only\`, \`@write_only\`.
- OUT: \`@alias\`. It goes with use-site flattening (Stage 4 WP4.1). Remove it from the model here;
  removing the flattener is Stage 4's.

## What is NOT yours

- \`compiler/referenceFlattener.ts\` (WP4.1), \`heldBody.ts\` (WP4.3),
  \`atomNarrowing.ts\` (WP4.5) — later Stage 4 packages.
- Scoped-value DISPATCH and the governing-schema switch — Stage 5.
- Resolved-output WRITING — Stage 6.
- \`test/conformance/\` — Stage 7, and never to make a vector pass.

You WILL have to update everything that reads the model to keep the tree compiling —
\`packages/tson/src/schema/bindings.ts\`, \`metaReader.ts\`, \`bootstrap.ts\`, and whatever in
\`src/compiler/\` and \`src/write/\` names a field you removed. Do that: a contract layer that does
not compile is not complete. Keep those edits MECHANICAL — make them read the new model — and do
not implement Stage 4's or Stage 6's behaviour while you are in there. Where a call site genuinely
needs the derived \`kind\`, call your derivation function.

**\`constructor\` is the exception, and it is why a second package follows yours.** Deleting the
field breaks three compiler modules that read it — \`definitionResolver.ts\`, \`desugar.ts\` and
\`templates.ts\` — and what replaces it is a real rule (WP4.2's IS-A \`top\`), not a mechanical
substitution. Delete the field, provide the \`isConstructor(entry)\` derivation beside your \`kind\`
derivation, and make those three call it so the tree compiles. Do not go further into WP4.2's
placement and atom-refinement rules; the next package owns those and will build on what you leave.

**The bundled schemas are the test.** \`spec/m/*.tn\` are loaded at runtime and
\`packages/tson/src/stdlib/schemas.generated.ts\` is already regenerated from the Revision 35
copies. The meta-kernel bootstrap in \`packages/tson/src/schema/bootstrap.ts\` must resolve them —
it currently stops at \`value => !unit {}\`, because \`unit\` was \`~atom & {}\` and is now
\`atom & {}\`, so the stored flag says it is not a constructor. Getting past that is the point of
this stage. Stage 1 already made that bootstrap resolve in dependency order and gave it a real
meta reader; build on it rather than reverting it. State plainly how far the three schemas get and
what blocks the rest — do not claim more than you can run.`;

const MODEL_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'filesWritten', 'contractSummary', 'vectorsMoved', 'specFindings', 'notes'],
  properties: {
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: {
      type: 'array',
      items: { type: 'string' },
      description: 'every file created, changed or deleted',
    },
    contractSummary: {
      type: 'string',
      description:
        'the exported shape of TypeDefinition, the body union, and the kind-derivation function, as Stage 4 will import them',
    },
    vectorsMoved: {
      type: 'array',
      items: { type: 'string' },
      description: 'vectors that moved either way, verified by running them',
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

log(
  'Revision 35 Stage 3: the schema model, then the applicability rule that replaces the field it deletes.',
);

const model = await agent(
  `${PORTER}

---

${BRIEF}

Stages 0 to 2 have landed: \`spec/\` at the repository root IS Revision 35, \`.references/\` is at
the new pins, \`schemas.generated.ts\` is regenerated, the Part 1 data layer is at Revision 35, and
equality is over value spaces. Read \`spec/\` and the current source, not a cached memory of
Revision 34.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`,
  { label: 'model', phase: 'Model', model: 'sonnet', schema: MODEL_RESULT, effort: 'high' },
);

if (model === null) {
  throw new Error(
    'the schema-model package returned nothing; aborting rather than reporting success',
  );
}

log(`Model: ${model.status}, ${String(model.filesWritten.length)} files`);

const APPLICABILITY_BRIEF = `WP4.2 — applicability is IS-A \`top\` ([TSON-SCHEMA] §3.3.1, §4.2, §5.5).

The schema model has just landed. \`TypeDefinition.constructor\` is gone and an
\`isConstructor(entry)\` derivation stands in its place, with the three call sites in
\`definitionResolver.ts\`, \`desugar.ts\` and \`templates.ts\` calling it so the tree compiles.
Your package is the rule that derivation is supposed to enforce, which the previous package
deliberately did not build.

Read §3.3.1, §4.1, §4.2 and §5.5 in \`spec/tson-part2-schema.md\` in full before writing anything.

**\`~\` leaves the type-def head.** It keeps exactly one grammar role, the default-value modifier
(\`port: integer ~ 8080\`). At type-def position it is a special token with no role, and a source
document that writes one there is a resolver error. The corpus states this by name:
\`class2/schema/invalid/a-constructor-marker-is-not-grammar\`. Note what the runner requires of it
— at the Class 2 schema layer the category is the PHASE's, so an error vector there states
\`resolver\` however parser-shaped the rule is, decided from the schema having failed to load and
never by reading whichever internal diagnostic fired.

**What \`!C { ... }\` may apply is an entry that IS-A \`top\`.** §5.5: "the \`!\` prefix always
takes an entry that IS-A \`top\` — a constructor (§4.2)". The kernel's \`reference\` is included,
which stops being a dispatched special case and becomes ordinary: \`!reference { target: X }\`
denotes the alias \`X\`, REFERENCE-kinded, open (\`<B> !reference { … }\`) and closed alike. Find
the special case in \`definitionResolver.ts\` and delete it rather than leaving it beside the
general rule.

**Revision 34's separate "level discipline" rule disappears into the placement rule.**
Constructorness now propagates through composition and refinement, so an ordinary schema that
composes with a constructor has *ipso facto* declared an entry that IS-A \`top\`, and placement
refuses it. One check where there were two — delete the second, do not leave it as a redundant
guard.

**Atom refinement's test is easy to get wrong, and the spec calls it out.** It asks whether the
body **is an atom application** (\`!integer_type {}\`), NOT whether the target IS-A \`atom\`:
IS-A \`atom\` is true of the constructor and false of every instance, which is the opposite of
what a reader expects. It is also not a kind check. Get this exactly right and write a test that
would fail under each of the two wrong readings.

**Kind determination is §5.5's, and it is a resolver error to get two.** "A constructor's kind is
settled at definition time by the base kind — \`atom\`, \`product\`, \`sum\`, or \`data\`,
excluding \`top\` — reachable through its transitive supertypes chain. Zero base kinds in the
chain → PRODUCT by structural default; exactly one → that kind; two or more → resolver error."

**Bodies are closed (§5.5).** A construction or refinement body is validated as an ordinary closed
record: a member the constructor's vocabulary does not declare is a resolver error at the
declaration, naming the member and the constructor's real fields. §5.5 says why this is stated
where bodies are written: an implementation that binds field-by-field and ignores unmatched members
reports success while discarding the constraint the author wrote, so
\`!integer ^ { minimum: 1  maximum: 100 }\` — JSON Schema's spellings — would compile clean and
constrain nothing. Check that this port does not do that.

**The measure of this package is the kernel.** \`spec/m/meta-kernel.tn\`, \`meta.tn\` and
\`core.tn\` must bootstrap and resolve; \`packages/tson/test/bootstrap.test.ts\`,
\`stdlib.test.ts\` and \`bundled-schemas-resolve.test.ts\` are the tests that say so. Around 43
unit tests and all 56 \`class2/\` vectors are currently red behind this one rule; they will not
all go green here (Stage 4's remaining packages, Stage 5 and Stage 6 own the rest), but the ones
blocked purely on "nothing is a constructor" must. Report the count you actually reach.

Fixture assertions that state Revision 34 counts or Revision 34 shapes — declaration counts, entry
counts, \`constructor\` being true — are yours to update to what Revision 35 requires, with the
reason in the test name. Do not update one to match whatever the code happens to produce; work out
what the spec and the bundled schema require and assert that.

Do NOT touch \`compiler/referenceFlattener.ts\` (WP4.1), \`heldBody.ts\` (WP4.3),
\`atomNarrowing.ts\` (WP4.5), the scoped-value dispatch (Stage 5), the resolved-output writer
(Stage 6), or \`test/conformance/\`.`;

const applicability = await agent(
  `${PORTER}

---

${APPLICABILITY_BRIEF}

The schema model package reported: ${model.contractSummary}
Files it changed: ${model.filesWritten.join(', ')}

\`packages/tson/src/schema/meta/\` is now FROZEN. Import from it; if something there is genuinely
wrong, say so and stop rather than editing it — Stage 4's other packages build on it next.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Do not modify test/conformance/.`,
  {
    label: 'applicability',
    phase: 'Applicability',
    model: 'sonnet',
    schema: MODEL_RESULT,
    effort: 'high',
  },
);

log(
  applicability === null
    ? 'Applicability returned nothing'
    : `Applicability: ${applicability.status}, ${String(applicability.filesWritten.length)} files`,
);

const verdict = await agent(
  `Adversarially review the TSON TypeScript port's Stage 3 — the rebuild of
\`packages/tson/src/schema/meta/\` for 2026 Revision 35, and the applicability rule (WP4.2) that
replaces the \`constructor\` field it deletes. Default to finding it UNSOUND.

This layer is the FROZEN CONTRACT nine Stage 4 packages will compile against concurrently. A gap
here is not a bug in one package, it is a gap in nine. Review it as a contract, not as code.

Files claimed by the model package: ${model.filesWritten.join(', ')}
Contract claimed: ${model.contractSummary}
Files claimed by the applicability package: ${applicability === null ? '(it returned nothing)' : applicability.filesWritten.join(', ')}

Check, in this order:

1. Run the gates yourself. \`npm run typecheck\`, \`npm run lint\`, \`npm run format:check\`,
   \`npm test\`, \`npm run test:conformance\`. Did anything green go red? Is the discovered count
   still 277?
2. **Read \`spec/m/meta-kernel.tn\` and \`spec/m/meta.tn\` declaration by declaration against the
   model.** Every field, every type, every default, every FIXED value, every §5.11 group. This is
   mechanical and it is the review: a field the model spells differently from the schema it reads
   is a defect the type checker cannot see.
3. Are the four removed \`TypeDefinition\` fields GONE — \`constructor\`, \`parameters\`, \`kind\`,
   \`disjoint\` — or is one still there under another name, or reachable through a helper?
4. Is \`kind\` DERIVED by the four-branch rule of §8.1, in that order, and is the derivation the one
   function everything calls? A stored field, a cache keyed on mutable state, or a second copy of
   the rule is the defect. Test the rule's branches yourself, including branch 4 (the kind of the
   entry the body's constructor head names) which is the one a shortcut skips.
5. Is \`TemplateBody.template\` a STRING? A structured held body here defeats the whole
   representation change. And does anything try to PARSE it at this layer — which would drag a
   compiler type into \`src/schema/meta\` and break the zone?
6. Is \`disjoint\` on \`ChoiceBody\` and nowhere else? \`scoped\` is a sum and must NOT carry one.
7. \`BytesType\`: is \`spec\` gone, is \`encoding\` a selector defaulting to \`BASE64\`, and can the
   model express "not refinable" for Stage 4 to enforce?
8. Did every counting facet move to \`non_negative_integer\`, everywhere the kernel and meta moved
   it? Check lengths, item counts, digit counts, bit widths, prefix lengths and precision.
9. Is \`@alias\` gone from the model?
10. **Optionality**: \`readonly x?: T\`, never \`readonly x: T | undefined\`.
    \`exactOptionalPropertyTypes\` is on and the distinction is meaningful. Check every optional
    field added or changed.
11. Stale TSDoc and stale \`§\` citations — this layer is mostly TSDoc, so this is a first-class
    check, not a nit. Any "renamed from", "used to", "in Revision 34"?
12. **The zone**: does \`src/schema/meta\` still import only itself, \`src/core\` and
    \`src/annotations\`? Did it acquire a compiler import, or did someone relax the rule instead of
    fixing an import?
13. Did it implement Stage 4's, 5's or 6's behaviour while it was in there? Scope creep in the
    contract layer blocks the fan-out.
14. Did it edit \`test/conformance/\`?

Then the applicability half (WP4.2), which the second package owned:

15. Does a \`~\` at type-def position actually fail? Run
    \`class2/schema/invalid/a-constructor-marker-is-not-grammar\` and check the runner sees a
    \`resolver\` category decided from the schema having failed to load, not from an internal
    parser diagnostic.
16. Is \`reference\` applied like any other constructor, or is the special case still there beside
    the general rule? \`!reference { target: X }\` must denote the alias \`X\`, open and closed
    alike.
17. Was Revision 34's separate "level discipline" check DELETED, or left as a redundant guard that
    happens to agree? §5.5 makes it one check, not two.
18. **Atom refinement's test.** Does it ask whether the body IS AN ATOM APPLICATION
    (\`!integer_type {}\`)? Construct the two wrong readings yourself — an IS-A \`atom\` check
    (true of the constructor, false of every instance) and a kind check — and confirm each would
    fail a test the package wrote. If neither would, the test does not pin the rule.
19. **Are bodies closed?** \`!integer ^ { minimum: 1  maximum: 100 }\` — JSON Schema's spellings,
    not this vocabulary's — must be a resolver error naming the member and the constructor's real
    fields. Try it. A body that binds field-by-field and ignores unmatched members reports success
    while discarding the constraint the author wrote, which is the failure §5.5 states this rule to
    prevent.
20. Do all three bundled schemas bootstrap and resolve? If not, is the remaining blocker honestly
    attributed to a later package rather than reported as done?
21. Was any fixture assertion updated to match whatever the code happens to produce, rather than to
    what the spec and the bundled schema require? Check each changed expected value against
    \`spec/m/\`.

Report only problems you can point at a file and line for.`,
  { label: 'verify:model', phase: 'Verify', schema: VERDICT, effort: 'high' },
);

log(
  verdict === null
    ? 'Verify returned nothing'
    : `Verdict: ${verdict.sound ? 'sound' : 'UNSOUND'}, ${String(verdict.problems.length)} problems`,
);

return { stage: 3, model, applicability, verdict };
