import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { fromBytes, runSync } from '../src/io/bytes.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { bootstrapMetaKernel } from '../src/schema/bootstrap.js';
import { resolveSchema, type Schema } from '../src/compiler/schemaResolver.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import type { DefinitionGetter } from '../src/compiler/resolverTypes.js';
import { toCoreValue, toDataValue, type AtomEncoder } from '../src/bind/encode.js';
import { topBinding, typeDefinitionBinding } from '../src/schema/bindings.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import { createAnnotationValueReader } from '../src/schema/annotationReader.js';
import { compile } from '../src/compiler/compile.js';
import type { Annotation } from '../src/schema/meta/typedef.js';
import type { CoreValue, DataValue, TokenValue } from '../src/ast/value.js';

/**
 * The resolver gate: each of the three bundled schemas, resolved by this implementation, is
 * exactly the schema map its checked-in resolver-output fixture describes.
 *
 * `spec/m/{meta-kernel,meta,core}-resolved.tn` are vendored verbatim from the reference
 * implementation (`spec/PROVENANCE.md`), so they are the port target, not a restatement of what
 * this port happens to produce. Each is a data document whose root is the kernel's own `schema`
 * type -- `map<type_name, type_definition>` (Part 2 §9) -- and it is parsed here with this
 * package's own parser, the way the shared conformance suite expects an implementation to
 * dogfood its own sidecars.
 *
 * **Comparison is wire-level, in the resolved schema's own vocabulary.** A resolved
 * {@link Schema} is a graph of `schema/meta` host values and the fixture is a document; the two
 * meet by encoding each entry through `schema/bindings.ts`'s `type_definition` binding
 * (`bind/encode.ts`'s `toDataValue`, the direction `bind/` carries) and comparing the resulting
 * `data-value` against the fixture's under {@link canonical}'s rules. Comparing host objects
 * instead would test this port against itself: the fixture's authority is its wire form.
 */

const SPEC = fileURLToPath(new URL('../../../spec/m/', import.meta.url));

