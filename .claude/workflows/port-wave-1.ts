export const meta = {
  name: 'tson-port-wave-1',
  description:
    'Wave 1 of the TSON Java-to-TypeScript port: the leaf packages, which depend only on the frozen contract layer',
  whenToUse:
    'After the Phase 0 scaffold is green (typecheck, lint, and 146 conformance vectors discovered). Produces the unicode tables, byte input, lexer, number grammar, event stream, atom vocabulary, regex engine, tree model and bind runtime.',
  phases: [
    { title: 'Port', detail: 'one agent per work package, all against the frozen contract layer' },
    { title: 'Verify', detail: 'adversarial spec review of each package that landed' },
  ],
};

// Wave 1 work packages, from PORT-PLAN.md Part B. Every one of these depends only on the frozen
// contract layer, so they share no context and can run in any order. The cloud VM has 4 vCPUs, so
// the runtime caps concurrency at 2 regardless of how many are listed here — the list is the unit
// of work, not a promise about parallelism.
const PACKAGES = [
  {
    key: 'unicode',
    loc: 350,
    brief: `Work package 1 (unicode). Produce packages/tson/src/unicode/: xid.ts (GENERATED), nfc.ts, whitespace.ts, and scripts/gen-unicode-tables.mjs.

The generator walks 0..0x10FFFF skipping surrogates, tests /^\\p{XID_Start}$/u, /^\\p{XID_Continue}$/u and /^\\p{Nd}$/u, coalesces to ranges, delta-varint encodes, base64-wraps, and records process.versions.unicode as UNICODE_VERSION. Check the table in, do not compute it at import — generation takes ~90ms.

Do NOT use the host regex at runtime. Three reasons, state them in the file's TSDoc: per-code-point testing would need String.fromCodePoint in the lexer's hottest loop; the property set would become the host engine's Unicode version, so two runtimes could disagree about whether a document is valid, which is wrong for a format whose identity can be a hash of its bytes; and §7.5 asks an implementation to document the Unicode version it supports, which a table pins and a host regex cannot.

Export isXidStart, isXidContinue, isNd with an ASCII fast path and binary search above it. The unquoted-token profile is §7.5's: start = XID_Start | Nd; continue = XID_Continue | '-' | '+' | '.'.

NFC: use String.prototype.normalize (ECMA-262, not Intl, so present in small-icu Node and every browser) behind a guard — a token whose maximum code point is < 0x0300 cannot contain a combining mark and is NFC by construction. Keep the allocating call off the path every ASCII identifier takes.

Pattern_White_Space stays a hardcoded 11-code-point check; it is frozen.

Write a test that regenerates the table in-process and asserts byte equality, warning rather than failing when process.versions.unicode differs from UNICODE_VERSION. Note in your report that this port is STRICTER than the Java, which approximates XID with Character.isUnicodeIdentifierStart/Part — the two disagree on a small set of code points including '$'. That is a spec-feedback finding.`,
  },
  {
    key: 'byte-input',
    loc: 350,
    brief: `Work package 2 (byte input and UTF-8). Produce packages/tson/src/io/utf8.ts, io/drivers.ts, io/streams.ts. io/bytes.ts is FROZEN — read it, do not edit it; ByteInput, Task, NEED_INPUT, runSync, runAsync and runOver already exist there.

Port the UTF-8 decoding half of .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/lexer/Lexer.java: decodeCodePoint and malformed(). Reject bad lead byte, bad continuation, truncated sequence, overlong form, encoded surrogate, and anything above U+10FFFF, each reported at the OFFENDING SEQUENCE'S OWN first byte offset. Never substitute U+FFFD — §7.1 requires rejection.

io/streams.ts adapts a web ReadableStream and a Node Readable into the ChunkInput that io/bytes.ts already defines, behind conditional exports so neither platform's types leak into the other.

Also provide a hand-written UTF-8 encoder so fromString does not depend on the ambient TextEncoder declaration in src/globals.d.ts, and delete that declaration once nothing needs it.`,
  },
  {
    key: 'lexer',
    loc: 1000,
    brief: `Work package 3 (lexer). Produce packages/tson/src/lexer/lexer.ts. token.ts is FROZEN.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/lexer/Lexer.java (900 lines) — read its Javadoc in full, it carries the invariants.

Non-negotiable, and the reason this package is one agent's whole job:
- Consume ByteInput and decode UTF-8 yourself. nextToken returns Task<TokenType>; every function that can starve is function* and every call to one is yield*.
- Code-point addressed, never UTF-16. Column counts code points.
- The byte offset is COUNTED, not derived. Carry per-code-point byte lengths alongside the lookahead buffer and add them on advance. A length re-derived from a decoded value is only right while the input is well-formed, which is exactly the case where an offset matters least.
- A leading BOM is discarded WITHOUT counting its bytes — it is not a character at offset zero.
- \\r defers the line bump to the following \\n; NEL/LS/PS bump the line.
- NFC check on unquoted tokens only, using the unicode package's guarded check.
- At most 2 code points of lookahead, per §7.2's six lookahead rules.
- Build token text through a code-point buffer, chunked, so String.fromCodePoint(...spread) never blows the stack on a long token.

Turns green: the lexer/valid and lexer/invalid conformance vectors, including the eight encoding: invalid-utf8 ones.`,
  },
  {
    key: 'numbers',
    loc: 800,
    brief: `Work package 4 (number grammar and base type resolution). Produce packages/tson/src/base/: numberScanner.ts, numberGrammar.ts, baseTypeResolver.ts, numberNarrowing.ts.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/base/*.java. Read NumberScanner.java's Javadoc first — it states the constraint this package exists to honour: a grammar written as a host regex is written in a dialect no other language shares. ONE FUNCTION PER ABNF RULE, over the token's text with charCodeAt, with mark/reset at the two genuinely optional productions (a float's fraction and its exponent). NO RegExp anywhere in src/base/.

§4.5's resolution order is fixed: null, then true/false, then the number grammar as a FULL-TOKEN match, then string. Quoted tokens always resolve to string. Note the traps: 007 and 1.2.3 fall through to string, while 0x71C7 resolves as a number.

This layer runs on already-lexed token text, so it is ordinary synchronous code — no Task, no generators.

Turns green: the resolver/valid conformance vectors.`,
  },
  {
    key: 'event-stream',
    loc: 850,
    brief: `Work package 5 (Tier 2 event stream). Produce packages/tson/src/stream/dataStream.ts. stream/event.ts is FROZEN — TsonEvent and EventSource already exist.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/TsonDataStream.java (812 lines). A lazy pull EventSource over the lexer with an explicit frame stack and at most two tokens of lookahead — that lookahead is what disambiguates a record from a map from an empty brace by content rather than bracket (§2.8).

next() and peek() return Task<TsonEvent> and delegate to the lexer with yield*. The frame stack is what keeps memory proportional to nesting depth.

Header handling: the document header is a fixed directive sequence needing at most two directives of lookahead and no backtracking. If the token past an optional !!id is !!meta, this is a schema document — a Class 1 path must raise TsonUnsupportedDocumentError rather than mis-parsing it.`,
  },
  {
    key: 'atoms-numeric',
    loc: 750,
    brief: `Work package 8a (numeric atoms). Produce packages/tson/src/atom/numeric/*.

Port IntegerParser, FloatParser, DecimalParser, RationalParser, ComplexParser, Base64Decoding, Base32Decoding and BinaryParser from .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/atom/.

READ .references/ltr8-io-tson-java/CONFORMANCE.md FIRST. JavaScript has no BigDecimal, so TsonDecimal (bigint unscaled value plus exponent, declared in src/value/types.ts) is yours to implement exactly. base64 and base64url REQUIRE padding. Integer families: int8..int32 to number, int64..int256 to bigint — exceeding 2^53 silently in a number is the trap this mapping exists to prevent.

Compare by information content, not text: the suite asserts numeric equality, and a rational may legitimately be asserted in reduced form.

Turns green: the numeric half of vocabulary/valid and vocabulary/invalid.`,
  },
  {
    key: 'atoms-temporal',
    loc: 550,
    brief: `Work package 8b (temporal atoms). Produce packages/tson/src/atom/temporal/*.

Port DateParser, TimeParser, DateTimeParser, DurationParser and IsoDuration.

READ .references/ltr8-io-tson-java/CONFORMANCE.md FIRST — every one of these is deliberately stricter than the JDK, and JavaScript gives you nothing to delegate to anyway: !date/!datetime/!time REJECT ISO 8601's extended-year form (a leading sign, or more than four digits), because RFC 3339's full-date grammar requires exactly four digits and no sign. !duration requires uppercase designators and no leading sign.

Do not use Date. Produce the PlainDate/PlainTime/PlainDateTime/TsonDuration value types declared in src/value/types.ts; duration is asserted by the suite as { period, clock }.

Turns green: the temporal vocabulary vectors.`,
  },
  {
    key: 'atoms-network',
    loc: 800,
    brief: `Work package 8c (network, binary and identifier atoms). Produce packages/tson/src/atom/network/*.

Port Ipv4Parser, Ipv6Parser, Cidr4Parser, Cidr6Parser, CidrParsing, MacParser, EmailParser, UriParser and UuidParser.

READ .references/ltr8-io-tson-java/CONFORMANCE.md FIRST — this is the package it matters most for, and the reasons are security reasons rather than pedantry:
- !ipv4 parses RFC 3986's IPv4address/dec-octet grammar itself. A lenient parser accepts a leading zero (0177.0.0.1), the legacy BSD short form (1.2.3), and a bare 32-bit integer — the same leniency class behind real SSRF filter bypasses, where a validator and the network stack disagree about what a string denotes.
- !ipv6 parses RFC 4291 §2.2 itself, including the dotted-quad tail checked against that same strict dec-octet grammar, because the IPv4-mapped form would otherwise reintroduce the whole gap.
- !uuid requires RFC 9562's canonical 8-4-4-4-12 grouping.
- !cidr4/!cidr6 validate a network but hand back the AUTHORED TEXT so a round trip is exact. Follow §5.5's split exactly: not CIDR-shaped is a parse error, a prefix outside the family range or an address with nonzero host bits is a validation error.

Turns green: the network and identifier vocabulary vectors.`,
  },
  {
    key: 'regex',
    loc: 1400,
    brief: `Work package 9 (I-Regexp engine). Produce packages/tson/src/regex/: parse.ts, nfa.ts, pike.ts, disjoint.ts, codePointSet.ts, index.ts.

Port .references/ltr8-io-tson-java/tson-regex/ (1447 lines) — an RFC 9485 I-Regexp engine. A true leaf: it must import NOTHING outside src/regex/, and an ESLint zone rule enforces that. It names no TSON type and could plausibly become its own package later; keep that door open.

Thompson NFA with a Pike VM — LINEAR TIME, no backtracking, so it is ReDoS-safe by construction. That property is the point; do not substitute the host RegExp. Also port the product-NFA emptiness check that decides whether two patterns share any string, which §5.4's choice disjointness needs.

Unicode categories for \\p{...}: use the generated tables from src/unicode/ rather than the host regex, for the same version-pinning reason.`,
  },
  {
    key: 'tree',
    loc: 600,
    brief: `Work package 10 (tree model). Produce packages/tson/src/tree/accessors.ts and tree/index.ts. tree/nodes.ts is FROZEN.

Port .references/ltr8-io-tson-java/tson-tree/ (628 lines). May import only src/core and src/tree — an ESLint zone rule enforces it.

Accessors NEVER throw. A failed lookup returns a MissingNode carrying the RFC 6901 pointer that failed, so a chain of gets ends in a node that can say where it went wrong. Two accessor families, and the distinction is deliberate: as/asString CAST, while asInt/asLong/asDouble CONVERT.`,
  },
  {
    key: 'bind-runtime',
    loc: 1200,
    brief: `Work package 11 (bind runtime). Produce packages/tson/src/bind/: combinators.ts, infer.ts, registry.ts, encode.ts, strictness.ts, index.ts. bind/binding.ts is FROZEN — the Binding union, FieldSlot, Infer and BindingRegistry already exist there; implement the signatures it declares.

This replaces .references/ltr8-io-tson-java/tson-bind/ (6313 lines). Do NOT translate it. The Java is a descriptor factory built on reflection; here the descriptor is authored, which deletes DefaultRecordBinder's 1158 lines of MethodHandle machinery, the three component finders, the mapper package, and the whole in-flight cycle-detection apparatus. lazy() is the only survivor of the cycle machinery, and it closes exactly the one edge Memoized defers.

encode.ts is load-bearing for the layering: toCoreValue(binding, value) must depend on ast/ and bind/ ONLY — no emitter, no compiler. This is what breaks the Java's compiler-to-bind circularity, where the definition resolver held an object writer because a chained atom refinement merges on the wire record before binding. An ESLint zone rule enforces the direction.

strictness.ts implements the schema-versus-binding cross-check: every non-FIXED field must have a slot and every slot must fill a field, raising TsonBindMismatchError at compile time rather than first read. FIXED fields are exempt; OPTIONAL fields are deliberately NOT, since those are the ones that work in development and fail on the first caller who sends them.

Document the lazy() ergonomics cliff at its docstring: a self-referential binding needs an explicit interface and a : Binding<X> annotation, or TypeScript reports that X implicitly has type any because it is referenced in its own initializer.`,
  },
];

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'vectorsGreen', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    vectorsGreen: {
      type: 'array',
      items: { type: 'string' },
      description: 'conformance vectors moved from failing to passing, as layer/bucket/slug',
    },
    gates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        typecheck: { type: 'boolean' },
        lint: { type: 'boolean' },
        unit: { type: 'boolean' },
        conformance: { type: 'boolean' },
      },
    },
    specFindings: {
      type: 'array',
      description: 'spec ambiguities, inconsistencies or errors found, with the reading chosen',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'problem', 'chosen'],
        properties: {
          section: { type: 'string' },
          problem: { type: 'string' },
          chosen: { type: 'string' },
        },
      },
    },
    notes: { type: 'string', description: 'anything unfinished, stated plainly' },
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'sound', 'problems'],
  properties: {
    key: { type: 'string' },
    sound: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'claim', 'severity'],
        properties: {
          file: { type: 'string' },
          claim: { type: 'string' },
          severity: { enum: ['blocking', 'significant', 'minor'] },
        },
      },
    },
  },
};

