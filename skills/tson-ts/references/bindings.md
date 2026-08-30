# `@ltr8/tson/bind` — object binding

Reading a document into your own types, and writing them back out.

**A `Binding` is authored, never derived.** The Java reference builds one by reflection over a
record class; there is no class analysis here, so you write the descriptor with combinators. That
also means a `Binding` is **independent of any schema** — it carries no field-state vocabulary, no
size or uniqueness facets, only what a binding alone can decide: which wire shape a kind expects,
whether a slot is required, and whether a wire name has a slot at all.

A `Binding<T>` is bidirectional by construction: the same descriptor decodes and encodes, which is
why the writers live in `@ltr8/tson/write` and never inside the compiler.

## The union

```ts
type Binding<T> =
  | AtomBinding<T>      // a scalar leaf; carries only a `wireType` label
  | RecordBinding<T>    // named fields
  | TupleBinding<T>     // fixed arity, positionally typed
  | ArrayBinding<T>     // variable length, one element type
  | MapBinding<T>       // key → value, keys are values too
  | VariantBinding<T>   // dispatches on the wire value's own !type-ref
  | AnnotatedBinding<T> // reads wire annotations back into the host box
  | BridgeBinding<T, D> // host type ⇄ a different wire type
  | LazyBinding<T>;     // breaks a recursive cycle

type Infer<B> = /* the host type a binding produces */;
```

`BindingBase` carries a phantom `unique symbol` key that no module outside the package can name, so
an object literal cannot structurally satisfy `Binding<T>` — the combinators are the only honest way
to build one.

## Combinators

```ts
import { record, field, optional, tuple, array, map, variant, bridge, lazy,
         registry, chain } from '@ltr8/tson/bind';

record<T>(options: RecordOptions<T>): RecordBinding<T>
tuple<const E extends readonly BindingRef<unknown>[]>(...): TupleBinding<...>
array<T, E>(options: ArrayOptions<T, E>): ArrayBinding<T>
map<T, K, V>(options: MapOptions<T, K, V>): MapBinding<T>
variant<const M extends Shape>(members): VariantBinding<...>
bridge<T, D>(wire, toWire, fromWire): BridgeBinding<T, D>
lazy<T>(resolve: () => Binding<T>): LazyBinding<T>

field<Host, K extends keyof Host & string>(index, wireName, key, binding): FieldSlot
optional<Host, K extends keyof Host & string>(index, wireName, key, binding): FieldSlot

registry(bindings: Record<string, Binding<unknown>>, options?: { profile?: string }): BindingRegistry
chain(...registries: readonly BindingRegistry[]): BindingRegistry   // first match wins
```

A `FieldSlot` keeps **three identities apart** that usually coincide: `index` (where the value goes
in the `construct` call), `wireName` (matched against the data, after any schema-level rename), and
`key` (the host property). A rename, or a host whose property names differ from the wire's, is
exactly where they diverge. `field`/`optional` exist so those closures are written once against a
real `Host` rather than by hand against `unknown`.

```ts
interface Person {
  readonly name: string;
  readonly age?: number;
}

const person = record<Person>({
  fields: [
    field<Person, 'name'>(0, 'name', 'name', TEXT_ATOM),
    optional<Person, 'age'>(1, 'age', 'age', INT_ATOM),
  ],
  construct: ([name, age]) =>
    age === undefined ? { name: name as string } : { name: name as string, age: age as number },
});
```

`RecordOptions` also takes `mutable`, `create` (for a mutable host built then populated), and
`annotationsCarrier` (a slot fed the record's own annotations, excluded from wire matching by
identity).

## Decoding and encoding

```ts
function fromDataValue<T>(binding, value: DataValue, decodeAtom?, fieldsFor?): T;
function fromCoreValue<T>(binding, value: CoreValue, decodeAtom?, fieldsFor?): T;
function toDataValue<T>(binding, value: T, encodeAtom?): DataValue;
function toCoreValue<T>(binding, value: T, encodeAtom?): CoreValue;

type AtomDecoder = (binding: AtomBinding<unknown>, wire: TokenValue) => unknown;
type AtomEncoder = (binding: AtomBinding<unknown>, value: unknown) => TokenValue;
```

Use `fromDataValue` at any position where framing might matter — it is what interprets `§3.1`
annotations and the `§3.2` `!type-ref`. `fromCoreValue` has no framing to read, so an
`AnnotatedBinding` or `VariantBinding` handed to it has nowhere to find its annotations or
discriminant: that is a caller error, not a document problem.

The complete round trip:

```ts
import { parse } from '@ltr8/tson';
import { fromDataValue } from '@ltr8/tson/bind';
import { writeBinding } from '@ltr8/tson/write';

const decodeAtom = (b, wire) => (b.wireType === 'int32' ? Number(wire.text) : wire.text);

const { document } = parse(bytes);
const value = fromDataValue(person, document.root, decodeAtom); // { name: 'Ada', age: 36 }
writeBinding(person, value); // '{ name: "Ada" age: 36 }'
```

Absent-field fallback order, when a bind-required field is not on the wire: `fieldsFor`'s own
`defaultFor` (a schema `REQUIRED_DEFAULT`/`REQUIRED_FIXED`), then the empty collection when the
field's binding is an array or a map ("absent and empty are the same list"), then a `TsonReadError`
— a scalar has nothing left to default to.

A record-shaped position with no record framing on the wire takes §5.6's positional form, via
`fieldsFor`'s `positionalField` or `inferPositionalField`'s own fallback.

## Strictness

```ts
function checkRecordBinding(...): void;   // does this binding cover its record type's fields?
function checkBinding(...): void;
```

That is a question about the **binding**, asked once when it is built. It is not a leniency knob for
reading: **records are closed under their type** (§7.2), so a wire field with no matching slot is
always `UNRECOGNIZED_FIELD`, never configurable.

Object-binding mode is **all-or-nothing**. Under a fail-fast receiver, a report throws and nothing
is assembled. Under a collecting receiver, a constructing binding hands back `undefined` cast to its
own `T` rather than a host value built from data already known to be wrong — check the diagnostics
before trusting the value.

## Two gaps to work around

- **No exported `atom()` combinator.** `AtomBinding` is deliberately inert — it carries a
  `wireType` label and nothing else, so `bind/` never has to depend on `atom/` — and no public
  function builds one. The package's own internal callers assert past the phantom key:

  ```ts
  function atom<T>(wireType: string): AtomBinding<T> {
    return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
  }
  ```

  Which token text a `wireType` maps to is your `AtomDecoder`/`AtomEncoder`'s job; the binding only
  names it.

- **`bindReader` cannot be driven from the published package.** `reader/bind.ts`'s `bindReader`
  adapts a `Binding` into a streaming `TypeReader`, and it is exported — but `createDataStream`,
  the event source it needs, is not exported from any entry point. Until that changes, use
  `fromDataValue` over a parsed AST, which buffers the document but is otherwise equivalent.
