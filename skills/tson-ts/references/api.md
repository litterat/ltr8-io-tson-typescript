# `@ltr8/tson` — export inventory

Every subpath, and what it exports. Signatures are as declared; TSDoc on the source is the
authority where this and the code disagree.

`exactOptionalPropertyTypes` is on throughout: an optional property is `readonly x?: T`, and an
absent one must be **omitted**, never assigned `undefined`.

---

## `@ltr8/tson` — the default entry

### The four front-door functions

```ts
function parse(source: Uint8Array, options?: ParseSourceOptions): ParsedDocument;
function parse(source: AsyncByteSource, options?: ParseSourceOptions): Promise<ParsedDocument>;

function readTree(source: Uint8Array, options?: ReadTreeOptions): Value;
function readTree(source: AsyncByteSource, options?: ReadTreeOptions): Promise<Value>;

function validate(source: Uint8Array, options?: ReadTreeOptions): ValidationResult;
function validate(source: AsyncByteSource, options?: ReadTreeOptions): Promise<ValidationResult>;

function write(value: Value, options?: WriteOptions): string;

function classifyDocument(source: Uint8Array): DocumentClassification;
function classifyDocument(source: AsyncByteSource): Promise<DocumentClassification>;
```

```ts
interface ParsedDocument {
  readonly document: Document; // ast/value.ts — the parse-preserving AST
  readonly positions: WeakMap<CoreValue, Position>; // each core value's own start position
}

type ReadTreeOptions = SchemaGovernedReadOptions | SchemalessReadOptions;

interface SchemaGovernedReadOptions extends NestingLimitOptions {
  readonly schema: CompiledSchema;
  readonly root: string; // the entry the ROOT value reads against
}

interface SchemalessReadOptions extends NestingLimitOptions {
  readonly schema?: undefined;
  readonly preserveUnknownTypeRefs?: boolean;
  readonly identifierPolicy?: NamePolicy; // §8.2 over names
  readonly tokenPolicy?: TokenPolicy; // §8.2 over values; scans nothing by default
}

interface ValidationResult {
  readonly value: Value; // missingNode('') when nothing could be read
  readonly diagnostics: readonly Diagnostic[]; // empty ⟺ the document conforms
}

interface WriteOptions {
  readonly id?: string; // writes !!id
  readonly schema?: string; // writes !!schema
}

type DocumentKind = 'data' | 'schema';
interface DocumentClassification {
  readonly kind: DocumentKind;
  readonly id?: string; // !!id, uninterpreted — not canonicalised, not syntax-checked
  readonly meta?: string; // !!meta — only for kind: 'schema'
}
```

`AsyncByteSource` is any `AsyncIterable<Uint8Array>`, which a web `ReadableStream<Uint8Array>`
satisfies. `write` has no async overload — a `Value` is already in memory.

### The tree model (also `@ltr8/tson/tree`)

```ts
type Value = RecordNode | MapNode | ArrayNode | TupleNode | AtomNode | AbsentNode | MissingNode;

interface RecordNode {
  kind: 'record';
  fields: ReadonlyMap<string, Value>;
  typeRef?: string;
  annotations: Annotations;
}
interface MapNode {
  kind: 'map';
  entries: readonly MapEntry[];
  typeRef?: string;
  annotations: Annotations;
}
interface ArrayNode {
  kind: 'array';
  elements: readonly Value[];
  typeRef?: string;
  annotations: Annotations;
}
interface TupleNode {
  kind: 'tuple';
  elements: readonly Value[];
  typeRef?: string;
  annotations: Annotations;
}
interface AtomNode {
  kind: 'atom';
  value: AtomValue;
  typeRef?: string;
  annotations: Annotations;
}
interface AbsentNode {
  kind: 'absent';
  typeRef?: string;
  annotations: Annotations;
}
interface MissingNode {
  kind: 'missing';
  path: string;
} // no typeRef, no annotations: it names a failed step

interface MapEntry {
  readonly key: Value;
  readonly value: Value;
} // re-exported as TreeMapEntry
// from the default entry, to
// avoid colliding with ast's own

interface TsonDocument {
  readonly id?: string;
  readonly schema?: string;
  readonly root: Value;
}
```

