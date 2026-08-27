export const meta = {
  name: 'tson-port-wave-0',
  description:
    'Wave 0 of the TSON Java-to-TypeScript port: verify the frozen contract layer before any implementation starts',
  whenToUse:
    'Once, before Wave 1. Confirms the contract layer typechecks, the reference and spec material is present, the conformance harness discovers all 146 vectors, and the contract types actually match the Java records they were transcribed from.',
  phases: [
    { title: 'Audit', detail: 'independent reviews of the frozen contract layer' },
    { title: 'Adjudicate', detail: 'one pass over every finding, keeping only the blocking ones' },
  ],
};

// Wave 0 writes no implementation. Its only product is a decision: is the contract layer sound
// enough to freeze? Everything after this point compiles against it concurrently, so a wrong type
// here is not a local mistake — it is a mistake that twelve agents build on top of before anyone
// notices. That asymmetry is why this wave exists at all.
//
// The audits are deliberately overlapping rather than partitioned. A partition would let a
// mistake fall between two reviewers who each assumed the other had it.

const AUDITS = [
  {
    key: 'schema-meta',
    brief: `Audit packages/tson/src/schema/meta/*.ts against the Java records they were transcribed
from: .references/ltr8-io-tson-java/tson-schema/src/main/java/io/ltr8/tson/schema/meta/.

This is the largest and most mechanical part of the contract layer (~54 value types), which makes
it the most likely to carry a silent transcription error. Check every one:

- Field for field, name for name, against the Java record. A missing field is invisible until a
  resolver tries to read it three waves from now.
- Optional<T> must have become \`readonly x?: T\`, never \`readonly x: T | undefined\`.
  exactOptionalPropertyTypes is on and the distinction is load-bearing.
- The "absent and empty list are the same" normalisation the Java applies — is it represented
  faithfully, and is it documented on the type?
- Does anything here name a compiler type? It must not: schema/meta ships to browsers that never
  compile a schema, which is why it carries its own Token and SourcePosition stand-ins.

Report every mismatch with the Java file and line beside the TypeScript file and line.`,
  },
  {
    key: 'suspension',
    brief: `Audit the suspension contract across packages/tson/src/io/bytes.ts,
lexer/token.ts, stream/event.ts and reader/contracts.ts.

The whole read stack is suspendable-but-sync-shaped, and that property cannot be retrofitted: a
signature that returns a plain value instead of Task<T> forces every caller above it to be
rewritten when the suspension is eventually needed. PORT-PLAN.md §3 states the rule as "every
generator-returning signature in ReadContext, EventSource, TypeReader and the lexer must be
declared Task<...> in the contract layer".

Check exactly that, exhaustively:
- Every function in those files that can starve for input returns Task<T>.
- Every one that cannot is genuinely on the far side of a suspension boundary — below the token
  (base/, atom/, which run on already-lexed text) or above TypeReader (the facades, which drive
  with runSync/runAsync).
- runSync and runAsync are declared such that a caller cannot accidentally drop a suspension.

Name any signature that should be Task<T> and is not. This is the single most expensive category
of contract error in the whole port.`,
  },
  {
    key: 'bind-and-layering',
    brief: `Audit packages/tson/src/bind/binding.ts and the layering rules in eslint.config.js.

Two things, both structural:

1. The Binding<T> union, FieldSlot, LazyBinding/BindingRef, Infer<> and BindingRegistry. Does
   Infer<> actually infer? Write a throwaway type-level probe: build a small record binding, a
   union binding, a tuple binding and one with an optional field, and check Infer<> produces the
   type a human would write by hand. A phantom output type that collapses to unknown or any for
   unions, tuples or optionals is the exact failure mode PORT-PLAN.md rejected decorators plus
   reflect-metadata for — if the authored path has the same defect, the decision bought nothing.
   Delete the probe before you finish; report what it showed.

2. The import/no-restricted-paths zones. Confirm each fires. The config comments say the
   TypeScript resolver is load-bearing because the project's imports carry .js specifiers that
   point at .ts files, and that without it every zone silently passes. Verify that claim rather
   than trusting it: add a deliberately illegal import, confirm lint fails, remove it. Do this
   for the compiler-must-not-import-bind zone specifically, since it is the §3 circularity guard
   and there is no compiler/ directory yet for it to fire on.

Report anything that does not hold.`,
  },
  {
    key: 'errors-diagnostics-ast',
    brief: `Audit packages/tson/src/core/{errors,diagnostic,position}.ts, ast/value.ts,
ast/schema/*.ts, tree/nodes.ts, value/types.ts and atom/contract.ts.

Check:
- Position: 1-based line, code-point column, 0-based UTF-8 byte offset. Is each documented as
  exactly that? The three are easy to conflate and impossible to fix later without touching every
  error site.
- The DiagnosticCode union is closed. Does it cover §8.1's categories? Compare against the Java's
  diagnostic codes and against the categories the conformance suite's sidecars actually use —
  read a few sidecars under .references/ltr8-io-tson-test-suite/tests/*/invalid/.
- Every error class the plan names exists, and each carries enough to report a position.
- ast/schema/*.ts covers Part 2's grammar: SchemaDocument, Declaration, TypeDef, the TypeRef
  union, TypeArg, FieldDef, GroupDef, ConstructionDef, Instance, SizeSpec, RemovalSet. Read
  spec/tson-part2-schema.md's grammar and check nothing in it is unrepresentable.
- The tree nodes take the Node suffix, and the Java's suffix-free names are not used.

Report anything missing or misdescribed.`,
  },
];

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'findings', 'notes'],
  properties: {
    key: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'problem', 'severity', 'evidence'],
        properties: {
          file: { type: 'string', description: 'path, with a line number where there is one' },
          problem: { type: 'string', description: 'what is wrong, in one sentence' },
          severity: {
            enum: ['blocking', 'significant', 'minor'],
            description:
              'blocking = Wave 1 must not start until this is fixed, because agents would build on it',
          },
          evidence: {
            type: 'string',
            description: 'the Java source, spec section, or probe result that shows it',
          },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['readyToFreeze', 'mustFixBeforeWave1', 'rationale'],
  properties: {
    readyToFreeze: { type: 'boolean' },
    mustFixBeforeWave1: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'problem', 'fix'],
        properties: {
          file: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'the specific change, not a direction to explore' },
        },
      },
    },
    rationale: { type: 'string' },
  },
};

