/**
 * A resolved schema written as the data value §8.1 specifies: the root `!schema` map, each entry its
 * value -- a type under the constructor that built it (`!meta.record { ... }`, `!numeric.integer_type { ... }`),
 * a value entry under its type -- and each nested schema map written nested and tagged `!meta.schema`,
 * its members named by their own names beneath it. One namespace holds every declaration under its path
 * (§2.2.3), so this is where the paths fold back into the nesting the document wrote.
 *
 * **The applied constructor is the entry's fact, never a guess from the body's shape.** `set_type`
 * restates `array`'s fields, and `enum` and `enum_type` share one body shape, so a body written under
 * `headed(body, head)` names the constructor its entry's facts record (`schema/bindings.ts`); a body with
 * no recorded head is written under its base constructor.
 *
 * **Key annotations are written as the document would carry them** (§6): each author-written one, then
 * the derived `@meta.completion` (`{ of: [...] }`, §8.1) and `@meta.application` (`{ head: …  arguments: […]
 * }`, §8.2). A value-position annotation (§3.1) stands in front of the value it annotates.
 *
 * **A resolved form holds complete entries only** (§8.1): an incomplete entry, and an alias whose chain ends at
 * one, is held in the namespace and written in no resolved form.
 */
import { runSync, fromString } from '../io/bytes.js';
import { parseDocument } from '../compiler/dataParser.js';
import { toDataValue } from '../bind/encode.js';
import { writeTreeValue } from '../write/treeWriter.js';
import { defaultAtomEncoder } from '../write/bindingWriter.js';
import type { AtomEncoder } from '../bind/encode.js';
import type { CoreValue, DataValue } from '../ast/value.js';
import type { Value } from '../tree/nodes.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { isQualifiedName } from '../atom/referenceGrammar.js';
import type {
  Annotation,
  Annotations,
  ApplyBody,
  Completion,
  EntryFacts,
  Top,
} from './meta/typedef.js';
import { isNestedMap, isPath, memberName, parentPath } from './meta/schemaPaths.js';
import { isValueEntry } from './meta/typedef.js';
import { applyBodyBinding, headed, topBinding } from './bindings.js';
import { metaDataValue } from './namespaceReader.js';
import { TsonInternalError } from '../core/errors.js';

/** What a resolved-output write reads of a schema: its entries by path and the facts beside each. */
export interface ResolvedSchemaView {
  readonly entries: ReadonlyMap<string, Top>;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  readonly keyAnnotations: ReadonlyMap<string, Annotations>;
}

/** What a resolved-output write includes. */
export interface ResolvedOutputOptions {
  /**
   * The entries to write, by path. Absent, every entry of the schema; a linked schema's closure holds its
   * imports' entries too, and a resolved form states only what its own document declares.
   */
  readonly own?: (path: string) => boolean;
}

/** The nested-map holder `path` stands for is written with its members; a path with no holder is written as an entry of the root. */
export function resolvedOutput(
  schema: ResolvedSchemaView,
  options: ResolvedOutputOptions = {},
): DataValue {
  const own = options.own ?? ((): boolean => true);
  const members = new Map<string, string[]>();
  for (const [path, value] of schema.entries) {
    if (!own(path) || isIncompleteHop(schema, value)) continue;
    const parent = parentPath(path);
    const siblings = members.get(parent);
    if (siblings === undefined) members.set(parent, [path]);
    else siblings.push(path);
  }
  const writeEntries = (parent: string): CoreValue => ({
    kind: 'map',
    entries: (members.get(parent) ?? []).map((path) => {
      const value = schema.entries.get(path);
      if (value === undefined) throw new TsonInternalError(`'${path}' has no entry`);
      return {
        key: keyOf(schema, path, isPath(path) ? memberName(path) : path),
        value: isNestedMap(value)
          ? { annotations: [], typeRef: 'meta.schema', coreValue: writeEntries(path) }
          : valueOf(schema, path, value),
      };
    }),
  });
  return { annotations: [], typeRef: 'schema', coreValue: writeEntries('') };
}

/** Whether `value` is an incomplete entry, or an alias whose chain ends at one: written in no resolved form. */
function isIncompleteHop(schema: ResolvedSchemaView, value: Top): boolean {
  const seen = new Set<Top>();
  let current: Top | undefined = value;
  while (current !== undefined && !seen.has(current)) {
    if (current.kind === 'incomplete') return true;
    if (current.kind !== 'alias') return false;
    seen.add(current);
    current = schema.entries.get(current.target.name);
  }
  return false;
}

