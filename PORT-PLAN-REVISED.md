# Porting TSON to a new language — the plan, rewritten from experience

`PORT-PLAN.md` is the plan that was actually followed to produce this repository. This document is
what that plan should have said, written after the port shipped and after the defects the plan's own
gates failed to catch were found and fixed.

It is written to be reusable. The **body is language-neutral** — Rust, Go, Python, C#, Swift, Kotlin
— and every decision that depends on the host language is posed as a question with the TypeScript
answer given as a worked example. The **TypeScript-specific material is in Appendix A**, and
**Appendix B** sketches the same answers for four other hosts. **Appendix C** is the honest list of
what went wrong.

The subject is TSON (Typed Schema Object Notation), ported from the reference Java implementation.
The lessons are not TSON-specific: they apply to any port of a specification-defined format with a
reference implementation and a shared conformance suite.

---

## 0. The one number that matters

The original plan estimated ~32,000 lines of implementation across seven waves. That estimate was
good: the result is ~35,000 lines of source and ~22,000 of tests, about 10% over.

The estimate that was wrong was the schedule's _shape_. The plan had seven waves and a final
"sweep". What actually happened was seven waves and then **twelve more commits of defect-fixing after
the port was declared complete** — roughly a third of the total, closing five distinct
stack-overflow paths, an unbounded buffering bug in every streaming read, a facade that threw where
its own documentation said it collects, and three security findings. None of these were new
features. All of them were defects that every wave gate had passed.

> **Plan for a hardening phase of about a third of the run, and give it its own gates.** Do not call
> it a sweep. A sweep is what you do when you expect to find nothing.

---

## 1. What the original plan got right — keep all of it

These decisions held up under 35,000 lines and should be made the same way again.

1. **A frozen contract layer written before any implementation.** Types and enums only, no bodies.
   This is what made a dozen agents (or a dozen people) able to work in parallel with no cross-talk,
   and it is the single highest-leverage artefact in the plan. Budget real time for it — it was
   ~2,500 lines of declarations and it earned every one.

2. **Suspension designed into the contract, not retrofitted.** The read stack is written once, in a
   suspendable-but-synchronous shape, and two small drivers adapt it to complete input or chunked
   input. Retrofitting this later means touching every reader. See §4.1 and Appendix A.

3. **Own the character-property tables; do not consult the host at runtime.** For a format whose
   identity can be a hash of its bytes, two hosts disagreeing about whether a document is
   well-formed is a correctness bug, not a portability nit. Two builds of the _same_ runtime major
   version shipped different Unicode versions during this port, changing `XID_Start` from 684 ranges
   to 691.

4. **Vendor the spec and the bundled schemas into the repository, byte for byte, with a provenance
   file and a drift test.** The reference implementation is pinned to a commit; the conformance
   suite tracks its main branch. Both are fetched into a gitignored directory, and the build works
   without them for everything except conformance.

5. **A harness that discovers every conformance vector before any implementation exists.** "146
   discovered / 146 failing" is the correct scaffold outcome and proves the pairing logic. Zero
   discovered is a harness bug that would otherwise be invisible for weeks.

6. **Dogfood the suite's own format.** The conformance sidecars are documents in the format being
   implemented, parsed with the implementation's own parser. This is free extra coverage and the
   suite expects it.

7. **Feed subjects as raw bytes, never as decoded-and-re-encoded strings.** Eight vectors carry
   deliberately malformed UTF-8; a string round trip destroys exactly what they test.

8. **A written record of every ambiguity and the reading chosen.** A resolved ambiguity that was
   never written down is an unresolved ambiguity again three sessions later. This port filed three
   findings back to the spec and the reference implementation, and each one was found by writing
   something down rather than by looking for it.

---

## 2. What it got wrong — eight corrections

### 2.1 The gates measured the wrong thing

Every wave gate was: typecheck, lint, format, unit tests, conformance vectors, build. All seven
waves passed. The public entry points — the four functions a consumer actually calls — died with an
uncaught host stack-overflow error on a document 750 levels deep, and nothing noticed until the
final sweep.

The reason is worth stating precisely, because it is the most repeatable mistake in the whole
project: **a regression test existed for exactly this property and it passed, because it measured
the right property on the wrong subject.** It drove the iterative event-stream tier directly — which
genuinely does walk a million levels — while every function reachable from the public API went
through the recursive tier and crashed.

