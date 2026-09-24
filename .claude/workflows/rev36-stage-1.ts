export const meta = {
  name: 'tson-rev36-stage-1',
  description:
    'Revision 36 Stage 1: the four-fact record_field, the three-slot field grammar, definition marks and =? parsed and lowered, and the bundled schemas bootstrapping again',
  whenToUse:
    'After Stage 0 (pins and vendoring) is committed. One package, alone: it is the contract layer and every consumer that must change for the kernel to load.',
  phases: [
    { title: 'Port', detail: 'the field model, grammar and bootstrap, as one package' },
    { title: 'Verify', detail: 'adversarial review against the Revision 36 text' },
    { title: 'Repair', detail: 'one repair round, only if the gate or the review failed' },
    { title: 'Sweep', detail: 'measure the vectors and name what is still red' },
  ],
};

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This is a REVISION run, not a fresh port. The code exists and passed all 277 vectors of 2026
Revision 35; your package moves it to Revision 36. You are looking for what the new spec text
requires that the current code does not do, and for what the current code does that the new text no
longer allows.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions.
2. \`REVISION-36-PLAN.md\` — the whole plan, then your stage. Your brief below is the authority
   where the two differ.
3. \`spec/tson-rev36-changelog.md\` — every adjudicated change, by section, with the reasoning. Its
   §4 digest is the shortest statement of what an implementer acts on.
4. The spec sections your package implements, in the RE-VENDORED \`spec/\`: \`tson-part1-data.md\`,
   \`tson-part2-schema.md\` (both Revision 36). Read the section text, not the summary.
5. \`spec/m/meta-kernel.tn\` and \`meta.tn\` — the kernel's own @doc text states several rules in
   the voice the resolved output must match. \`git diff a628700~2 -- spec/m/\` shows what moved.
6. The Java reference at the new pin, \`.references/ltr8-io-tson-java/\`, including Javadoc.
7. The vectors your package should turn green, in \`.references/ltr8-io-tson-test-suite/tests/\` —
   subject AND \`-expected.tn\` sidecar. \`RUNNER.md\` there is normative for runners.

# How to port

Idiomatic TypeScript, not transliterated Java: discriminated unions, plain functions. Behaviour comes
from the spec and the vectors, not from the Java's convenience and not from what the code did last
revision. Never weaken a \`Task<T>\` signature. No \`RegExp\` in \`src/base/\`. The lexer is
code-point addressed. Zero runtime dependencies.

**Delete what the revision removes.** Not behind a flag, not as a lenient fallback. Delete the unit
tests that asserted the old behaviour and replace them with tests of the new behaviour citing the new
section.

**TSDoc documents current contract only.** Never "Revision 35", "used to", "renamed from", "no
longer". When you change what an exported type or function does, rewrite its TSDoc in the same edit
and re-cite the section.

# Tests

Write tests from the spec, citing the section in the test name. The suite discovers **328 subjects**
at the Revision 36 pin; that number must not drop. Do not modify \`test/conformance/\` except where
your brief explicitly says so. If a vector looks wrong, report it.

# Definition of done

\`\`\`bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance
\`\`\`

If a lint zone rule fires, fix the import, not the rule.

# Report back

Files changed; vectors moved to passing, by name, verified by running them; every spec ambiguity with
the reading you chose and why; anything unfinished, stated plainly.`;

