export const meta = {
  name: 'tson-rev36-stage-4a',
  description:
    'Revision 36 Stage 4a: Part 3, the JSON encoding — the RFC 8259 lexer, event stream, JSON tree and schemaless read, then the schema-directed tree read without dispatch',
  whenToUse:
    "After Stage 3's gate is committed. Two sequential packages building src/json/; the second reads through the first.",
  phases: [
    { title: 'Syntax', detail: 'WP4A: lexer, stream, tree, schemaless read, tree writer' },
    { title: 'Directed', detail: 'WP4B: schema-directed tree read, no dispatch' },
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
    key: 'json-syntax',
    phase: 'Syntax',
    brief: `WP4A — the JSON lexer, event stream, JSON tree, schemaless read, and tree writer
([TSON-JSON] §3.1, §3.2, §4, §9.4, §10; [TSON-DATA] §6).

Java: \`tson-json/.../json/lexer/\` (\`JsonLexer\`), \`stream/\` (\`JsonStream\`, \`JsonEvent\`,
\`JsonEventSource\`), \`tree/\` (\`JsonValue\` and six node types), \`reader/SchemalessTreeReader\`,
\`writer/TreeValueWriter\`, \`JsonDataEmitter\`, and the front-door \`Json.parse\` /
\`toDisplayString\`.

- **Lexer.** RFC 8259 under §3.1's accepted profile: UTF-8 only, decoded by the lexer itself (reuse
  \`io/utf8.ts\`); exactly one leading BOM accepted and discarded; malformed UTF-8 a lexer error; a
  valid surrogate-pair escape is one character, a lone surrogate escape (or anything decoding to a
  surrogate) is a lexer error; a number is kept as its LEXEME, never converted — no precision limit
  and no silent rounding; positions are line, column (code points) and byte offset. No
  \`JSON.parse\`, anywhere (§10.2).
- **Stream.** An event pull source with the nesting-depth limit from \`core/limits.ts\` (refusal
  \`LIMIT_REFUSED\`, the port's name for the reference's \`LIMIT_EXCEEDED\`); duplicate member names
  in one object compared after NFC are an error at the repeated occurrence (§3.1 — the category
  depends on the position; schemaless it is the resolver category, as Part 1 §2.6 gives maps).
  Trailing content after the root value is an error.
- **Tree.** A \`JsonValue\` model — object (member order preserved), array, string, number (lexeme
  kept; equality on the lexeme), boolean, null. Shape it idiomatically as a discriminated union.
- **Schemaless read** ([TSON-DATA] §6): a JSON object to a record where every key is an identifier
  and to a map otherwise, arrays to arrays, strings to strings, numbers to \`number\`, \`true\` and
  \`false\` to booleans, \`null\` to absence. Decide whether a schemaless read returns the port's
  existing tree \`Value\` type or \`JsonValue\` by reading what the reference does and what Part 3
  §4 says a tree read yields; state the choice in TSDoc.
- **Tree writer / emitter**: \`JsonValue\` to JSON text, exact round trip of a number's lexeme
  (\`199.90\` stays \`199.90\`), escaping per RFC 8259, never a BOM.
- **Streaming proof.** A test that splits every input at every byte offset and asserts \`runAsync\`
  over the chunks equals \`runSync\` over the whole — the property the \`Task<T>\` design exists for.
- Port \`JsonLexerTest\`, \`JsonStreamTest\`, \`JsonValueTest\`, \`JsonTreeWriterTest\`,
  \`JsonBaseSyntaxDiagnosticTest\`, \`JsonTokenPolicyTest\` as table-driven cases.

You are alone on the tree.`,
  },
  {
    key: 'json-directed',
    phase: 'Directed',
    brief: `WP4B — the schema-directed tree read, without dispatch ([TSON-JSON] §4, §5, §6.1.1–§6.1.4,
§6.1.6, §6.2, §6.3, §6.4, §7, §9.4; Part 2 §5.2, §7.6).

WP4A has landed just before you: \`src/json/\` has a lexer, event stream, \`JsonValue\` tree,
schemaless read and writer. Read its diff first (\`git show --stat HEAD\` and the files).

Java: \`tson-json/.../json/reader/\` — \`JsonReadContext\`, \`JsonSchemaCompiler\` /
\`CompiledReaders\` / \`ValueReaderFactory*\`, \`AtomForm\`, \`AtomReader\`, \`VoidReader\`,
\`ValuePositionReader\`, \`RecordPlan\` / \`RecordReader\` / \`RecordBuilder\` / \`TreeRecordBuilder\`,
\`Array*\`, \`Tuple*\`, \`MapPlan\` / \`MapObjectReader\` / \`MapPairsReader\` / \`MapEntries\`,
\`ValueIdentity\`, \`NameHygiene\`, \`ErrorReader\`, \`EventSkip\`; and \`JsonTreeReader\` /
\`JsonTypeReader\` / \`JsonCompiledSchema\` at the front door.

- **Compile once** from a \`LinkedSchema\` (\`link/link.ts\`) to a JSON reader per type: map form by
  key type, record plan, choice table — decisions made at compile, not per value.
- **Atoms** (§5): JSON string content goes to the atom's own parser as if it were a quoted token;
  a parser rejection is \`ATOM_FORM_INVALID\` (resolver), a constraint failure
  \`ATOM_CONSTRAINT_VIOLATION\` (validation), a wrong JSON kind a validation error. Enums (§5.2)
  match on CONTENT, not JSON kind: a string gives its content, \`true\`/\`false\` their literals, a
  number its lexeme — so \`"true"\` and \`true\` are one boolean, and a JSON number at an enum
  position is matched by its lexeme (the reference refuses numbers here; Part 3 does not — follow
  Part 3 and say so). Exact integers take no fraction or exponent (\`1.0\` at an integer position is
  a resolver error); \`number\` preserves digits and scale. Floats: finite as JSON numbers,
  \`-0.0\` round-trips, specials as the strings \`".inf"\`, \`"-.inf"\`, \`".nan"\`. \`void\` admits only
  \`null\`; \`value\` takes boolean, number or string. Base type resolution plays NO part (§4).
- **Records** (§6.1.1–§6.1.4, §6.1.6, §7): closed — an undeclared member is a validation error;
  names NFC-normalised before matching; name hygiene reaches member names that match NO declared
  field and is checked BEFORE the closure error, so a look-alike is refused, not called unknown
  (§9.4); the three field slots exactly as Part 2 §5.2 states them, with \`null\` as the absent
  sentinel (a missing member at an unmarked name, or \`null\` at a non-voidable type, is a
  validation error); defaults and pins injected, the injected form being the value; a FIXED field
  checked against the decoded VALUE; field groups have no wire form and are counted after the
  fields; member order carries no meaning. Reuse \`schema/meta\`'s \`fieldOmission\` — do not
  re-derive what omission yields.
- **Arrays, sets, tuples** (§6.2, §6.3): \`[T?]\` slots accept \`null\`; set duplicates by element
  equality over value spaces; a tuple has exactly its declared length.
- **Maps** (§6.4): OBJECT form when the key type, after its reference chain, is an atom-family
  instance or an enum (not \`value\`, not \`void\`) — member names go through the key type's parser,
  a rejected name is a resolver error, identity is decoded-key identity (\`"1"\` and \`"1.0"\` under a
  \`number\` key are one key); PAIRS form \`[[k, v], …]\` for any other key type; \`{}\` and \`[]\` are
  empty maps; \`{K => V?}\` accepts \`null\` values. Value identity must be the SAME function the
  text stack uses (Stage 3 made one) — import it, do not write a second.
- **Every read is all-or-nothing**, as in the text stack: diagnostics all reported, no value if any
  was.
- A position needing dispatch — an ABSTRACT or member-dispatched record, an untagged choice, a
  scoped position, an annotation object — is WP4C's. Compile such a position to a reader that reports
  \`NOT_IMPLEMENTED\` for now, so the plan is total, and say which positions do.
- Front door for this layer: a function reading a JSON document against a compiled schema and a
  root type into a tree, sync and async, following the shape of the text stack's \`facade/tree.ts\`
  \`validate\`.
- Port \`JsonAtomReadTest\`, \`JsonContainerReadTest\`, \`JsonMapReadTest\`, \`AllOrNothingReadTest\`,
  \`CollectingJsonReadTest\`, \`JsonNameHygieneTest\`, \`JsonIdentifierPolicyTest\` as table-driven
  cases, dropping what exercises dispatch.

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

1. Run \`npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:conformance && npm run build\`
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

return { stage: '4a', results, sweep };