> **Correction.** From the first wave that produces a public entry point, every gate includes an
> end-to-end assertion _through that entry point_. A test that exercises an internal seam is a unit
> test, not a gate. And when a test asserts a property the documentation claims, it must call the
> thing the documentation is about.

### 2.2 Conformance vectors are necessary and nowhere near sufficient

All 146 vectors were green at the end of wave 2, with five waves of work still to come and a front
door that crashed. The vectors test the grammar. They do not test the API surface, resource limits,
memory behaviour, packaging, or whether a function does what its own doc comment says.

> **Correction.** Name the _classes_ of test each wave must add, not just the vectors it turns
> green. Five classes, and each wave's gate says which of them apply:
>
> | Class                      | Asks                                                                                  |
> | -------------------------- | ------------------------------------------------------------------------------------- |
> | **Conformance**            | does the grammar match the shared suite?                                              |
> | **API contract**           | does each public function do what its own documentation claims?                       |
> | **Adversarial / resource** | depth, size, pathological input, unbounded producers — reached through the public API |
> | **Fixture**                | does resolved output match the reference's published output?                          |
> | **Packaging**              | does the built, published artifact resolve and run for a consumer?                    |

### 2.3 Documented contracts were never audited against the code

Four claims in this repository were false when written, and each was found by accident:

- A read function's documentation said it throws one error type; it threw three.
- A validating function's documentation said it collects every problem and never throws; it threw
  for exactly the malformed documents a caller reaches for it to handle.
- The conventions file said the host's Unicode data is never consulted at runtime; normalization
  consults it.
- The conventions file described a divergence from the reference implementation that did not exist —
  a claim about a specific character that was refuted by running the reference's own predicate.

> **Correction.** Add a **doc-claim audit** as an explicit, gated task, once per wave and again at
> the end. Every behavioural claim in a module doc gets a test that names it, or the claim is
> deleted. Prefer testing a claim to restating it. A claim about the _reference implementation_
> gets verified by running the reference implementation, not by reading it.

### 2.4 A test written after a fix proves nothing until it has been seen to fail

This happened repeatedly, in both directions: tests that passed against the unfixed code (and so
tested nothing), and one case of reading a command's _output_ — counting green cells — instead of
its exit code, and calling a red continuous-integration step green.

> **Correction, and it is cheap.** Every regression test must be run once with the fix reverted, and
> the commit message says it was. Every gate assertion reads an exit code, never output text. In
> this repository the revert check was done with a one-line stash-and-rerun; it caught three tests
> that would otherwise have shipped as decoration, including one that only failed at 250,000
> elements after passing at 50,000.

### 2.5 Findings from review agents are claims, not facts

The adversarial verification stages produced genuinely valuable findings — including the two
security fixes that mattered most. They also produced findings that were wrong, findings attributed
to the wrong wave, and one finding that was a documentation error of mine that an agent had faithfully
propagated into its code.

> **Correction.** A finding without a reproduction is discarded. Every finding is reproduced by the
> manager before it is acted on, and the reproduction goes in the commit. One finding in this port
> was nearly dismissed after five plausible attack vectors were tested and found safe — the sixth,
> which the report actually named, worked.

### 2.6 Parallel work can fail silently

The first fan-out lost four of its five agents to a resolution failure and reported "0 findings" as
a successful, complete wave.

> **Correction, two parts.** (a) Carry the worker's instructions _inside the orchestration script_
> rather than as a separately-registered artefact, so there is nothing to resolve and nothing to be
> missing. (b) Every fan-out counts its results against the number dispatched and fails loudly on a
> shortfall. Silence and emptiness must not be the same observation.

### 2.7 Wave ordering was derived from the wrong dependency graph

Wave 3's gate required two capabilities that wave 4 produced. The waves were ordered by what each
work package needed to _compile_; the gates needed more than that.

> **Correction.** Write every gate first, then derive the wave order from the gates' dependencies,
> not from the work packages'. Where a gate genuinely cannot be met until later, say so in the plan
> and give the wave a weaker gate plus a named, allowlisted deferral that a test enforces — so the
> list of deferrals can only shrink and is never a skip.

### 2.8 The plan omitted whole categories of work

Six things were needed, were not in the plan, and were built late and under pressure:

