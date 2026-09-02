/**
 * What a `class2/schema/` `valid` vector's own expected side means, and how to compare it against
 * this implementation's real resolver output -- the port of the reference implementation's
 * `ResolvedForm.java`, over this package's own `schema/meta` value model rather than Java's.
 *
 * **No §8 resolved-schema writer exists in this port, and this module does not add one.**
 * [TSON-SCHEMA] §1.3 makes producing a resolved schema value a MUST but writing it back out to
 * text an OPTIONAL, and this port only has the former. Comparing therefore runs the other
 * direction from what a first instinct suggests: the sidecar's own `resolved` text is read back
 * through this implementation's own meta.tn-governed reader (`schema/metaReader.ts`'s
 * {@link createDefinitionMetaReader}, the same machinery `definitionResolver.ts` already uses to
 * bind a schema *source* document's own constructor-application bodies) into the same
 * `schema.meta.TypeDefinition` shape this implementation's own resolver produces, and the two
 * `TypeDefinition` values are compared directly. Nothing here ever renders this implementation's
 * own resolved output to text.
 *
 * **RUNNER.md rule 6's hash normalisation is applied wherever a resolver-minted name appears** --
 * an entry's own key, or a name written inside a body (a field's `type`, a `binds`/`subtypes`
 * entry) -- via `synthetic.ts`'s {@link normalizeSyntheticNamesAnywhere}. A single `TypeDefinition`
 * is rendered to a canonical, key-sorted JSON text (never a TSON document) purely so that
 * normalisation can run once over the whole structure rather than being threaded through every
 * shape in `schema/meta` individually; two `TypeDefinition`s compare equal exactly when their
 * canonical renderings do.
 */
import { encodeUtf8 } from '../../packages/tson/src/io/utf8.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import type { DataValue } from '../../packages/tson/src/ast/value.js';
import type {
  DefinitionGetter,
  DefinitionMetaReader,
} from '../../packages/tson/src/compiler/resolverTypes.js';
import { createDefinitionMetaReader } from '../../packages/tson/src/schema/metaReader.js';
import { canonicalizeIdentity } from '../../packages/tson/src/link/identity.js';
import type { LinkedSchema } from '../../packages/tson/src/link/link.js';
import type { Top, TypeDefinition } from '../../packages/tson/src/schema/meta/typedef.js';
import { normalizeSyntheticName, normalizeSyntheticNamesAnywhere } from './synthetic.js';

/** `dv`'s decoded token text -- the resolved schema-map's own keys, always a bare identifier. */
function tokenTextOf(dv: DataValue): string {
  if (dv.coreValue.kind !== 'token') {
    throw new Error(
      `expected a token for a resolved schema-map key, found core-value kind '${dv.coreValue.kind}'`,
    );
  }
  return dv.coreValue.text;
}

/** `dv`'s own record field named `name`, or `undefined` when `dv` is not record-shaped or has none such. */
function fieldValueOf(dv: DataValue, name: string): DataValue | undefined {
  if (dv.coreValue.kind !== 'record') return undefined;
  return dv.coreValue.fields.find((field) => field.name === name)?.value.value;
}

/**
 * A no-op stand-in for `type_definition.body`'s own slot, valid against every member of
 * `topBinding`'s variant (`unitBinding`, zero fields) -- used only to satisfy the generic decode
 * below while `body` itself is decoded separately; see {@link readTypeDefinition}'s own note.
 */
const VOID_PLACEHOLDER: DataValue = {
  annotations: [],
  typeRef: 'void',
  coreValue: { kind: 'empty-brace' },
};

/** `dv`, with its record field `name` replaced by `replacement` -- `dv` unchanged, everything else shared. */
function withReplacedField(dv: DataValue, name: string, replacement: DataValue): DataValue {
  if (dv.coreValue.kind !== 'record') {
    throw new Error(
      `expected a record to replace field '${name}' on, found core-value kind '${dv.coreValue.kind}'`,
    );
  }
  return {
    ...dv,
    coreValue: {
      kind: 'record',
      fields: dv.coreValue.fields.map((field) =>
        field.name === name ? { ...field, value: { ...field.value, value: replacement } } : field,
      ),
    },
  };
}

