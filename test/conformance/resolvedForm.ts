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
 * `schema.meta` values this implementation's own resolver produces -- an entry is its value
 * (§8.1) -- and the two are compared directly. Nothing here ever renders this implementation's
 * own resolved output to text.
 *
 * **No name is normalised.** No entry is minted (RUNNER.md, Revision 40), so every key and every
 * name inside a body is compared as written. A single entry is rendered to a canonical, key-sorted
 * JSON text (never a TSON document) purely so that one comparison covers the whole structure rather
 * than being threaded through every shape in `schema/meta` individually; two entries compare equal
 * exactly when their canonical renderings do.
 *
 * **A resolved form lists complete entries only** (RUNNER.md): an incomplete entry, and an alias
 * whose chain ends at one, appears in the subject and never in its resolved form
 * ({@link isIncomplete}). What a declared completion closed is stated on its key, `@meta.completion`,
 * and is compared as a claim of its own ({@link markedCompletions}, {@link ourCompletions}).
 */
import { encodeUtf8 } from '../../packages/tson/src/io/utf8.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import type { DataValue } from '../../packages/tson/src/ast/value.js';
import type { DefinitionGetter } from '../../packages/tson/src/compiler/resolverTypes.js';
import { createDefinitionMetaReader } from '../../packages/tson/src/schema/metaReader.js';
import { canonicalizeIdentity } from '../../packages/tson/src/link/identity.js';
import type { LinkedSchema } from '../../packages/tson/src/link/link.js';
import type { Annotation, Top } from '../../packages/tson/src/schema/meta/typedef.js';
import { isConstructor } from '../../packages/tson/src/schema/meta/typedef.js';
import { createDefinitionValueReader } from '../../packages/tson/src/schema/namespaceReader.js';
import { isNestedMap } from '../../packages/tson/src/schema/meta/schemaPaths.js';

/** `dv`'s decoded token text -- the resolved schema-map's own keys, always a bare identifier. */
function tokenTextOf(dv: DataValue): string {
  if (dv.coreValue.kind !== 'token') {
    throw new Error(
      `expected a token for a resolved schema-map key, found core-value kind '${dv.coreValue.kind}'`,
    );
  }
  return dv.coreValue.text;
}

/** One resolved entry as a comparison sees it: its value and the annotations written in front of it (§3.1). */
export interface ResolvedEntry {
  readonly value: Top;
  readonly annotations: readonly Annotation[];
}

/**
 * Reads a `class2/schema/` `valid` vector's `resolved` text -- a `!schema { name => value }` document,
 * each entry its value (`!meta.record {...}`, `!meta.alias {...}`, `!meta.template {...}`) and each
 * schema map an entry nested as `!meta.schema { ... }` -- into the entries it denotes, keyed by path.
 *
 * Each value is read through its own top-level call of the meta reader, keyed by the constructor its
 * `!type-ref` names, exactly as `definitionResolver.ts` reads a constructor application in a schema
 * source: that is what gives every nested constructor's declared field defaults and §5.6's positional
 * form a source to be read from. A nested map's members are keyed under their path (`geo.address`), as
 * one namespace holds them at every depth (§2.2.3). `lookup` resolves a constructor's definition: the
 * subject's own imports, and the pre-loaded kernel alone when it has none (RUNNER.md).
 */
export function readResolved(
  resolvedText: string,
  lookup: DefinitionGetter,
): Map<string, ResolvedEntry> {
  const { document } = runSync(
    parseDocument(fromBytes(encodeUtf8(resolvedText)), { resolvedForm: true }),
  );
  const root = document.root.coreValue;
  if (root.kind !== 'map') {
    throw new Error(
      `expected a '!schema {...}' map at a resolved-schema vector's root, found core-value kind '${root.kind}'`,
    );
  }
  const reader = createDefinitionMetaReader(lookup);
  const valueReader = createDefinitionValueReader(lookup);
  const result = new Map<string, ResolvedEntry>();
  const add = (prefix: string, entries: readonly { key: DataValue; value: DataValue }[]): void => {
    for (const entry of entries) {
      const value = entry.value;
      const path = `${prefix}${tokenTextOf(entry.key)}`;
      if (value.typeRef === 'meta.schema') {
        const nested = value.coreValue;
        if (nested.kind === 'map') add(`${path}.`, nested.entries);
        continue;
      }
      if (value.typeRef === undefined) {
        throw new Error(`resolved entry '${path}' must carry its constructor as a !type-ref`);
      }
      // A tag that names no constructor builds a value entry, an instance of an ordinary type (§4.1):
      // read against that type as a data value is, and held as the value it is.
      const definition = lookup(value.typeRef);
      const built: Top =
        definition !== undefined && !isConstructor(definition, value.typeRef)
          ? { kind: 'value_entry', type: value.typeRef, value: valueReader(value.typeRef, value) }
          : reader(value.typeRef, value);
      result.set(path, {
        value: built,
        annotations: value.annotations.map((annotation) => ({
          name: annotation.name,
          ...(annotation.value === undefined ? {} : { value: annotation.value }),
        })),
      });
    }
  };
  add('', root.entries);
  return result;
}