log(`Wave 0: ${String(AUDITS.length)} independent audits of the frozen contract layer`);

const audits = await parallel(
  AUDITS.map(
    (audit) => () =>
      agent(
        `${audit.brief}

Read CLAUDE.md first. You are AUDITING, not implementing: write no production code, and change
nothing under packages/tson/src/. A scratch file you delete before finishing is fine.

Report only what you can point at a file and a line for, with the Java source or spec section that
shows it is wrong. "Could be clearer" is not a finding. A type that disagrees with the Java record
it was transcribed from is.`,
        {
          label: `audit:${audit.key}`,
          phase: 'Audit',
          agentType: 'tson-porter',
          schema: FINDINGS,
        },
      ),
  ),
);

const all = audits.filter((a) => a !== null).flatMap((a) => a.findings);
const blocking = all.filter((f) => f.severity === 'blocking');

log(`${String(all.length)} findings, ${String(blocking.length)} blocking`);

// A barrier is right here, unlike in Wave 1. The adjudicator's whole job is to look at every
// finding at once: two auditors reporting the same type from different directions is the
// strongest signal available that it is genuinely wrong, and that signal only exists in the
// aggregate.
const verdict = await agent(
  `You are deciding whether the TSON contract layer is sound enough to freeze. Wave 1 puts twelve
agents to work against it concurrently, so a wrong type here is multiplied, not contained.

${all.length === 0 ? 'The audits reported no findings at all. Treat that as suspicious rather than as good news, and spot-check the contract layer yourself before agreeing.' : `The audits reported ${String(all.length)} findings:\n\n${JSON.stringify(all, null, 2)}`}

For each finding: verify it yourself against the Java source or the spec. Auditors overclaim. Keep
only what is real, and mark as blocking only what would actually corrupt Wave 1's output — a type
an agent would build on and then have to unbuild. A cosmetic problem in a file nobody imports is
not blocking, however true it is.

Where two auditors independently reported the same type, say so; that is the strongest evidence in
the set.

Then decide: can Wave 1 start? Give a specific fix for anything blocking, not a direction to
explore.`,
  { label: 'adjudicate', phase: 'Adjudicate', schema: VERDICT, effort: 'high' },
);

log(
  verdict?.readyToFreeze === true
    ? 'Contract layer ready to freeze: Wave 1 may start'
    : `NOT ready: ${String(verdict?.mustFixBeforeWave1.length ?? 0)} blocking items`,
);

return { wave: 0, findings: all, verdict };