The `Node` suffix is a deliberate divergence from the Java (`TsonRecord`/`TsonMap`/…): `Record` is a
TypeScript global utility type and `Map`/`Array` are globals, so bare names would shadow them.

```ts
type AtomValue =
  | bigint
  | number
  | string
  | boolean
  | Uint8Array
  | TsonDecimal
  | Rational
  | Complex
  | PlainDate
  | PlainTime
  | PlainDateTime
  | TsonDuration
  | Ipv4Address
  | Ipv6Address
  | Cidr
  | Uuid
  | MacAddress;
```

Constructors: `recordNode`, `mapNode`, `arrayNode`, `tupleNode`, `atomNode`, `absentNode`,
`missingNode`, `tsonDocument`, plus the `ABSENT` constant.

Accessors — **all total, none throws**:

```ts
const get: (node: Value, key: string | number) => Value;
const at: (node: Value, pointer: string) => Value; // RFC 6901; '' is the node itself
const as: <T>(node: Value, guard: (v: unknown) => v is T) => T | undefined;
const asString: (node: Value) => string | undefined;
const asBoolean: (node: Value) => boolean | undefined;
const asDecimal: (node: Value) => TsonDecimal | undefined;
const asInt: (node: Value) => number | undefined; // converting, exactness-checked
const asLong: (node: Value) => bigint | undefined;
const asDouble: (node: Value) => number | undefined;
```

A malformed pointer (one not starting with `/`) yields a `MissingNode` carrying the offending text —
another deliberate divergence: `TsonValue.at` in the Java throws.

### The registry

```ts
function createTson(config?: Config): Tson;

interface Config extends NestingLimitOptions {
  readonly schemaSource?: SchemaSource;
  readonly identifierPolicy?: NamePolicy;   // §8.2 over names
  readonly tokenPolicy?: TokenPolicy;       // §8.2 over values; scans nothing by default
}

interface Tson {
  readonly config: Config;
  readonly schemas: ReadonlyMap<string, LinkedSchema>;   // keyed by canonical identity
  register(schema: LinkedSchema): void;
  resolveSchema(source: string | Uint8Array): LinkedSchema;  // synchronous; never fetches
  compile(schema: LinkedSchema): CompiledSchema;
  fetch(reference: string): Promise<Uint8Array>;             // raw bytes only
  preload(references: readonly string[]): Promise<void>;     // fetch+resolve+link+register, in order
  readonly processorPolicy: ProcessorPolicy;                 // §8.2 policy + UCD version, stated once
  parse/readTree/validate/write                              // bound to this instance's config
}

interface ProcessorPolicy {
  readonly identifierPolicy: NamePolicy;
  readonly tokenPolicy: TokenPolicy;
  readonly unicodeDataVersion: string;
}

interface SchemaSource { fetch(reference: string): Promise<Uint8Array> }

// An in-memory source, canonicalizing identity and raising a miss rather than returning undefined.
function mapSchemaSource(
  schemas: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>,
): SchemaSource;
```

`preload` is idempotent per reference (an already-registered one is never re-fetched), verifies any
declared `?sha256=` pin, and rejects a document whose own `!!id` is not the identity requested.

### The compile pipeline

```ts
function bootstrapMetaKernel(bytes: Uint8Array): Schema; // §1.5 — meta-kernel's !!meta names itself
function linkSchema(resolved: Schema, deps?: LinkDeps): LinkedSchema;

interface LinkedSchema {
  readonly id: string;
  readonly meta: string;
  readonly imports: readonly string[];
  readonly entries: ReadonlyMap<string, TypeDefinition>; // local + every import's, transitively
  readonly keyAnnotations: ReadonlyMap<string, Annotations>; // local declarations only
  readonly bootstrap: boolean;
  readonly origins: ReadonlyMap<string, string>; // entry name → home schema id (§2.2.3)
}

interface CompiledSchema {
  readonly linked: LinkedSchema;
  reader(name: string): TypeReader<Value>; // lazy, cached, cycle-safe
}
```