| Missing                                                    | Cost of the omission                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Resource limits** (nesting depth, document size)         | five distinct stack-overflow paths reaching public entry points                                                     |
| **Backpressure** — that a streaming read pulls on demand   | every streaming read buffered its whole input; the "memory is proportional to nesting depth" claim was false        |
| **Packaging validation** in continuous integration         | subpath type resolution was broken on every entry and nobody knew                                                   |
| **A bundled standard library**                             | the command-line tool carried its own copy of the format's own schemas, with a comment saying it should not have to |
| **Identity and content hashing as a public surface**       | the command-line tool reimplemented the specification's hashing algorithm rather than calling the library           |
| **Document classification** — is this file data or schema? | a specification requirement listed on a checklist that no work package owned                                        |

> **Correction.** Walk the specification's _non-grammar_ sections — security considerations,
> resource limits, media types, identity, canonicalisation — and give each one a work package or an
> explicit decision not to implement it. Grammar sections attract attention on their own; these do
> not. Then walk the reference implementation's _public API_ and confirm every entry point has an
> owner.

---

## 3. Part A — the scaffold

### A0. Answer the host questions before writing any code

These five answers shape everything else and cannot be changed later. Write them down in the
conventions file with the reasoning, not just the choice.

| #   | Question                                                                                       | Why it is structural                                                                            |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **How does the read stack suspend when input starves?**                                        | Determines whether the grammar is written once or twice.                                        |
| 2   | **Does the host bound recursion, and how deeply?**                                             | Determines whether recursive descent is viable at all, and where explicit limits are mandatory. |
| 3   | **Does the host provide versioned Unicode property data, and can two installations disagree?** | Determines whether you ship tables.                                                             |
| 4   | **Which of the format's atom types does the host provide, and are its parsers strict enough?** | Determines the size of the atom work package — 33 parsers here, ~3,600 lines.                   |
| 5   | **What enforces layering, now that you are not in the reference's module system?**             | Determines whether the architecture survives contact with parallel work.                        |

TypeScript's answers are in Appendix A; four other hosts are sketched in Appendix B.

Two notes that apply to every host:

- **Question 1 has a null answer for some hosts.** If the host has real threads and blocking input,
  the reference implementation's own shape may port directly and no suspension machinery is needed.
  The rule to preserve is not "use generators", it is **the grammar is written once**. A second,
  asynchronous copy of a parser is a permanent maintenance liability and drifts within one release.

- **Questions 1 and 2 interact, and this is where this port paid.** A suspension mechanism built on
  the host call stack — generators, most coroutine implementations — makes every level of nesting a
  host frame. That is fine, and it is what the reference implementation's frame stack costs too, but
  it makes explicit depth limits **mandatory rather than defensive**. Decide up front which tiers are
  iterative and which are recursive, write it down, and bound every recursive one.

### A1. Workspace

One published library with subpath entry points, plus a command-line tool. Not a package per module
of the reference implementation: you get neither enforced encapsulation nor a reason to version many
things in lockstep, and the property that actually matters — _a consumer reading data without a
schema must not carry the schema compiler_ — comes from tree-shaking and entry points.

Choose entry points by **what a consumer can take without the rest**, and verify it against the
built artifact rather than the import graph. This port ships nine, and two of them were added late
because the command-line tool needed something the library kept private:

| Entry        | Holds                                             | Deliberately excludes                                 |
| ------------ | ------------------------------------------------- | ----------------------------------------------------- |
| default      | parse / read / validate / write, and the registry | —                                                     |
| `./tree`     | the document tree model                           | the compiler                                          |
| `./bind`     | binding descriptors                               | the compiler                                          |
| `./schema`   | the resolved-schema value model                   | the compiler                                          |
| `./write`    | the writers                                       | —                                                     |
| `./regex`    | the pattern engine, standalone                    | _everything_; it imports nothing                      |
| `./identity` | content hashing and canonical identity            | the lexer, the compiler                               |
| `./stdlib`   | the format's own bundled schemas, embedded        | not on the default entry — it is 45 KB of schema text |
| `./source`   | schema fetching over the network and from disk    | **not reachable from a browser build at all**         |

### A2. The frozen contract layer

Types and enums only. Everything a work package will import from another work package lives here and
is written before any of them start.

The original plan's file list was right. **Add three things it lacked:**

