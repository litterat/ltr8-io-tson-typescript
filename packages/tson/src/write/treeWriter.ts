/**
 * Writes an immutable `tree/nodes.ts` {@link Value} tree back to TSON text -- the write-side
 * counterpart to `reader/tree/`/`reader/schemaless/tree.ts`, and the tree analogue of
 * `bindingWriter.ts` (which writes a bound host object graph). The port of `TsonTreeWriter.java`.
 *
 * **Closer to lossless than `bindingWriter.ts`**, because a tree node already carries its own
 * type-ref when it has one: an `AtomNode` typed `int32` writes back as `!int32 42`, so the
 * integer width survives a read/write/re-read round trip (a bound plain `number` has no such
 * memory once decoded -- see `atomFraming.ts`'s own top note on why that specific ambiguity is
 * this port's, not the reference's). **Round trip here is value-preserving, not byte-identical**
 * (matching `TsonTreeWriter.java`'s own doc): a vocabulary value is always written quoted with its
 * type-ref, whichever way the source spelled it, and a node re-read from the result yields an
 * equal tree, not necessarily the original bytes -- `astWriter.ts` is the syntax-exact writer,
 * this one is the value-exact one.
 *
 * **Wire annotations are re-emitted** (§3.1), ahead of each value's type-ref and in the order the
 * tree holds them, repeats included, so a schemalessly-read tree survives a read/write/read round
 * trip with its metadata intact and not just its values. An annotation's own value is an
 * `ast.DataValue` (`tree/nodes.ts` has nowhere else to put one -- `reader/tree/annotations.ts`'s
 * own note explains why), so it is written through `astWriter.ts`'s {@link writeDataValueTo}
 * rather than through this module's own node writer.
 *
 * A {@link MissingNode} is a navigation artifact, not a value (`tree/nodes.ts`'s own doc); writing
 * one is a programming error, {@link TsonWriteError} here rather than the silent nonsense of
 * emitting its RFC 6901 pointer as if it were data.
 */
import type { Annotations } from '../annotations/index.js';
import { TsonWriteError } from '../core/errors.js';
import type { AtomNode, MapNode, RecordNode, TsonDocument, Value } from '../tree/nodes.js';
import { writeDataValueTo } from './astWriter.js';
import { formatDefaultAtom, formatKnownAtom, type AtomText } from './atomFraming.js';
import type { Emitter, TextSink } from './emitter.js';
import { createEmitter, stringSink } from './emitter.js';

/** The type-ref a value carries for the header's own "does the root name a type?" check -- `undefined` for a {@link MissingNode}, which carries none. */
function rootTypeRef(value: Value): string | undefined {
  return value.kind === 'missing' ? undefined : value.typeRef;
}

/**
 * Writes `document`'s header (`!!id`/`!!schema`, §2.2) and its root value into `out`.
 *
 * A document declaring `!!schema` needs a root type-ref to select a type against it -- a root
 * with none (a hand-built node, or one from a schemaless read of an untagged document) would make
 * a document that declares a schema and then gives a reader no type to dispatch on, so this
 * refuses rather than half-writing it. Mirrors `TsonTreeWriter.write`'s own check, run before any
 * header text is emitted so a caller sees the failure with nothing partially written.
 */
export function writeTreeTo(document: TsonDocument, out: Emitter): void {
  if (document.schema !== undefined && rootTypeRef(document.root) === undefined) {
    throw new TsonWriteError(
      `a document declaring !!schema "${document.schema}" needs a root type-ref to select a ` +
        'type, and this root value carries none -- set one on the root before writing',
    );
  }
  if (document.id !== undefined) out.documentId(document.id);
  if (document.schema !== undefined) out.schemaRef(document.schema);
  writeValueTo(document.root, out);
}

/** {@link writeTreeTo} into a fresh `string`. */
export function writeTree(document: TsonDocument): string {
  const { sink, result } = stringSink();
  writeTreeTo(document, createEmitter(sink));
  return result();
}

/** {@link writeTreeTo} into any {@link TextSink}. */
export function writeTreeToSink(document: TsonDocument, sink: TextSink): void {
  writeTreeTo(document, createEmitter(sink));
}

