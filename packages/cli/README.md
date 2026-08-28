# @ltr8/tson-cli

The `tson` command line tool — validate, compile, hash and scaffold **TSON** (Typed Schema Object
Notation) documents.

```bash
npx @ltr8/tson-cli init-example .
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli hash person.tn
```

## Commands

| Command        | Does                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | validates data documents; with `--schema` and `--root`, against that schema entry. `-` reads one document from standard input                        |
| `compile`      | resolves and links a schema against the bundled standard library and reports whether it compiles                                                     |
| `hash`         | prints a document's canonical content hash and, when it declares `!!id`, the reference pinned with that hash. Read-only — it never rewrites the file |
| `init-example` | writes an example schema and a matching data document, ready to validate                                                                             |

`--format text|json|tson` selects the output form; `tson` output is produced by the implementation's
own writer, never by string concatenation.

## Exit codes

Scripts depend on these, so they are part of the contract:

| Code | Means                                                                        |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | valid                                                                        |
| `1`  | at least one input was invalid                                               |
| `2`  | usage error — an unrecognised option, a missing argument, an unusable schema |
| `70` | a gap or fault in the library: the tool did not reach a verdict              |

The `1` / `70` split is the one that matters. `1` means the tool worked and the data was bad; `70`
means nothing was checked.

## Offline

`validate`, `compile` and `hash` register `@ltr8/tson/stdlib`'s embedded `meta-kernel` / `meta.tn` /
`core.tn`, so they work with no network access and no schema source configured.

Full documentation is in the
[repository](https://github.com/litterat/ltr8-io-tson-typescript#readme). Apache-2.0.