/**
 * Reads one `!type_definition {...}` value back into the `TypeDefinition` it denotes.
 *
 * **Why `body` needs its own, separate decode.** {@link createDefinitionMetaReader} is built for
 * how `definitionResolver.ts` actually calls it: once per constructor-application node,
 * dispatched fresh with that node's own wire name, while it walks a schema *source* document's
 * AST. Every position `metaReader.ts`'s own `RecordFieldsProvider` can supply a field-defaulting
 * policy for is one it can name in advance -- `type_definition` itself (the top-level call) and a
 * small closed table of "supporting record" shapes that only ever appear nested one way
 * (`type_ref`, `record_field`, ...). `type_definition.body: Top` is the one field whose own value
 * is itself an *arbitrary* top-level constructor application (`!array {...}`, `!enum {...}`, ...),
 * decoded through `fromDataValue`'s automatic variant dispatch — which shares the *outer* call's
 * fieldsFor closure rather than starting a fresh one keyed on `body`'s own wire name. So a
 * `REQUIRED_DEFAULT` field the resolved text omits for brevity (`array`'s own `unordered`/
 * `unique_items`/`state`, all defaulted in the fixture vectors) has no default source to consult
 * mid-recursion, and decoding throws `FIELD_REQUIRED` for a field §8's own output never restates.
 *
 * The fix mirrors how `definitionResolver.ts` itself would read it: decode `body` through its
 * *own* fresh top-level call (`reader(bodyTypeRef, bodyValue)`, `bodyTypeRef` read directly off
 * the value's own `!type-ref`, exactly the wire name a resolved document always states there),
 * and decode everything else through one ordinary `type_definition` call with `body` swapped for
 * a trivially-valid placeholder so that call's own walk never reaches the field this handles
 * separately.
 */
function readTypeDefinition(dv: DataValue, reader: DefinitionMetaReader): TypeDefinition {
  const bodyValue = fieldValueOf(dv, 'body');
  if (bodyValue === undefined) {
    throw new Error("a resolved 'type_definition' value is missing its required 'body' field");
  }
  const bodyTypeRef = bodyValue.typeRef;
  if (bodyTypeRef === undefined) {
    throw new Error("a resolved 'type_definition' value's own 'body' must carry its own !type-ref");
  }
  const body: Top = reader(bodyTypeRef, bodyValue);
  const withoutBody = withReplacedField(dv, 'body', VOID_PLACEHOLDER);
  const definition = reader('type_definition', withoutBody) as TypeDefinition;
  return { ...definition, body };
}

/**
 * Reads a `class2/schema/` `valid` vector's `resolved` text -- a bare `!schema { name =>
 * !type_definition {...} }` value, always governed by meta.tn (`schema-sidecar.tn`'s own doc: "The
 * resolved document carries no header... it is meta.tn for every vector at this layer") -- into
 * the `Map<string, TypeDefinition>` it denotes.
 *
 * `governingMeta` is meta.tn's own linked entries: the structure namespace
 * {@link createDefinitionMetaReader} needs to resolve `type_definition`'s and every nested
 * constructor's own declared field defaults and single-required-field positional form, the same
 * namespace `config.ts`'s own `resolveAgainstRegistry` threads into `definitionResolver.ts` while
 * resolving a schema *source* document.
 */
export function readResolved(
  resolvedText: string,
  governingMeta: ReadonlyMap<string, TypeDefinition>,
): Map<string, TypeDefinition> {
  const { document } = runSync(parseDocument(fromBytes(encodeUtf8(resolvedText))));
  const root = document.root.coreValue;
  if (root.kind !== 'map') {
    throw new Error(
      `expected a '!schema {...}' map at a resolved-schema vector's root, found core-value kind '${root.kind}'`,
    );
  }
  const lookup: DefinitionGetter = (name) => governingMeta.get(name);
  const reader = createDefinitionMetaReader(lookup);
  const result = new Map<string, TypeDefinition>();
  for (const entry of root.entries) {
    result.set(tokenTextOf(entry.key), readTypeDefinition(entry.value.value, reader));
  }
  return result;
}