/** An entry's key: its name, with the annotations written at it and the derived ones (§6, §8.1, §8.2). */
function keyOf(schema: ResolvedSchemaView, path: string, name: string): DataValue {
  const annotations: Annotation[] = [...(schema.keyAnnotations.get(path) ?? [])];
  return {
    annotations: annotations.map(writtenAnnotation),
    coreValue: {
      kind: 'token',
      text: name,
      form: isIdentifierText(name) ? 'unquoted' : 'single-line',
    },
  };
}

/** An entry's value: the body under the constructor that built it, with its own annotations in front (§3.1). */
function valueOf(schema: ResolvedSchemaView, path: string, value: Top): DataValue {
  const facts = schema.facts.get(path);
  const written: DataValue = isValueEntry(value)
    ? { ...metaDataValue(value.value), typeRef: value.type }
    : toDataValue(topBinding, headed(value, facts?.head), resolvedAtomEncoder);
  if (facts?.annotations === undefined || facts.annotations.length === 0) {
    return written;
  }
  return { ...written, annotations: [...facts.annotations.map(writtenAnnotation)] };
}

/**
 * How a resolved body's atoms are spelled (§8.1): a reference as the data grammar spells one, a closed
 * enumeration's member (`FIXED`, `NFC`), a name and a number bare, and free `text` quoted unless it is a
 * plain lexeme -- so `optional: true` and `spec: "https://..."` each read back as what they were. Every
 * other atom takes the writer's default.
 */
const resolvedAtomEncoder: AtomEncoder = (binding, value) => {
  if (typeof value === 'string' && binding.wireType !== 'type_ref') {
    return {
      kind: 'token',
      text: value,
      form: binding.wireType === 'text' && !isPlainLexeme(value) ? 'single-line' : 'unquoted',
    };
  }
  if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number') {
    return { kind: 'token', text: String(value), form: 'unquoted' };
  }
  return defaultAtomEncoder(binding, value);
};

/** A lexeme written bare: ASCII letters, digits and `_`, not led by a digit, and not `_` alone, the void sentinel (§2.4). */
function isPlainLexeme(text: string): boolean {
  if (text.length === 0 || text === '_') return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    const digit = code >= 48 && code <= 57;
    if (!(letter || (digit && i > 0))) return false;
  }
  return true;
}

/** An annotation as the document writes it: the name, and the value where it has one. */
function writtenAnnotation(annotation: Annotation): { name: string; value?: DataValue } {
  const value = annotationData(annotation.value);
  return value === undefined ? { name: annotation.name } : { name: annotation.name, value };
}

/** An annotation's value as data: whatever form its reader left it in, to the token or reference it was. */
function annotationData(value: unknown): DataValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null && 'coreValue' in value) {
    return value as DataValue;
  }
  // `@meta.application`'s value, a `meta.apply` (§8.2).
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'apply'
  ) {
    const written = toDataValue(applyBodyBinding, value as ApplyBody, resolvedAtomEncoder);
    return { annotations: [], coreValue: written.coreValue };
  }
  // `@meta.completion`'s value, `{ of: [text; 1..] }` (§8.1).
  if (
    typeof value === 'object' &&
    value !== null &&
    !('kind' in value) &&
    Array.isArray((value as { of?: unknown }).of)
  ) {
    return {
      annotations: [],
      coreValue: {
        kind: 'record',
        fields: [
          {
            name: 'of',
            value: {
              annotations: [],
              coreValue: {
                kind: 'array',
                elements: (value as Completion).of.map((name) => nameToken(name)),
              },
            },
          },
        ],
      },
    };
  }
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const node = value as Value;
    if (node.kind === 'void') return { annotations: [], coreValue: { kind: 'void' } };
    if (node.kind === 'atom' && typeof node.value !== 'object') return tokenOf(String(node.value));
    return runSync(parseDocument(fromString(writeTreeValue(node)))).document.root;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return tokenOf(String(value));
  }
  return undefined;
}

/** A name as one token, bare where every segment is an identifier (`meta.set_type`), quoted otherwise. */
function nameToken(name: string): DataValue {
  return {
    annotations: [],
    coreValue: {
      kind: 'token',
      text: name,
      form: isQualifiedName(name) ? 'unquoted' : 'single-line',
    },
  };
}

function tokenOf(text: string): DataValue {
  return {
    annotations: [],
    coreValue: { kind: 'token', text, form: isIdentifierText(text) ? 'unquoted' : 'single-line' },
  };
}
