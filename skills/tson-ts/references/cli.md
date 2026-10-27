# The `tson` command line

`@ltr8/tson-cli`: commands, flags, exit codes and the machine-readable report.

```bash
npx @ltr8/tson-cli init-example .                                            # person.tn + person-data.tn
npx @ltr8/tson-cli validate person-data.tn --schema person.tn --root person
npx @ltr8/tson-cli validate --format json data/*.tn                          # Class 1 only, no schema
npx @ltr8/tson-cli validate person-data.json --schema person.tn --root person # .json, [TSON-JSON]
npx @ltr8/tson-cli compile person.tn
npx @ltr8/tson-cli policy                                                    # the §8.2 policy this run would apply
npx @ltr8/tson-cli hash person.tn                                            # canonical content hash (§2.2.1)
```

`tson --help` lists the six commands; `tson <command> --help` prints that command's own page,
including the shared policy-flag block below for `validate`/`compile`/`policy`.

|                          |                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands                 | `validate`, `compile`, `policy`, `hash`, `strip`, `init-example`                                                                                                |
| `--schema <file-or-url>` | validate only; a local path or an `https://` URL. **Never** a data file's own `!!schema` — honouring that would fetch whatever untrusted content named.         |
| `--root <name>`          | required whenever `--schema` is given; not auto-detected                                                                                                        |
| `--format`               | `text` (default), `json`, `tson`, on every command but `strip`                                                                                                  |
| `-`                      | reads one data document from stdin (validate, at most once) — TSON text by default, whatever binding is given; `--input json` forces JSON                       |
| `--input tson\|json`     | validate only; forces every input's encoding, `-` included, overriding the by-extension/TSON-for-stdin default                                                  |
| `.json` input            | validate only; a JSON encoding of TSON data ([TSON-JSON] §3.1), case-insensitive by extension, and it requires `--schema`/`--root` (a usage error without them) |
| Exit codes               | see below, ranked `70 > 78 > 69 > 75 > 1` by who must act first                                                                                                 |

`validate`/`compile`/`hash` register the bundled `meta-kernel`/`meta.tn`/`core.tn`/`net.tn`/`policy.tn`, so they work
offline with no `SchemaSource`. Data files are streamed, never buffered whole. Any argument
beginning with `-` that is not a known flag is a usage error, never a file name.

| Exit | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| `0`  | checked, and nothing to report                                                              |
| `1`  | checked and rejected — includes a §8.2 name-hygiene refusal, since the sender holds the fix |
| `2`  | usage error                                                                                 |
| `69` | a schema permanently unavailable — refused by policy, absent, or too large                  |
| `75` | a schema temporarily unavailable — unreachable, or it did not answer in time                |
| `78` | a type the schema needs has no registered binding                                           |
| `70` | a gap in this library, or an internal fault — never a statement about the document          |

### Policy flags

`--identifier-policy <level>`, `--identifier-per-segment`, `--identifier-allow-look-alikes`
(skeleton distinctness off), `--identifier-scripts <A+B>`, `--token-policy <level>`, `--token-scripts <A+B>` are shared by `validate`, `compile` and `policy`.
`<level>` is a UTS #39 §5.2 restriction level (`ascii-only` … `unrestricted`, or the
`ASCII_ONLY`-style spelling `tson policy` prints, accepted back); `<A+B>` names UCD `Script`
property long-form names joined by `+` (`Latin+Cyrillic` — never the ISO 15924 alias `Latn`).
`tson policy [<policy options>]` prints the policy a run under those flags would apply, with no
document in hand — a generator can conform before writing rather than after being refused, and its
own JSON/tson `policy` record is exactly what a `validate`/`compile` run of the same flags carries
as its `policy` field.

### Machine-readable output

`--format json` is the shape to parse in CI. **Its field names are `snake_case`, unlike the
library's own `camelCase` `Diagnostic`** — `schema_id`, `schema_pointer`, `data_position`,
`schema_position` — and every optional field is omitted rather than emitted as `null`. The run and
each file report an `outcome` of `"ACCEPTED"`, `"REJECTED"` or `"UNDETERMINED"` — never a plain
`valid` boolean, so a file whose schema could not be obtained is distinguishable from one that failed:

```json
{
  "outcome": "REJECTED",
  "policy": {
    "identifier_policy": { "level": "HIGHLY_RESTRICTIVE", "per_segment": false, "permitting": [] },
    "token_policy": { "level": "UNRESTRICTED", "per_segment": false, "permitting": [] },
    "unicode_data_version": "16.0"
  },
  "files": [
    {
      "file": "order.tn",
      "outcome": "REJECTED",
      "diagnostics": [
        {
          "code": "ATOM_FORM_INVALID",
          "message": "'x' is not a valid integer …",
          "path": "/order_id",
          "schema_id": "example.com/order.tn",
          "schema_pointer": "/order/order_id",
          "expected": "an integer or based-integer form",
          "actual": "x",
          "data_position": { "line": 1, "column": 13, "offset": 12 }
        }
      ]
    }
  ]
}
```

Every `validate`/`compile` run carries `policy` — the same record `tson policy` prints on its own
— so a report always states what it was judged under. A file whose schema could not be obtained
carries `"outcome": "UNDETERMINED"` (or `"REJECTED"`, for a schema this run will not supply) and a
`SCHEMA_*` diagnostic with no `path`/`schema_pointer` (nothing was read to place one); a
`NOT_IMPLEMENTED` or `BIND_MISMATCH` diagnostic alone likewise makes its file `UNDETERMINED`. `--format tson` is the same record written through
the library's own writer; `--format text` is one line per diagnostic, `CODE at /path
(line:column): message`, or `CODE at the document root: message` when `path` is `""`.
