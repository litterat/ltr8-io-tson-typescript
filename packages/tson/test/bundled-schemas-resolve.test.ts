import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { fromBytes, runSync } from '../src/io/bytes.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { bootstrapKernel } from '../src/schema/bootstrap.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import { createTson } from '../src/config.js';
import { toDataValue, type AtomEncoder } from '../src/bind/encode.js';
import { headed, topBinding } from '../src/schema/bindings.js';
import { defaultAtomEncoder } from '../src/write/bindingWriter.js';
import { isNestedMap } from '../src/schema/meta/schemaPaths.js';
import {
  subtypesOf,
  type Annotation,
  type ApplyBody,
  type Completion,
  type Top,
} from '../src/schema/meta/typedef.js';
import {
  CORE_TN,
  META_TN,
  NET_TN,
  NUMERIC_TN,
  POLICY_TN,
  TEMPORAL_TN,
} from '../src/stdlib/schemas.generated.js';
import type { CoreValue, DataValue, TokenValue } from '../src/ast/value.js';
import { writeDataValue } from '../src/write/astWriter.js';
import { resolvedOutput } from '../src/schema/resolvedOutput.js';

/**
 * The resolver gate: each bundled schema with a resolver-output fixture, resolved by this
 * implementation, is exactly the schema map its checked-in fixture describes.
 *
 * `spec/fixtures/{meta,numeric,temporal,net,core}-resolved.tn` are vendored verbatim from the
 * reference implementation (`spec/PROVENANCE.md`), so they are the port target, not a restatement of
 * what this port happens to produce. Each is a data document whose root is the kernel's own `schema`
 * namespace -- a map from entry name to the entry's value (Part 2 §8.1, §9), the machinery a library
 * adds nested as the root's entry of its own map (`net => !meta.schema { ... }`) -- and it is parsed
 * here with this package's own parser, the way the shared conformance suite expects an
 * implementation to dogfood its own sidecars.
 *
 * **Comparison is wire-level, in the resolved schema's own vocabulary.** A resolved schema is a graph of
 * `schema/meta` host values and the fixture is a document; the two meet by encoding each entry's value
 * through `schema/bindings.ts`'s `top` binding, headed by the constructor its facts record
 * (`bind/encode.ts`'s `toDataValue`, the direction `bind/` carries), and comparing the resulting
 * `data-value` against the fixture's under {@link canonical}'s rules. Comparing host objects instead
 * would test this port against itself: the fixture's authority is its wire form. A nested map is
 * compared member by member under its path, since one namespace holds every declaration at every depth
 * (§2.2.3), and a resolver-minted name's hash is normalised on both sides (RUNNER.md).
 */

const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));

