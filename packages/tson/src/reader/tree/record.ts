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
  type FieldOmission,
  groupRefusals,
  isGroupMember,
  namedFields,
  type FieldGroup,
  type NamedField,
  type RecordBody,
} from '../../schema/meta/bodies.js';
import type { Value } from '../../tree/nodes.js';
import { voidNode, recordNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import {
  describeEvent,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipDataValue,
} from './grammar.js';
import { valuesEqual } from './equality.js';
import { abandonedValue, readSchemaLiteral, renderValue } from './support.js';
import { FIELD_NAME_RULE, judgeFieldName, matchKey, type FieldNameRule } from './fieldNames.js';
import { DEFAULT_IDENTIFIER_POLICY, type IdentifierPolicy } from '../../unicode/policy.js';
import type { TypeRef } from '../../schema/meta/typedef.js';
import { writtenBeforeItsSibling, writtenWithoutItsSibling } from '../../link/dependentFields.js';
import { isDependentReader, referenceOfValue, type DependentReader } from './dependent.js';

interface CompiledField {
  readonly schema: NamedField;
  readonly parser: TypeReader<Value>;
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
 * package over the same {@link RecordBody}).
 */
export function recordTreeReader(
  name: string,
  displayName: string,
  body: RecordBody,
  resolveField: (field: NamedField) => TypeReader<Value>,
  schemaLocation: SchemaLocation,
  fieldNames: FieldNameRule = FIELD_NAME_RULE,
  identifierPolicy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
): TypeReader<Value> {
  const fields: CompiledField[] = namedFields(body).map((schema) => ({
    schema,
    parser: resolveField(schema),
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
    // Keyed in the name type's form, the equality linking judged the declared names distinct under.
    fieldIndex.set(matchKey(fieldNames, field.schema.name), i);
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

  // §5.2: each field's sibling index where the field is a dependent one read through a
  // {@link DependentReader}, and -1 elsewhere; and whether each field is the sibling of some dependent
  // field. Only a record with a dependent field keeps any per-read state for it.
  const siblingOf = fields.map((field) => {
    const reader = field.parser;
    if (!isDependentReader(reader)) return -1;
    const index = fields.findIndex((other) => other.schema.name === reader.sibling);
    if (index < 0) {
      throw new Error(
        `'${displayName}': dependent field '${field.schema.name}' names no field ` +
          `'${reader.sibling}'; the linker refuses one`,
      );
    }
    return index;
  });
  const typesADependent = fields.map((_, i) => siblingOf.includes(i));
  const hasDependents = siblingOf.some((sibling) => sibling >= 0);
  /** What omitting field `i` yields: its own §5.2 derivation, a group member's being the group's. */
  const omissionOf = (i: number): FieldOmission =>
    fieldOmission(at(fields, i, 'field').schema, at(memberOfGroup, i, 'memberOfGroup'));
  // A field group's member, absent where another option is chosen, has nothing to stand for it, so a
  // read keeps where each dependent field was written to refuse it once the record closes.
  const siblingMayBeAbsent = siblingOf.some(
    (sibling) => sibling >= 0 && omissionOf(sibling) === 'ABSENT',
  );

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
   * Admitted exactly when `voidable` (§2.9: present with a void value, distinct from never
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
      return voidNode();
    }
    const omission = fieldOmission(schema, at(memberOfGroup, schemaIndex, 'memberOfGroup'));
    if (schema.role === 'DEFAULT') {
      ctx
        .schemaField(schema.name)
        .report(
          'ATOM_CONSTRAINT_VIOLATION',
          `'${schema.name}' on '${displayName}' is always filled from the schema and cannot be ` +
            `written as void -- omit the field to take its default (§5.2)`,
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
    const fieldCtx = ctx.schemaField(fieldName);
    const check = at(fixedCheck, schemaIndex, 'fixed-check');
    const peeked = yield* ctx.peek();
    if (peeked.kind === 'void') {
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
    const fixedValue = check.value ?? voidNode();
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

  /** What one read of a record with a dependent field keeps: each sibling's value as this instance wrote it, and each dependent field reached before its sibling was written. */
  interface Dependents {
    readonly named: (TypeRef | undefined)[];
    readonly readBefore: (string | undefined)[];
    readonly readBeforeAt: (ReadContext | undefined)[];
  }

  function newDependents(): Dependents {
    return {
      named: new Array<TypeRef | undefined>(fields.length).fill(undefined),
      readBefore: new Array<string | undefined>(fields.length).fill(undefined),
      readBeforeAt: new Array<ReadContext | undefined>(fields.length).fill(undefined),
    };
  }

  /**
   * Sibling `sibling` is written: a free one written after a dependent field reached before it is the order
   * rule broken (§2.5, §5.2), reported at that field. A pinned sibling orders nothing, its pin typing the
   * field.
   */
  function siblingArrives(dependents: Dependents, sibling: number): void {
    if (fixedCheck[sibling] !== undefined) return;
    for (let d = 0; d < fields.length; d += 1) {
      const written = dependents.readBefore[d];
      if (written !== undefined && siblingOf[d] === sibling) {
        const refusal = writtenBeforeItsSibling(
          displayName,
          written,
          at(fields, sibling, 'field').schema.name,
        );
        dependents.readBeforeAt[d]?.report(
          refusal.code,
          refusal.message,
          refusal.expected,
          refusal.found,
        );
        dependents.readBefore[d] = undefined;
      }
    }
  }

  /**
   * Dependent field `index`, written as `written`, read against the type its sibling names in this
   * instance (§5.2): a pinned sibling's is the pin, whatever the document's order; a free sibling's is the
   * value this instance wrote, which is therefore written first, or its default where it is not written.
   * A sibling written after the dependent field is the order rule broken, found when the sibling arrives:
   * a value a default could type is read against it, and one with no type yet is skipped unjudged.
   */
  function* readDependent(
    ctx: ReadContext,
    index: number,
    written: string,
    seen: readonly boolean[],
    dependents: Dependents | undefined,
  ): Task<Value | undefined> {
    const field = at(fields, index, 'field');
    const reader = field.parser as DependentReader;
    const sibling = at(siblingOf, index, 'siblingOf');
    const siblingField = at(fields, sibling, 'field');
    const fieldCtx = ctx.schemaField(written);
    const siblingCtx = ctx.schemaField(siblingField.schema.name);
    let named: TypeRef | undefined;
    if (fixedCheck[sibling] !== undefined) {
      named = referenceOfValue(precomputedValue[sibling]);
    } else if (seen[sibling] === true) {
      named = dependents?.named[sibling];
    } else if (omissionOf(sibling) === 'INJECTED') {
      named = referenceOfValue(precomputedValue[sibling]);
      if (dependents !== undefined) {
        dependents.readBefore[index] = written;
        dependents.readBeforeAt[index] = fieldCtx.withPosition(fieldCtx.position());
      }
    } else if (dependents === undefined) {
      throw new Error(
        `'${displayName}': positional field '${field.schema.name}' has a sibling ` +
          `'${siblingField.schema.name}' that is neither pinned nor defaulted; the linker refuses one`,
      );
    } else {
      // The sibling is yet to come, the order rule broken, or is absent: only what follows says which.
      dependents.readBefore[index] = written;
      dependents.readBeforeAt[index] = fieldCtx.withPosition(fieldCtx.position());
      yield* skipDataValue(ctx);
      return undefined;
    }
    return yield* reader.readAgainst(fieldCtx, named, siblingCtx);
  }

  /**
   * Each dependent field `seen` holds whose sibling, a field group's member, it does not: nothing typed the
   * value, so it is refused where it was written (§5.2, §5.11). A sibling with nothing to stand for it is
   * known to be absent only here, at the record's close, a dependent field written first being a sibling
   * that may yet arrive; a required one is the missing-field error instead.
   */
  function refuseAbsentSiblings(
    ctx: ReadContext,
    seen: readonly boolean[],
    writtenAt: readonly ({ name: string; position: Position } | undefined)[],
  ): void {
    for (let i = 0; i < fields.length; i += 1) {
      const sibling = at(siblingOf, i, 'siblingOf');
      const stated = writtenAt[i];
      if (
        seen[i] === true &&
        stated !== undefined &&
        sibling >= 0 &&
        seen[sibling] !== true &&
        omissionOf(sibling) === 'ABSENT'
      ) {
        const refusal = writtenWithoutItsSibling(
          displayName,
          stated.name,
          at(fields, sibling, 'field').schema.name,
        );
        ctx
          .schemaField(stated.name)
          .withPosition(stated.position)
          .report(refusal.code, refusal.message, refusal.expected, refusal.found);
      }
    }
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
    const dependents = hasDependents ? newDependents() : undefined;
    const writtenAt = siblingMayBeAbsent
      ? new Array<{ name: string; position: Position } | undefined>(fields.length).fill(undefined)
      : undefined;
    for (;;) {
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'record-end') break;
      const fieldNameEvent = yield* ctx.next();
      if (fieldNameEvent.kind !== 'field-name') {
        throw new Error(`expected a field-name event, found '${fieldNameEvent.kind}'`);
      }
      const written = fieldNameEvent.name;
      const key = matchKey(fieldNames, written);
      // The name type judges the name before closure does: a refused name was never read, so
      // nothing below may hold a verdict about it (`fieldNames.ts`).
      const judged = judgeFieldName(ctx.field(written), fieldNames, identifierPolicy, written);
      const schemaIndex = fieldIndex.get(key);
      if (schemaIndex === undefined) {
        if (judged === 'refused') {
          yield* skipDataValue(ctx);
          continue;
        }
        if (seenUnmatched.has(key)) {
          ctx
            .field(fieldNameEvent.name)
            .report(
              'DUPLICATE_FIELD',
              `duplicate field '${fieldNameEvent.name}' on '${displayName}' -- a record states each field at most once (§2.5), and the repeat states a value for nothing`,
              'each field stated once',
              `'${fieldNameEvent.name}' stated again`,
            );
          yield* skipDataValue(ctx);
          continue;
        }
        seenUnmatched.add(key);
        // Under the default the message is the plain one any undeclared name draws; under a
        // declared name type it names the type and its reason, the rules the author looks up.
        const reason =
          judged === undefined || fieldNames.typeName === undefined
            ? ''
            : ` -- it is no value of its name_type '${fieldNames.typeName}': ${judged.notAName}`;
        ctx
          .field(fieldNameEvent.name)
          .report(
            'UNRECOGNIZED_FIELD',
            `unknown field '${fieldNameEvent.name}' on '${displayName}' -- a record is closed under its type (§7.2), whose fields are (${declaredFields})${reason}`,
            declaredFields,
            fieldNameEvent.name,
          );
        yield* skipDataValue(ctx);
        continue;
      }
      if (seen[schemaIndex]) {
        const declared = at(fields, schemaIndex, 'field').schema.name;
        const spelling =
          declared === written
            ? ''
            : `, another spelling of the field '${declared}' under its name type`;
        ctx
          .schemaField(fieldNameEvent.name)
          .report(
            'DUPLICATE_FIELD',
            `duplicate field '${fieldNameEvent.name}'${spelling} on '${displayName}' -- a record states each field at most once (§2.5), and the repeat states a value for nothing`,
            'each field stated once',
            `'${fieldNameEvent.name}' stated again`,
          );
      }
      if (writtenAt !== undefined) {
        writtenAt[schemaIndex] = { name: fieldNameEvent.name, position: fieldNameEvent.position };
      }
      if (dependents !== undefined && typesADependent[schemaIndex] === true) {
        siblingArrives(dependents, schemaIndex);
      }
      if (fixedCheck[schemaIndex] !== undefined) {
        yield* verifyFixed(ctx, schemaIndex, fieldNameEvent.name, sink);
        seen[schemaIndex] = true;
        continue;
      }
      const field = at(fields, schemaIndex, 'field');
      const fieldCtx = ctx.schemaField(fieldNameEvent.name);
      const valuePeek = yield* ctx.peek();
      let decoded: Value | undefined;
      if (valuePeek.kind === 'void') {
        yield* ctx.next();
        decoded = valueForStatedVoidField(ctx, schemaIndex);
      } else if (at(siblingOf, schemaIndex, 'siblingOf') >= 0) {
        decoded = yield* readDependent(ctx, schemaIndex, fieldNameEvent.name, seen, dependents);
      } else {
        const before = ctx.reported();
        decoded = yield* field.parser.read(fieldCtx);
        if (dependents !== undefined && typesADependent[schemaIndex] === true) {
          dependents.named[schemaIndex] =
            ctx.reported() > before ? undefined : referenceOfValue(decoded);
        }
      }
      sink(schemaIndex, decoded);
      seen[schemaIndex] = true;
    }
    if (writtenAt !== undefined) refuseAbsentSiblings(ctx, seen, writtenAt);
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
    const decoded =
      at(siblingOf, index, 'siblingOf') >= 0
        ? yield* readDependent(ctx, index, field.schema.name, seen, undefined)
        : yield* field.parser.read(ctx.schemaField(field.schema.name));
    sink(index, decoded);
    seen[index] = true;
    return seen;
  }

  /** Field-group presence check (§5.11, {@link groupViolations}): one option chosen, or at most one under `?`, and a chosen option holds every unmarked member. */
  function validateGroups(ctx: ReadContext, seen: readonly boolean[]): void {
    const isPresent = (member: string): boolean => {
      const idx = fieldIndex.get(matchKey(fieldNames, member));
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
