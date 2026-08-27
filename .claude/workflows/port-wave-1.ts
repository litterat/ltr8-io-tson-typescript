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

// The porter charter, carried in the script rather than looked up as a registered agent
// type. `.claude/agents/tson-porter.md` is only visible to a session that started AFTER it
// was committed, so a session that pulled it mid-run gets 'agent type not found' — which is
// how Wave 0's first run lost four of five agents. The charter travels with the wave script,
// which is the unit of review anyway, and `model: 'sonnet'` carries what the frontmatter said.
const PORTER = `You port one work package of TSON from the Java reference implementation to idiomatic TypeScript.

# Before writing anything

Read, in this order:

1. \`CLAUDE.md\` — the hard constraints and conventions. They are not negotiable and they are not
   suggestions.
2. \`PORT-PLAN.md\` — find your work package in the Part B wave tables. It names the Java sources you
   port, the TypeScript you produce, and what you may assume exists.
3. The spec sections your package implements:
   \`.references/ltr8-io-tson-java/spec/tson-part1-data.md\` and \`tson-part2-schema.md\`.
4. The Java sources named for your package, including their Javadoc. The Javadoc carries invariants
   and deliberate divergences that the code alone does not show.
5. The contract-layer types you import. They are frozen. If one is genuinely wrong, say so and stop —
   do not edit it, because other packages are building against it concurrently.

# How to port

**Idiomatic TypeScript, not transliterated Java.** Discriminated unions over class hierarchies, plain
functions over singleton objects, closures over \`MethodHandle\`. Same behaviour, same conformance,
different shape. A class-for-class translation is a failed port.

**Behaviour comes from the spec and the vectors, not from the Java's convenience.** Where the Java
leans on a JDK type this port has no equivalent for, read
\`.references/ltr8-io-tson-java/CONFORMANCE.md\` — it records where the reference is deliberately
stricter than the JDK, and those checks are the required behaviour.

**Never weaken a signature.** Anything that can starve for input returns \`Task<T>\` and is called with
\`yield*\`. Do not "simplify" one to a plain return type; it breaks every caller above it and the
suspension cannot be reintroduced locally.

**No regex in the grammar.** The number grammar is hand-written, one function per ABNF rule. The
reference states this explicitly for the benefit of ports.

**Zero runtime dependencies.** Not one, for any reason.

# Tests

Write tests from the **spec**, not by translating the Java tests. Read the Java tests to learn what
edge cases exist and what they assert, then write TypeScript tests that state those cases against the
spec section that requires them. Cite the section in the test name.

Run the shared vectors:

\`\`\`bash
npm run test:conformance
\`\`\`

**Your wave's brief says what the suite should do at your point in the port, and it governs.** In
early waves nothing can pass — \`test/conformance/sidecar.ts\` parses sidecars with this
implementation's own parser, so until the data parser lands every vector fails on the same throw.
There the thing to check is that the DISCOVERED count is still 146; a drop means the harness broke.

Do not modify the harness in \`test/conformance/\` to make a vector pass. If a vector looks wrong,
report it — it may be a genuine spec-feedback finding.

# Definition of done

These always, no exceptions:

\`\`\`bash
npm run typecheck          # clean
npm run lint               # clean, including the import/no-restricted-paths zones
npm run format:check       # clean
npm test                   # your unit tests pass
\`\`\`

Plus whatever your wave's brief states about \`npm run test:conformance\`. Nothing that was green
may go red, in any wave.

If a lint zone rule fires, fix the import, not the rule. The zones replace the reference
implementation's module system and carry real design weight.

# Report back

- Files created or changed.
- Which conformance vectors moved from failing to passing, by name.
- Every place the spec was ambiguous, underspecified, internally inconsistent, or plain wrong, with
  the interpretation you chose and why. Do not silently pick a reading — a resolved ambiguity is
  invisible again three sessions later unless it is written down.
- Anything you could not finish, stated plainly.`;