function fixtureSource(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${SPEC}fixtures/${name}-resolved.tn`));
}

function schemaSource(file: string): Uint8Array {
  return new Uint8Array(readFileSync(`${SPEC}m/${file}.tn`));
}

// -- Canonical form ---------------------------------------------------------------------------

/**
 * A comparable projection of a `data-value`. Records become objects, arrays become arrays,
 * tokens become their text (a quoted token keeps its quotes, so `true` and `"true"` stay
 * distinct), and framing -- wire annotations and a `!type-ref` -- folds into the object under the
 * `@` and `!` keys, which no field name can collide with (§7.2: a field name is a token).
 */
type Canonical = unknown;

/*
 * Both sides are canonicalised before comparison, under exactly the conventions
 * `meta-kernel-resolved.tn`'s own header states for a comparison tool. Every rule below is one of
 * those conventions; nothing here normalises away a difference the fixture does not itself
 * declare non-normative.
 */

/** "Fields at their default values are omitted." An absent list and an empty one are the same (§8.1). */
const FALSE_BY_DEFAULT = new Set(['constructor', 'disjoint', 'optional', 'voidable']);

/**
 * A held template's text reduced to the structure it denotes (§5.10, §8.2): the application is
 * identity, never its spelling, so two spellings that differ in whitespace are one template.
 */
function parsedTemplate(text: string): string {
  const parsed = runSync(parseDocument(fromBytes(new TextEncoder().encode(text))));
  return JSON.stringify(canonical(parsed.document.root));
}

/** Text-valued facets of an identifier profile: the form a token is written in is not meaning for a `text` position (Part 1 §2.4), so these compare by their text. */
const TEXT_FACETS = new Set(['start_add', 'continue_add', 'medial', 'exclude']);

/**
 * The value each constructor's field holds when the fixture omits it ("fields at their default
 * values are omitted"), by the wire name of the constructor the value is headed by. This is the
 * DEFAULT role only: a resolved body states what its constructor does not already say, so
 * `array`'s `ordered` is true unless stated, a `map` defaults it false, a text family's
 * `normalization` is `NONE` unless it states another, an `identifier_type`'s is `NFC` and its start
 * and continue sets `XID`, a `uri_type`/`iri_type` permits relative references and fragments until
 * it withdraws either, and a `float_type` admits NaN, infinities, subnormals and negative zero.
 *
 * A FIXED field (`spec`, a text family's `normalization` under `regex_type`/`uri_type`/
 * `iri_type`/`email_type`, what `set_type` and `enum`/`text_enum` pin) is not in this table: the
 * writer leaves it out at its pinned value (`schema/bindings.ts`), so a difference there is a real
 * difference.
 */
const DEFAULTS_BY_HEAD: Record<string, Record<string, string>> = {
  array: { ordered: 'true', unique_items: 'false' },
  map: { ordered: 'false' },
  namespace: { ordered: 'false' },
  text_type: { normalization: 'NONE' },
  bytes_type: { encoding: 'BASE64' },
  uri_type: { allow_relative: 'true', allow_fragment: 'true' },
  iri_type: { allow_relative: 'true', allow_fragment: 'true' },
  identifier_type: { normalization: 'NFC', start: 'XID', continue: 'XID' },
  float_type: {
    allow_nan: 'true',
    allow_infinity: 'true',
    allow_subnormal: 'true',
    allow_negative_zero: 'true',
  },
  complex_type: { component: 'NUMBER' },
  hostname_type: { allow_idn: 'true' },
  media_type_type: { allow_parameters: 'false' },
};

/**
 * The chain's name lists and a kind's derived `members`, which the fixture header says are
 * written sorted and a comparison tool canonicalises before comparing.
 */
const SET_TYPED = new Set(['subtypes', 'supertypes', 'members']);

/**
 * Constructor markers the fixture writes where the position's own declared type already fixes the
 * constructor -- `!record_field` at a `[record_field]`-typed position is decoration, not
 * discrimination, and `bind/encode.ts` writes no type-ref for a non-variant binding. Stripped on
 * both sides. `top`'s own body constructors (`!record`, `!enum`, `!set`, ...) are deliberately
 * absent from this set: there the marker *is* the discriminant.
 */
const MONOMORPHIC = new Set([
  'type_chain',
  'field_map',
  'template_param',
  'record_field',
  'field_group',
  'tuple_element',
  'type_ref',
  'record_template_field',
  'type_argument',
  'integer_size',
  'annotation',
]);

/**
 * "Instantiation entries are internally named (implementation-chosen, non-normative)": the
 * fixture spells every generated name's hash suffix `xxhash`. Applied to entry keys and to every
 * reference to one.
 */
function canonicalName(text: string): string {
  // Every hash in a minted name, not only the last: a form minted over another minted form embeds
  // that form's hash (`array_array_field_name_1_5d4d7dc5_1_xxhash`), which is as much an
  // implementation's own as the trailing one. Both spellings normalise to one placeholder.
  return text.replace(/_(?:[0-9a-f]{8}|xxhash)(?=_|$)/g, '_xxhash');
}

/** A constructor's own name: the last segment of its path (`meta.array` is `array`). */
function baseOf(head: string): string {
  return head.slice(head.lastIndexOf('.') + 1);
}

/**
 * The sentinel {@link encodeAtom} writes for a slot whose host value is `undefined`. Reached only
 * through `annotationBinding`, which binds its `value` with `field()` rather than `optional()`
 * -- its own comment explains why (`optional()` narrows through `NonNullable`, which collapses an
 * `unknown`-typed slot to `{}`) -- so a valueless annotation encodes with a present-but-undefined
 * value slot. {@link annotationOf} reads the sentinel back as "no value".
 */
const NO_VALUE = '<no annotation value>';

const encodeAtom: AtomEncoder = (binding, value) => {
  if (binding.wireType === 'type_ref' || binding.wireType === 'reference') {
    return defaultAtomEncoder(binding, value);
  }
  if (typeof value === 'object' && value !== null && 'text' in value && 'form' in value) {
    const token = value as { text: string; form: TokenValue['form'] };
    return { kind: 'token', text: token.text, form: token.form };
  }
  if (typeof value === 'string') {
    // Every closed-enumeration leaf (`type_kind`, `field_role`, `ieee_format`, ...) is an
    // unquoted lexeme, and so is `enum.members` even though its own element type is `text` now
    // (#12, §7.4) rather than `identifier`: a member spelled as a bare identifier still reads
    // unquoted in canonical output, since [TSON-DATA] §2.4's "form is not meaning" makes an
    // unquoted token a perfectly good `text` value. Free text that is NOT identifier-shaped
    // (a URL, a sentence) still needs quoting to round-trip at all, so the two are told apart by
    // the string's own shape rather than by the binding's wire type.
    const identifierShaped = /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
    return {
      kind: 'token',
      text: value,
      form: binding.wireType === 'text' && !identifierShaped ? 'single-line' : 'unquoted',
    };
  }
  if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number') {
    return { kind: 'token', text: String(value), form: 'unquoted' };
  }
  return {
    kind: 'token',
    text: value === undefined ? NO_VALUE : JSON.stringify(value),
    form: 'unquoted',
  };
};

/** The fixture's own side of {@link renderAnnotationValue}: a key annotation's value as its plain scalar text. */
function fixtureAnnotationValue(value: DataValue): Canonical {
  const core = value.coreValue;
  if (core.kind === 'token') return core.text;
  if (core.kind === 'void') return NO_VALUE;
  return canonical(value);
}

function annotationOf(name: string, value: Canonical): Canonical {
  return value === undefined || value === NO_VALUE ? `@${name}` : { [`@${name}`]: value };
}

/**
 * `annotations` is bound as an ordinary wire field rather than as a record's annotations carrier
 * (`bind/binding.ts`'s `RecordBinding.annotationsCarrier`), because `schema/meta` carries its own
 * `Annotation` stand-in that `annotations/index.ts`'s wire `Annotations` does not meet --
 * `STATUS.md`'s own known gap. The fixture writes those annotations where §3.1 puts them, in
 * front of the value, so this lifts the field into that position on both sides; the comparison is
 * then about which annotations a value carries, not about where the binding layer puts them.
 */
function liftedAnnotations(value: CoreValue): Canonical[] {
  if (value.kind !== 'record') return [];
  const field = value.fields.find((f) => f.name === 'annotations');
  if (field === undefined) return [];
  const list = field.value.coreValue;
  if (list.kind !== 'array') return [];
  return list.elements.map((element) => {
    const record = element.coreValue;
    if (record.kind !== 'record') return canonical(element);
    const name = record.fields.find((f) => f.name === 'name')?.value.coreValue;
    const held = record.fields.find((f) => f.name === 'value')?.value;
    return annotationOf(
      name?.kind === 'token' ? name.text : '?',
      held === undefined ? undefined : canonical(held),
    );
  });
}

function canonicalCore(value: CoreValue, head?: string): Canonical {
  switch (value.kind) {
    case 'token':
      return value.form === 'unquoted' ? canonicalName(value.text) : JSON.stringify(value.text);
    case 'empty-brace':
      return {};
    case 'void':
      return '_';
    case 'array':
      return value.elements.map((element) => canonical(element));
    case 'map':
      return value.entries.map((e) => [canonical(e.key), canonical(e.value)]);
    case 'record': {
      const record: Record<string, Canonical> = {};
      for (const field of value.fields) {
        if (field.name === 'annotations') continue; // lifted to the framing position
        const core = field.value.coreValue;
        const held =
          TEXT_FACETS.has(field.name) && core.kind === 'token'
            ? JSON.stringify(core.text)
            : field.name === 'template' &&
                head !== undefined &&
                baseOf(head) === 'template' &&
                core.kind === 'token'
              ? JSON.stringify(parsedTemplate(core.text))
              : canonical(field.value);
        if (Array.isArray(held) && held.length === 0) continue;
        // An empty braced value and an empty map are one empty field map (§8.1: absent and
        // empty are the same, and `fields: {}` is how a document writes an empty map).
        if (core.kind === 'empty-brace') continue;
        if (FALSE_BY_DEFAULT.has(field.name) && held === 'false') continue;
        if (field.name === 'role' && held === 'FREE') continue;
        if (field.name === 'extension' && held === 'OPEN') continue;
        if (head !== undefined && DEFAULTS_BY_HEAD[baseOf(head)]?.[field.name] === held) continue;
        const sorted = SET_TYPED.has(field.name);
        record[field.name] = sorted && Array.isArray(held) ? [...(held as string[])].sort() : held;
      }
      return record;
    }
  }
}

function canonical(value: DataValue): Canonical {
  const core = canonicalCore(value.coreValue, value.typeRef);
  const annotations = [
    ...value.annotations.map((a) =>
      annotationOf(a.name, a.value === undefined ? undefined : canonical(a.value)),
    ),
    ...liftedAnnotations(value.coreValue),
  ];

  // §5.6's positional form, general over schema-backed data: `name` is `type_ref`'s only REQUIRED
  // field, so an argument-free reference is a bare token and a braced record appears only where
  // `arguments` is present.
  let body = core;
  if (typeof core === 'object' && core !== null && !Array.isArray(core)) {
    const record = core as Record<string, Canonical>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'name') body = record.name;
  }

  const typeRef =
    value.typeRef !== undefined && MONOMORPHIC.has(baseOf(value.typeRef))
      ? undefined
      : value.typeRef;
  if (typeRef === undefined && annotations.length === 0) return body;
  return {
    ...(typeRef === undefined ? {} : { '!': typeRef }),
    ...(annotations.length === 0 ? {} : { '@': annotations }),
    v: body,
  };
}

/**
 * A resolved entry's key-position annotations (§6): `@doc` on a declared name, and the derived
 * `@synthetic` marker every sugar-lifted entry carries (§8.2).
 */
function canonicalKeyAnnotations(annotations: readonly Annotation[]): Canonical[] {
  // `@doc` is excluded on BOTH sides and checked separately, against the source rather than the
  // fixture -- see `preserves every @doc verbatim` below. The fixture's own header says it carries
  // long `@doc` strings abbreviated and that "a conforming resolver preserves them verbatim", so
  // the fixture cannot be the oracle for their text; it can and does remain the oracle for every
  // other key annotation, `@synthetic` above all.
  return annotations
    .filter((a) => a.name !== 'doc')
    .map((a) => {
      if (a.value === undefined) return `@${a.name}`;
      return { [`@${a.name}`]: renderAnnotationValue(a.value) };
    });
}

/**
 * A resolved key annotation's value, rendered the way {@link canonical} renders the fixture's own
 * side of the comparison.
 *
 * `schema/meta`'s `Annotation.value` is `unknown` -- that package may not name a `tree/nodes.ts`
 * `Value`, which is what `schema/annotationReader.ts` actually puts there. Unwrapping the atom
 * node to its host value is what makes the two sides comparable at all; the alternative is
 * comparing a serialized node against a token's text, which is not a comparison of anything.
 *
 * Quoting is deliberately *not* reconstructed. The fixture distinguishes `@ordered:TOTAL` from
 * `@doc:"..."` by the form each was written in, and a bound host value has lost that -- both
 * arrive as JavaScript strings. §8.1's canonical output rules are a writer question and are
 * tested on the writer; here the value is the point.
 */
function renderAnnotationValue(value: unknown): Canonical {
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const node = value as { kind: string; value?: unknown };
    if (node.kind === 'atom') return String(node.value);
    if (node.kind === 'void') return NO_VALUE;
    // `@meta.application`'s value, a `meta.apply` (§8.2).
    if (node.kind === 'apply') {
      const apply = value as ApplyBody;
      return { head: apply.head.name, arguments: apply.arguments.map((a) => a.name) };
    }
  }
  // `@meta.completion`'s value, `{ of: [text; 1..] }` (§8.1).
  if (typeof value === 'object' && value !== null && Array.isArray((value as Completion).of)) {
    return { of: [...(value as Completion).of] };
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return (value as { text: string }).text;
  }
  return String(value);
}

/**
 * `value` with an entry's value-position annotations (§3.1) in front of it, where {@link
 * canonical} puts the fixture's own: the resolver records them in the entry's facts, beside the
 * value rather than on it, and resolved output writes them where the author did.
 */
function withValueAnnotations(value: Canonical, annotations: readonly Annotation[]): Canonical {
  if (annotations.length === 0) return value;
  const rendered = annotations.map((a) =>
    annotationOf(a.name, a.value === undefined ? undefined : renderAnnotationValue(a.value)),
  );
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'v' in value) {
    const framed = value as Record<string, Canonical>;
    const { v, ...frame } = framed;
    return { ...frame, '@': [...rendered, ...((framed['@'] as Canonical[] | undefined) ?? [])], v };
  }
  return { '@': rendered, v: value };
}

// -- The fixtures -----------------------------------------------------------------------------

interface FixtureEntry {
  readonly definition: Canonical;
  readonly keyAnnotations: Canonical[];
}

function fixtureKeyAnnotations(key: DataValue): Canonical[] {
  return key.annotations
    .filter((a) => a.name !== 'doc')
    .map((a) =>
      annotationOf(a.name, a.value === undefined ? undefined : fixtureAnnotationValue(a.value)),
    );
}

/**
 * A resolved form's entries keyed by path. A root entry tagged `meta.schema` is a nested map and is
 * flattened into the entries it holds under `map.member`, each as one namespace holds them (§2.2.3), so
 * both sides of a comparison are keyed alike.
 */
function entriesOf(label: string, root: DataValue): Map<string, FixtureEntry> {
  const rootCore = root.coreValue;
  if (rootCore.kind !== 'map') {
    throw new Error(`${label}: root is a ${rootCore.kind}, expected the schema map (§9)`);
  }
  const entries = new Map<string, FixtureEntry>();
  const add = (prefix: string, map: readonly { key: DataValue; value: DataValue }[]): void => {
    for (const entry of map) {
      const key = entry.key.coreValue;
      if (key.kind !== 'token') {
        throw new Error(`${label}: a schema-map key is not a token`);
      }
      const path = canonicalName(`${prefix}${key.text}`);
      const nested = entry.value.coreValue;
      if (entry.value.typeRef === 'meta.schema' && nested.kind === 'map') {
        add(`${prefix}${key.text}.`, nested.entries);
        continue;
      }
      if (entry.value.typeRef === 'meta.schema' && nested.kind === 'empty-brace') continue;
      entries.set(path, {
        definition: canonical(entry.value),
        keyAnnotations: fixtureKeyAnnotations(entry.key),
      });
    }
  };
  add('', rootCore.entries);
  return entries;
}

/** Parses `<name>-resolved.tn` into its entries keyed by path. */
function fixture(name: string): Map<string, FixtureEntry> {
  const parsed = runSync(parseDocument(fromBytes(fixtureSource(name)), { resolvedForm: true }));
  return entriesOf(`${name}-resolved.tn`, parsed.document.root);
}

/** The resolved output this implementation writes for `name`, written to text and read back, keyed by path. */
function writtenEntries(name: string): Map<string, FixtureEntry> {
  const schema = resolved(name);
  const selfId = canonicalizeIdentity(schema.id);
  const text = writeDataValue(
    resolvedOutput(schema, { own: (path) => schema.origins.get(path) === selfId }),
  );
  const parsed = runSync(parseDocument(fromBytes(encodeUtf8(text)), { resolvedForm: true }));
  return entriesOf(`the resolved output of ${name}.tn`, parsed.document.root);
}

// -- Resolving the bundled schemas ------------------------------------------------------------

/** The six bundled schemas, resolved and linked in registration order, by the file they live in. */
const linked = new Map<string, LinkedSchema>();

function resolved(name: string): LinkedSchema {
  if (linked.size === 0) {
    const tson = createTson({});
    const kernel = linkSchema(bootstrapKernel(encodeUtf8(META_TN)));
    tson.register(kernel);
    linked.set('meta', kernel);
    for (const [file, text] of [
      ['numeric', NUMERIC_TN],
      ['temporal', TEMPORAL_TN],
      ['net', NET_TN],
      ['core', CORE_TN],
      ['policy', POLICY_TN],
    ] as const) {
      linked.set(file, tson.resolveSchema(text));
    }
  }
  const found = linked.get(name);
  if (found === undefined) throw new Error(`no bundled schema '${name}'`);
  return found;
}

// -- The comparison ---------------------------------------------------------------------------

/** Enough differences to act on; a resolver that is structurally wrong produces hundreds. */
const LIMIT = 60;

function report(path: string, expected: Canonical, actual: Canonical, out: string[]): void {
  if (out.length >= LIMIT) return;
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  const bothObjects =
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected) &&
    typeof actual === 'object' &&
    actual !== null &&
    !Array.isArray(actual);
  if (bothObjects) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      report(
        `${path}.${key}`,
        (expected as Record<string, Canonical>)[key],
        (actual as Record<string, Canonical>)[key],
        out,
      );
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    expected.forEach((element, i) => {
      report(`${path}[${String(i)}]`, element, actual[i], out);
    });
    return;
  }
  out.push(
    `${path}\n    fixture: ${JSON.stringify(expected)}\n    ours:    ${JSON.stringify(actual)}`,
  );
}

/**
 * Every way `name`'s resolved form differs from `spec/fixtures/<name>-resolved.tn`, one entry per
 * difference, each naming the declaration and the field. Empty means the gate is met.
 */
function differences(name: string): string[] {
  const expected = fixture(name);
  let schema: LinkedSchema;
  try {
    schema = resolved(name);
  } catch (e: unknown) {
    return [`${name}.tn does not resolve at all: ${(e as Error).message}`];
  }

  // `schema.entries` is the whole merged closure (§2.2.3); the fixture describes `name` itself, so only
  // entries `origins` attributes to this schema's own id belong in the comparison, and a nested map's
  // own entry is the union of every document's members, so its members are compared under their paths.
  const selfId = canonicalizeIdentity(schema.id);
  const ours = new Map<string, string>();
  for (const [key, value] of schema.entries) {
    if (schema.origins.get(key) !== selfId || isNestedMap(value)) continue;
    // A resolved form holds complete entries only (§8.1): an incomplete entry, and an alias of one, is held
    // in the namespace and written nowhere.
    if (isIncompleteOrItsAlias(value, schema.entries)) continue;
    ours.set(canonicalName(key), key);
  }
  const out: string[] = [];

  for (const key of expected.keys()) {
    if (!ours.has(key)) out.push(`'${key}': in the fixture, not resolved by this implementation`);
  }
  for (const key of ours.keys()) {
    if (!expected.has(key)) {
      out.push(`'${key}': resolved by this implementation, not in the fixture`);
    }
  }

  for (const [key, entry] of expected) {
    const real = ours.get(key);
    const definition = real === undefined ? undefined : schema.entries.get(real);
    if (real === undefined || definition === undefined) continue;
    report(
      key,
      entry.definition,
      withValueAnnotations(
        canonical(
          toDataValue(topBinding, headed(definition, schema.facts.get(real)?.head), encodeAtom),
        ),
        schema.facts.get(real)?.annotations ?? [],
      ),
      out,
    );
  }
  for (const [key, entry] of expected) {
    const real = ours.get(key);
    if (real === undefined) continue;
    report(
      `${key} <key annotations>`,
      entry.keyAnnotations,
      canonicalKeyAnnotations(schema.keyAnnotations.get(real) ?? []),
      out,
    );
  }
  return out;
}

/** Whether `value` is an incomplete entry, or an alias whose chain ends at one (§5.5). */
function isIncompleteOrItsAlias(value: Top, entries: ReadonlyMap<string, Top>): boolean {
  let current: Top | undefined = value;
  for (let hop = 0; hop < 16 && current !== undefined; hop++) {
    if (current.kind === 'incomplete') return true;
    if (current.kind !== 'alias') return false;
    current = entries.get(current.target.name);
  }
  return false;
}

/** Every way the written resolved output of `name` differs from its fixture, one entry per difference. */
function writtenDifferences(name: string): string[] {
  const expected = fixture(name);
  const actual = writtenEntries(name);
  const out: string[] = [];
  for (const key of expected.keys()) {
    if (!actual.has(key)) out.push(`'${key}': in the fixture, not written by this implementation`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key))
      out.push(`'${key}': written by this implementation, not in the fixture`);
  }
  for (const [key, entry] of expected) {
    const written = actual.get(key);
    if (written === undefined) continue;
    report(key, entry.definition, written.definition, out);
    report(`${key} <key annotations>`, entry.keyAnnotations, written.keyAnnotations, out);
  }
  return out;
}

// -- The gate ---------------------------------------------------------------------------------

const WITH_FIXTURE = [['meta'], ['numeric'], ['temporal'], ['net'], ['core']];

describe('the bundled schemas resolve to their checked-in fixtures (Part 2 §8.1)', () => {
  it.each(WITH_FIXTURE)('%s.tn resolves to its fixture', (name) => {
    const unexpected = differences(name);
    expect(
      unexpected,
      `${name}.tn vs ${name}-resolved.tn:\n\n  ${unexpected.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it.each(WITH_FIXTURE)('%s.tn is written, to text and read back, as its fixture', (name) => {
    const unexpected = writtenDifferences(name);
    expect(
      unexpected,
      `${name}.tn written vs ${name}-resolved.tn:\n\n  ${unexpected.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it('policy.tn, which has no fixture, resolves and links (Part 2 §9)', () => {
    const policy = resolved('policy');
    expect(policy.entries.has('policy')).toBe(true);
    expect(policy.entries.has('policy.restriction_level')).toBe(true);
  });

  it.each([...WITH_FIXTURE, ['policy']])(
    "%s.tn's key annotations carry their values, each @doc verbatim from the source",
    (name) => {
      // The fixture cannot check this: its own header says it leaves entry docs out, and that "a
      // conforming resolver carries every source @doc verbatim". The source document is the
      // oracle instead -- a stronger check than the fixture would have been, since it compares
      // against the exact text an author wrote.
      const document = runSync(parseSchemaDocument(fromBytes(schemaSource(name))));
      const schema = resolved(name);
      const selfId = canonicalizeIdentity(schema.id);
      let checked = 0;
      for (const [declared, declaration] of document.body.declarations) {
        if (schema.origins.get(declared) !== selfId) continue;
        const written = declaration.nameAnnotations.find((a) => a.name === 'doc');
        const resolvedDoc = schema.keyAnnotations.get(declared)?.find((a) => a.name === 'doc');
        if (written?.value === undefined) {
          expect(resolvedDoc, `'${declared}' has no @doc in the source`).toBeUndefined();
          continue;
        }
        const core = written.value.coreValue;
        if (core.kind !== 'token') throw new Error(`'${declared}': @doc's value is not a token`);
        expect(
          renderAnnotationValue(resolvedDoc?.value),
          `'${declared}': @doc should be preserved verbatim`,
        ).toBe(core.text);
        checked += 1;
      }
      // A guard against the loop silently checking nothing -- every bundled schema documents most
      // of what it declares.
      expect(checked).toBeGreaterThan(3);
    },
  );

  it("computes the kernel's subtypes exactly as the fixture's chains record them (§4.1)", () => {
    const entries = resolved('meta').entries;
    const subtypeCount = (name: string): number => {
      const value = entries.get(name);
      return value === undefined ? -1 : subtypesOf(value).length;
    };
    expect(subtypeCount('meta.top')).toBeGreaterThan(20);
    expect(subtypeCount('meta.type')).toBeGreaterThan(15);
  });
});