1. **A resource-limits module.** The default depth bound, the option type that configures it, and
   the message every layer reports when it fires — so eleven call sites cannot each invent their own
   wording. This port added it after five separate overflow paths had shipped.

2. **A source-resolution condition** so the type-checker and the test runner resolve intra-repository
   imports to _source_, never to build output. Without it, tests pass against a stale build locally
   and fail on a clean checkout, which is exactly what happened here and cost two red continuous
   integration runs to diagnose.

3. **The diagnostic vocabulary must include a code for "this implementation has not built this
   yet"**, distinct from "the document is invalid". Reporting a library gap as a verdict on the
   user's document is the one answer that is simply false, and a command-line tool cannot recover
   the distinction from a flattened message.

Two rules to state in the conventions file for whoever touches this layer:

- Every signature that can suspend is declared as such **from the start**. Weakening one later
  breaks every caller above it and the suspension cannot be reintroduced locally.
- Value-model types are transcribed from the reference implementation _literally_, including its
  optionality and its "absent and empty are the same" normalisations. Improvements here are how a
  fixture comparison becomes unusable.

### A3. Layering enforcement

Whatever the reference implementation's module system enforced, something must enforce in the port,
mechanically, from day one — a linter rule, a build-system boundary, an architecture test. Two
properties in this port carry real design weight and both would have rotted without enforcement:

- the schema value model may not name a compiler type (this is what lets it ship to a browser that
  never compiles a schema);
- the compiler may not import the binding layer (this is the circularity the reference implementation
  has and the port deliberately does not).

**Verify that the enforcement actually fires.** In this port the rule only takes effect when an
import specifier _resolves_, and the project's specifiers point at files the default resolver cannot
find — so without a language-aware resolver every zone silently passed, which is worse than having
no zones at all. Prove the rule fails on a deliberate violation before trusting it.

### A4. Character property tables

Generate them, check them in, record the Unicode version they were derived from, and use them
instead of the host's at runtime.

Three things this port learned the hard way:

- **The generation rules for the two identifier properties are different**, and applying one rule to
  both produces two byte-identical tables that pass every ASCII test. Assert that the two tables
  differ on a code point that continues an identifier but cannot start one — the digits.
- **The verification job must be version-aware.** Regenerating on the runner and demanding a clean
  diff reintroduces exactly the host dependence the tables exist to remove. Verify only when the
  runner's Unicode version matches the tables'; report, don't fail, when it does not.
- **Normalization is the one property worth reading from the host**, if the host offers it without a
  data dependency — because Unicode's normalization stability policy freezes the answer, where
  identifier-property membership demonstrably is not frozen. Say this explicitly; the asymmetry
  looks like an inconsistency otherwise.

Expect to be **stricter than the reference implementation** here, and expect the difference to run in
a surprising direction. This port's disagreement with the reference was not the character everyone
guesses; it was the invisible format-control and identifier-ignorable characters, one of which the
specification explicitly excludes and the reference accepts.

### A5. Conformance harness

Written in the scaffold, expected to fail entirely. Four rules:

- parse the suite's own sidecar files with **your** parser;
- feed subjects as **raw bytes**;
- on an expected error, assert the **category only** — never the position, which the suite does not
  pin;
- **skip, don't fail**, encodings you have decided not to support, and say so in the report.

The project must skip cleanly, with a message, when the suite is not checked out.

### A6. The gate ladder — the biggest addition

The original plan had one gate, repeated. Replace it with a ladder that grows: each wave runs
everything below it plus its own new class of check.

| Rung | Check                                                                                                                 | From wave                      |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0    | typecheck, lint, format                                                                                               | scaffold                       |
| 1    | unit tests                                                                                                            | 1                              |
| 2    | conformance vectors — count green, and **never let the discovered count drop**                                        | 1                              |
| 3    | build succeeds                                                                                                        | 1                              |
| 4    | **packaging validation** — the built artifact resolves for a consumer, from every entry point and every module system | 1                              |
| 5    | **end-to-end through the public API** — one real document, one real schema                                            | first wave with an entry point |
| 6    | **adversarial / resource** — depth, size, pathological input, all through the public API                              | first wave with an entry point |
| 7    | **fixture comparison** against the reference's published resolved output                                              | first wave that resolves       |
| 8    | **doc-claim audit**                                                                                                   | every wave                     |

