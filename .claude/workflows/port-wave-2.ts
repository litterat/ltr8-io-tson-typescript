export const meta = {
  name: 'tson-port-wave-2',
  description:
    'Wave 2 of the TSON port: the parsers and desugarer that close Part 1 — the wave whose gate is all 146 conformance vectors green',
  whenToUse:
    "After Wave 1's gate is green. Produces the data parser, the schema grammar parser, the schema.meta bindings, the desugarer, and the conformance harness's real sidecar parsing.",
  phases: [
    { title: 'Port', detail: 'one agent per work package, on top of Wave 1' },
    { title: 'Verify', detail: 'adversarial spec review of each package that landed' },
    { title: 'Sweep', detail: 'whatever the vector count says is still red' },
  ],
};

// Wave 2's packages sit on Wave 1's output but not on each other, with one ordering that is real
// and easy to miss: the conformance harness parses sidecars with THIS implementation's own parser
// (the suite expects an implementation to dogfood), so work package 21 needs the data parser to
// exist. It is listed last and the sweep stage exists to catch what that ordering leaves behind.
const PACKAGES = [
  {
    key: 'data-parser',
    loc: 350,
    brief: `Work package 6 (data parser). Produce packages/tson/src/ast/parser.ts and whatever it
needs beside it. ast/value.ts is FROZEN.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/parser/.

Build the Tier 3 AST on top of Wave 1's event stream: Document, DataValue, the CoreValue union,
RecordValue, MapValue, ArrayValue, ScopedValue, TokenValue, Annotation, AbsentValue, EmptyBrace.

The traps, all three from the reference implementation's own list:
- requireDocumentEnd. A lazy generator stream that merely STOPS silently accepts trailing
  content. Reaching the end of the value you wanted is not the same as reaching the end of the
  document, and §7.1 requires the difference to be observable. Test it directly with a document
  that has a second value after the first.
- The desugar map is identity-keyed. Where the Java uses IdentityHashMap, use WeakMap and compare
  with toBe, never toEqual — two structurally identical values are two different values here.
- The absent sentinel is a value, not a missing key. AbsentValue and "the field was not present"
  are distinct and both are representable.

Parsing stays suspendable: everything that can starve returns Task<T> and is called with yield*.

Turns green: the parser/valid and parser/invalid vectors.`,
  },
  {
    key: 'schema-grammar',
    loc: 900,
    brief: `Work package 7 (schema grammar parser). Produce packages/tson/src/compiler/schemaParser.ts
and its neighbours. The AST under packages/tson/src/ast/schema/*.ts is FROZEN — parse INTO it.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/schema/.

Read spec/tson-part2-schema.md's grammar in full before writing anything. Every production in it
must be reachable: SchemaDocument, Declaration, TypeDef, the TypeRef union, TypeArg, FieldDef,
GroupDef, ConstructionDef, Instance, SizeSpec, RemovalSet.

This is a faithful parse, not a resolution — no composition, no refinement, no constructor
application. Those are Wave 3. A schema document that is grammatically well-formed but
semantically nonsense must parse cleanly here and fail later, because that is where the
diagnostics belong and where the vectors expect them.

Turns green: parser/schema-document.`,
  },
  {
    key: 'meta-bindings',
    loc: 900,
    brief: `Work package 12 (schema.meta bindings). Produce packages/tson/src/schema/bindings.ts.

Author Binding descriptors for the ~54 resolved-schema value types in packages/tson/src/schema/meta/,
using the combinators Wave 1's bind runtime provides. These are what let a *-resolved.tn fixture be
read back into the schema model, which is how the Wave 3 gate is measured.

This is the payoff for rejecting reflection: the descriptors are authored, so write them plainly.
lazy() closes the one declaration-order cycle — find it before you start rather than discovering
it as a stack overflow.

Check Infer<> on each: the static type a binding infers must equal the hand-written type in
schema/meta/. If it does not, the binding is wrong, not the type.

Note the zone rule: schema/meta may import only itself, core/ and annotations/. Your bindings live
OUTSIDE it, in schema/, precisely so schema/meta stays free of the bind layer.`,
  },
  {
    key: 'desugarer',
    loc: 1250,
    brief: `Work package 13 (desugarer). Produce packages/tson/src/compiler/desugar.ts.

Port the desugaring half of
.references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/.

Every sugar form in Part 2 lifts to a closed synthetic entry. Read the spec's sugar sections and
enumerate them before writing — a missed form is a schema that resolves to something subtly wrong
rather than something that fails.

The desugar map is IDENTITY-KEYED. WeakMap, and toBe in the tests. Two structurally identical
sugar nodes in one document are two nodes and must desugar to two entries; a structural map
silently merges them and the bug surfaces waves later as a shared mutation.

Synthetic names must be deterministic and stable across runs — they end up in canonical identity
and therefore in content hashes.`,
  },
  {
    key: 'conformance-harness',
    loc: 400,
    brief: `Work package 21 (conformance harness completion). Make test/conformance/sidecar.ts real.

parseSidecar currently throws TsonNotImplementedError. Replace it with a real parse USING THIS
IMPLEMENTATION'S OWN PARSER — the suite expects an implementation to dogfood, and the Java runner
does the same. Do not hand-roll a second parser for sidecars.

The four rules in CLAUDE.md are requirements on the harness, not suggestions:
- Feed subjects RAW BYTES. Eight vectors carry deliberately malformed UTF-8; a TextDecoder round
  trip destroys exactly what they test.
- On outcome: error assert the CATEGORY only, never the position. The suite does not pin
  positions.
- Skip, do not fail, encoding: utf-16 and utf-32.
- Discovery stays a directory walk. There is no manifest and adding one would diverge from the
  shared suite.

test/conformance/bundled-ids.ts holds the three-entry short-name table and the !!meta / !!import
splice; wire it in.

You may edit test/conformance/ — you are the work package that owns it. No other agent may.

Turns green: this is what lets every other vector be measured at all.`,
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
          owner: { type: 'string', description: 'which work package should have covered it' },
        },
      },
    },
  },
};