/**
 * Deterministic, key-sorted JSON of `value` -- never written anywhere as a document, only ever
 * compared against another rendering of the same shape. Drops `TypeDefinition.position` at any
 * depth (this implementation's own diagnostic addition, with no counterpart in §8's output form,
 * exactly as the Java reference implementation's own `rendered()` strips its equivalent) and
 * `undefined`-valued fields (this model's own "absent" spelling).
 */
function canonicalJson(value: unknown): string {
  // `metaAtomDecoder`'s own `integer` case (`schema/metaReader.ts`) decodes to a `bigint`
  // (`toExactInteger`), which `JSON.stringify` refuses outright -- rendered as its decimal
  // digits, indistinguishable from a same-valued host `number` the way this comparison needs.
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (key === 'position') continue; // no §8 output counterpart -- see this module's own doc
      const fieldValue = record[key];
      if (fieldValue === undefined) continue; // "absent" in this model's own convention
      parts.push(`${JSON.stringify(key)}:${canonicalJson(fieldValue)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `definition`, reduced to what a comparison is about: a canonical rendering with every
 * resolver-minted name's content hash normalised (RUNNER.md rule 6, generalised) wherever it
 * appears in the structure.
 */
export function renderDefinition(definition: TypeDefinition): string {
  return normalizeSyntheticNamesAnywhere(canonicalJson(definition));
}

/**
 * `linked`'s own entries -- the ones this schema declares itself, excluding whatever `!!import`
 * merged in -- keyed by their hash-normalised name. Mirrors the Java reference implementation's
 * `ResolvedForm.ownEntries`: a `class2/schema/valid` vector states only what its own subject
 * declares, never restating an imported schema's entries too.
 */
export function ownEntries(linked: LinkedSchema): Map<string, TypeDefinition> {
  const selfId = canonicalizeIdentity(linked.id);
  const own = new Map<string, TypeDefinition>();
  for (const [name, definition] of linked.entries) {
    if (linked.origins.get(name) === selfId) {
      own.set(normalizeSyntheticName(name), definition);
    }
  }
  return own;
}

/**
 * The names `linked` marks `@synthetic` at their schema-map key, among its own (non-imported)
 * entries -- hash-normalised. §8.2 puts this marker on every entry the resolver materialised from
 * a sugar form or closed from a template application, and on no other.
 */
export function ourSynthetics(linked: LinkedSchema): Set<string> {
  const selfId = canonicalizeIdentity(linked.id);
  const marked = new Set<string>();
  for (const name of linked.entries.keys()) {
    if (linked.origins.get(name) !== selfId) continue;
    const annotations = linked.keyAnnotations.get(name);
    if (annotations?.some((annotation) => annotation.name === 'synthetic') === true) {
      marked.add(normalizeSyntheticName(name));
    }
  }
  return marked;
}

const SYNTHETIC_KEY_MARKER = /@synthetic\s+([A-Za-z0-9_]+)\s*=>/g;

/**
 * The names a §8 resolved-schema document's own *text* marks `@synthetic` at a schema-map key --
 * hash-normalised. Read from raw text rather than from a bound value for the reason the Java
 * reference implementation's own `ResolvedForm.markedSynthetics` gives: a key-position annotation
 * is dropped when a resolved-form document is read back, so a bound comparison would render no
 * annotations on either side and agree for the wrong reason.
 */
export function markedSynthetics(resolvedText: string): Set<string> {
  const marked = new Set<string>();
  for (const match of resolvedText.matchAll(SYNTHETIC_KEY_MARKER)) {
    const name = match[1];
    if (name !== undefined) marked.add(normalizeSyntheticName(name));
  }
  return marked;
}