Rungs 4, 5, 6 and 8 are the ones this port lacked, and they are precisely where its escaped defects
were found. Rung 4 costs about ten lines of configuration; it would have caught a broken published
type surface that shipped through seven waves.

Two rules about the gate itself:

- **Read exit codes.** Not output.
- **A gate that has never failed has not been tested.** Break something on purpose once per rung.

---

## 4. Part B — the waves

### 4.1 Ordering

Derive it from the **gates**. The structure that worked:

| Wave | Work                                                                                                                                          | Gate adds                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 0    | contract review; no implementation                                                                                                            | rungs 0, 4                               |
| 1    | the leaves — character properties, byte input, lexer, number grammar, event stream, atom parsers, pattern engine, tree model, binding runtime | rungs 1–3                                |
| 2    | data parser, schema grammar parser, value-model bindings, desugarer, conformance harness                                                      | **all vectors green**                    |
| 3    | definition resolution, template materialisation, schema resolution, bootstrap                                                                 | rung 7                                   |
| 4    | linking, identity, content hashing ∥ the reader families                                                                                      | rungs 5, 6                               |
| 5    | the compiler ∥ the writers                                                                                                                    | end-to-end through three schema levels   |
| 6    | public facades ∥ the command-line tool                                                                                                        | exit-code contract                       |
| 7    | **hardening**, not sweep — see §4.3                                                                                                           | everything, and a fresh adversarial pass |

Two ordering corrections against the original:

- The **reader families must land before or with the resolver's fixture gate**, because the fixture
  comparison needs the reverse index the linker populates and a reader for the meta-schema. In the
  original these were a wave apart and the gate could not be met.
- **The public facade should exist by wave 4, even as a stub.** Its entry points are what rungs 5 and
  6 test. Landing it in wave 6 meant nothing tested the real front door until the sweep.

### 4.2 Work packages the original plan lacked

Add these five, and give them owners:

1. **Resource limits.** One configurable nesting bound, threaded through _every_ recursive-descent
   layer: the value parser, the schema grammar, the embedded data-value grammar inside the schema
   grammar, the tree readers, and the compiled readers. Five, in this port. Each one that was missed
   was reachable from a public entry point, and the schema-side ones were the worst, because a schema
   is routinely fetched from somewhere else.

   Two traps found the hard way. **Check the bound on the way down, not at the bottom** — a
   construct that recurses without opening a container (an annotation chain, here) reaches the check
   with the host stack already spent. And **count every construct that recurses**, not only the ones
   that look like nesting: an annotation whose value is another annotated value is a real descent
   with no brace to see.

2. **Streaming backpressure.** Assert that a streaming read pulls one chunk per suspension and stops
   pulling when the read finishes. In this port the driver ran a concurrent pump loop that pushed
   chunks as fast as the producer yielded them, so a fast producer buffered the entire document —
   which made the central memory claim false for every streaming read, in a project that put
   "streaming is non-negotiable" at the top of its conventions file.

3. **The standard library, embedded.** The format's own bundled schemas as source-text constants
   behind their own entry point. Generated from the vendored copies, with a test asserting they match
   byte for byte. This was explicitly deferred as out of scope, and the command-line tool then built
   it anyway because it had no choice.

4. **Identity and content hashing as public API.** If the specification defines a content-addressing
   scheme, a consumer will want to compute one. This port kept it internal, and its own command-line
   tool reimplemented the algorithm with a comment explaining that it should not have to.

5. **Document classification.** If the specification says a document's kind is decidable from its
   header with bounded lookahead — and says content sniffers should rely on that — implement it as a
   function. It is fifty lines and it is a stated requirement.

### 4.3 The hardening phase

Budget a third of the run. Gate it on finding things, not on finishing.

- Re-run **every** rung of the ladder from a clean checkout, in continuous integration, in the order
  the automation runs them. This port's tests passed locally against stale build output and failed
  on a clean machine.
- Run the adversarial pass **against the public API**, not against internals.
- Do the **doc-claim audit** across every module.
- Exercise the built, published artifacts — not the source — end to end.
- Then write the known-gaps list, and make every entry say _why the fix is what it is_: a contract
  change, a deliberate floor, a shared limitation of the reference implementation. A gap list of
  symptoms is not actionable; a gap list of causes is.

