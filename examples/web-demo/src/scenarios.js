/**
 * The demo's worked examples. Each is a schema plus a data document, and each data document has a
 * known number of *independent* faults -- the point being that one `validate()` call reports them
 * all, rather than stopping at the first.
 */
export const SCHEMA = `!!id:"https://example.com/people.tn"
!!meta:"https://tson.io/2026/33/m/meta.tn"
!!import:"https://tson.io/2026/33/m/core.tn"
@doc:"The demo schema: an employee record."
{
  @doc:"A person on the payroll."
  employee => {
    id:        uuid
    name:      non_empty_text
    age:       uint8
    email:     email
    started:   date
    active:    boolean
    tags:      [non_empty_text]?
  }
}
`;

export const SCENARIOS = [
  {
    id: 'valid',
    label: 'valid',
    root: 'employee',
    data: `!employee {
  id:      "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
  name:    "Ada Lovelace"
  age:     36
  email:   "ada@example.com"
  started: 2026-01-15
  active:  true
  tags:    ["founder" "mathematician"]
}
`,
  },
  {
    id: 'planted',
    label: 'ten planted errors',
    root: 'employee',
    data: `!employee {
  id:        "not-a-uuid"
  name:      ""
  age:       300
  email:     "ada@@example.com"
  started:   2026-13-45
  active:    yes
  tags:      { first: "founder" }
  nickname:  "Countess"
  salary:    100000
  id:        "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
}
`,
  },
  {
    id: 'missing',
    label: 'missing fields',
    root: 'employee',
    data: `!employee {
  name: "Grace Hopper"
  age:  45
}
`,
  },
  {
    id: 'syntax',
    label: 'malformed syntax',
    root: 'employee',
    data: `!employee {
  id:   "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
  name: "Unclosed record
  age:  36
`,
  },
  {
    id: 'schemaless',
    label: 'no schema (Class 1)',
    root: '',
    data: `{
  reading:  42
  when:     2026-08-28T05:14:00Z
  where:    !ipv4 "10.0.0.1"
  who:      !nonesuch "unknown to the built-in vocabulary"
  nested:   { a: [1 2 3]  b: { c: _ } }
}
`,
  },
];