/**
 * Deterministic, key-sorted JSON of `value` -- never written anywhere as a document, only ever
 * compared against another rendering of the same shape. Drops a `position` at any
 * depth (this implementation's own diagnostic addition, with no counterpart in §8's output form,
 * exactly as the Java reference implementation's own `rendered()` strips its equivalent) and
 * `undefined`-valued fields (this model's own "absent" spelling).
 */
function canonicalJson(value: unknown): string {
  // `metaAtomDecoder`'s own `integer` case (`schema/metaReader.ts`) decodes to a `bigint`
  // (`toExactInteger`), which `JSON.stringify` refuses outright -- rendered as its decimal
  // digits, indistinguishable from a same-valued host `number` the way this comparison needs.
  if (typeof value === 'bigint') return value.toString();
  // A namespace value's entries and a record value's fields are `Map`s, which have no own
  // enumerable keys: rendered as their entries, in order, so two maps compare by what they hold.
  if (value instanceof Map) {
    return `{"$map":${canonicalJson([...(value as Map<unknown, unknown>).entries()])}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (key === 'position') continue; // no §8 output counterpart -- see this module's own doc
      // A reference's `index` is derived by the linker and written by no document (§4.2, §8.1).
      if (key === 'index' && (record as { kind?: unknown }).kind === 'ref') continue;
      // The application a record in place closes is held beside it for a message, and is no field of the kernel's
      // `meta.type_inline`, whose one field is `of` (§4.2, §8.2).
      if (key === 'application' && (record as { kind?: unknown }).kind === 'inline') continue;
      const fieldValue = record[key];
      if (fieldValue === undefined) continue; // "absent" in this model's own convention
      parts.push(`${JSON.stringify(key)}:${canonicalJson(fieldValue)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** An annotation value reduced to comparable text: a data value's token, or a bound atom's value. */
function annotationValueText(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null && 'coreValue' in value) {
    const core = (value as DataValue).coreValue;
    return core.kind === 'token' ? core.text : JSON.stringify(core);
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return annotationValueText(value.value);
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * `entry`, reduced to what a comparison is about: its value-position annotations other than `doc`
 * (whose text a fixture abbreviates), and a canonical rendering.
 */
export function renderDefinition(entry: ResolvedEntry): string {
  const { value } = entry;
  const compared = {
    annotations: entry.annotations
      .filter((annotation) => annotation.name !== 'doc')
      .map((annotation) => ({
        name: annotation.name,
        value: annotationValueText(annotation.value),
      })),
    value,
  };
  return canonicalJson(compared);
}

/**
 * Whether the entry `name` names is an incomplete entry ([TSON-SCHEMA] §5.5), or an alias whose chain
 * ends at one: what a resolved form leaves out.
 */
function isIncomplete(linked: LinkedSchema, name: string): boolean {
  let current: Top | undefined = linked.entries.get(name);
  for (let hop = 0; hop < 64 && current !== undefined; hop++) {
    if (current.kind === 'incomplete') return true;
    if (current.kind !== 'alias') return false;
    current = linked.entries.get(current.target.name);
  }
  return false;
}

/**
 * `linked`'s own entries -- the ones this schema declares itself, excluding whatever `!!import`
 * merged in -- as its resolved form holds them: complete entries only. Mirrors the Java reference
 * implementation's `ResolvedForm.ownEntries`: a `class2/schema/valid` vector states only what its
 * own subject declares, never restating an imported schema's entries too.
 */
export function ownEntries(linked: LinkedSchema): Map<string, ResolvedEntry> {
  const selfId = canonicalizeIdentity(linked.id);
  const own = new Map<string, ResolvedEntry>();
  for (const [name, value] of linked.entries) {
    if (linked.origins.get(name) === selfId && !isNestedMap(value) && !isIncomplete(linked, name)) {
      own.set(name, {
        value,
        annotations: linked.facts.get(name)?.annotations ?? [],
      });
    }
  }
  return own;
}

/**
 * The names `annotation`'s `{ of: [capped bounded] }` value lists, in order; `undefined` where it is no such
 * record. A resolver's own value is the `meta.completion` it bound; a resolved form's is the data written.
 */
function completionNames(value: unknown): readonly string[] | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { of?: unknown }).of)
  ) {
    return (value as { of: readonly string[] }).of;
  }
  if (typeof value !== 'object' || value === null || !('coreValue' in value)) return undefined;
  const core = (value as DataValue).coreValue;
  if (core.kind !== 'record') return undefined;
  const of = core.fields.find((field) => field.name === 'of')?.value.coreValue;
  if (of?.kind !== 'array') return undefined;
  return of.elements.map((element) =>
    element.coreValue.kind === 'token' ? element.coreValue.text : '',
  );
}

