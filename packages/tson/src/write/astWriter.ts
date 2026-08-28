/**
 * Writes a parsed `ast/value.ts` value back as the source it was parsed from -- the return leg
 * `compiler/dataParser.ts` never had. The port of `AstWriter.java`.
 *
 * **The only writer in this package that writes syntax.** {@link writeTreeTo} (`treeWriter.ts`)
 * writes a `tree.Value` and {@link writeBindingTo} (`bindingWriter.ts`) a bound host value, both
 * of which describe a *value* and are free to choose how to spell it; an AST records what an
 * author wrote, including the choices a value no longer remembers -- which token was quoted, what
 * a record's field order was -- so this puts them back rather than deciding them again. Every
 * token is re-emitted with its own captured {@link TokenValue.text}/{@link TokenValue.form}
 * unchanged, so this module never has to make a single formatting decision (no quoting rule, no
 * numeric reformatting) -- which is exactly what makes **parse, then write, then re-parse** a
 * value-and-syntax-preserving round trip for any document this package can already read: the free
 * round-trip cases `PORT-PLAN.md`'s work package brief asks for.
 */
import type {
  Annotation,
  ArrayValue,
  CoreValue,
  DataValue,
  Document,
  MapEntry,
  RecordValue,
  ScopedValue,
} from '../ast/value.js';
import { TsonInternalError } from '../core/errors.js';
import type { Emitter, TextSink } from './emitter.js';
import { createEmitter, stringSink } from './emitter.js';

/** `document = [id-directive] ws data-doc` (§2.2, §7.4), written into `out`. */
export function writeDocumentTo(document: Document, out: Emitter): void {
  if (document.id !== undefined) out.documentId(document.id);
  if (document.schema !== undefined) out.schemaRef(document.schema);
  writeDataValueTo(document.root, out);
}

/** {@link writeDocumentTo} into a fresh `string`. */
export function writeDocument(document: Document): string {
  const { sink, result } = stringSink();
  writeDocumentTo(document, createEmitter(sink));
  return result();
}

/** {@link writeDocumentTo} into any {@link TextSink}. */
export function writeDocumentToSink(document: Document, sink: TextSink): void {
  writeDocumentTo(document, createEmitter(sink));
}

/** `data-value = *annotation [type-ref] core-value` (§2.3, §7.4), annotations and type-ref first. */
export function writeDataValueTo(value: DataValue, out: Emitter): void {
  writeAnnotationsTo(value.annotations, out);
  if (value.typeRef !== undefined) out.typeRef(value.typeRef);
  writeCoreValueTo(value.coreValue, out);
}

/** {@link writeDataValueTo} into a fresh `string`. */
export function writeDataValue(value: DataValue): string {
  const { sink, result } = stringSink();
  writeDataValueTo(value, createEmitter(sink));
  return result();
}

function writeAnnotationsTo(annotationList: readonly Annotation[], out: Emitter): void {
  for (const ann of annotationList) {
    if (ann.value !== undefined) {
      out.beginAnnotation(ann.name);
      writeDataValueTo(ann.value, out);
      out.endAnnotation();
    } else {
      out.annotation(ann.name);
    }
  }
}

function writeCoreValueTo(value: CoreValue, out: Emitter): void {
  switch (value.kind) {
    case 'token':
      // The form is put back as it was found. A quoted token and an unquoted one denote the same
      // value under a schema (§4.4), so a writer that chose for itself would be within its rights
      // about the value and wrong about the source.
      switch (value.form) {
        case 'unquoted':
          out.unquotedToken(value.text);
          break;
        case 'single-line':
          out.quotedString(value.text);
          break;
        case 'multi-line':
          out.multiLineString(value.text);
          break;
      }
      break;
    case 'record':
      writeRecordTo(value, out);
      break;
    case 'map':
      out.beginMap();
      for (const entry of value.entries) {
        writeMapEntryTo(entry, out);
      }
      out.endMap();
      break;
    case 'array':
      writeArrayTo(value, out);
      break;
    case 'absent':
      out.absentValue();
      break;
    case 'empty-brace':
      // `{}` is the empty container of whatever the position's own type is (§2.8), and it is
      // spelled the same way whichever that turns out to be.
      out.beginRecord();
      out.endRecord();
      break;
    default:
      throw new TsonInternalError(`unreachable core-value kind`);
  }
}

function writeRecordTo(value: RecordValue, out: Emitter): void {
  out.beginRecord();
  for (const field of value.fields) {
    out.field(field.name);
    writeScopedValueTo(field.value, out);
  }
  out.endRecord();
}

function writeMapEntryTo(entry: MapEntry, out: Emitter): void {
  out.beforeMapEntry();
  writeDataValueTo(entry.key, out);
  out.mapArrow();
  writeScopedValueTo(entry.value, out);
}

function writeArrayTo(value: ArrayValue, out: Emitter): void {
  out.beginArray();
  for (const element of value.elements) {
    out.beforeArrayElement();
    writeScopedValueTo(element, out);
  }
  out.endArray();
}

/** A scoped value keeps its `!!schema` reference, which is part of the source too. */
function writeScopedValueTo(value: ScopedValue, out: Emitter): void {
  if (value.schemaRef !== undefined) out.schemaRef(value.schemaRef);
  writeDataValueTo(value.value, out);
}
