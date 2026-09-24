export const meta = {
  name: 'tson-rev36-stage-2',
  description:
    'Revision 36 Stage 2: record extension and the discriminated family, templates as family bases and declared applications as entries, then enum profiles, text member sets and class stability',
  whenToUse:
    "After Stage 1's gate is committed. Three packages: two sequential on definitionResolver.ts, then one on the atom checks.",
  phases: [
    {
      title: 'Families',
      detail: 'WP2A: abstract/final, =? selectors, the family checks, dispatch',
    },
    {
      title: 'Templates',
      detail: 'WP2B: type_ref supertypes, template family bases, declared applications',
    },
    { title: 'Enums', detail: 'WP2C: enum profile, text members, settable once, class stability' },
    { title: 'Verify', detail: 'adversarial review of each package' },
    { title: 'Repair', detail: 'one repair round per package that failed review' },
    { title: 'Sweep', detail: 'measure the vectors and name what is still red' },
  ],
};

const START = args && args.startCommit ? args.startCommit : 'HEAD';
const FAILING = args && args.failing ? args.failing : '(see the sweep)';

const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

This is a REVISION run, not a fresh port. The code passed all 277 vectors of 2026 Revision 35, and
Stage 1 of the move to Revision 36 has landed: the four-fact \`record_field\` (\`optional\`,
\`voidable\`, \`role\`, \`value\`), the three-slot field grammar, and the definition marks and \`=?\`
parsed and lowered into \`RecordBody.extension\` / \`discriminators\`. The bundled schemas bootstrap.
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
that must not drop, and nothing green may go red. Do not modify \`test/conformance/\`. If a vector
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
    key: 'families',
    phase: 'Families',
    brief: `WP2A — record extension and the discriminated family ([TSON-SCHEMA] §5.2, §5.4, §5.7,
§5.8, §5.9, §5.10.1, §7.2; change log #10, #11).

Read §5.2's "Definition marks" and "The selector \`=?\`" paragraphs in full, and §7.2.

**Resolver** (\`compiler/definitionResolver.ts\`): nothing may compose onto or refine a FINAL record
— in the declaring schema and in any importing one; subtraction stays admissible and mints no IS-A
edge. \`final\` beside a selector is refused. Check what Stage 1 already lowered and refuses (marks on
non-records, two marks) rather than duplicating it.

**Linker** — a new \`packages/tson/src/link/recordExtension.ts\`, called from \`link/link.ts\` (Java
\`tson-compiler/.../RecordExtension.java\`, \`tson-schema/.../FamilySelectors.java\`). At the base:
each selector's declared type resolves, after its reference chain, to an atom-family instance or an
enum; its name is unmarked and its type non-voidable; it is no field-group member (one reachable by
refinement included, §5.11); it carries no value. Over the family: every entry in the base's
\`subtypes\`, transitively, restates each selector FIXED; the pins are pairwise distinct AS VALUES
under the field type's own equality (§5.5) — \`= 255\` and \`= 0xFF\` collide, \`= 1\` and \`= 1.0\`
collide, text compared NFC — and as tuples in the base's declaration order where there are several.
The family is re-judged whenever any part of it is local, and the refusal lands in the schema that
broke it. One level only. Diagnostics name entries by the name the author wrote.

**Inhabitance** (\`link/typeInhabitance.ts\`): an ABSTRACT record with no subtype in its own closure
is NOT a productivity error (§5.2, §5.10.1).

**Reading** (\`compiler/subsumption.ts\`, \`compiler/compile.ts\`, \`reader/tree/\`, \`reader/bind.ts\`;
Java \`reader/RecordDispatch.java\`, \`RecordTagDispatchReader.java\`,
\`RecordMemberDispatchReader.java\`, \`Subsumption.java\`):
- A position typed by an ABSTRACT record with no discriminators admits exactly its subtypes: the tag
  is REQUIRED, and a tag naming the base itself is refused — no value satisfies it.
- A position typed by a member-dispatched base (non-empty \`discriminators\`) places the value by
  reading the selector field(s), decoded with the BASE's field types and matched against the members'
  pins as values. In text a selector may arrive AFTER the fields it selects
  (\`a-discriminator-may-arrive-after-the-fields-it-selects\`, citing [TSON-DATA] §2.5), so the reader
  must look ahead within the one record — use \`reader/context.ts\`'s existing lookahead mechanism if
  it fits rather than building a second one, and state in the TSDoc that memory there is bounded by
  one record, not by depth. A tag there is optional and, where written, must name the dispatched
  member or a subtype of it. A combination no member pins is a validation error that SHOULD list the
  alternatives. A tag naming the sealed base is refused.
- A position reaching a family with no subtypes in the closure reports that no imported schema
  declares one — a read-time validation error naming the remedy, never "one of ()".
- Tree mode and bind mode both.

Vectors (all under \`class2/\`):
- schema/valid \`how-a-record-may-be-realised\`, \`a-mark-word-is-an-ordinary-name\`; schema/invalid
  \`a-definition-mark-is-not-an-annotation\`, \`a-definition-mark-with-no-definition\`,
  \`two-definition-marks-on-one-declaration\`, \`a-marked-name-cannot-be-applied-as-a-body\`,
  \`a-flatten-directive-names-no-type\` (confirm whichever of these Stage 1 already turned green).
- link/valid \`a-sealed-family-indexes-its-members\`, \`a-selector-implies-abstract\`,
  \`subtraction-from-a-final-record-keeps-no-is-a-edge\`; link/invalid
  \`composing-onto-a-final-record\`, \`refining-a-final-record\`,
  \`a-discriminator-that-is-a-group-member\`, \`a-family-member-that-does-not-pin-the-discriminator\`,
  \`two-family-members-pinning-one-value\`, \`pins-that-differ-only-in-radix\`.
- validate/valid \`a-sealed-family-member-is-placed-by-its-discriminator\`,
  \`a-discriminator-may-arrive-after-the-fields-it-selects\`,
  \`a-pin-is-matched-as-a-value-and-not-as-a-token\`,
  \`a-tag-agreeing-with-the-discriminator-is-admitted\`,
  \`an-abstract-position-reads-the-tagged-subtype\`; validate/invalid
  \`a-discriminator-value-no-member-pins\`, \`a-sealed-family-value-with-no-discriminator\`,
  \`a-tag-contradicting-the-discriminator\`, \`a-tag-naming-a-sealed-base\`,
  \`an-abstract-position-with-no-tag\`.

The abstract-TEMPLATE family vectors (\`a-tag-naming-an-abstract-templates-base\`,
\`an-abstract-templates-instantiation-with-no-tag\`,
\`an-alias-selects-a-member-of-an-abstract-template-family\`) are WP2B's, which runs after you and
builds on your dispatch readers — build them so a template family base can plug in.

You are alone on the tree. Stay out of \`atom/\`, \`compiler/atomChecks.ts\`, \`atomNarrowing.ts\`,
\`link/disjointness.ts\` and \`link/nameHygiene.ts\` (WP2C's).`,
  },
  {
    key: 'templates',
    phase: 'Templates',
    brief: `WP2B — templates and applications ([TSON-SCHEMA] §4.3, §5.6, §5.7, §5.8, §5.9, §5.10,
§7.2, §8.1, §8.2, §8.3; change log #12, #13, #14, #15, #16).

WP2A has landed just before you: definition marks and FINAL enforced, \`link/recordExtension.ts\`
judging families, and tag/member dispatch readers for ABSTRACT and member-dispatched positions. Read
its diff (\`git log -3 --stat\`, \`git diff\`) before starting.

1. **\`record.supertypes\` is \`[type_ref]\`** (#12, §5.8 "Parameterized references", §5.9). A
   supertype may be an application — \`ok => <T> result<T> & { … }\` — and on the reference channel
   the parent is substituted and closed with the rest of the held body, so \`ok<text>\` IS-A
   \`result<text>\` and not \`result<int32>\`. A closed supertype writes as a bare token, so output for
   schemas with no open parent is byte-identical. A removal drops an open application from the
   lineage it keeps for names. Java: \`resolver/MetaRefs.java\` (\`mapRecordSupertypes\`),
   \`TemplateMaterialiser\`, \`SchemaResolver\` (\`withAppliedParents\`).
2. **A record-bodied template is a family base** (#13, §5.10, §1.3). Its entry's
   \`template.extension\` is ABSTRACT and DERIVED (the author's own \`abstract\` mark is the
   instantiation's fact and travels inside the held text); \`template.discriminators\` is whichever
   selectors survive erasure of the parameters (a selector's declared type contains no type
   parameter). Such a template may be named BARE at a type position — a reference, container,
   constructor-application or atom template may not. A position typed by one dispatches exactly as
   an ABSTRACT record's does, over its instantiations, never reading the held body; plug into WP2A's
   dispatch readers. \`compiler/compile.ts\` currently treats a \`TemplateBody\` reaching compilation
   as an error. Minting is keyed on NAMING: an instantiation entry is minted where an application is
   named at a type position, never for a composition operand. A template itself is not credited as
   a subtype of its base (\`link/subtypes.ts\`) — only its instantiations are. \`final\` on a template
   is refused; \`abstract\` is admitted. Java: \`TemplateBody.java\`,
   \`reader/AbstractTemplateReader.java\`, \`TsonSchemaLinker.computeSubtypes\`.
3. **A declaration naming a fully-bound application IS the instantiation entry** (#15, §5.6, §8.2,
   §8.3). \`text_box => box<text>\` resolves to the closed record itself, \`source\` the canonical
   application, the substituted binding record its body — no minted \`box_text_…\` beside it and no
   \`!reference\` hop; a use-site application resolves to a declaration owning it where one exists;
   two declarations naming one application are two entries. A use-site SUGAR form keeps minting a
   content-keyed synthetic. Java: \`TemplateMaterialiser.ownedBy\`, \`ApplicationCloser.java\`.
4. **A record instantiation composes and refines** (#16, §4.3, §5.7): drop "a template instantiation"
   from the finished-operand list; the body test is the whole rule. \`vector<text, 3>\`, a declared
   map and a choice are still refused for having no fields. An application at a composition operand
   is subsumed where it stands and mints nothing.
5. **Applying \`template\` directly in a source declaration is a resolver error** (§8.1 resolver
   vocabulary, §5.10) — judged at the end of the head's reference chain. \`<…>\` is the authored
   spelling of an open entry.
6. **An alias names its target at a subsumption position, on both sides of §7.2's comparison** — the
   annotated name and the position name both reduce to their terminal; the diagnostic names what the
   author wrote. Check whether this already holds before changing anything.

Vectors: link/valid \`a-subtype-template-closes-to-an-is-a-edge\`,
\`a-declared-application-is-the-entry\`, \`an-instantiation-composes-like-a-record\`; schema/invalid
\`applying-template-directly\`, \`applying-template-directly-in-an-open-entry\`; validate/invalid
\`a-tag-naming-an-abstract-templates-base\`, \`an-abstract-templates-instantiation-with-no-tag\`,
\`an-alias-of-an-unrelated-type-is-still-refused\`; validate/valid
\`an-alias-selects-a-member-of-an-abstract-template-family\`,
\`an-alias-is-the-only-name-a-template-instantiation-has\`, \`an-alias-names-the-subtype-it-flattens-to\`;
fixture \`validate-alias.tn\`. Also the resolved-form sidecars for any class2/schema/valid vector.

You are alone on the tree. Stay out of \`atom/\`, \`compiler/atomChecks.ts\`, \`atomNarrowing.ts\`,
\`link/disjointness.ts\` and \`link/nameHygiene.ts\` (WP2C's).`,
  },
  {
    key: 'enums-text',
    phase: 'Enums',
    brief: `WP2C — enum profile, text member sets, settable-once facets, and class stability
([TSON-SCHEMA] §5.4, §5.7, §7.4, §11.4; [TSON-DATA] §7.1, §7.7; change log #17, #21, #22).

WP2A and WP2B have landed before you. The model already carries \`EnumBody.profile\` and the text
types' \`members\`; the rules are yours.

1. **Enum profile** (#21, §7.4, §5.4, §11.4). \`enum_set\` is \`!set_type { element_type: text }\`, so
   the TYPE no longer makes a member an identifier. Under IDENTIFIER (the default) every member MUST
   match [TSON-DATA] §7.7's identifier grammar in NFC — check it in the enum's coherence check with
   \`unicode/\`'s existing identifier-grammar function — and the members see §8.2 name hygiene
   (\`link/nameHygiene.ts\`). Under TEXT a member is any text, sees no name hygiene, and the enum is
   STRING-class whatever its members' spellings (\`!enum [80 443]\` under TEXT is string-class) —
   \`link/disjointness.ts\`. IDENTIFIER is inside TEXT, the narrowing relation a refinement follows:
   IDENTIFIER may refine TEXT, not the reverse. Java: \`EnumBody.java\` (\`coherenceCheck\`,
   \`constraintsCheck\`), \`EnumProfile.java\`, \`TsonSchemaLinker\`.
2. **\`text_type.members\`** (#22, §7.4, §5.7), reached by \`uri_type\`, \`regex_type\` and
   \`email_type\` through composition. Every member satisfies the other facets on the same body, the
   pattern included. **Settable once** is a new facet kind in §5.7's table, for \`members\` AND
   \`pattern\`: a refinement may set one the source left unset, or restate the source's own verbatim,
   and never change it — put a \`checkSettableOnce\` helper in \`compiler/atomNarrowing.ts\` (Java
   \`AtomNarrowing.checkSettableOnce\`). Membership is enforced at read (\`atom/text/\`,
   \`compiler/atomBuilder.ts\`) — a value outside the set is \`ATOM_CONSTRAINT_VIOLATION\`. Members
   are compared as text, NFC.
3. **\`disjoint\` carries class stability** (#17, §5.4's no-class list): an approximate atom whose
   \`allow_nan\` or \`allow_infinity\` is true, and a map whose key type, after its reference chain,
   is not an atom-family instance or an enum, get NO class — so \`( float64 | text )\` is not
   disjoint and needs a tag in text too. \`link/disjointness.ts\`.

Vectors: schema/valid \`an-enum-declares-which-kind-of-enumeration-it-is\`,
\`a-text-type-carries-a-member-set\`; schema/invalid \`an-enum-member-that-is-not-a-name\`,
\`a-member-outside-the-facets-beside-it\`; every vector under \`class2/schema/refused/\`. #17 has no
vector: write unit tests from §5.4.

You are alone on the tree.`,
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
   \`schema/meta/\` or \`test/conformance/\`?
6. A local re-derivation of something \`schema/meta/\` already derives — omission, kind,
   constructorness, disjointness?
7. Tests asserting what the code happens to produce rather than what the spec requires.

Report only problems you can point at a file and line for. Set gatesGreen from what you ran.`;

log(`Revision 36 Stage 2 from ${START}. Entering: ${FAILING}`);

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
the real numbers. Stage 2's gate is 328/328. For every failing vector give the ACTUAL cause — read
the failure — and the owner (WP2A families, WP2B templates, WP2C enums/text, Stage 1 field model, or
other). DISCOVERED must be 328, or the harness is broken and that is the finding. List any failing
unit test. Fix nothing.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'medium' },
);

return { stage: 2, results, sweep };
