/**
 * Tree mode's `record` reader -- reads a record-shaped value into a {@link RecordNode}, the port of
 * `RecordAbstractReader`/`RecordTreeReader` (`tson-compiler/.../reader/`). Everything the Java splits
 * across those two classes lives in this one factory function, since TypeScript has no "shared abstract
 * base, one subclass per output shape" need here -- tree mode is the only output shape this package
 * builds (bind mode is a separate work package, over the same {@link RecordBody}).
 *
 * **The read is all-or-nothing.** A missing REQUIRED field, a stray or repeated name, or a group
 * violation is reported same as ever, but reporting anything abandons the whole record rather than
 * building a partial one around the gap -- `support.ts`'s own `abandonedValue`, the tree-mode
 * reading of the reference implementation's `ConstructionGuard`. A field this reader *does*
 * produce is never a placeholder either way, matching `RecordNode`'s own frozen TSDoc ("a
 * subsequent `get` of it yields `MissingNode`").
 *
 * **`typeRef` is this reader's own compiled `name`, not the wire token the document wrote** -- a
 * schema-driven record position always resolves to the schema's own name for the type in scope, mirroring
 * `RecordTreeReader.read`'s `new TsonRecord(result, Optional.of(name), annotations)`.
 */
import type { Task } from '../../io/bytes.js';
import type { Position } from '../../core/position.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import {
  fieldOmission,
  groupRefusals,
  isGroupMember,
  type FieldGroup,
  type RecordBody,
  type RecordField,
} from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { absentNode, recordNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  refuseUnscopedSchemaRef,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipScopedValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import { abandonedValue, readSchemaLiteral, renderValue } from './support.js';

interface CompiledField {
  readonly schema: RecordField;
  readonly parser: TypeReader<Value>;
  /** Whether this field's own declared type resolves to a `scoped` instance (§7.8) -- whether a nested `!!schema` may stand at this field's value at all. */
  readonly scoped: boolean;
}

/**
 * A FIXED field's own check (§5.2): `role: 'FIXED'` fields are never voidable (a pin on a
 * voidable type is a resolver error), so a written `_` at one is always refused, never a second
 * spelling of the pin.
 */
interface FixedCheck {
  readonly value: Value | undefined;
  readonly parser: TypeReader<Value>;
}

type Shape = 'fields' | 'empty' | 'positional' | 'mismatch';

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
 * package over the same {@link RecordBody}). `isScopedType` answers §7.8's typed-position question
 * for one field's own declared type, once, at the same construction step.
 */