/**
 * The names each schema-map key's `@meta.completion` lists in a §8 resolved-schema document, keyed by
 * entry name. Read from the text parsed as data rather than from a bound value, for the reason the
 * Java reference's `ResolvedForm.markedCompletions` gives: a key-position annotation is dropped when a
 * resolved-form document is read back, so a bound comparison would render none on either side and
 * agree for the wrong reason.
 */
export function markedCompletions(resolvedText: string): Map<string, readonly string[]> {
  const { document } = runSync(
    parseDocument(fromBytes(encodeUtf8(resolvedText)), { resolvedForm: true }),
  );
  const marked = new Map<string, readonly string[]>();
  const root = document.root.coreValue;
  if (root.kind !== 'map') return marked;
  const walk = (prefix: string, entries: readonly { key: DataValue; value: DataValue }[]): void => {
    for (const entry of entries) {
      const path = `${prefix}${tokenTextOf(entry.key)}`;
      for (const annotation of entry.key.annotations) {
        if (annotation.name !== 'meta.completion') continue;
        const names = completionNames(annotation.value);
        if (names !== undefined) marked.set(path, names);
      }
      if (entry.value.typeRef === 'meta.schema' && entry.value.coreValue.kind === 'map') {
        walk(`${path}.`, entry.value.coreValue.entries);
      }
    }
  };
  walk('', root.entries);
  return marked;
}

/** The same, from this resolver: the `@meta.completion` on the keys of the schema's own entries. */
export function ourCompletions(linked: LinkedSchema): Map<string, readonly string[]> {
  const selfId = canonicalizeIdentity(linked.id);
  const marked = new Map<string, readonly string[]>();
  for (const name of linked.entries.keys()) {
    if (linked.origins.get(name) !== selfId) continue;
    for (const annotation of linked.keyAnnotations.get(name) ?? []) {
      if (annotation.name !== 'meta.completion') continue;
      const names = completionNames(annotation.value);
      if (names !== undefined) marked.set(name, names);
    }
  }
  return marked;
}

/**
 * An application as a comparison sees it: its head and arguments, each a name ([TSON-SCHEMA] §8.2). A resolver's
 * own value is the `meta.apply` it bound; a resolved form's is the data written, `{ head: H  arguments: [A …] }`.
 */
function applicationText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ((value as { kind?: unknown }).kind === 'apply') {
    const apply = value as { head: { name: string }; arguments: readonly { name: string }[] };
    return `${apply.head.name}<${apply.arguments.map((argument) => argument.name).join(' ')}>`;
  }
  if (!('coreValue' in value)) return undefined;
  const core = (value as DataValue).coreValue;
  if (core.kind !== 'record') return undefined;
  const head = core.fields.find((field) => field.name === 'head')?.value.coreValue;
  const listed = core.fields.find((field) => field.name === 'arguments')?.value.coreValue;
  if (head?.kind !== 'token' || listed?.kind !== 'array') return undefined;
  const names = listed.elements.map((element) =>
    element.coreValue.kind === 'token' ? element.coreValue.text : '',
  );
  return `${head.text}<${names.join(' ')}>`;
}

/**
 * The application each schema-map key's `@meta.application` states in a §8 resolved-schema document, keyed by
 * entry name -- read from the text parsed as data, as {@link markedCompletions} reads its annotation.
 */
export function markedApplications(resolvedText: string): Map<string, string> {
  const { document } = runSync(
    parseDocument(fromBytes(encodeUtf8(resolvedText)), { resolvedForm: true }),
  );
  const marked = new Map<string, string>();
  const root = document.root.coreValue;
  if (root.kind !== 'map') return marked;
  const walk = (prefix: string, entries: readonly { key: DataValue; value: DataValue }[]): void => {
    for (const entry of entries) {
      const path = `${prefix}${tokenTextOf(entry.key)}`;
      for (const annotation of entry.key.annotations) {
        if (annotation.name !== 'meta.application') continue;
        const text = applicationText(annotation.value);
        if (text !== undefined) marked.set(path, text);
      }
      if (entry.value.typeRef === 'meta.schema' && entry.value.coreValue.kind === 'map') {
        walk(`${path}.`, entry.value.coreValue.entries);
      }
    }
  };
  walk('', root.entries);
  return marked;
}

/** The same, from this resolver: the `@meta.application` on the keys of the schema's own entries. */
export function ourApplications(linked: LinkedSchema): Map<string, string> {
  const selfId = canonicalizeIdentity(linked.id);
  const marked = new Map<string, string>();
  for (const name of linked.entries.keys()) {
    if (linked.origins.get(name) !== selfId) continue;
    for (const annotation of linked.keyAnnotations.get(name) ?? []) {
      if (annotation.name !== 'meta.application') continue;
      const text = applicationText(annotation.value);
      if (text !== undefined) marked.set(name, text);
    }
  }
  return marked;
}