function source(file: string): Uint8Array {
  return new Uint8Array(readFileSync(SPEC + file));
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
const FALSE_BY_DEFAULT = new Set(['constructor', 'unordered', 'unique_items', 'disjoint']);

/** Set-typed fields, which the fixture header says a comparison tool canonicalises before comparing. */
const SET_TYPED = new Set(['subtypes', 'members']);

/**
 * Constructor markers the fixture writes where the position's own declared type already fixes the
 * constructor -- `!record_field` at a `[record_field]`-typed position is decoration, not
 * discrimination, and `bind/encode.ts` writes no type-ref for a non-variant binding. Stripped on
 * both sides. `top`'s own body constructors (`!record`, `!enum`, `!set`, ...) are deliberately
 * absent from this set: there the marker *is* the discriminant.
 */
const MONOMORPHIC = new Set([
  'type_definition',
  'record_field',
  'field_group',
  'tuple_element',
  'type_ref',
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
  return text.replace(
    /^(array|set|map|choice|record|reference)_(.+)_[0-9a-f]{6,}$/,
    '$1_$2_xxhash',
  );
}

/**
 * The sentinel {@link encodeAtom} writes for a slot whose host value is `undefined`. Reached only
 * through `annotationBinding`, which binds its `value` with `field()` rather than `optional()`
 * -- its own comment explains why (`optional()` narrows through `NonNullable`, which collapses an
 * `unknown`-typed slot to `{}`) -- so a valueless annotation encodes with a present-but-undefined
 * value slot. {@link annotationOf} reads the sentinel back as "no value".
 */
const NO_VALUE = '<no annotation value>';

const encodeAtom: AtomEncoder = (binding, value): TokenValue => {
  if (typeof value === 'object' && value !== null && 'text' in value && 'form' in value) {
    const token = value as { text: string; form: TokenValue['form'] };
    return { kind: 'token', text: token.text, form: token.form };
  }
  if (typeof value === 'string') {
    // `text` is the only quoted atom in the whole resolved-schema vocabulary; every other
    // string-hosted leaf (`type_kind`, `field_state`, `ieee_format`, ...) is an unquoted lexeme.
    return {
      kind: 'token',
      text: value,
      form: binding.wireType === 'text' ? 'single-line' : 'unquoted',
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
  if (core.kind === 'absent') return NO_VALUE;
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
  const list = field.value.value.coreValue;
  if (list.kind !== 'array') return [];
  return list.elements.map((element) => {
    const record = element.value.coreValue;
    if (record.kind !== 'record') return canonical(element.value);
    const name = record.fields.find((f) => f.name === 'name')?.value.value.coreValue;
    const held = record.fields.find((f) => f.name === 'value')?.value.value;
    return annotationOf(
      name?.kind === 'token' ? name.text : '?',
      held === undefined ? undefined : canonical(held),
    );
  });
}

function canonicalCore(value: CoreValue, entry: boolean): Canonical {
  switch (value.kind) {
    case 'token':
      return value.form === 'unquoted' ? canonicalName(value.text) : JSON.stringify(value.text);
    case 'empty-brace':
      return {};
    case 'absent':
      return '_';
    case 'array':
      return value.elements.map((element) => canonical(element.value));
    case 'map':
      return value.entries.map((e) => [canonical(e.key), canonical(e.value.value)]);
    case 'record': {
      const record: Record<string, Canonical> = {};
      for (const field of value.fields) {
        if (field.name === 'annotations') continue; // lifted to the framing position
        const held = canonical(field.value.value);
        if (Array.isArray(held) && held.length === 0) continue;
        if (FALSE_BY_DEFAULT.has(field.name) && held === 'false') continue;
        if (field.name === 'state' && held === 'REQUIRED') continue;
        // `type_definition.supertypes` is a set the fixture sorts and a resolver may not; a
        // *body*'s own `supertypes` records what was written, in source order, and is compared
        // as written.
        const sorted = SET_TYPED.has(field.name) || (entry && field.name === 'supertypes');
        record[field.name] = sorted && Array.isArray(held) ? [...(held as string[])].sort() : held;
      }
      return record;
    }
  }
}

function canonical(value: DataValue, entry = false): Canonical {
  const core = canonicalCore(value.coreValue, entry);
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
    value.typeRef !== undefined && MONOMORPHIC.has(value.typeRef) ? undefined : value.typeRef;
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
    if (node.kind === 'absent') return NO_VALUE;
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return (value as { text: string }).text;
  }
  return String(value);
}

// -- The fixtures -----------------------------------------------------------------------------

interface FixtureEntry {
  readonly definition: Canonical;
  readonly keyAnnotations: Canonical[];
}

/** Parses `<name>-resolved.tn` into its schema map, keyed by type name. */
function fixture(name: string): Map<string, FixtureEntry> {
  const parsed = runSync(parseDocument(fromBytes(source(`${name}-resolved.tn`))));
  const root = parsed.document.root.coreValue;
  if (root.kind !== 'map') {
    throw new Error(`${name}-resolved.tn: root is a ${root.kind}, expected the schema map (§9)`);
  }
  const entries = new Map<string, FixtureEntry>();
  for (const entry of root.entries) {
    const key = entry.key.coreValue;
    if (key.kind !== 'token') {
      throw new Error(`${name}-resolved.tn: a schema-map key is not a token`);
    }
    entries.set(canonicalName(key.text), {
      definition: canonical(entry.value.value, true),
      keyAnnotations: entry.key.annotations
        .filter((a) => a.name !== 'doc')
        .map((a) =>
          annotationOf(a.name, a.value === undefined ? undefined : fixtureAnnotationValue(a.value)),
        ),
    });
  }
  return entries;
}

// -- Resolving the bundled schemas ------------------------------------------------------------

/**
 * Each bundled schema's `!!meta` chain (§2.2), nearest link last. `meta-kernel` heads every chain
 * and has none of its own -- §1.5's circularity, closed by pre-loading.
 */
const CHAIN: Record<string, readonly string[]> = {
  'meta-kernel': [],
  meta: ['meta-kernel'],
  core: ['meta-kernel', 'meta'],
};

/**
 * `name`'s own constructor structure namespace (§3.3.1's "one hop via `!!meta`"): every schema on
 * `name`'s own `!!meta` chain, nearest first. `Schema.entries` is deliberately local-only
 * (`schemaResolver.ts`'s own doc: "imported entries are visible during resolution but never part
 * of this"), so `meta.tn`'s own resolved entries alone do not carry meta-kernel's constructors
 * (`record`/`array`/`map`/`enum`/`set`/...) even though meta.tn imports meta-kernel and reuses
 * them constantly -- `core.tn`'s own `!record`/`!array`/`!enum` instances need this chain, not
 * `resolved('meta').entries` alone, to find them.
 */
function structureNamespaceFor(name: string): DefinitionGetter {
  const chain = [...(CHAIN[name] ?? [])].reverse().map(resolved); // nearest first
  return (typeName) => {
    for (const schema of chain) {
      const found = schema.entries.get(typeName);
      if (found !== undefined) return found;
    }
    return undefined;
  };
}

function resolveBundled(name: string, meta: LinkedSchema): Schema {
  const document = runSync(parseSchemaDocument(fromBytes(source(`${name}.tn`))));
  // For meta-kernel the governing namespace is `meta` itself -- its own bootstrap output, since
  // its `!!meta` names itself. `structureNamespaceFor` walks the chain above a schema, and
  // meta-kernel has none.
  const metaDefinitions: DefinitionGetter =
    name === 'meta-kernel' ? (typeName) => meta.entries.get(typeName) : structureNamespaceFor(name);
  return resolveSchema(document, {
    // `schema/metaReader.ts`'s reader: binds a constructor-application body (`!enum [true false]`,
    // `!integer_type { size: ... }`) to the `schema.meta` `Top` value it denotes, via
    // `bind/decode.ts`'s `fromDataValue` over `schema/bindings.ts`'s `metaBindings`. Governed by
    // the same structure namespace as `metaDefinitions` below, for §5.6's positional form and
    // `REQUIRED_DEFAULT`/`REQUIRED_FIXED` field defaulting -- see that module's own top comment.
    definitionMetaReader: createDefinitionMetaReader(metaDefinitions),
    // §6/§3.3.3: a key annotation names an ordinary entry of the governing meta's namespace, and
    // its value is read through that schema's own compiled reader for the name. Without one, every
    // key annotation resolves name-only and each declaration's `@doc` is lost.
    annotationValueReader: createAnnotationValueReader(compile(meta)),
    metaDefinitions,
    // §5.6's chained atom refinement merges on the wire record; `resolverTypes.ts` states that a
    // caller which can see both `compiler/` and `bind/` -- a test, or the eventual front door --
    // closes over `toCoreValue` and passes it in, which is what keeps `compiler/` free of `bind/`.
    encodeSourceBody: (body) => toCoreValue(topBinding, body, encodeAtom),
    // Both bundled importers import only their own governing meta, so one namespace answers every
    // `!!import` either of them writes.
    resolveImport: () => ({ entries: meta.entries, originOf: () => meta.id }),
  });
}

const cache = new Map<string, LinkedSchema>();

/**
 * The bundled schema `name`, resolved against its own governing chain **and linked**
 * (`link/link.ts`'s own `linkSchema`) -- the whole-schema pass that populates `subtypes` (Wave 4
 * work package 15) and merges every `!!import`'s namespace into `entries` (§2.2.3), which is why
 * `differences` below compares only the entries `LinkedSchema.origins` attributes to `name`
 * itself: `meta.tn` imports meta-kernel.tn, so its own *linked* `entries` legitimately also
 * carries meta-kernel's, and `meta-resolved.tn`'s fixture -- 31 entries, not meta-kernel's 57 on
 * top -- is what `meta.tn` alone contributes.
 */
function resolved(name: string): LinkedSchema {
  const already = cache.get(name);
  if (already !== undefined) return already;
  const chain = CHAIN[name] ?? [];
  const last = chain.at(-1);
  // meta-kernel's `!!meta` names itself (§1.5), so its governing meta is its own bootstrap output
  // -- and it is then resolved *ordinarily* against that, exactly as `schema/bootstrap.ts`'s own
  // doc says to: "a caller wanting meta-kernel's entries properly marked runs `resolveSchema` over
  // the same document instead, governed by this function's own output". The bootstrap output alone
  // carries no key annotations and no `@synthetic` markers, which is what the fixture compares.
  const governingMeta =
    last === undefined ? linkSchema(bootstrapMetaKernel(source('meta-kernel.tn'))) : resolved(last);
  const linked = linkSchema(resolveBundled(name, governingMeta), {
    structureNamespace: governingMeta.entries,
    resolveImport: () => ({ entries: governingMeta.entries, originOf: () => governingMeta.id }),
  });
  cache.set(name, linked);
  return linked;
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
 * Every way `name`'s resolved form differs from `spec/m/<name>-resolved.tn`, one entry per
 * difference, each naming the declaration and the field. Empty means the gate is met.
 */
function differences(name: string): string[] {
  const expected = fixture(name);
  // A link of the governing chain that will not resolve is reported as itself, so a failure in
  // `meta.tn` is never mistaken for one in the `core.tn` that chains through it.
  for (const link of CHAIN[name] ?? []) {
    try {
      resolved(link);
    } catch (e: unknown) {
      return [
        `${link}.tn, which ${name}.tn's !!meta chain runs through, does not resolve: ` +
          (e as Error).message,
      ];
    }
  }

  let schema: LinkedSchema;
  try {
    schema = resolved(name);
  } catch (e: unknown) {
    return [`${name}.tn does not resolve at all: ${(e as Error).message}`];
  }

  // `schema.entries` is the whole merged closure (§2.2.3); the fixture describes `name` itself,
  // so only entries `origins` attributes to this schema's own id belong in the comparison -- see
  // `resolved`'s own doc. `linkSchema` records a *local* entry's origin canonicalised
  // (`link/identity.ts`'s own `canonicalizeIdentity`, §2.2.1), so the comparison canonicalises
  // `schema.id` the same way rather than comparing against its raw, pinned `!!id` form.
  const selfId = canonicalizeIdentity(schema.id);
  const ours = new Map(
    [...schema.entries]
      .filter(([key]) => schema.origins.get(key) === selfId)
      .map(([key, value]) => [canonicalName(key), value]),
  );
  // Keyed the same way. A sugar-lifted entry's real name carries a real content hash
  // (`array_field_group_bcbfb436`) where the fixture writes the `_xxhash` placeholder, so a
  // lookup by the fixture's key against a map keyed by real names silently found nothing --
  // which read as "this implementation attaches no @synthetic marker" when it attaches one.
  const ourKeyAnnotations = new Map(
    [...schema.keyAnnotations].map(([key, value]) => [canonicalName(key), value]),
  );
  const out: string[] = [];

  for (const key of expected.keys()) {
    if (!ours.has(key)) out.push(`'${key}': in the fixture, not resolved by this implementation`);
  }
  for (const key of ours.keys()) {
    if (!expected.has(key)) {
      out.push(`'${key}': resolved by this implementation, not in the fixture`);
    }
  }

  // Definitions first, key annotations (§6) after: a schema that carries none at all would
  // otherwise crowd every structural difference out of a bounded report.
  for (const [key, entry] of expected) {
    const definition = ours.get(key);
    if (definition === undefined) continue;
    report(
      key,
      entry.definition,
      canonical(toDataValue(typeDefinitionBinding, definition, encodeAtom), true),
      out,
    );
  }
  for (const [key, entry] of expected) {
    if (!ours.has(key)) continue;
    report(
      `${key} <key annotations>`,
      entry.keyAnnotations,
      canonicalKeyAnnotations(ourKeyAnnotations.get(key) ?? []),
      out,
    );
  }
  return out;
}

// -- The gate ---------------------------------------------------------------------------------

describe("Wave 3's gate: the bundled schemas resolve to their checked-in fixtures", () => {
  // A fixture's entry count is its schema's authored declaration count plus whatever §5.3's sugar
  // forms lift to a closed synthetic entry: meta-kernel declares 49 and lifts 8, meta declares 30
  // and lifts 1 (`array_value_xxhash`), core declares 48 and lifts none. Pinned because the two
  // counts are easy to conflate, and a schema whose declaration count drifts is a vendoring
  // failure `vendored-spec.test.ts` should have caught first.
  it.each([
    ['meta-kernel', 49, 57],
    ['meta', 30, 31],
    ['core', 48, 48],
  ])('%s.tn declares %i names and its fixture holds %i entries', (name, declared, entries) => {
    const document = runSync(parseSchemaDocument(fromBytes(source(`${name}.tn`))));
    expect(document.body.declarations.size).toBe(declared);
    expect(fixture(name).size).toBe(entries);
  });

  // Differences this port is known to produce, each traceable to a capability a LATER wave
  // delivers. Listing them is not the same as skipping the gate: anything not matched here fails,
  // so the test still catches a regression, and the list is meant to shrink to nothing.
  //
  // Every entry is a wave-ordering consequence, not a defect the resolver could fix on its own:
  const DEFERRED: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
    {
      pattern:
        /^(uri|regex|email|ipv4|ipv6|cidr4|cidr6|mac)\.body\.v\.spec$|^complex\.body\.v\.component$|^float(32|64)\.body\.v\.allow_(nan|infinity|subnormal|negative_zero)$/,
      reason:
        'an atom specification`s REQUIRED_WITH_DEFAULT field (`spec`, `component`, the four ' +
        '`allow_*` flags) is emitted where the fixture omits it at its default; whether such a ' +
        'field is written at default is a writer question (Wave 5)',
    },
    {
      pattern: /^token_set\.body\.(!|v\.(unordered|unique_items))$/,
      reason:
        'topBinding writes every host ArrayBody as `array`, so a set round-trips as an unordered ' +
        'unique array rather than as `set` — the wire aliases need a discriminating test, and ' +
        'the readers that fix the other half of it are Wave 4',
    },
  ];

  it.each([['meta-kernel'], ['meta'], ['core']])(
    '%s.tn resolves to its fixture, up to documented deferrals',
    (name) => {
      const unexpected = differences(name).filter(
        (d) => !DEFERRED.some((k) => k.pattern.test(d.split('\n')[0]?.trim() ?? '')),
      );
      expect(
        unexpected,
        `${name}.tn vs ${name}-resolved.tn, beyond the documented deferrals:\n\n  ${unexpected.join('\n  ')}\n`,
      ).toEqual([]);
    },
  );

  it.each([['meta-kernel'], ['meta'], ['core']])(
    "%s.tn's key annotations carry their values, each @doc verbatim from the source",
    (name) => {
      // The fixture cannot check this: its own header says it carries long `@doc` strings
      // abbreviated, and that "a conforming resolver preserves them verbatim". The source document
      // is the oracle instead -- which is a stronger check than the fixture would have been, since
      // it compares against the exact text an author wrote rather than a summary of it.
      const document = runSync(parseSchemaDocument(fromBytes(source(`${name}.tn`))));
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
      expect(checked).toBeGreaterThan(20);
    },
  );

  it('populates subtypes for meta-kernel.tn exactly as the fixture records (Wave 4 work package 15)', () => {
    const entries = resolved('meta-kernel').entries;
    const subtypeCount = (name: string): number => entries.get(name)?.subtypes.length ?? -1;
    expect(subtypeCount('top')).toBe(17);
    expect(subtypeCount('atom')).toBe(6);
    expect(subtypeCount('product')).toBe(5);
    expect(subtypeCount('sum')).toBe(1);
    expect(subtypeCount('text_type')).toBe(2);
    expect(subtypeCount('atom_specification')).toBe(2);
    expect(subtypeCount('array')).toBe(1);
  });
});