log(`Wave 2: ${String(PACKAGES.length)} work packages. Gate is all 146 vectors green.`);

const results = await pipeline(
  PACKAGES,
  (pkg) =>
    agent(
      `${pkg.brief}

Read CLAUDE.md first — its hard constraints are not suggestions. The contract layer is FROZEN:
import from it, never edit it. Wave 1's output (unicode, io, lexer, base, stream, atom, regex,
tree, bind) is done and is yours to build on; if something there is wrong, report it rather than
patching around it.

Definition of done, all of: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance. Except for work package 21, do not modify test/conformance/.`,
      { label: `port:${pkg.key}`, phase: 'Port', agentType: 'tson-porter', schema: PORT_RESULT },
    ),
  (port, pkg) => {
    if (port === null || port.status === 'blocked') return null;
    return agent(
      `Adversarially review work package "${pkg.key}" of the TSON TypeScript port. Default to
finding it UNSOUND: refute the claim that it is a faithful port rather than confirming it.

Files claimed: ${port.filesWritten.join(', ')}
Vectors claimed green: ${port.vectorsGreen.join(', ') || '(none claimed)'}

Check, in this order:
1. Run the gates yourself. Do the claimed vectors actually pass? Did anything that was green
   before this package go red? A regression is blocking regardless of what else is true.
2. Read the spec sections it implements against what it wrote. Not the summary — the code.
3. requireDocumentEnd: does a document with trailing content after a complete value actually
   fail? A generator stream that merely stops accepts it silently. Test it yourself.
4. Is the desugar map identity-keyed? A structural Map here is a real bug that only shows up
   with two identical sugar nodes in one document. Construct that case.
5. Did it weaken any Task<T> signature to a plain return type?
6. Did it change test/conformance/ to make a vector pass? Only work package 21 may touch it.
7. Any new runtime dependency, any RegExp in src/base/, anything materialising a whole document?

Report only problems you can point at a file and line for.`,
      { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT },
    );
  },
);

const landed = results.filter((r) => r !== null);
log(`Wave 2 packages returned: ${String(landed.length)}/${String(PACKAGES.length)}`);

// The gate for this wave is a number, so end by measuring it rather than by asking whether every
// agent felt finished. A wave where every package reports success and the count is still short is
// the case this stage exists to make visible.
const sweep = await agent(
  `Run \`npm run test:conformance\` and report the real numbers.

For every vector still failing, give the ACTUAL cause — read the failure, do not paraphrase the
assertion message — and say which Wave 1 or Wave 2 work package should have covered it.

Do not fix anything. Do not modify test/conformance/. This is a measurement.

Wave 2's gate is 146 discovered and 146 passing. If the discovered count is not 146, the harness
is broken and that is the finding, ahead of anything about individual vectors.`,
  { label: 'sweep', phase: 'Sweep', schema: SWEEP, effort: 'high' },
);

log(
  sweep === null
    ? 'Sweep returned nothing'
    : `Conformance: ${String(sweep.passing)}/${String(sweep.discovered)} passing, ${String(sweep.failing)} failing`,
);

return { wave: 2, results, sweep };
