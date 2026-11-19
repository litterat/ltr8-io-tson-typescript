/**
 * Conformance-harness bridge from the real {@link parseDocument} (Tier 3, `compiler/dataParser.ts`)
 * to the suite's own parser-sidecar shapes (`schemas/parser-sidecar.tn`). Pure reduction: every
 * `ast/value.ts` field this parser produces already has a same-named, same-shaped counterpart in
 * `sidecar.ts`'s `Expected*` types (that mirroring is deliberate on both sides — see `sidecar.ts`'s
 * own doc comment), so this module's job is only to turn `undefined` into an omitted optional
 * property (`exactOptionalPropertyTypes`) and to name the array-mapping glue.
 */

import { parseDocument as parseDataDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import type {
  Annotation,
  CoreValue,
  DataValue,
  Document,
  MapEntry,
  RecordField,
} from '../../packages/tson/src/ast/value.js';
import type {
  ApplicationReference,
  ReferenceArgument,
} from '../../packages/tson/src/ast/reference.js';
import type {
  ExpectedAnnotation,
  ExpectedCoreValue,
  ExpectedDataValue,
  ExpectedDocument,
  ExpectedMapEntry,
  ExpectedRecordField,
  ExpectedReferenceArgument,
} from './sidecar.js';

/**
 * Parses `subject`'s raw bytes into the suite's own {@link ExpectedDocument} shape (§2, §7.4).
 * Throws {@link TsonLexError}/{@link TsonParseError}/{@link TsonUnsupportedDocumentError} exactly
 * as {@link parseDataDocument} does, uncaught, for a parser-layer `error`/`schema-document` vector.
 */
export function parseDocument(subject: Uint8Array): ExpectedDocument {
  const { document } = runSync(parseDataDocument(fromBytes(subject)));
  return toExpectedDocument(document);
}

function toExpectedDocument(doc: Document): ExpectedDocument {
  return {
    ...(doc.id !== undefined ? { id: doc.id } : {}),
    imports: doc.imports,
    root: toExpectedDataValue(doc.root),
  };
}

function toExpectedDataValue(dv: DataValue): ExpectedDataValue {
  return {
    annotations: dv.annotations.map(toExpectedAnnotation),
    ...(dv.typeRef !== undefined ? { typeRef: dv.typeRef } : {}),
    core: toExpectedCoreValue(dv.coreValue),
  };
}

function toExpectedAnnotation(annotation: Annotation): ExpectedAnnotation {
  return {
    name: annotation.name,
    ...(annotation.value !== undefined ? { value: toExpectedDataValue(annotation.value) } : {}),
  };
}

function toExpectedRecordField(field: RecordField): ExpectedRecordField {
  return { name: field.name, value: toExpectedDataValue(field.value) };
}

function toExpectedMapEntry(entry: MapEntry): ExpectedMapEntry {
  return { key: toExpectedDataValue(entry.key), value: toExpectedDataValue(entry.value) };
}

function toExpectedCoreValue(core: CoreValue): ExpectedCoreValue {
  switch (core.kind) {
    case 'token':
      return { kind: 'token', form: core.form, text: core.text };
    case 'reference':
      // A sibling reference has no member in `parser-sidecar.tn`'s `reference_core`, so it reduces
      // to its own text: a vector expecting one would have nothing to state it with.
      return core.reference.kind === 'sibling'
        ? { kind: 'reference', name: `${core.reference.field}!`, arguments: [] }
        : toExpectedReference(core.reference);
    case 'void':
      return { kind: 'absent' };
    case 'empty-brace':
      return { kind: 'empty-brace' };
    case 'record':
      return { kind: 'record', fields: core.fields.map(toExpectedRecordField) };
    case 'map':
      return { kind: 'map', entries: core.entries.map(toExpectedMapEntry) };
    case 'array':
      return { kind: 'array', elements: core.elements.map(toExpectedDataValue) };
  }
}

function toExpectedReference(reference: ApplicationReference): {
  readonly kind: 'reference';
  readonly name: string;
  readonly arguments: readonly ExpectedReferenceArgument[];
} {
  return {
    kind: 'reference',
    name: reference.name,
    arguments: reference.arguments.map(toExpectedArgument),
  };
}

function toExpectedArgument(argument: ReferenceArgument): ExpectedReferenceArgument {
  if (argument.kind === 'value') {
    return { kind: 'token', form: argument.form, text: argument.text };
  }
  const reference = argument.reference;
  // A qualified name without arguments is a token in the grammar's own terms (§7.4).
  return reference.kind === 'name'
    ? { kind: 'token', form: 'unquoted', text: reference.name }
    : toExpectedReference(reference);
}
