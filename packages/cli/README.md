# @ltr8/tson-cli

The `tson` command line tool — validate, compile, hash and scaffold **TSON** (Typed Schema Object
Notation) documents.

```bash
npx @ltr8/tson-cli init-example .
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli hash person.tn
```

## Versioning

`0.<spec revision>.<patch>` — the minor tracks the TSON spec revision this implements, so
`0.36.x` is built against the 2026 Revision 36 series. `@ltr8/tson` and `@ltr8/tson-cli` are
released in lockstep at the same version.

## Commands

| Command        | Does                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate`     | validates data documents — `.tn` text, or `.json` under a schema ([TSON-JSON]) — with `--schema` and `--root`, against that schema entry. `-` reads one document from standard input; `--input tson\|json` forces the encoding instead of choosing it from the file name |
| `compile`      | resolves and links a schema against the bundled standard library and reports whether it compiles                                                                                                                                                                         |
| `policy`       | prints the [TSON-DATA] §8.2 Unicode name-hygiene policy this run would apply, with no document in hand                                                                                                                                                                   |
| `hash`         | prints a document's canonical content hash and, when it declares `!!id`, the reference pinned with that hash. Read-only — it never rewrites the file                                                                                                                     |
| `init-example` | writes an example schema and a matching data document, ready to validate                                                                                                                                                                                                 |

`--format text|json|tson` selects the output form; `tson` output is produced by the implementation's
own writer, never by string concatenation.

## Exit codes

Scripts depend on these, so they are part of the contract:

| Code | Means                                                                        |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | checked, and nothing to report                                               |
| `1`  | checked and rejected — includes a §8.2 name-hygiene refusal                  |
| `2`  | usage error — an unrecognised option, a missing argument, an unusable schema |
| `69` | a schema permanently unavailable — refused by policy, absent, or too large   |
| `75` | a schema temporarily unavailable — unreachable, or it did not answer in time |
| `78` | a type the schema needs has no registered binding                            |
| `70` | a gap or fault in the library: the tool did not reach a verdict              |

The `1` / `70` split is the one that matters most. `1` means the tool worked and the data was bad;
`70` means nothing was checked. `69`, `75` and `78` sit between the two — each means some
diagnostic was not a verdict at all, so the run has no more grounds to call the data invalid than
a `70` gap does.

## Offline

`validate`, `compile` and `hash` register `@ltr8/tson/stdlib`'s embedded `meta-kernel` / `meta.tn` /
`core.tn`, so they work with no network access and no schema source configured.

Full documentation is in the
[repository](https://github.com/litterat/ltr8-io-tson-typescript#readme). Apache-2.0.
