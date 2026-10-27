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
 * **RUNNER.md rule 6's hash normalisation is applied wherever a resolver-minted name appears** --
 * an entry's own key, or a name written inside a body (a field's `type`, a `binds`/`subtypes`
 * entry) -- via `synthetic.ts`'s {@link normalizeSyntheticNamesAnywhere}. A single entry
 * is rendered to a canonical, key-sorted JSON text (never a TSON document) purely so that
 * normalisation can run once over the whole structure rather than being threaded through every
 * shape in `schema/meta` individually; two entries compare equal exactly when their
 * canonical renderings do.
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
import { isTemplateBody } from '../../packages/tson/src/schema/meta/typedef.js';
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

/** One resolved entry as a comparison sees it: its value and the annotations written in front of it (§3.1). */
export interface ResolvedEntry {
  readonly value: Top;
  readonly annotations: readonly Annotation[];
}

/**
 * Reads a `class2/schema/` `valid` vector's `resolved` text -- a bare `!schema { name => value }`
 * namespace, each entry its value (`!record {...}`, `!reference {...}`, `!template {...}`), always
 * governed by meta.tn (`schema-sidecar.tn`'s own doc) -- into the entries it denotes.
 *
 * Each value is read through its own top-level call of the meta reader, keyed by the constructor
 * its `!type-ref` names, exactly as `definitionResolver.ts` reads a constructor application in a
 * schema source: that is what gives every nested constructor's declared field defaults and §5.6's
 * positional form a source to be read from. `governingMeta` is meta.tn's own linked entries.
 */
export function readResolved(
  resolvedText: string,
  governingMeta: ReadonlyMap<string, Top>,
): Map<string, ResolvedEntry> {
  const { document } = runSync(parseDocument(fromBytes(encodeUtf8(resolvedText))));
  const root = document.root.coreValue;
  if (root.kind !== 'map') {
    throw new Error(
      `expected a '!schema {...}' map at a resolved-schema vector's root, found core-value kind '${root.kind}'`,
    );
  }
  const lookup: DefinitionGetter = (name) => governingMeta.get(name);
  const reader = createDefinitionMetaReader(lookup);
  const result = new Map<string, ResolvedEntry>();
  for (const entry of root.entries) {
    const value = entry.value.value;
    if (value.typeRef === undefined) {
      throw new Error(
        `resolved entry '${tokenTextOf(entry.key)}' must carry its constructor as a !type-ref`,
      );
    }
    result.set(tokenTextOf(entry.key), {
      value: reader(value.typeRef, value),
      annotations: value.annotations.map((annotation) => ({
        name: annotation.name,
        ...(annotation.value === undefined ? {} : { value: annotation.value }),
      })),
    });
  }
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
 * A held template's text reduced to the structure it denotes. The kernel's `template` doc: what is
 * compared is the parsed form, never the text, so two spellings that differ in whitespace are one
 * template (Part 2 §5.10, §8.2). The reference's `ResolvedForm.parsedForComparison` does the same
 * on both sides.
 */
function parsedTemplate(text: string): string {
  const { document } = runSync(parseDocument(fromBytes(encodeUtf8(text))));
  return JSON.stringify(document.root, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
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
 * (whose text a fixture abbreviates) and `synthetic` (derived, recomputed on ingest -- §8.2), a
 * held template as the structure its text parses to, and a canonical rendering with every
 * resolver-minted name's content hash normalised (RUNNER.md rule 6, generalised) wherever it
 * appears.
 */
export function renderDefinition(entry: ResolvedEntry): string {
  const { value } = entry;
  const compared = {
    annotations: entry.annotations
      .filter((annotation) => annotation.name !== 'doc' && annotation.name !== 'synthetic')
      .map((annotation) => ({
        name: annotation.name,
        value: annotationValueText(annotation.value),
      })),
    value: isTemplateBody(value) ? { ...value, template: parsedTemplate(value.template) } : value,
  };
  return normalizeSyntheticNamesAnywhere(canonicalJson(compared));
}

/**
 * `linked`'s own entries -- the ones this schema declares itself, excluding whatever `!!import`
 * merged in -- keyed by their hash-normalised name. Mirrors the Java reference implementation's
 * `ResolvedForm.ownEntries`: a `class2/schema/valid` vector states only what its own subject
 * declares, never restating an imported schema's entries too.
 */
export function ownEntries(linked: LinkedSchema): Map<string, ResolvedEntry> {
  const selfId = canonicalizeIdentity(linked.id);
  const own = new Map<string, ResolvedEntry>();
  for (const [name, value] of linked.entries) {
    if (linked.origins.get(name) === selfId) {
      own.set(normalizeSyntheticName(name), {
        value,
        annotations: linked.facts.get(name)?.annotations ?? [],
      });
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
