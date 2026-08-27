# @ltr8/tson

A TypeScript implementation of **TSON** (Typed Schema Object Notation), for Node 24+ and modern
browsers, with **zero runtime dependencies**.

> **Status: scaffold.** The contract layer and conformance harness are in place; the implementation
> is not. See [STATUS.md](STATUS.md). Nothing here is publishable yet.

## What TSON is

TSON is a schema system with its own notation, not a data format with a schema bolted on. At its
centre is a type system of immutable, hash-pinned schemas whose definitions are themselves data,
resolving down a verified chain — document → schema → meta-schema → kernel — so that one hash
authenticates a document together with its entire contract.

The text format is a Unicode-first superset of JSON. Commas and quotes are optional where
unambiguous, identifiers may be in any script, and there are three structural forms distinguished by
their contents rather than their brackets:

```tson
!!id:"https://example.com/orders/1042.tn"
!!schema:"https://example.com/order.tn"
@doc:"Order record exported 2026-07-03"
!order {
  order_id:  1042
  reference: !uuid 9f1c8e2a-4b7d-4e6f-9a3b-2c5d8e7f1a09
  customer: {
    name:  "Ada Lovelace"
    tier:  @deprecated GOLD
  }
  placed:  !date 2026-07-01
  flags:   0b0110
  items: [
    { sku: A-100 qty: 2 price: 49.95 discount: .5 }
    { sku: B-205 qty: 1 price: 100.00 discount: _ }
  ]
  discounts: { WELCOME10 => "10%" loyalty => _ }
}
```

- **Records** `{ name: value }` — fields, separated by `:`
- **Maps** `{ key => value }` — arbitrary keys, separated by `=>`
- **Arrays** `[ a b c ]` — whitespace or commas
- **`_`** — the absent sentinel, distinct from `null`, and it occupies an array slot
- **`@name`** — annotations, ordered and repeatable, preserved verbatim
- **`!name`** — type annotations
- **`!!name:"…"`** — directives: `id`, `schema`, `meta`, `import`, and only those

Valid JSON is valid TSON apart from two character-level exceptions in string content.

Two conformance classes: **Class 1** implements the data format alone and needs nothing from Part 2;
**Class 2** implements the schema layer too. This port targets both.

## Specification

- Part 1 — Text Data Format: https://tson.io/raw/2026/33/tson-part1-data.md
- Part 2 — Type System and Schema: https://tson.io/raw/2026/33/tson-part2-schema.md

The spec is a working revision and changes without compatibility guarantees until it freezes as
version 1.

## Development

```bash
./scripts/fetch-references.sh   # pinned Java reference + the shared conformance suite
npm install
npm run typecheck
npm run lint
npm test
npm run test:conformance        # 146 shared vectors
npm run build
```

`.references/` is gitignored and required for the conformance project, which skips with a message
rather than failing when it is absent.

See [CLAUDE.md](CLAUDE.md) for the design constraints and conventions, and
[PORT-PLAN.md](PORT-PLAN.md) for how the port is organised.

## Related

- [ltr8-io-tson-java](https://github.com/litterat/ltr8-io-tson-java) — the reference implementation
- [ltr8-io-tson-test-suite](https://github.com/litterat/ltr8-io-tson-test-suite) — the shared,
  language-agnostic conformance vectors

## License

Apache-2.0