const BRIEF = `Stage 1 — the four-fact record_field, the three-slot field grammar, and the bootstrap.

**Where the suite stands.** Class 1 is all green. All 107 Class 2 vectors fail for ONE reason: the
bundled meta-kernel is spelled in Revision 36's field grammar and \`parseFieldDef\` in
\`packages/tson/src/compiler/schemaParser.ts\` expects \`:\` right after a field name, meets
\`extension?:\` at meta-kernel line 125, and throws. The kernel never bootstraps, so no Class 2
vector can be measured. Your package makes it bootstrap, under the Revision 36 model, and nothing
less: a parser that swallows \`?\` while the model still says \`field_state\` is not this package.

You are working ALONE on the tree. Nothing else is running.

## 1. The model — \`packages/tson/src/schema/meta/\` (the contract layer)

Put EVERY Revision 36 field in now; the model is frozen once later stages fan out.

- \`bodies.ts\`: \`RecordField\` becomes \`{ name, type, optional, voidable, role, value?, annotations }\`
  with \`FieldRole = 'FREE' | 'DEFAULT' | 'FIXED'\` (§5.2, §8.1, kernel \`record_field\` and
  \`field_role\`). **Delete \`FieldState\`.** What omission yields is derived and never stored: an
  unmarked name is MISSING when omitted; an optional field with a value injects it; an optional one
  without yields absence — except a field-group member, whose presence is the group's and which is
  never supplied. Put that derivation in ONE exported function here and have every consumer call it.
- \`RecordBody\` gains \`extension\` (\`RecordExtensionType = 'ABSTRACT' | 'FINAL' | 'OPEN'\`, kernel
  default OPEN) and \`discriminators: readonly string[]\`; \`supertypes\` becomes \`TypeRef[]\` (§5.8,
  kernel \`record\` @doc). \`TypeDefinition.supertypes\` in \`typedef.ts\` stays names.
- \`TemplateBody\` gains \`extension?\` and \`discriminators?\` — optional with NO default (kernel
  \`template\` @doc says why: absence means the template is no type).
- \`EnumBody\` gains \`profile\` (\`'IDENTIFIER' | 'TEXT'\`, default IDENTIFIER).
- \`atoms-text.ts\`: \`TextType\` and the three that compose it (\`RegexType\`, \`UriType\`,
  \`EmailType\`) gain \`members?\`.

Optionality is \`readonly x?: T\` (CLAUDE.md; \`exactOptionalPropertyTypes\` is on).

## 2. The grammar — \`ast/schema/\` and \`compiler/schemaParser.ts\` (§12.1, §12.2, §12.3)

- \`field-def = *annotation field-name ["?"] ws ":" ws …\` — the \`?\` MUST be adjacent to the name.
- \`field-modifier = ws ("~" / "=") ws token / ws "=" ws "?"\`. The absent sentinel is NOT a modifier
  value any more; \`=?\` is the selector and takes no value (\`a: T =? v\` is a parse error).
- A \`?\` after the TYPE at a field makes it voidable.
- \`group-member = *annotation field-name ws ":" ws type-ref ["?"]\` — no \`?\` on a member's name.
- \`schema-map-entry\` gains \`[ definition-mark ws ]\` between \`=>\` and the type definition, before
  any parameter list: the words \`abstract\` and \`final\`, read UNCONDITIONALLY at that slot. A
  declaration whose whole body is the bare word is a declaration missing its definition;
  \`abstract => { … }\` (the word as a declared NAME) and \`f: abstract\` stay legal. Two marks are
  ungrammatical.
- AST: the name's \`?\`, \`voidable\` on the field type, a selector variant of the modifier, the
  modifier's absent variant DELETED, \`voidable\` on a group member, \`Declaration.mark\`.

## 3. One field-marks table

The field-marks table exists TWICE today: \`compiler/fieldModifiers.ts\` (\`resolveFieldModifiers\`,
used by \`definitionResolver.ts\`) and a private copy in \`compiler/desugar.ts\` (around lines
790–890: \`resolveFieldModifiers\`, \`FieldStateName\`, \`recordFieldValue\`). Merge them into one —
the Java has one, \`FieldModifiers.of\` in \`tson-compiler/.../resolver/FieldModifiers.java\`. It
carries §5.2's refusals: a default on an unmarked name (suggest \`a?: T ~ v\`); a pin on a voidable
type; a modifier on a \`void\`-typed field, and \`_\` as a modifier value; \`=?\` on a marked name or a
voidable type. And "which fields may carry a value" (atom-family instance or enum after the reference
chain) stays.

## 4. Every consumer of the old model

- \`desugar.ts\` \`recordBinding\`: group members lower to \`optional: true\` (plus \`voidable\` for
  \`T?\`) — \`spec/m/meta-kernel-resolved.tn\` shows this.
- \`compiler/wireForm.ts\` \`heldRecord\`: writes \`optional\`/\`voidable\`/\`role\` rather than \`state\`.
- \`compiler/definitionResolver.ts\`: \`resolveFieldEntry\`, \`resolveTighteningField\`,
  \`resolveGroupMember\`, \`dissolveInto\`. Refinement is **three orders** (§5.7): omission absent →
  required → injected, voidable true → false, role FREE → DEFAULT → FIXED; no question moves
  backwards; a restatement may change a default but never a pin; a restated group member stays a
  member. Delete the five-state transition matrix (\`isValidTighteningTransition\`) and §5.11's
  "two members always present" refusal (\`checkGroupPresence\`, \`isAlwaysPresent\`,
  \`isOptionalState\`, \`stateOf\`) — §5.11 restates it as a consequence that refuses nothing. Java:
  \`DefinitionResolver.refines\` / \`omission\` / \`resolveTighteningField\`.
- Lower the definition mark into \`RecordBody.extension\` and the \`=?\` fields into
  \`discriminators\` (in declaration order), the marked fields themselves staying FREE, unmarked,
  unpinned; \`=?\` implies ABSTRACT. A mark on a non-record is a resolver error. The REST of the
  family rules (FINAL refusals, pin checks, dispatch) are Stage 2's — do not build them.
- \`schema/bindings.ts\`: \`record_field\` (four facts), \`field_role\` in place of \`field_state\`,
  \`record\` (\`extension\`, \`discriminators\`, \`supertypes\` as type_ref), \`template\`, \`enum\`
  (\`profile\`; \`enum_set\` elements are TEXT now, not identifier), the text types' \`members\`,
  \`record_extension_type\`, \`enum_profile\`.
- \`schema/metaReader.ts\`: the §5.6 positional form counts fields whose NAME is unmarked;
  \`defaultAsDataValue\` injects when \`optional && value\`; the atom decoder knows \`field_role\`.
- \`schema/bootstrap.ts\`, \`compiler/templates.ts\` (a parametric \`= P\` is a required FREE field
  with the parameter in \`value\`, and closes optional and FIXED when substitution makes it
  concrete), \`compiler/schemaResolver.ts\`, \`link/subtypes.ts\` (supertypes are type_refs now).
- \`reader/tree/record.ts\`: \`_\` is admitted exactly when the field is voidable; omission is
  missing / injected value / nothing by the one derivation; a written \`_\` at a voidable field stays
  in the TREE as a present field with an absent value (§5.2 "Delivery", [TSON-DATA] §2.9). Delete
  the "fixed to absent" branch (\`FixedCheck.mustBeAbsent\`) and the refusal of \`_\` at a defaulted
  field. A FIXED field's written value is verified against the pin as values (§5.5).
- \`reader/bind.ts\`, \`bind/decode.ts\`, \`bind/strictness.ts\`, \`link/typeInhabitance.ts\` (a field
  is inhabited if optional or voidable; a \`void\`-typed field whose key must be written and which
  refuses \`_\` empties the record — §5.10.1), \`link/referenceValidation.ts\`.
- The resolved-output writer: four-fact fields with defaults omitted, \`extension\` omitted at OPEN,
  \`discriminators\` omitted when empty, set-typed fields in SOURCE DECLARATION ORDER (§7.5, #4 —
  the set-comparison MUST is gone; resolved output is compared as written).

About 6,200 lines of unit tests name the five field states (schemaParser, definitionResolver,
desugar, fieldModifiers, bootstrap, schema-bindings, reader-tree-record, bind-strictness,
link-typeInhabitance, link-referenceValidation, heldBody, bundled-schemas-resolve). Rewrite them to
the new model; do not delete coverage, move it.

\`test/conformance/\` you may touch ONLY if the harness itself names \`field_state\` or the old shape
in the resolved-form comparison — say exactly what and why in your report.

## Gate

- The three bundled schemas bootstrap; \`packages/tson/test/bundled-schemas-resolve.test.ts\` is
  green against the Revision 36 \`spec/m/*-resolved.tn\` (update its \`/2026/35/\` identities).
- Class 1 stays all green; 328 discovered.
- These vectors green (field marks, #23): schema/valid \`each-field-mark-answers-one-question\`,
  \`a-field-that-admits-only-absence\`, \`record-with-optional-field\`; schema/invalid
  \`a-default-on-a-key-that-is-always-written\`, \`a-pin-on-a-voidable-type\`, \`a-pin-to-absence\`,
  \`default-on-a-record-typed-field\`; link/invalid \`a-void-field-the-document-must-write\`;
  validate/invalid \`a-marker-left-out\`, \`a-required-voidable-key-left-out\`,
  \`an-optional-key-written-as-absent\`; validate/valid \`a-defaulted-key-cleared-with-absent\`,
  \`a-required-key-written-as-absent\`.
- Report the Class 2 pass count after your change. Family, template, enum-profile and text-member
  vectors are Stage 2's and may stay red; everything that is neither of those should go green now
  that the kernel loads, and any that does not is a finding to report with its actual cause.`;

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'filesWritten',
    'vectorsGreen',
    'passing',
    'discovered',
    'specFindings',
    'notes',
  ],
  properties: {
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    vectorsGreen: { type: 'array', items: { type: 'string' } },
    passing: { type: 'number' },
    discovered: { type: 'number' },
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
  required: ['sound', 'gatesGreen', 'problems'],
  properties: {
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
          cause: { type: 'string', description: 'the actual reason, not the assertion message' },
          owner: {
            type: 'string',
            description: 'Stage 1, WP2A families, WP2B templates, WP2C enums/text, or other',
          },
        },
      },
    },
  },
};