`reader(name)` throws `TsonInternalError` for a name the schema does not declare (linking already
rejected unresolved references) and `TsonNotImplementedError` for a well-formed entry this compiler
has no reader for yet.

### Also on the default entry

`Position`/`START`/`position`/`formatPosition`; every error class; `Diagnostic`,
`DiagnosticCode`, `DiagnosticsReceiver`, `collector()`, `throwing()`; `DEFAULT_MAX_NESTING_DEPTH`
and `NestingLimitOptions`; `Task`/`runSync`/`fromBytes`/`fromString`/`chunkInput` from `io/bytes`;
the `Token` and `TsonEvent` types; the `ast/value.ts` `Document`/`DataValue`/`CoreValue` family;
`Annotations`; the atom contract; the reader contracts (`TypeReader`, `ReadContext`,
`createReadContext`, `bindReader`, `schemalessTreeReader`, `lookupBuiltinAtom`); `value/types.ts`
(`TsonDecimal`, `Rational`, `Complex`, `PlainDate`, `PlainTime`, `PlainDateTime`, `TsonDuration`,
`Ipv4Address`, `Ipv6Address`, `Cidr`, `Uuid`, `MacAddress`, and the width aliases `Int8`…`Uint256`);
and everything from `@ltr8/tson/write`.

---

## `@ltr8/tson/write`

```ts
// The tree/nodes.ts Value model
function writeTree(document: TsonDocument): string;
function writeTreeValue(value: Value): string;
function writeTreeTo(document: TsonDocument, out: Emitter): void;
function writeTreeValueTo(value: Value, out: Emitter): void;
function writeTreeToSink(document: TsonDocument, sink: TextSink): void;

// The parse-preserving ast/value.ts model — reproduces the ORIGINAL token choices
function writeDocument(document: Document): string;
function writeDataValue(value: DataValue): string;
function writeDocumentTo / writeDataValueTo / writeDocumentToSink

// A bound host object graph
function writeBinding<T>(binding: BindingRef<T>, value: T, encodeAtom?: AtomEncoder): string;
function writeBindingTo / writeBindingToSink

function createEmitter(sink: TextSink): Emitter;
function stringSink(): { sink: TextSink; result: () => string };
function formatKnownAtom(typeRef: string, value: unknown): AtomText | undefined;
function formatDefaultAtom(value: AtomValue): AtomText;
```

**Canonical form and readable form are the same call** — one space between elements, vocabulary
atoms always quoted, numeric atoms always bare. There is no "pretty" mode, which is what makes the
output byte-stable enough to hash (§2.2.1).

`writeDocument`/`writeDataValue` are the exception: they reproduce a _parsed_ document's own quoting
and field order rather than normalising, which is what round-trip tests need — and exactly why they
are **not** the writers to take a content hash over.

---

## `@ltr8/tson/schema`

The §8 resolver output as a value model: `TypeDefinition` and its bodies (`schema/meta/typedef.ts`,
`bodies.ts`, `algebra.ts`, the four atom families, and `position.ts`). It **names no compiler type**,
which is what lets the schema model ship to a browser that never compiles a schema.

---

## `@ltr8/tson/identity`

```ts
function contentStart(bytes: Uint8Array): number;          // first byte past the !!id line
function sha256Hex(bytes: Uint8Array): Promise<string>;
function declaredSha256(reference: string): string | undefined;
function verifyContentHash(bytes: Uint8Array, reference: string): Promise<void>;
function withSha256Pin(reference: string, hex: string): string;

function canonicalizeIdentity(reference: string): string;  // scheme and query stripped
function sameIdentity(a: string, b: string): boolean;
function validateIdentity(reference: string): void;

class TsonContentHashMismatchError; class TsonSchemaValidationError;
```

`crypto.subtle` is the only platform API involved — a global in Node 24 and every browser — so this
subpath is not Node-only.

---

## `@ltr8/tson/stdlib`

```ts
function standardLibrary(config?: Config): Tson; // createTson + registerStandardLibrary
function registerStandardLibrary(tson: Tson): Tson; // returns the same instance, for chaining
const META_KERNEL_TN: string;
const META_TN: string;
const CORE_TN: string;
```

