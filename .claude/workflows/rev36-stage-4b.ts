export const meta = {
  name: 'tson-rev36-stage-4b',
  description:
    'Revision 36 Stage 4b: Part 3, the JSON encoding — the annotation object, tag, member and choice dispatch with cross-encoding parity, then the front door and the CLI',
  whenToUse: 'After Stage 4a is committed. Two sequential packages completing src/json/.',
  phases: [
    { title: 'Dispatch', detail: 'WP4C: annotation object, family and choice dispatch, parity' },
    { title: 'FrontDoor', detail: 'WP4D: front door, CLI, docs' },
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
    key: 'json-dispatch',
    phase: 'Dispatch',
    brief: `WP4C — the annotation object and dispatch ([TSON-JSON] §3.2, §3.3, §6.1.5, §8, §8.3.1, §9.4;
Part 2 §5.2, §5.4, §5.10, §7.2).

WP4A and WP4B have landed: \`src/json/\` reads JSON schemalessly and against a schema at every
position that needs no dispatch; positions that do compile to a \`NOT_IMPLEMENTED\` reader. Your
package replaces those. Read \`git log --stat -6\` and the \`src/json/\` sources first.

Java: \`tson-json/.../json/reader/\` — \`ReservedMembers\` (\`lead\`), \`Tags\`, \`DispatchTagReader\`,
\`DispatchMemberReader\`, \`DispatchChoiceReader\`, \`DispatchFactories\`, \`Route\`, \`ExactReader\`,
\`DiscriminationClass\`, \`OpenTemplateReader\`, \`ReferenceChain\`, \`DeferredTypeReader\`.

- **Reserved names** (§3.2): \`$schema\`, \`$type\`, \`$value\`, a CLOSED set — any other \`$\` name
  where names are field names is a resolver error; never reserved at a map position.
- **The annotation object** (§3.3): wrapper form (reserved members only, with \`$value\`; anything
  else a resolver error) and inline form (only when the value is a record). **The reserved members
  LEAD**: \`$schema\` first, then \`$type\`; anywhere else is a resolver error, as is a \`$value\` in
  an object not led by \`$type\`. Recognition happens where a tag is required or the position is
  scoped; at other typed non-map positions only when the first member is reserved; never at a map
  position. \`$type\` MUST resolve and be admissible (subsumption, variant membership). \`$schema\`
  outside an EXTERN scoped position is a resolver error.
- **Records at a family position** (§6.1.5): OPEN or FINAL — the value is exactly the type (a tag,
  if written, admissible by §7.2); ABSTRACT — \`$type\` REQUIRED, a tag naming the abstract base
  refused; member-dispatched (non-empty \`discriminators\`) — **the discriminators LEAD**, right
  after any reserved members, read at the BASE's field types and matched against the members' pins
  by value; a missing or late discriminator is a validation error (that bounded prefix is what keeps
  this reader streaming, and it is a real difference from the text encoding, which must look ahead);
  an unmatched value is a validation error that SHOULD list the alternatives; a tag there only
  asserts and must name the dispatched type or a subtype of it. A record-bodied template named as a
  family base dispatches over its instantiations the same way. Use the family facts \`schema/meta\`
  and \`link/\` already derive; do not re-derive them.
- **Choices** (§8): a tag is always accepted; it may be omitted IFF the choice is \`disjoint: true\`
  (\`schema/meta\`'s \`choiceDisjoint\` — class stability is folded into it at Revision 36), and then
  selection is by JSON kind from a table precomputed per choice. No shape matching, no trying
  variants in order. Decode order: first member reserved → tagged; else disjoint → by kind; else a
  validation error. §8.3.1: at a choice position an object whose first member is reserved is an
  annotation object.
- **Diagnostic codes**: a resolving name that is not admissible is \`TYPE_MISMATCH\`, a name that
  denotes nothing \`UNKNOWN_TYPE_REF\` — the same rule the text stack follows since Stage 3.
- **Scoped positions** (§8.5) and **the in-band root binding** (§3.4): the reference does not
  implement either (\`NOT_IMPLEMENTED\` and refused respectively); match it and leave them as recorded
  gaps unless they fall out for free.
- **Cross-encoding parity is the most important test.** Port the reference's
  \`CrossEncodingParityTest\` (one inline schema, a table of TSON-text / JSON pairs, asserting the same
  diagnostic codes and RFC 6901 pointers from both encodings, with the legitimate divergences
  pinned) against THIS port's own text \`validate\` and your JSON read. It is the Class 3 equivalence
  check Part 3 §1.5 states. Also port \`JsonTaggedValueReadTest\`, \`JsonSealedFamilyReadTest\`,
  \`JsonChoiceReadTest\`, \`JsonAliasTagReadTest\`, \`SealedFactoryEncodingParityTest\`,
  \`TemplateFamilyEncodingParityTest\`.

- **One value identity.** \`json/schema/valueIdentity.ts\` is a second value-identity implementation
  (string keys) beside \`value/equality.ts\`, which the text stack uses. Pin comparison, set
  duplicates and map-key identity must all go through ONE definition of a value space's equality —
  make the JSON reader use \`value/equality.ts\` (extend it with a keying function there if hashing
  is needed), and delete the second.
- The \`$\`-initial member that is not one of the three reserved names is currently reported as
  \`UNKNOWN_TYPE_REF\`; §3.2 makes it a resolver error — choose the code by what it is (a name
  that is not a field, in the resolver category) and say why.

You are alone on the tree.`,
  },
  {
    key: 'json-front-door',
    phase: 'FrontDoor',
    brief: `WP4D — the JSON front door, the CLI, documentation ([TSON-JSON] §1.5, §3.4, §9, §10).

WP4A–WP4C have landed: \`src/json/\` is a complete schema-directed JSON reader. Read its sources and
\`git log --stat -8\` first.

1. **Front door.** A coherent public surface under the \`./json\` subpath, following the shape of the
   text stack's own facades (\`facade/\`, \`index.ts\`) and naming (CLAUDE.md: bare names, the
   \`Tson\` prefix only for errors): parse schemalessly, read into a tree against a schema and a root
   type, validate — sync over bytes and async over a chunked source, both driven from the ONE
   \`Task<T>\` grammar. The reference's surface is \`Json\` (\`parse\`, \`treeReader\`, \`objectReader\`,
   \`validate\`, \`withSchemas\`) — mirror its capabilities, not its class shape. How a caller supplies
   the schema should match how the text stack's \`validate\` takes one (a compiled/linked schema from
   \`createTson\` / \`standardLibrary\` or equivalent — read \`config.ts\`). Every export has TSDoc.
2. **CLI** (\`packages/cli\`). \`tson validate\` classifies an input ending \`.json\` (case-insensitive)
   as JSON; a JSON input is bound by the CLI's existing \`--schema\` / \`--root\` flags (the reference
   spells the second \`--type\`; keep this CLI's own name); standard input is read as JSON when a
   binding is given and nothing says it is TSON. Usage errors, exit 2, checked before any file is
   read: half a binding, a JSON input with no binding, a binding with no JSON input to apply it to
   (only if that matches how \`--schema\` already behaves for \`.tn\` inputs — read the CLI first and
   do not break an existing use), an unknown root type. Outcomes and exit codes are the ones the CLI
   already uses for text. Reads stream. Add CLI tests, and a \`.json\` case to
   \`scripts/smoke-cli.sh\`.
3. **Package surface.** \`npm run build\`, \`npm run check:package\` (publint and are-the-types-wrong
   over the new subpath) and \`npm run smoke:cli\` all green. The browser-bundle test covers the new
   subpath.
4. **Docs.** A JSON section in \`README.md\` and in \`skills/tson-ts/SKILL.md\` (and its references)
   showing the front door and the CLI; \`STATUS.md\`'s line claiming neither implementation has a JSON
   reader is now false — replace it with what is implemented and the recorded gaps: §3.4 in-band
   root binding, §8.5 scoped positions, the §3.5 \`TSON-Schema\` / \`TSON-Accept-Schema\` header
   fields, a schema-directed encoder (§9.2's encoder MUSTs), §10.1's limits beyond depth.
5. Port \`JsonFrontDoorTest\` and \`JsonSchemaBindingTest\`.

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

return { stage: '4b', results, sweep };