const VERIFY = `Adversarially review Stage 1 of the TSON TypeScript port's move to 2026 Revision 36
(the four-fact record_field, the three-slot field grammar, definition marks and =? parsed and
lowered). \`git diff a628700\` is the change. Default to finding it UNSOUND.

Check, in order:
1. Run \`npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance\`
   yourself. 328 discovered? Class 1 all green? The thirteen field-mark vectors named in
   REVISION-36-PLAN.md Stage 1's gate green? \`bundled-schemas-resolve.test.ts\` green?
2. Read §5.2, §5.7, §5.11, §7.6, §8.1 and §12.1 in \`spec/tson-part2-schema.md\` against the CODE.
   Is every refusal there? Refinement as three orders? Injection derived in ONE place, and does
   every consumer call it rather than re-deriving? A group member never injected?
3. Did it DELETE \`FieldState\`, the \`= _\` / absent-modifier path, the five-state matrix, §5.11's
   "two always present" refusal, and the second field-marks table in desugar.ts — or leave any
   reachable?
4. Stale TSDoc and \`§\` citations: any "Revision 35", "used to", "no longer", or a comment still
   describing field states. First-class, not a nit.
5. Weakened \`Task<T>\`, runtime dependency, RegExp in src/base/, relaxed ESLint zone?
6. Tests asserting what the code produces rather than what the spec says; coverage deleted rather
   than moved.
7. Edits to \`test/conformance/\` beyond what the brief allowed.

Report only problems you can point at a file and line for. Set gatesGreen from what you ran.`;

