/**
 * Tree mode's `record` reader -- reads a record-shaped value into a {@link RecordNode}, the port of
 * `RecordAbstractReader`/`RecordTreeReader` (`tson-compiler/.../reader/`). Everything the Java splits
 * across those two classes lives in this one factory function, since TypeScript has no "shared abstract
 * base, one subclass per output shape" need here -- tree mode is the only output shape this package
 * builds (bind mode is a separate work package, over the same {@link RecordBody}).
 *
 * **A field a read doesn't produce is simply omitted** (never a placeholder value) -- matching
 * `RecordNode`'s own frozen TSDoc ("a subsequent `get` of it yields `MissingNode`"): a missing REQUIRED
 * field is reported and then left out of the map exactly like a silently-omitted OPTIONAL one, the
 * diagnostic carrying what went wrong rather than the tree.
 *
 * **`typeRef` is this reader's own compiled `name`, not the wire token the document wrote** -- a
 * schema-driven record position always resolves to the schema's own name for the type in scope, mirroring
 * `RecordTreeReader.read`'s `new TsonRecord(result, Optional.of(name), annotations)`.
 */
import type { Task } from '../../io/bytes.js';
import type { Position } from '../../core/position.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { FieldGroup, FieldState, RecordBody, RecordField } from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode, recordNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipDataValue,
  skipScopedValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import { readSchemaLiteral, renderValue } from './support.js';

interface CompiledField {
  readonly schema: RecordField;
  readonly parser: TypeReader<Value>;
}

/** §5.2's sixth spelling (`type? = _`): nothing to parse, and the only conforming document omits the field or writes `_`. */
interface FixedCheck {
  readonly mustBeAbsent: boolean;
  readonly value: Value | undefined;
  readonly parser: TypeReader<Value>;
}

type Shape = 'fields' | 'empty' | 'positional' | 'mismatch';

function isFixedState(state: FieldState): boolean {
  return state === 'REQUIRED_FIXED' || state === 'OPTIONAL_FIXED';
}

/** A record's compiled field is looked up by an index this module itself derived (a schema-map count or a `fieldIndex` hit) -- never out of range in a correct build, so a miss is this module's own bug, not a document problem. */
function at<T>(array: readonly (T | undefined)[], index: number, what: string): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error(`internal error: no ${what} at index ${String(index)}`);
  }
  return value;
}

/**
 * Builds a `record` tree reader for one compiled schema entry.
 *
 * `resolveField` is asked once per field, at construction, for that field's own declared type's
 * reader -- the port of `RecordAbstractReader.FieldReaders.byType`, tree mode's only field-reader
 * strategy (object-binding mode, which additionally consults the bound component, is a separate work
 * package over the same {@link RecordBody}).
 */