**No I/O on any platform** — the three documents are string constants generated from `spec/m/`, not
files read at run time. Registration order is the algorithm: kernel (bootstrapped, then re-resolved
under its own output), then `meta.tn`, then `core.tn`.

---

## `@ltr8/tson/source` — Node only

```ts
function httpSchemaSource(options?: HttpSchemaSourceOptions): HttpSchemaSource;
interface HttpSchemaSourceOptions {
  readonly allowHosts?: readonly string[]; // nothing is fetched without this
  readonly mapHosts?: Readonly<Record<string, string>>;
  readonly maxDocumentBytes?: number;
  readonly timeoutMs?: number;
  readonly maxCachedSchemas?: number;
  readonly requireContentHashPin?: boolean;
}

function fileSchemaSource(options?: FileSchemaSourceOptions): FileSchemaSource;
interface FileSchemaSourceOptions {
  readonly mapHosts?: Readonly<Record<string, string>>; // host → directory; nothing read until set
  readonly maxDocumentBytes?: number;
  readonly maxCachedSchemas?: number;
  readonly requireContentHashPin?: boolean;
}

function permittedReference(reference: string, requireContentHashPin: boolean): PermittedReference;
// PermittedReference: { canonical, host, path }
```

Plus `HTTP_DEFAULT_MAX_DOCUMENT_BYTES`, `FILE_DEFAULT_MAX_DOCUMENT_BYTES`, `DEFAULT_TIMEOUT_MS`,
`HTTP_DEFAULT_MAX_CACHED_SCHEMAS`, `FILE_DEFAULT_MAX_CACHED_SCHEMAS`.

Neither source verifies a `?sha256=` pin or cross-checks a fetched document's `!!id` — that stays
the loader's job (`Tson.preload` does both).

---

## `@ltr8/tson/regex`

```ts
function parseRegex(pattern: string): Regex; // throws TsonRegexSyntaxError
interface Regex {
  readonly pattern: string;
  readonly ast: RegexNode;
  matches(input: string): boolean; // RFC 9485 §3 full-match, linear time, no ReDoS
  isDisjointFrom(other: Regex): boolean; // exact, never "unknown"
}
function parseIRegex(pattern: string): RegexNode;
function toCodePoints(text: string): readonly number[];
```

A true leaf: it names no TSON type and imports nothing outside itself. Anything outside the
interoperable subset (`\d`/`\w`/`\s`, class subtraction, captures, back-references, lookaround,
Unicode blocks, non-greedy quantifiers) is a syntax error, not a silent acceptance.
`\p{…}`/`\P{…}` resolves against checked-in Unicode tables, never a host regex engine.

`isDisjointFrom` is **not** [TSON-SCHEMA] §5.4's choice disjointness, which is discrimination-class
distinctness and forbids proving more; this answers the narrower question for a schema author
reasoning about their own patterns.

---

## Known API gaps

Real, and worth knowing before you write around them:

- **`NamePolicy`/`TokenPolicy` and their `with*` helpers are not exported.**
  `Config.identifierPolicy` and `Config.tokenPolicy` are public, but the type names and
  `withRestrictionLevel`/`perSegment`/`permitting`/`DEFAULT_NAME_POLICY` are not reachable from any
  entry point. Write the policy as an object literal (every field is required). `scriptNamed` and
  `scriptName` _are_ exported, because building a `permittedScripts` combination means resolving a
  script a caller names as text to the `ScriptId` this build assigns it.
- **`createDataStream` is not exported**, so `bindReader` — which needs an event source — cannot be
  driven from the published package. Use `@ltr8/tson/bind`'s `fromDataValue`/`fromCoreValue` over a
  parsed AST instead.
- **There is no exported `atom()` binding combinator.** See `bindings.md`.
- **Use-site naming (§8.3) is not implemented.** A diagnostic names the entry a reference resolves
  to, not the alias written at the position — `c: pct` where `pct => small` reports `'small'`.
- **A data document's annotations are preserved but never resolved (§6).** An unknown `@annotation`
  on data, or one whose value does not match its declared type, passes. The schema side does
  enforce this.