log(`Wave 1: ${String(PACKAGES.length)} work packages against the frozen contract layer`);

// Pipeline rather than a barrier: each package is verified as soon as it lands, so a slow one does
// not hold up review of a fast one. There is no cross-package dependency to synchronise on.
const results = await pipeline(
  PACKAGES,
  (pkg) =>
    agent(
      `${pkg.brief}

Read CLAUDE.md first — its hard constraints are not suggestions. The contract layer under
packages/tson/src/{core,io,lexer/token,stream/event,ast,schema/meta,bind/binding,tree/nodes,value,reader,atom/contract}.ts
is FROZEN: import from it, never edit it. If one of those types is genuinely wrong, stop and say so.

Definition of done, all four: npm run typecheck, npm run lint, npm test, npm run test:conformance.
Do not modify test/conformance/ to make a vector pass.`,
      {
        label: `port:${pkg.key}`,
        phase: 'Port',
        agentType: 'tson-porter',
        schema: PORT_RESULT,
      },
    ),
  (port, pkg) => {
    if (port === null || port.status === 'blocked') return null;
    return agent(
      `Adversarially review work package "${pkg.key}" of the TSON TypeScript port. Default to
finding it UNSOUND: your job is to refute the claim that it is a faithful port, not to confirm it.

Files it claims to have written: ${port.filesWritten.join(', ')}
Vectors it claims to have turned green: ${port.vectorsGreen.join(', ') || '(none claimed)'}

Check, in this order:
1. Read the spec sections it implements and the Java source it ports. Does the behaviour actually
   match, including the edge cases .references/ltr8-io-tson-java/CONFORMANCE.md records?
2. Did it weaken any Task<T> signature to a plain return type? That silently breaks suspension.
3. Is there a RegExp anywhere in src/base/, or a host-regex Unicode property test at runtime?
4. Did it introduce a runtime dependency? Check the package.json diff.
5. Does it materialise a whole document anywhere, rather than streaming?
6. Run the gates yourself. Do the claimed green vectors actually pass, and did anything regress?

Report only problems you can point at a file and line for.`,
      { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT },
    );
  },
);

const landed = results.filter((r) => r !== null);
log(`Wave 1 complete: ${String(landed.length)}/${String(PACKAGES.length)} packages returned`);

return { wave: 1, results };