phase('Port');
log('Revision 36 Stage 1: one package. 107 of 328 failing at the start, all Class 2, one cause.');
const port = await agent(`${PORTER}\n\n---\n\n${BRIEF}`, {
  label: 'port:field-model',
  phase: 'Port',
  model: 'sonnet',
  schema: PORT_RESULT,
  effort: 'high',
});
if (port === null) throw new Error('the Stage 1 porter returned nothing');
log(`port: ${port.status}, ${String(port.passing)}/${String(port.discovered)} passing`);

phase('Verify');
const verdict = await agent(
  `${VERIFY}\n\nThe porter claims: status ${port.status}; vectors green: ${port.vectorsGreen.join(', ') || '(none)'}; notes: ${port.notes}`,
  { label: 'verify:field-model', phase: 'Verify', schema: VERDICT, effort: 'high' },
);

let repair = null;
const blocking = verdict === null ? [] : verdict.problems.filter((p) => p.severity !== 'minor');
if (verdict === null || !verdict.gatesGreen || blocking.length > 0 || port.status !== 'complete') {
  phase('Repair');
  log(
    `repair: ${String(blocking.length)} blocking/significant problems, gates ${verdict === null ? 'unknown' : String(verdict.gatesGreen)}`,
  );
  repair = await agent(
    `${PORTER}\n\n---\n\n${BRIEF}\n\n---\n\nA first porter has already done most of this package; its work is in the tree (\`git diff a628700\`). You are the REPAIR pass. Its own report:\n${JSON.stringify(port, null, 2)}\n\nAn adversarial reviewer found:\n${JSON.stringify(verdict, null, 2)}\n\nFix every blocking and significant problem, and anything the porter left unfinished, until the definition of done and the Stage 1 gate hold. Do not undo correct work.`,
    {
      label: 'repair:field-model',
      phase: 'Repair',
      model: 'sonnet',
      schema: PORT_RESULT,
      effort: 'high',
    },
  );
}

phase('Sweep');
const sweep = await agent(
  `Run \`npm test\` and \`npm run test:conformance\` for the TSON port at 2026 Revision 36 and report
the real numbers. For EVERY failing conformance vector give the ACTUAL cause — read the failure, do
not paraphrase the assertion — and attribute it: "Stage 1" if it is a field-model / grammar /
bootstrap defect; "WP2A" for definition marks, FINAL, selectors, sealed/abstract families and their
dispatch; "WP2B" for type_ref supertypes, template family bases, declared applications, instantiations
as operands, applying template directly, alias subsumption; "WP2C" for enum profile, text members,
disjoint class stability; else "other". If DISCOVERED is not 328 the harness is broken, and that is
the finding. Also list any failing unit test. Fix nothing.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'medium' },
);

return { stage: 1, port, verdict, repair, sweep };
