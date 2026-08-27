# Orchestration

How the Java-to-TypeScript port is executed. `PORT-PLAN.md` says _what_ is being built and why;
this says _how the run is driven_. Read `CLAUDE.md` before either — its hard constraints bind every
agent in every wave.

## The shape of the run

One Opus manager. Every line of implementation is written by Sonnet sub-agents of type
`tson-porter` (`.claude/agents/tson-porter.md`). The manager writes no implementation code — it
runs a wave, reads the structured result, runs the gate, reviews the diff, commits, and decides
whether the next wave may start.

Each wave is one committed workflow script under `.claude/workflows/`. The script is the unit of
review: it is in git, so a wave can be re-read, edited and re-run without reconstructing what was
asked.

**Sub-agents share no context.** The frozen contract layer is the only interface between work
packages. This is what makes twelve agents in one wave safe, and it is why the contract layer was
written first and completely. An agent that finds a contract type wrong must stop and report, never
edit — another agent is compiling against that type right now.

## Waves

Waves run in order. A wave starts only when the previous wave's gate is green.

| Wave | Work                                                                                                      | Gate                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0    | Contract review. No implementation.                                                                       | `typecheck` clean; `.references/` and `spec/` present; 146 vectors discovered           |
| 1    | The leaf packages: unicode, byte input, lexer, numbers, event stream, atoms ×4, regex, tree, bind runtime | Gates green; lexer and resolver vectors moving                                          |
| 2    | Data parser, schema grammar parser, `schema.meta` bindings, desugarer, conformance harness                | **All 146 vectors green.** The Part 1 completion gate                                   |
| 3    | Definition resolver → template materialisation ∥ schema resolver, flattening, meta-kernel bootstrap       | meta-kernel resolves 49 declarations, meta 31, core 48, matching `spec/m/*-resolved.tn` |
| 4    | Linking, registry, identity, content hashing ∥ readers (abstract → tree ∥ bind ∥ schemaless)              | Gates green; no vector regressed                                                        |
| 5    | Compiler ∥ emit and writers                                                                               | A user schema importing `core.tn` compiles and validates real data three schemas deep   |
| 6    | Facades and front door → CLI                                                                              | Gates green; CLI exit codes correct                                                     |
| 7    | Sweep: full conformance, fixture tests, browser bundle, docs, `publint`, `arethetypeswrong`               | Everything green, CI included                                                           |

Waves 1 and 2 are `pipeline()` — each package is verified the moment it lands, because no package
in those waves depends on another. Waves 3 to 6 carry real ordering, expressed as sequential stages
inside the script; the `∥` above marks what genuinely runs concurrently.

## Running a wave

```bash
./scripts/fetch-references.sh    # idempotent; the SessionStart hook does this in cloud sessions
npm install
```

Then one `Workflow` call per wave:

```
Workflow({ scriptPath: '.claude/workflows/port-wave-1.ts' })
```

Do not run two waves concurrently. Do not start a wave whose predecessor's gate is red.

## The gate

Every wave ends the same way. All of it, in this order, from the repository root:

```bash
npm run typecheck          # tsc --build, plus the two test projects
npm run lint               # including the import/no-restricted-paths zones
npm run format:check
npm test                   # unit
npm run test:conformance    # the shared vectors
npm run build              # tsup, ESM + CJS + dts, both packages
```

Then two things a script cannot do:

1. **Read the diff.** Not the summary the agent returned — the actual diff. An agent's report is a
   claim, and the adversarial verify stage inside each wave exists because claims are sometimes
   wrong.
2. **Check nothing regressed.** A vector that was green before the wave and is red after is a
   blocking failure even if the wave's own vectors all went green.

`npm run test:conformance` is expected to be red until Wave 2's gate. Red _in the right way_ — the
count of failing vectors must only ever go down. A wave that reduces the discovered count has
broken the harness, not fixed anything.

## Failure

If a gate cannot be made green in **two** repair attempts, stop and report. Do not:

- weaken a `Task<T>` signature to make something typecheck,
- edit `test/conformance/` to make a vector pass,
- skip, disable or quarantine a test,
- relax an ESLint zone rule — if a zone fires, the import is wrong, not the rule,
- add a runtime dependency, for any reason.

Each of those turns a visible failure into an invisible one, which is worse than a red wave.

A vector that looks wrong may genuinely be wrong. That is a spec-feedback finding for the shared
suite, not a licence to edit the harness. Report it.

## Committing

The manager commits each green wave. One commit per wave, message stating what the wave built,
which vectors moved, and any spec ambiguity that was resolved along the way.

`STATUS.md` is the only checklist and is updated in the same commit — it carries the conformance
count, which is the number that actually says how far along the port is.

Never commit a red wave, and never commit with the conformance count moving backwards.

## Spec feedback

Both the spec and the shared conformance suite are working drafts, and this port is their second
implementation — the first in a language with no JDK to lean on. Ambiguities will surface.

Every agent is asked to report them rather than silently pick a reading. Collect those reports.
A resolved ambiguity that was never written down is an unresolved ambiguity again three sessions
later, and the reading this port chose is exactly the kind of thing the Java implementation's
authors need to see.

Two divergences from the reference implementation are already known and deliberate:

- Identifier characters use real `XID_Start`/`XID_Continue` tables where the Java approximates
  them with `Character.isUnicodeIdentifier*`. This port is stricter; `$` is the visible case.
- Every built-in atom is parsed from scratch, since JS has no host `UUID`, `InetAddress`,
  `LocalDate` or `BigDecimal`. `.references/ltr8-io-tson-java/CONFORMANCE.md` records where the
  Java is deliberately stricter than the JDK, and those checks are the required behaviour.