### 4.4 Fixture comparison: choose your level, and say which

The reference implementation compares its resolved output against the published fixtures by binding
the fixture _into the value model_ and comparing objects. This port compares **written form**.

Written form is stricter and worth choosing, because it tests the writer as well as the resolver. It
found two output defects the reference implementation's own fixture test is structurally unable to
see — one of which is a specification-conformance gap in both implementations.

The cost is that writer-canonicalisation differences show up as fixture differences. Handle them the
way this port eventually did: **hold every remaining difference as an allowlisted assertion**, never
a skip, so that a new difference fails and a closed one fails too, asking for the list to shrink. And
where the fixture cannot be the oracle — this one abbreviates long documentation strings and says so
in its own header — **compare against the source document instead**, which is a stronger check than
the fixture would have been.

---

## 5. Part C — orchestration

If the port is run by parallel agents, these are the rules the run depends on. They generalise to
human teams with only the nouns changed.

1. **The frozen contract is the only interface between work packages.** A worker that finds a
   contract type wrong stops and reports; it never edits, because someone else is compiling against
   it right now.
2. **Carry the worker's instructions in the orchestration script**, which is in version control and
   is the unit of review.
3. **Count every result.** Silence and emptiness must not be the same observation.
4. **Every wave ends with a human — or the manager — reading the diff**, not the summary. A report is
   a claim.
5. **A verification finding without a reproduction is discarded.**
6. **Never edit the conformance harness to make a vector pass.** A vector that looks wrong may be
   wrong; that is a finding for the shared suite, not a licence.
7. **Two repair attempts, then stop and report.** Each of the following turns a visible failure into
   an invisible one and is worse than a red wave: weakening a signature to make it typecheck,
   skipping or quarantining a test, relaxing a layering rule, adding a runtime dependency.
8. **One commit per wave**, its message stating what landed, which vectors moved, and every
   ambiguity resolved along the way.

---

## Appendix A — TypeScript specifics

Everything here is a decision this port made and would make again, unless marked otherwise.

### A.1 Suspension

```ts
type Task<T> = Generator<typeof NEED_INPUT, T, void>;
```

Every function that can starve for input is a generator returning `Task<T>`; every call to one is
`yield*`. Two drivers sit at the top — one for complete input, one for chunked. The suspended state
_is_ the delegation chain, which is exactly the bound the reference implementation's explicit frame
stack gives.

This is the best decision in the port. Three things to know:

- **Declare it in the contract layer**, on every signature that could ever suspend. "Simplifying" one
  to a plain return type later breaks every caller above it.
- **It costs a host frame per level.** Bound every recursive tier explicitly (§4.2.1). The one tier
  that replaced recursion with an explicit frame stack walks a million levels; every other tier gave
  out around 750.
- **Suspension stops at two boundaries**: below the token, code runs on already-lexed text and is
  ordinary synchronous code; above the reader, the facades drive with the two drivers. Say where the
  boundaries are.

`try/finally` inside a generator runs on both normal completion and exception propagation, which
makes it the right place for depth-counter decrements.

### A.2 Driving a stream

Pull one chunk per suspension. **Do not run a concurrent pump loop.**

```ts
const iterator = source[Symbol.asyncIterator]();
let step = task.next();
while (!step.done) {
  const next = await iterator.next(); // only now, because the task actually needs it
  if (next.done === true) input.end();
  else input.push(next.value);
  step = task.next();
}
// and in a finally: await iterator.return?.() — so an early-finishing read closes the producer
```

This is what makes "memory is proportional to nesting depth" true rather than aspirational, and what
lets a header-only read stop after four chunks of a fifty-kilobyte document.

### A.3 Type configuration

`strict`, plus:

- **`exactOptionalPropertyTypes`** — and then optionality is written `readonly x?: T`, never
  `readonly x: T | undefined`. The distinction is meaningful and the codebase relies on it.
- **`noUncheckedIndexedAccess`** — the lexer indexes buffers constantly.
- **`verbatimModuleSyntax`**, `moduleResolution: "bundler"`, ES2023.
- **`customConditions`** pointing at a source condition (below).

### A.4 Resolving to source, not to build output

Declare a private export condition alongside the published ones:

