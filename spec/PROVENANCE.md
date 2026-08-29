# Provenance

Everything else in this directory is **vendored verbatim** from the reference implementation at
https://github.com/litterat/ltr8-io-tson-java, pinned to commit
`66222ac26ddf2e5364abc1aca000f61c04237d54` (the same commit `scripts/fetch-references.sh` pins).

| File | What it is |
| --- | --- |
| `tson-part1-data.md` | TSON Part 1 — text data format. 2026 Revision 34, Working Draft. |
| `tson-part2-schema.md` | TSON Part 2 — type system and schema. 2026 Revision 34, Working Draft. |
| `m/meta-kernel.tn`, `m/meta.tn`, `m/core.tn` | The three live bundled schemas. |
| `m/*-resolved.tn` | Resolver-output fixtures for the three above. |

## Do not edit these files

They are copies, not sources. Two things depend on that:

- The `*-resolved.tn` fixtures are compared against resolver output. They apply unchanged only
  because the `.tn` inputs they were produced from are unchanged — content digests included.
- The spec snapshots are the revision this port was written against. Editing one would make the
  code disagree with the document that justifies it, silently.

`spec.test.ts` fails if any file here drifts from the pinned checkout. `.prettierignore` covers
this directory so formatting cannot rewrite them either.

To move to a newer spec revision, change the pin in `scripts/fetch-references.sh`, re-run it, and
re-copy — as one commit, so the diff shows what changed in the spec.

## Why vendor at all

`.references/` is gitignored and refetched, so it is not present in a fresh clone, in a published
package, or in any archive of this repository. The spec and the bundled schemas need to be
readable without network access — the schemas are loaded at runtime, and the spec is what every
`§`-citation in the source refers to.