/**
 * Agents that error resolve to `null`, so a wave whose agents all died looks exactly like a wave
 * that ran cleanly and found nothing. Wave 0's first run reported "0 findings" while four of its
 * five agents had failed to start at all, and the run was reported as completed. Filtering nulls
 * away silently is what made that possible, so every stage counts them instead.
 */
function requireAgents(results, expected, what) {
  const ok = results.filter((r) => r !== null);
  const lost = expected - ok.length;
  if (lost > 0) {
    log(
      `WARNING: ${String(lost)} of ${String(expected)} ${what} agents returned nothing. Their results are MISSING, not empty — do not read this wave as complete.`,
    );
  }
  if (ok.length === 0) {
    throw new Error(
      `every ${what} agent failed; aborting rather than reporting an empty result as success`,
    );
  }
  return ok;
}

// Wave 1 work packages, from PORT-PLAN.md Part B. Every one of these depends only on the frozen
// contract layer, so they share no context and can run in any order. The cloud VM has 4 vCPUs, so
// the runtime caps concurrency at 2 regardless of how many are listed here — the list is the unit
// of work, not a promise about parallelism.
const PACKAGES = [
  {
    key: 'unicode',
    loc: 350,
    brief: `Work package 1 (unicode). Produce packages/tson/src/unicode/nfc.ts and
packages/tson/src/unicode/whitespace.ts, and wire them into an index.

ALREADY DONE — do not regenerate, do not edit, do not rename:
  - scripts/gen-unicode-tables.mjs
  - packages/tson/src/unicode/xid.ts, which exports UNICODE_VERSION, isXidStart, isXidContinue
    and isNd, with an ASCII bitmask fast path and binary search above it.
  - packages/tson/test/unicode.test.ts, which cross-checks the whole code space against the
    host's property data when the host's Unicode version matches the table's.
Import from xid.ts; it is part of your frozen surface. If you believe it is wrong, stop and say
so rather than editing it.

NFC: use String.prototype.normalize (ECMA-262, not Intl, so present in small-icu Node and every
browser) behind a guard — a token whose maximum code point is < 0x0300 cannot contain a combining
mark and is NFC by construction. Keep the allocating call off the path every ASCII identifier
takes. Expose both a predicate (is this text already NFC) and the check the lexer needs, and be
explicit in the TSDoc about which one allocates.

Pattern_White_Space stays a hardcoded 11-code-point check; it is frozen by UAX #31 and will not
gain members. Do not derive it from a table.

The unquoted-token profile is §7.5's, and belongs here rather than in the lexer:
start = XID_Start | Nd; continue = XID_Continue | '-' | '+' | '.'.

Note in your report that this port is STRICTER than the Java, which approximates XID with
Character.isUnicodeIdentifierStart/Part — the two disagree on a small set of code points
including '$', which the Java admits and real XID tables reject. That is a spec-feedback finding
and packages/tson/test/unicode.test.ts already pins the '$' behaviour.`,
  },
  {
    key: 'byte-input',
    loc: 350,
    brief: `Work package 2 (byte input and UTF-8). Produce packages/tson/src/io/utf8.ts, io/drivers.ts, io/streams.ts. io/bytes.ts is FROZEN — read it, do not edit it; ByteInput, Task, NEED_INPUT, runSync, runAsync and runOver already exist there.

Port the UTF-8 decoding half of .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/lexer/Lexer.java: decodeCodePoint and malformed(). Reject bad lead byte, bad continuation, truncated sequence, overlong form, encoded surrogate, and anything above U+10FFFF, each reported at the OFFENDING SEQUENCE'S OWN first byte offset. Never substitute U+FFFD — §7.1 requires rejection.

io/streams.ts adapts a web ReadableStream and a Node Readable into the ChunkInput that io/bytes.ts already defines, behind conditional exports so neither platform's types leak into the other.

Also provide a hand-written UTF-8 encoder in io/utf8.ts and repoint fromString at it.

io/bytes.ts is frozen EXCEPT for the single expression in fromString's body (currently a call to new TextEncoder().encode(text) wrapped in fromBytes), which is yours to change to call your own encoder. Make that edit and delete src/globals.d.ts in the same change. Nothing else in io/bytes.ts may change. test/conformance/runner.test.ts also uses TextEncoder but compiles under test/tsconfig.json, which sets types: ["node"], so deleting globals.d.ts does not affect it.`,
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

Unblocks (these go green in Wave 2, not this wave): the lexer/valid and lexer/invalid conformance vectors, including the eight encoding: invalid-utf8 ones.`,
  },
  {
    key: 'numbers',
    loc: 800,
    brief: `Work package 4 (number grammar and base type resolution). Produce packages/tson/src/base/: numberScanner.ts, numberGrammar.ts, baseTypeResolver.ts, numberNarrowing.ts.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/base/*.java. Read NumberScanner.java's Javadoc first — it states the constraint this package exists to honour: a grammar written as a host regex is written in a dialect no other language shares. ONE FUNCTION PER ABNF RULE, over the token's text with charCodeAt, with mark/reset at the two genuinely optional productions (a float's fraction and its exponent). NO RegExp anywhere in src/base/.

§4.5's resolution order is fixed: null, then true/false, then the number grammar as a FULL-TOKEN match, then string. Quoted tokens always resolve to string. Note the traps: 007 and 1.2.3 fall through to string, while 0x71C7 resolves as a number.

This layer runs on already-lexed token text, so it is ordinary synchronous code — no Task, no generators.

Unblocks (these go green in Wave 2, not this wave): the resolver/valid conformance vectors.`,
  },
  {
    key: 'event-stream',
    loc: 850,
    brief: `Work package 5 (Tier 2 event stream). Produce packages/tson/src/stream/dataStream.ts. stream/event.ts is FROZEN — TsonEvent and EventSource already exist.

Port .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/TsonDataStream.java (812 lines). A lazy pull EventSource over the lexer with an explicit frame stack and at most two tokens of lookahead — that lookahead is what disambiguates a record from a map from an empty brace by content rather than bracket (§2.8).

next() and peek() return Task<TsonEvent> and delegate to the lexer with yield*. The frame stack is what keeps memory proportional to nesting depth.

Header handling: the document header is a fixed directive sequence needing at most two directives of lookahead and no backtracking. If the token past an optional !!id is !!meta, this is a schema document — a Class 1 path must raise TsonUnsupportedDocumentError rather than mis-parsing it.

TsonParseError now carries optional expected/actual alongside message and position:
new TsonParseError(message, position, { expected, actual }). Java's TsonDataStream.java:371 uses
exactly that four-argument form ("expected " + construct + ", found " + describe(peekToken())), so
port it with the pair populated rather than folding both into the message. Where a throw states a
RULE rather than a substitution — an adjacency violation, a trailing separator — omit both; the
pair is all-or-nothing and no throw site invents one to fill the other.`,
  },
  {
    key: 'atoms-numeric',
    loc: 750,
    brief: `Work package 8a (numeric atoms). Produce packages/tson/src/atom/numeric/*.

Port IntegerParser, FloatParser, DecimalParser, RationalParser, ComplexParser, Base64Decoding, Base32Decoding and BinaryParser from .references/ltr8-io-tson-java/tson-compiler/src/main/java/io/ltr8/tson/compiler/atom/.

READ .references/ltr8-io-tson-java/CONFORMANCE.md FIRST. JavaScript has no BigDecimal, so TsonDecimal (bigint unscaled value plus exponent, declared in src/value/types.ts) is yours to implement exactly. base64 and base64url REQUIRE padding. Integer families: int8..int32 to number, int64..int256 to bigint — exceeding 2^53 silently in a number is the trap this mapping exists to prevent.

Compare by information content, not text: the suite asserts numeric equality, and a rational may legitimately be asserted in reduced form.

Both error classes now REQUIRE a structured \`expected\` fragment as their third constructor argument — TsonAtomParseError(typeRef, message, expected) and TsonAtomValidationError(typeRef, message, expected). It is the machine-readable half of the failure and reaches Diagnostic.expected verbatim, so draw it from the closed six-shape vocabulary documented on AtomType.read() in atom/contract.ts: ordering bound, membership, length, pattern, grammar (parse failures only), prohibition. Each is a FRAGMENT, never a sentence — a renderer composes "expected <= 100, found 99999" around it. Do not supply actual; that is the token's own text and the reader adds it.

Unblocks (these go green in Wave 2, not this wave): the numeric half of vocabulary/valid and vocabulary/invalid.`,
  },
  {
    key: 'atoms-temporal',
    loc: 550,
    brief: `Work package 8b (temporal atoms). Produce packages/tson/src/atom/temporal/*.

Port DateParser, TimeParser, DateTimeParser, DurationParser and IsoDuration.

READ .references/ltr8-io-tson-java/CONFORMANCE.md FIRST — every one of these is deliberately stricter than the JDK, and JavaScript gives you nothing to delegate to anyway: !date/!datetime/!time REJECT ISO 8601's extended-year form (a leading sign, or more than four digits), because RFC 3339's full-date grammar requires exactly four digits and no sign. !duration requires uppercase designators and no leading sign.

Do not use Date. Produce the PlainDate/PlainTime/PlainDateTime/TsonDuration value types declared in src/value/types.ts; duration is asserted by the suite as { period, clock }.

Both atom error classes REQUIRE a structured \`expected\` fragment as their third constructor argument, drawn from the closed six-shape vocabulary documented on AtomType.read() in atom/contract.ts. Do not supply actual; the reader adds it from the token text.

Unblocks (these go green in Wave 2, not this wave): the temporal vocabulary vectors.`,
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

Both atom error classes REQUIRE a structured \`expected\` fragment as their third constructor argument, drawn from the closed six-shape vocabulary documented on AtomType.read() in atom/contract.ts. Do not supply actual; the reader adds it from the token text.

Unblocks (these go green in Wave 2, not this wave): the network and identifier vocabulary vectors.`,
  },
  {
    key: 'regex',
    loc: 1400,
    brief: `Work package 9 (I-Regexp engine). Produce packages/tson/src/regex/: parse.ts, nfa.ts, pike.ts, disjoint.ts, codePointSet.ts, index.ts.

Port .references/ltr8-io-tson-java/tson-regex/ (1447 lines) — an RFC 9485 I-Regexp engine. A true leaf: it must import NOTHING outside src/regex/, and an ESLint zone rule enforces that. It names no TSON type and could plausibly become its own package later; keep that door open.

Thompson NFA with a Pike VM — LINEAR TIME, no backtracking, so it is ReDoS-safe by construction. That property is the point; do not substitute the host RegExp. Also port the product-NFA emptiness check that decides whether two patterns share any string, which §5.4's choice disjointness needs.

Unicode categories for \\p{...}: use packages/tson/src/regex/categories.ts. It is GENERATED and checked in, it lives inside the regex leaf so the zone stands, and it exports CATEGORY_NAMES, isCategoryName and isInCategory covering all 36 categories RFC 9485 admits. Do not import src/unicode/ — the first eslint zone makes regex/ a leaf and xid.ts carries identifier tables only, no general-category data. Do not fall back to the host RegExp for \\p{...}; that is the version-pinning problem this file exists to solve. Reject an unrecognised category name at PARSE time with a position, using isCategoryName.

Throw packages/tson/src/regex/errors.ts's TsonRegexSyntaxError, which already exists and carries (message, pattern, position) with position in CODE POINTS. It extends Error, not TsonError, because this zone forbids reaching core/ — that is deliberate and documented in the file; do not "fix" it back and do not add a second error type. regex/index.ts already re-exports it alongside categories.ts.`,
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
    brief: `Work package 11 (bind runtime). Produce packages/tson/src/bind/: combinators.ts, infer.ts, registry.ts, encode.ts, strictness.ts, index.ts. bind/binding.ts is FROZEN — the Binding union, FieldSlot, Infer, BindingRegistry, RecordOptions, ArrayOptions, MapOptions, Shape and InferShape already exist there. It declares TYPES ONLY and exports no runtime value, deliberately: it previously carried these eleven combinators as \`export declare function\`, which emitted no JavaScript and left the published @ltr8/tson/bind subpath with a .d.ts promising eleven values over an empty module. Do not put them back there.

Implement exactly these signatures — record, tuple, array, map, variant, bridge, lazy, field and optional in combinators.ts; registry and chain in registry.ts. Carry each TSDoc block onto the implementation:

\`\`\`ts
/** Build a {@link RecordBinding} from explicit fields -- see {@link field}/{@link optional} to build each one. */
function record<T>(options: RecordOptions<T>): RecordBinding<T>;

/**
 * Build a {@link TupleBinding} from a positional literal of element bindings, inferring the tuple's
 * host type via a \`const\` type parameter -- \`tuple([intBinding, textBinding])\` infers
 * \`TupleBinding<readonly [number, string]>\` with no \`as const\` needed.
 */
function tuple<const E extends readonly BindingRef<unknown>[]>(
  elements: E,
): TupleBinding<{ readonly [I in keyof E]: Infer<E[I]> }>;

/** Build an {@link ArrayBinding}. */
function array<T, E>(options: ArrayOptions<T, E>): ArrayBinding<T>;

/** Build a {@link MapBinding}. */
function map<T, K, V>(options: MapOptions<T, K, V>): MapBinding<T>;

/**
 * Build a {@link VariantBinding} from a shape literal of members keyed by wire type name, inferring
 * the host union type via a \`const\` type parameter. Pass \`discriminant\` for a shared tag property;
 * omit it to fall back to each member's own \`test\` (built alongside its binding by a caller that
 * needs one -- this signature only fixes the member shape's keys, not per-member recognition, which
 * a later work package's implementation composes from the shape and any per-member options passed
 * alongside it).
 */
function variant<const M extends Shape>(
  members: M,
  discriminant?: PropertyKey,
): VariantBinding<InferShape<M>[keyof M]>;

/** Build a {@link BridgeBinding} converting between a host type \`T\` and a wire-shaped \`D\` bound by \`wire\`. */
function bridge<T, D>(
  wire: BindingRef<D>,
  toWire: (value: T) => D,
  fromWire: (wire: D) => T,
): BridgeBinding<T, D>;

/**
 * Defer a binding until first use, closing a declaration-order cycle -- see {@link LazyBinding}'s
 * own doc for what this ports and why it is the only survivor of Java's cycle machinery.
 *
 * ### The ergonomics cliff
 *
 * A self-referential binding cannot be written as a single flat \`const\`, because TypeScript must
 * finish inferring an expression's type before that expression can refer to the variable it is
 * being assigned to:
 *
 * \`\`\`ts
 * // Does NOT typecheck:
 * const nodeBinding = record({
 *   fields: [
 *     field<Node, 'value'>(0, 'value', 'value', valueBinding),
 *     field<Node, 'next'>(1, 'next', 'next', lazy(() => nodeBinding)),
 *   ],
 *   construct: ([value, next]) => ({ value, next }) as Node,
 * });
 * // error TS7022: 'nodeBinding' implicitly has type 'any' because it is referenced
 * // directly or indirectly in its own initializer.
 * \`\`\`
 *
 * The fix is to give the binding an explicit type -- an interface plus a \`: Binding<X>\` (or
 * \`: RecordBinding<X>\`, etc.) annotation on the \`const\` -- *before* the initializer runs, so the
 * reference inside \`lazy(() => nodeBinding)\` resolves against a type already fully known rather
 * than one still being inferred:
 *
 * \`\`\`ts
 * interface NodeBinding extends RecordBinding<Node> {}
 *
 * const nodeBinding: NodeBinding = record({
 *   fields: [
 *     field<Node, 'value'>(0, 'value', 'value', valueBinding),
 *     field<Node, 'next'>(1, 'next', 'next', lazy((): Binding<Node> => nodeBinding)),
 *   ],
 *   construct: ([value, next]) => ({ value, next }) as Node,
 * });
 * \`\`\`
 *
 * This is the one authoring cost of deleting Java's reflection-driven cycle detection: Java
 * discovered the cycle at runtime, from a class graph that already fully existed; here the author
 * states it, once, at the one declaration that closes it.
 */
function lazy<T>(resolve: () => Binding<T>): LazyBinding<T>;

/**
 * Build a required {@link FieldSlot} reading/writing host property \`key\` directly -- \`wireName\` is
 * matched against the wire data (after any rename), \`key\` is the host property, and \`index\` is the
 * construction slot {@link RecordBinding.construct} expects this value at.
 */
function field<Host, K extends keyof Host & string>(
  index: number,
  wireName: string,
  key: K,
  binding: BindingRef<Host[K]>,
): FieldSlot<Host[K]>;

/**
 * {@link field}'s optional counterpart: \`required\` is \`false\`, and presence is derived from
 * \`host[key]\` being non-\`null\`/non-\`undefined\` -- the host-side analogue of \`DataClassField\`'s own
 * note that an optional field's accessor proxies through the host's own \`Optional\`/nullable slot
 * rather than this descriptor layer inventing a second notion of absence.
 */
function optional<Host, K extends keyof Host & string>(
  index: number,
  wireName: string,
  key: K,
  binding: BindingRef<NonNullable<Host[K]>>,
): FieldSlot<NonNullable<Host[K]>>;

/** Build a {@link BindingRegistry} from a fixed table of bindings keyed by schema type name. */
function registry(
  bindings: Readonly<Record<string, Binding<unknown>>>,
  options?: { readonly profile?: string },
): BindingRegistry;

/**
 * Compose several registries into one that tries each in turn, first match wins -- the port of
 * \`DefaultDataNameBinder\` trying each of its configured packages in order.
 */
function chain(...registries: readonly BindingRegistry[]): BindingRegistry;
\`\`\`

bind/index.ts then re-exports binding.js alongside your implementation modules, with no name collision because binding.ts no longer declares them.

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
      `${PORTER}

---

${pkg.brief}

Read CLAUDE.md first — its hard constraints are not suggestions. The contract layer under
packages/tson/src/{core,io,lexer/token,stream/event,ast,schema/meta,bind/binding,tree/nodes,value,reader,atom/contract}.ts
is FROZEN: import from it, never edit it. If one of those types is genuinely wrong, stop and say so.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test.

npm run test:conformance CANNOT pass in this wave and you are not expected to make it pass.
test/conformance/sidecar.ts's parseSidecar throws unconditionally until Wave 2 lands the data
parser, and the runner parses a sidecar before it looks at the subject, so all 146 vectors fail on
that single throw regardless of what you write. Run it anyway to confirm you have not made things
worse — the DISCOVERED count must stay 146 — then return vectorsGreen: [] and name the vectors
your package unblocks in notes. Do not implement sidecar parsing and do not modify
test/conformance/; that is work package 21's job in Wave 2.`,
      {
        label: `port:${pkg.key}`,
        phase: 'Port',
        model: 'sonnet',
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
6. Run typecheck, lint, format:check and the unit tests yourself. Then run the conformance suite
   and confirm the DISCOVERED count is still 146 — no vector can pass in this wave, but a drop in
   the discovered count means the harness was broken, which is blocking.

Report only problems you can point at a file and line for.`,
      { label: `verify:${pkg.key}`, phase: 'Verify', schema: VERDICT },
    );
  },
);

const landed = results.filter((r) => r !== null);
log(`Wave 1 complete: ${String(landed.length)}/${String(PACKAGES.length)} packages returned`);

return { wave: 1, results };
