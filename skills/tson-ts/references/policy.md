# Resource limits and name policy

The §9.1 nesting bound and §8.2's name hygiene, and how to state a relaxation.

`maxNestingDepth` (default **64**, §9.1's own default) bounds nesting, per call or once per instance. The
recursion is real — one host call frame per level — so lowering it is free and raising it is bounded
by the host stack. A document past the limit is refused with a typed error and a position, never a
host `RangeError`.

```ts
parse(bytes, { maxNestingDepth: 128 });
readTree(bytes, { schema, root: 'order', maxNestingDepth: 128 });
createTson({ maxNestingDepth: 128 }); // every schema it resolves and document it reads
```

§8.2's three name-hygiene mechanisms are on by default (skeleton distinctness, `Identifier_Status`,
Highly Restrictive over the whole name). A refusal is §8.1's refused outcome, apart from its four categories: `isVerdict` is `false`
for its code (`CONFUSABLE_NAMES`, `RESTRICTED_CHARACTER`, `RESTRICTED_SCRIPT`; `isNameRefusal`), and
`tson validate` reports the file `REJECTED` and exits 1. Relaxation is a **code decision stated at the call site** —
never an environment variable, because a security policy read from the environment is ambient
authority. State it once on the instance, via `Config.identifierPolicy`:

```ts
const tson = createTson({
  identifierPolicy: {
    skeletonDistinctness: true,
    restrictionLevel: 'ASCII_ONLY', // ASCII_ONLY | SINGLE_SCRIPT | HIGHLY_RESTRICTIVE | …; UNRESTRICTED drops Identifier_Status too
    perSegment: false, // true applies the level per segment — §8.2's first relaxation to reach for
    permittedScripts: [], // combinations admitted in addition to the level -- build with `permitting`
  },
});
```

Script combinations are `ScriptId` numbers, not names — `scriptNamed('Latin')` resolves the UCD
`Script` property's long-form name to one, so `permittedScripts: [[scriptNamed('Latin')!,
scriptNamed('Cyrillic')!]]` admits that combination in addition to whatever the level already
allows. `IdentifierPolicy`, `ScriptPolicy` and `ProcessorPolicy` are exported types, with
`DEFAULT_IDENTIFIER_POLICY`, `NO_IDENTIFIER_POLICY`, `perSegment`, `permitting`,
`withRestrictionLevel`, `withSkeletonDistinctness` and `scriptPolicy` to derive a relaxed copy, and
`withIdentifierPolicy(config, …)`/`withTokenPolicy(config, …)` to set one on a `Config`.

`Config.tokenPolicy` is the same shape's counterpart over _values_ rather than declared names —
only the restricted-script mechanism applies there, since a value has no identifier profile to
violate and no scope to be distinct within; it defaults to `UNRESTRICTED`, so an ordinary read
scans no values at all. `tson.processorPolicy` reports both policies, §9.1's limits and the UCD version
they were computed against, the same record `tson policy` prints from the command line.

Name hygiene decides **policy, not validity**: it can never make a document invalid, and its verdict
can change under a routine Unicode data refresh, which is why it is reported apart from the four
error categories.