```jsonc
"exports": {
  ".": {
    "@ltr8/source": "./src/index.ts",
    "import":  { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

Then select it in `tsconfig` (`customConditions`) **and** in the test runner. The test runner needs
three lists, not one — workspace symlinks are externalized to the platform's own resolver, which
consults neither of the bundler's condition lists:

```ts
resolve: { conditions: ['@ltr8/source'] },
ssr: { resolve: { conditions: ['@ltr8/source'], externalConditions: ['@ltr8/source'] } },
```

Without this, tests pass against whatever the last build left behind. This port shipped two red
continuous-integration runs before the cause was found.

### A.5 Publishing

- **Nest `types` inside each condition**, not beside them. The flat form makes the package report as
  "masquerading as ECMAScript modules" from every consumer that uses the older module system.
- **Turn off the bundler's `node:`-prefix stripping.** The prefix is the one specifier form a browser
  bundler cannot mistake for a resolvable package; stripping it turns a loud failure into a silent
  attempt to resolve a shim.
- `sideEffects: false`, and one entry per genuinely-separable slice.
- **Run packaging validation in continuous integration from wave 1.** The entry point that
  deliberately does not resolve for a bundler — the platform-only one — is checked on its own with
  that rule suppressed; the rest are checked strictly, so a genuinely broken entry cannot hide.
- The tool that resolves types **is the wrong tool for a binary-only package**: it has no entry point
  to resolve and reports failure for every profile. Check what that package actually publishes
  instead.

### A.6 Layering

Enforce it with the linter's restricted-import-paths rule, stated **outbound** — what a directory may
import — because a leaf is a leaf by what it depends on, not by who depends on it.

**The rule only fires when a specifier resolves.** With specifiers that point at files the default
resolver cannot find, every zone silently passes. Install a language-aware resolver and prove the
rule fails on a deliberate violation.

### A.7 Naming

- Drop the reference implementation's type prefix; module namespacing gives the disambiguation at
  the import site.
- **Keep it on error classes.** An error's name appears verbatim in stack traces and in `instanceof`
  checks across bundle boundaries, where a bare `ParseError` names nothing.
- **Tree nodes take a `Node` suffix**, a forced divergence: `Record` is a global utility type and
  `Map`/`Array` are globals, and importing those names shadows them for the whole file. Document it
  as a divergence, not an oversight.

### A.8 The number grammar

Hand-written, one function per grammar rule, **no regular expressions**. A grammar expressed as a
regular expression is expressed in a dialect no other language shares, which defeats the point of a
port. The reference implementation states this explicitly for the benefit of ports; honour it.

Regular expressions are fine for what the specification itself expresses that way — this port uses
the URI specification's own splitting expression, and says so at the call site.

### A.9 Unicode

- Generate identifier-property and general-category tables into checked-in source, delta-varint
  encoded and base64-wrapped; record the version.
- **The two identifier properties have different closure rules.** Getting this wrong produces two
  byte-identical tables that pass every ASCII test.
- The lexer decodes UTF-8 itself and is code-point addressed. **Never index a string by its
  UTF-16 unit** to derive a column or an offset. Count the byte offset; do not re-derive it from a
  decoded length, which is only right while the input is well-formed.
- Malformed input is an error, never a replacement character.
- Normalization via `String.prototype.normalize` is fine — it is core-language, not the
  internationalization library, so it needs no data of its own — and it is the one host-data
  dependency worth keeping. See §A4 of the body for why it is safe.

### A.10 Host types the language does not have

There is no built-in UUID, IP address, date, or arbitrary-precision decimal. All 33 atom parsers are
written from scratch, about 3,600 lines. **Read the reference implementation's conformance notes
first**: they record where it is deliberately stricter than its own standard library, and those
checks are the required behaviour, not the standard library's leniency. Network-address leniency in
particular is a request-forgery bypass class.

Arbitrary-precision integers are `bigint`. Exact decimals are an own value type. Content hashing goes
through the platform's subtle-crypto interface, which is `Promise`-returning by design — so make it
plainly `async`, and do **not** dress it up in the suspension type: that type exists for a suspension
the caller's own input supply resumes, which hashing never does.

### A.11 Bindings and discriminated unions

Model the reference implementation's reflective binder as an **authored descriptor** — a
discriminated union with a phantom output type — not as decorators plus runtime metadata. Metadata
reflection is a runtime dependency that also degrades to a bare object type for every union, tuple
and optional, which is every case this format needs.

A tagged-union binding needs a way to choose a member when _writing_, not only when reading. A
discriminant property is the cheap answer; make sure the host value actually carries one, or the
value model can be read but never written.

---

## Appendix B — the same questions, other hosts

Sketches, not recommendations. Each host's answers should be written down with reasoning before the
contract layer is frozen.

|                     | Rust                                                                                                                                                                        | Go                                                                                                                                                         | Python                                                                                                                                        | C#                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Suspension**      | A hand-written state machine, or `async` with a custom input trait. Generators are unstable; do not build the contract on them.                                             | Real blocking input over `io.Reader` — the reference implementation's shape ports directly. No suspension machinery needed.                                | Generators with `yield` behave almost exactly like this port's; the same design applies, including the frame cost.                            | `IAsyncEnumerable` / `ValueTask`, or the reference's blocking shape over `Stream`.                                             |
| **Recursion depth** | No language limit; the OS thread stack is the bound. Explicit limits still required.                                                                                        | Growable goroutine stacks make deep recursion survivable, which makes an explicit limit _more_ important — it will exhaust memory instead of failing fast. | ~1,000 frames by default and a generator costs several. Limits are mandatory and must be low.                                                 | ~1 MB stack. Limits mandatory.                                                                                                 |
| **Unicode**         | The property crates are versioned and pinned by the lockfile — closer to shipping your own than most hosts. Still record the version.                                       | `unicode` package is tied to the toolchain version. Ship tables.                                                                                           | `unicodedata` is tied to the interpreter build. Ship tables.                                                                                  | Framework-version dependent. Ship tables.                                                                                      |
| **Atom types**      | `uuid`, `chrono`, `ipnet` exist — but each is a runtime dependency and each is more lenient than the specification. Budget for wrapping and tightening, not for delegating. | `net/netip`, `time`, `google/uuid`. Same caveat.                                                                                                           | `uuid`, `ipaddress`, `datetime`, `decimal` in the standard library. Same caveat — check strictness against the reference's conformance notes. | `Guid`, `IPAddress`, `DateOnly`, `decimal`. `decimal` is **not** arbitrary precision; do not use it for the exact-number tier. |
| **Layering**        | Crates and module visibility do this natively and better than any of the others.                                                                                            | `internal/` packages, plus an import-graph test.                                                                                                           | An import-linter configuration in continuous integration.                                                                                     | Assembly boundaries, or an architecture test.                                                                                  |
| **Trap**            | Recursion in a `Drop` implementation on a deep tree.                                                                                                                        | `encoding/json`-shaped reflection is a tempting wrong turn for the binding layer.                                                                          | Default recursion limit will be hit during development; raising it is not the fix.                                                            | `decimal`'s 28-digit limit will silently truncate the exact tier.                                                              |

---

## Appendix C — what I would do differently, in one list

1. **Write the gates before the waves**, and derive the wave order from the gates' dependencies.
2. **Add rungs 4, 5, 6 and 8 to the gate ladder** — packaging, end-to-end through the public API,
   adversarial through the public API, doc-claim audit. All four caught real defects when they were
   finally added; none of them existed during the waves.
3. **Land a public facade by wave 4**, even as a stub, so there is something for those rungs to test.
4. **Add the five missing work packages** in §4.2: resource limits, backpressure, embedded standard
   library, public identity and hashing, document classification.
5. **Walk the specification's non-grammar sections** and give each an owner or a written decision.
   Security considerations and resource limits do not attract attention on their own.
6. **Budget a third of the run for hardening** and gate it on findings, not on completion.
7. **Verify every regression test by reverting the fix**, and say so in the commit.
8. **Read exit codes, never output.**
9. **Reproduce every review finding before acting on it**, and discard findings without
   reproductions.
10. **Count agents in every fan-out**; never let silence read as success.
11. **Resolve tests to source from day one**, and run the whole ladder on a clean checkout early
    enough that a stale-build dependence cannot hide.
12. **Prove the layering rule fails** on a deliberate violation before trusting it.
13. **Choose the fixture comparison level deliberately** and write down which it is; prefer written
    form, and hold every difference as an allowlisted assertion rather than a skip.
14. **State which tiers are recursive and which are iterative** in the conventions file, before any
    of them are written — and bound the recursive ones the day they land, not in the sweep.