export function recordTreeReader(
  name: string,
  displayName: string,
  body: RecordBody,
  resolveField: (field: RecordField) => TypeReader<Value>,
  schemaLocation: SchemaLocation,
  isScopedType: (typeName: string) => boolean,
): TypeReader<Value> {
  const fields: CompiledField[] = body.fields.map((schema) => ({
    schema,
    parser: resolveField(schema),
    scoped: isScopedType(schema.type.name),
  }));
  const fieldIndex = new Map<string, number>();
  const groups: readonly FieldGroup[] = body.groups;
  const precomputedValue = new Array<Value | undefined>(fields.length);
  const fixedCheck = new Array<FixedCheck | undefined>(fields.length);
  // §5.11: a field-group member's omission is the group's, never the field's own -- computed once
  // here so {@link valueForMissingField}/{@link valueForStatedVoidField} can pass it through to
  // {@link fieldOmission} without walking `groups` on every field.
  const memberOfGroup = fields.map((field) => isGroupMember(groups, field.schema.name));
  let solePositionalField = -1;
  let bareRequiredCount = 0;

  fields.forEach((field, i) => {
    fieldIndex.set(field.schema.name, i);
    const role = field.schema.role;
    if (role !== 'FREE') {
      const token = field.schema.value;
      if (token === undefined) {
        throw new Error(
          `'${field.schema.name}' on '${displayName}' has role ${role} but the schema carries no ` +
            'value for it -- the resolver should never produce this (§8.1: value is present ' +
            "exactly when role is not 'FREE')",
        );
      }
      precomputedValue[i] = readSchemaLiteral(token, field.parser);
    }
    if (role === 'FIXED') {
      fixedCheck[i] = { value: precomputedValue[i], parser: field.parser };
    }
    // §5.6's positional form counts fields whose NAME is unmarked, whatever their modifier: a
    // voidable field must still be written, and so must a marker.
    if (!field.schema.optional) {
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

  /**
   * The value a field takes when the document never mentioned it at all -- §5.2's one derivation
   * ({@link fieldOmission}), applied.
   */
  function valueForMissingField(ctx: ReadContext, schemaIndex: number): Value | undefined {
    const schema = at(fields, schemaIndex, 'field').schema;
    switch (fieldOmission(schema, at(memberOfGroup, schemaIndex, 'memberOfGroup'))) {
      case 'MISSING':
        ctx
          .schemaField(schema.name)
          .report(
            'FIELD_REQUIRED',
            `missing required field '${schema.name}' for '${displayName}'`,
            `a value for '${schema.name}'`,
            '(missing)',
          );
        return undefined;
      case 'ABSENT':
        return undefined;
      case 'INJECTED':
        return precomputedValue[schemaIndex];
    }
  }

  /**
   * The value a field takes when the document explicitly wrote `_` at it. Never reached for a
   * `role: 'FIXED'` field -- {@link readFields} routes those through {@link verifyFixed} before a
   * value is even peeked, and a FIXED field is never voidable (§5.2's own refusal), so this
   * function's own `role` is always `'FREE'` or `'DEFAULT'`.
   *
   * Admitted exactly when `voidable` (§2.9: present with an absent value, distinct from never
   * written); refused everywhere else, split by `role` on the same terms the JSON encoding's own
   * `json/schema/record.ts#statedNull` already does, both ports of the reference's one shared
   * `RecordDiagnostics.absenceAtRequiredField`/`absenceAtDefaultedField` ([TSON-JSON] §9.4: one
   * diagnostic vocabulary, no category of its own): `role: 'DEFAULT'` (`a?: T ~ v`) is
   * `ATOM_CONSTRAINT_VIOLATION`, since §5.2 makes omission the injection route and the fix is to
   * omit the field rather than disclaim its value; `role: 'FREE'` -- required or merely optional,
   * §5.2's other non-voidable case -- is `FIELD_REQUIRED`, "admits no absence", matching what an
   * *omitted* FREE field already reports ({@link readFields}'s own `FIELD_REQUIRED` for a missing
   * required field) rather than the DEFAULT field's own constraint-violation reading.
   */
  function valueForStatedVoidField(ctx: ReadContext, schemaIndex: number): Value | undefined {
    const schema = at(fields, schemaIndex, 'field').schema;
    if (schema.voidable) {
      return absentNode();
    }
    const omission = fieldOmission(schema, at(memberOfGroup, schemaIndex, 'memberOfGroup'));
    if (schema.role === 'DEFAULT') {
      ctx
        .schemaField(schema.name)
        .report(
          'ATOM_CONSTRAINT_VIOLATION',
          `'${schema.name}' on '${displayName}' is always filled from the schema and cannot be ` +
            `written as absent -- omit the field to take its default (§5.2)`,
          `the field omitted, or a value for '${schema.name}'`,
          '_',
        );
      return omission === 'INJECTED' ? precomputedValue[schemaIndex] : undefined;
    }
    // `role: 'FREE'` never carries a default, so `omission` here is always `'MISSING'` (required)
    // or `'ABSENT'` (optional) -- never `'INJECTED'`, which is `fieldOmission`'s own DEFAULT-role
    // case handled in the branch above.
    ctx
      .schemaField(schema.name)
      .report(
        'FIELD_REQUIRED',
        `'${schema.name}' on '${displayName}' admits no absence (§5.2)`,
        `a value for '${schema.name}'`,
        '_',
      );
    return undefined;
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
    const field = at(fields, schemaIndex, 'field');
    const fieldCtx = ctx.schemaField(fieldName);
    yield* refuseUnscopedSchemaRef(fieldCtx, field.scoped, field.schema.type.name);
    const check = at(fixedCheck, schemaIndex, 'fixed-check');
    const peeked = yield* ctx.peek();
    if (peeked.kind === 'absent') {
      yield* ctx.next();
      // §5.2: a pin on a voidable type is refused at the schema, so a FIXED field is never
      // voidable -- a written `_` is always refused here, never a second spelling of the pin.
      fieldCtx.report(
        'FIELD_FIXED',
        `'${fieldName}' is fixed on '${displayName}' and is not voidable, so it cannot be written '_' (§5.2)`,
        check.value === undefined ? '(none)' : renderValue(check.value),
        '_',
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
    // Every undeclared field name met so far -- tracked so a *repeated* undeclared name reports
    // `DUPLICATE_FIELD` at its second occurrence rather than a second `UNRECOGNIZED_FIELD`.
    // [TSON-DATA] §2.5's duplicate-field rule is name identity, not "identity among declared
    // fields": `seen` (below) already gives declared fields this; an undeclared name needs its
    // own set since it has no `schemaIndex` to key `seen` by.
    const seenUnmatched = new Set<string>();
    for (;;) {
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'record-end') break;
      const fieldNameEvent = yield* ctx.next();
      if (fieldNameEvent.kind !== 'field-name') {
        throw new Error(`expected a field-name event, found '${fieldNameEvent.kind}'`);
      }
      const schemaIndex = fieldIndex.get(fieldNameEvent.name);
      if (schemaIndex === undefined) {
        if (seenUnmatched.has(fieldNameEvent.name)) {
          ctx
            .field(fieldNameEvent.name)
            .report(
              'DUPLICATE_FIELD',
              `duplicate field '${fieldNameEvent.name}' on '${displayName}' -- a record states each field at most once (§2.5), and the repeat states a value for nothing`,
              'each field stated once',
              `'${fieldNameEvent.name}' stated again`,
            );
          yield* skipScopedValue(ctx);
          continue;
        }
        seenUnmatched.add(fieldNameEvent.name);
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
      const field = at(fields, schemaIndex, 'field');
      const fieldCtx = ctx.schemaField(fieldNameEvent.name);
      yield* refuseUnscopedSchemaRef(fieldCtx, field.scoped, field.schema.type.name);
      const valuePeek = yield* ctx.peek();
      let decoded: Value | undefined;
      if (valuePeek.kind === 'absent') {
        yield* ctx.next();
        decoded = valueForStatedVoidField(ctx, schemaIndex);
      } else {
        decoded = yield* field.parser.read(fieldCtx);
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

  /** Field-group presence check (§5.11, {@link groupViolations}): one option chosen, or at most one under `?`, and a chosen option holds every unmarked member. */
  function validateGroups(ctx: ReadContext, seen: readonly boolean[]): void {
    const isPresent = (member: string): boolean => {
      const idx = fieldIndex.get(member);
      return idx !== undefined && seen[idx] === true;
    };
    for (const group of groups) {
      for (const refusal of groupRefusals(group, isPresent, displayName)) {
        ctx.report(refusal.code, refusal.message, refusal.expected, refusal.found);
      }
    }
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const recordCtx = ctx.inRecord(schemaLocation);
      const annotations = yield* captureAnnotations(recordCtx);
      // The construction-guard checkpoint (`ConstructionGuard.mark`): after the framing (this
      // value's own annotations/type-ref, consumed by `captureAnnotations`/`expectRecordShape`)
      // and before the fields -- see `reader/tree/support.ts`'s own `abandonedValue` note.
      const mark = recordCtx.reported();
      const shapeResult = yield* expectRecordShape(recordCtx);
      if (shapeResult.shape === 'mismatch') {
        return abandonedValue();
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
          sink(i, valueForMissingField(anchoredCtx, i));
        }
      }
      validateGroups(anchoredCtx, seen);
      if (recordCtx.reported() > mark) {
        // Tree mode is all-or-nothing: a field left unbuilt, a stray or repeated name, a group
        // violation -- everything above already reported -- means no partial record to mistake
        // for a valid one.
        return abandonedValue();
      }
      return recordNode(result, name, annotations);
    },
  };
}