/** Writes `value` alone, with no document header -- {@link writeTreeTo} without the `!!id`/`!!schema` framing. */
export function writeTreeValueTo(value: Value, out: Emitter): void {
  writeValueTo(value, out);
}

/** {@link writeTreeValueTo} into a fresh `string`. */
export function writeTreeValue(value: Value): string {
  const { sink, result } = stringSink();
  writeTreeValueTo(value, createEmitter(sink));
  return result();
}

function writeValueTo(value: Value, out: Emitter): void {
  if (value.kind === 'missing') {
    throw new TsonWriteError(
      `a MissingNode is a navigation artifact and cannot be written as TSON; navigation failed ` +
        `at "${value.path}"`,
    );
  }
  writeAnnotationsTo(value.annotations, out);
  switch (value.kind) {
    case 'record':
      writeRecordTo(value, out);
      break;
    case 'map':
      writeMapTo(value, out);
      break;
    case 'array':
      writeSequenceTo(value.elements, value.typeRef, out);
      break;
    case 'tuple':
      writeSequenceTo(value.elements, value.typeRef, out);
      break;
    case 'atom':
      writeAtomTo(value, out);
      break;
    case 'absent':
      if (value.typeRef !== undefined) out.typeRef(value.typeRef);
      out.absentValue();
      break;
  }
}

/**
 * A value's own annotations, ahead of its type-ref and core-value -- the order §7.4's
 * `data-value = *annotation [type-ref] core-value` fixes, which is why this runs first in
 * {@link writeValueTo} rather than inside each shape's own writer. Order and repeats are
 * preserved as the tree holds them.
 */
function writeAnnotationsTo(annotations: Annotations, out: Emitter): void {
  for (const ann of annotations.values) {
    if (ann.value !== undefined) {
      out.beginAnnotation(ann.name);
      writeDataValueTo(ann.value, out);
      out.endAnnotation();
    } else {
      out.annotation(ann.name);
    }
  }
}

function writeRecordTo(node: RecordNode, out: Emitter): void {
  if (node.typeRef !== undefined) out.typeRef(node.typeRef);
  out.beginRecord();
  for (const [name, fieldValue] of node.fields) {
    out.field(name);
    writeValueTo(fieldValue, out);
  }
  out.endRecord();
}

function writeMapTo(node: MapNode, out: Emitter): void {
  if (node.typeRef !== undefined) out.typeRef(node.typeRef);
  out.beginMap();
  for (const entry of node.entries) {
    out.beforeMapEntry();
    writeValueTo(entry.key, out);
    out.mapArrow();
    writeValueTo(entry.value, out);
  }
  out.endMap();
}

/** Arrays and tuples share the `[ ... ]` shape (§2.7); a tuple keeps its type-ref, if any. */
function writeSequenceTo(
  elements: readonly Value[],
  typeRef: string | undefined,
  out: Emitter,
): void {
  if (typeRef !== undefined) out.typeRef(typeRef);
  out.beginArray();
  for (const element of elements) {
    out.beforeArrayElement();
    writeValueTo(element, out);
  }
  out.endArray();
}

/**
 * A node's own type-ref, when it names a built-in vocabulary type, formats its value exactly as
 * that type's own atom would (`atomFraming.ts`'s stage 1); otherwise this value's own runtime
 * shape decides (stage 2), still under the node's type-ref if it carried one the vocabulary
 * simply didn't recognise -- preserving a type annotation this package cannot resolve is §3.2's
 * own requirement, not an accident of this fallback.
 */
function formatAtomNode(node: AtomNode): AtomText {
  if (node.typeRef !== undefined) {
    const known = formatKnownAtom(node.typeRef, node.value);
    if (known !== undefined) return known;
  }
  const fallback = formatDefaultAtom(node.value);
  return node.typeRef !== undefined ? { ...fallback, typeRef: node.typeRef } : fallback;
}

function writeAtomTo(node: AtomNode, out: Emitter): void {
  const formatted = formatAtomNode(node);
  if (formatted.typeRef !== undefined) out.typeRef(formatted.typeRef);
  if (formatted.quoted) {
    out.quotedString(formatted.text);
  } else {
    out.unquotedToken(formatted.text);
  }
}