export function recordTreeReader(
  name: string,
  displayName: string,
  body: RecordBody,
  resolveField: (field: RecordField) => TypeReader<Value>,
  schemaLocation: SchemaLocation,
): TypeReader<Value> {
  const fields: CompiledField[] = body.fields.map((schema) => ({
    schema,
    parser: resolveField(schema),
  }));
  const fieldIndex = new Map<string, number>();
  const groups: readonly FieldGroup[] = body.groups;
  const precomputedValue = new Array<Value | undefined>(fields.length);
  const fixedCheck = new Array<FixedCheck | undefined>(fields.length);
  let solePositionalField = -1;
  let bareRequiredCount = 0;

  fields.forEach((field, i) => {
    fieldIndex.set(field.schema.name, i);
    const state = field.schema.state;
    if (
      state === 'REQUIRED_DEFAULT' ||
      state === 'REQUIRED_FIXED' ||
      (state === 'OPTIONAL_FIXED' && field.schema.value !== undefined)
    ) {
      const token = field.schema.value;
      if (token === undefined) {
        throw new Error(
          `'${field.schema.name}' on '${displayName}' is ${state} but the schema carries no value for it -- the resolver should never produce this`,
        );
      }
      precomputedValue[i] = readSchemaLiteral(token, field.parser);
    }
    if (isFixedState(state)) {
      fixedCheck[i] = {
        mustBeAbsent: field.schema.value === undefined,
        value: precomputedValue[i],
        parser: field.parser,
      };
    }
    if (state === 'REQUIRED') {
      bareRequiredCount += 1;
      solePositionalField = i;
    }
  });

  const positionalFieldIndex = bareRequiredCount === 1 ? solePositionalField : -1;
  const declaredFields = fields.map((field) => field.schema.name).join(' | ');

  /**
   * Consumes leading annotations/type-ref, then decides the record's own shape -- the port of
   * `RecordAbstractReader.expectRecordShape`.
   */
  function* expectRecordShape(
    ctx: ReadContext,
  ): Task<{ shape: Shape; anchor: Position | undefined }> {
    yield* skipAnnotationsAndTypeRef(ctx);
    const e = yield* ctx.peek();
    const anchor = e.position;
    if (e.kind === 'record-start') {
      yield* ctx.next();
      return { shape: 'fields', anchor };
    }
    if (e.kind === 'empty-brace') {
      yield* ctx.next();
      return { shape: 'empty', anchor };
    }
    if (positionalFieldIndex >= 0) {
      return { shape: 'positional', anchor };
    }
    ctx.report(
      'TYPE_MISMATCH',
      `expected a record for '${displayName}', found ${describeEvent(e)}`,
      'a record',
      describeEvent(e),
    );
    yield* skipCoreValue(ctx);
    return { shape: 'mismatch', anchor };
  }

  /** The value a field takes when the document never mentioned it at all -- §5.2's five states, one place. */
  function valueForAbsentField(ctx: ReadContext, schemaIndex: number): Value | undefined {
    const schema = at(fields, schemaIndex, 'field').schema;
    switch (schema.state) {
      case 'REQUIRED':
        ctx
          .schemaField(schema.name)
          .report(
            'FIELD_REQUIRED',
            `missing required field '${schema.name}' for '${displayName}'`,
            `a value for '${schema.name}'`,
            '(absent)',
          );
        return undefined;
      case 'OPTIONAL':
        return undefined;
      case 'REQUIRED_DEFAULT':
      case 'REQUIRED_FIXED':
        return precomputedValue[schemaIndex];
      case 'OPTIONAL_FIXED':
        return undefined;
    }
  }

  /** The value a field takes when the document explicitly wrote `_` at it -- differs from omission only for `REQUIRED_DEFAULT` (§5.2). */
  function valueForStatedAbsentField(ctx: ReadContext, schemaIndex: number): Value | undefined {
    const schema = at(fields, schemaIndex, 'field').schema;
    if (schema.state === 'REQUIRED_DEFAULT') {
      ctx
        .schemaField(schema.name)
        .report(
          'ATOM_CONSTRAINT_VIOLATION',
          `'${schema.name}' on '${displayName}' is always filled from the schema and cannot be written '_' -- omit the field to take its default (§5.2)`,
          `the field omitted, or a value for '${schema.name}'`,
          '_',
        );
      return precomputedValue[schemaIndex];
    }
    return valueForAbsentField(ctx, schemaIndex);
  }

  /**
   * Checks a FIXED field the document actually stated, re-emitting the schema's own value for it
   * (§5.2). The document's token decides only whether the document is valid; it never becomes the
   * field's own value.
   */
  function* verifyFixed(
    ctx: ReadContext,
    schemaIndex: number,
    fieldName: string,
    sink: (schemaIndex: number, decoded: Value | undefined) => void,
  ): Task<void> {
    const maybeRef = yield* ctx.peek();
    if (maybeRef.kind === 'schema-ref') {
      yield* ctx.next();
    }
    const check = at(fixedCheck, schemaIndex, 'fixed-check');
    const schema = at(fields, schemaIndex, 'field').schema;
    const fieldCtx = ctx.schemaField(fieldName);
    const peeked = yield* ctx.peek();
    if (peeked.kind === 'absent') {
      yield* ctx.next();
      if (schema.state === 'REQUIRED_FIXED') {
        fieldCtx.report(
          'FIELD_FIXED',
          `'${fieldName}' is fixed on '${displayName}' and cannot be absent`,
          check.value === undefined ? '(none)' : renderValue(check.value),
          '_',
        );
      }
      return; // OPTIONAL_FIXED, valued or `= _`: absence is exactly what it permits
    }
    if (check.mustBeAbsent) {
      yield* skipDataValue(ctx);
      fieldCtx.report(
        'FIELD_FIXED',
        `'${fieldName}' is fixed to absent on '${displayName}' and may only be omitted or written as '_'`,
        '_',
        'a value',
      );
      return;
    }
    const before = ctx.reported();
    const written = yield* check.parser.read(fieldCtx);
    if (ctx.reported() > before) {
      // The token isn't a value of the field's own type at all, already reported against this path.
      return;
    }
    const fixedValue = check.value ?? absentNode();
    if (!valuesEqual(written, fixedValue)) {
      fieldCtx.report(
        'FIELD_FIXED',
        `'${fieldName}' is fixed on '${displayName}' and cannot be given another value -- the schema declares it with '=' (fixed); for a default the data may override, use '~'`,
        renderValue(fixedValue),
        renderValue(written),
      );
      return;
    }
    sink(schemaIndex, fixedValue);
  }

  /** Loops `field-name` events forward until `record-end` -- the port of `RecordAbstractReader.readFields`. */
  function* readFields(
    ctx: ReadContext,
    sink: (schemaIndex: number, decoded: Value | undefined) => void,
  ): Task<boolean[]> {
    const seen: boolean[] = new Array(fields.length).fill(false) as boolean[];
    for (;;) {
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'record-end') break;
      const fieldNameEvent = yield* ctx.next();
      if (fieldNameEvent.kind !== 'field-name') {
        throw new Error(`expected a field-name event, found '${fieldNameEvent.kind}'`);
      }
      const schemaIndex = fieldIndex.get(fieldNameEvent.name);
      if (schemaIndex === undefined) {
        ctx
          .field(fieldNameEvent.name)
          .report(
            'UNRECOGNIZED_FIELD',
            `unknown field '${fieldNameEvent.name}' on '${displayName}' -- a record is closed under its type (§7.2), whose fields are (${declaredFields})`,
            declaredFields,
            fieldNameEvent.name,
          );
        yield* skipScopedValue(ctx);
        continue;
      }
      if (seen[schemaIndex]) {
        ctx
          .schemaField(fieldNameEvent.name)
          .report(
            'DUPLICATE_FIELD',
            `duplicate field '${fieldNameEvent.name}' on '${displayName}' -- a record states each field at most once (§2.5), and the repeat states a value for nothing`,
            'each field stated once',
            `'${fieldNameEvent.name}' stated again`,
          );
      }
      if (fixedCheck[schemaIndex] !== undefined) {
        yield* verifyFixed(ctx, schemaIndex, fieldNameEvent.name, sink);
        seen[schemaIndex] = true;
        continue;
      }
      const maybeRef = yield* ctx.peek();
      if (maybeRef.kind === 'schema-ref') {
        yield* ctx.next();
      }
      const afterRef = yield* ctx.peek();
      let decoded: Value | undefined;
      if (afterRef.kind === 'absent') {
        yield* ctx.next();
        decoded = valueForStatedAbsentField(ctx, schemaIndex);
      } else {
        decoded = yield* at(fields, schemaIndex, 'field').parser.read(
          ctx.schemaField(fieldNameEvent.name),
        );
      }
      sink(schemaIndex, decoded);
      seen[schemaIndex] = true;
    }
    yield* ctx.next(); // record-end
    return seen;
  }

  /** {@link Shape} `'positional'`'s counterpart to {@link readFields} -- reads whatever's at the cursor directly as {@link positionalFieldIndex}'s own value. */
  function* readPositional(
    ctx: ReadContext,
    sink: (schemaIndex: number, decoded: Value | undefined) => void,
  ): Task<boolean[]> {
    const seen: boolean[] = new Array(fields.length).fill(false) as boolean[];
    const index = positionalFieldIndex;
    const field = at(fields, index, 'field');
    const decoded = yield* field.parser.read(ctx.schemaField(field.schema.name));
    sink(index, decoded);
    seen[index] = true;
    return seen;
  }

  /** Field-group presence check (§5.11): a bare group needs exactly one member present, a `?` group at most one. */
  function validateGroups(ctx: ReadContext, seen: readonly boolean[]): void {
    for (const group of groups) {
      let present = 0;
      for (const member of group.members) {
        const idx = fieldIndex.get(member);
        if (idx !== undefined && seen[idx]) present += 1;
      }
      const members = group.members.join(' | ');
      if (present > 1) {
        ctx.report(
          'TYPE_MISMATCH',
          `at most one of (${members}) may be present for '${displayName}', found ${String(present)}`,
          `at most one of (${members})`,
          `${String(present)} present`,
        );
      } else if (group.state === 'REQUIRED' && present === 0) {
        ctx.report(
          'FIELD_REQUIRED',
          `exactly one of (${members}) must be present for '${displayName}'`,
          `one of (${members})`,
          'none present',
        );
      }
    }
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const recordCtx = ctx.inRecord(schemaLocation);
      const annotations = yield* captureAnnotations(recordCtx);
      const shapeResult = yield* expectRecordShape(recordCtx);
      if (shapeResult.shape === 'mismatch') {
        return absentNode(undefined, annotations);
      }
      const result = new Map<string, Value>();
      const sink = (schemaIndex: number, decoded: Value | undefined): void => {
        if (decoded !== undefined) {
          result.set(at(fields, schemaIndex, 'field').schema.name, decoded);
        }
      };
      let seen: boolean[];
      switch (shapeResult.shape) {
        case 'fields':
          seen = yield* readFields(recordCtx, sink);
          break;
        case 'empty':
          seen = new Array(fields.length).fill(false) as boolean[];
          break;
        case 'positional':
          seen = yield* readPositional(recordCtx, sink);
          break;
      }
      const anchoredCtx = recordCtx.withPosition(shapeResult.anchor);
      for (let i = 0; i < fields.length; i += 1) {
        if (!seen[i]) {
          sink(i, valueForAbsentField(anchoredCtx, i));
        }
      }
      validateGroups(anchoredCtx, seen);
      return recordNode(result, name, annotations);
    },
  };
}
