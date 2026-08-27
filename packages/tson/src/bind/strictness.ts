/**
 * The schema-versus-binding cross-check: does a {@link RecordBinding} actually cover the record
 * type it is registered against?
 *
 * A `Binding` is authored independently of the schema it will be read/written against -- nothing
 * connects `combinators.ts`'s output to a `RecordBody` until a caller (a later work package's
 * schema compiler) puts the two together. Left unchecked, a missing or extra field only shows up
 * the first time real data exercises it: an omitted OPTIONAL field silently reads as absent in
 * every test that never sends it, then throws (or worse, drops data) for the first caller who
 * does. This module raises {@link TsonBindMismatchError} the moment a binding is checked against
 * its type, not on first read.
 *
 * **Scope.** Field-level coverage is a `record`-specific question: `record_field` is the one
 * meta-kernel shape carrying the five-member {@link FieldState} vocabulary (§5.2) this check
 * reads, because it is the one shape a FIXED value can make legitimately slot-free. No other
 * PRODUCT/SUM body has an analogous per-position "this position never needs binding coverage"
 * case -- a tuple position and an array element carry only the two-member {@link ElementState}
 * (§5.3), with no FIXED counterpart, and a `choice`'s variants (§5.4) are plain type references,
 * not positions that can be pinned to a literal. So {@link checkRecordBinding} is this module's
 * only real check; {@link checkBinding} is the dispatcher a caller holding a `TypeDefinition`
 * uses without narrowing its body by hand, and is a deliberate no-op outside the `record`/`record`
 * pairing -- see its own doc.
 */
import type { FieldState, RecordBody, RecordField } from '../schema/meta/bodies.js';
import type { TypeDefinition } from '../schema/meta/typedef.js';
import { TsonBindMismatchError } from '../core/errors.js';
import type { Binding, RecordBinding } from './binding.js';

/**
 * `state` values a {@link RecordField} may carry with no corresponding {@link FieldSlot} required
 * -- the two FIXED states (§5.2): the decoder injects `REQUIRED_FIXED`'s value and never reads
 * `OPTIONAL_FIXED` past checking it against the pin, so neither needs a host-side slot to land in.
 * `REQUIRED_DEFAULT` is deliberately absent from this set: its injected value still has to be
 * *stored* somewhere, so it needs a slot exactly like a plain `REQUIRED` field does.
 */
const FIXED_STATES: ReadonlySet<FieldState> = new Set(['REQUIRED_FIXED', 'OPTIONAL_FIXED']);

/**
 * Checks that `binding` covers `fields` exactly: every non-FIXED field has a matching slot
 * (`binding.byWireName`, keyed by wire name after any rename), and every slot fills a field.
 * {@link FieldSlot.unbound} slots (the {@link RecordBinding.annotationsCarrier}, most commonly)
 * are already excluded from `byWireName` per that field's own contract, so they never enter
 * either direction of this check.
 *
 * Raises {@link TsonBindMismatchError} naming every uncovered field and every unmatched slot in
 * one message -- a caller fixing a mismatch wants the whole list, not one violation at a time
 * forcing a fix-rerun-fix cycle.
 *
 * @param typeName the schema type name `binding` is registered against, for the error message
 */
export function checkRecordBinding(
  typeName: string,
  fields: readonly RecordField[],
  binding: RecordBinding<unknown>,
): void {
  const uncoveredFields: string[] = [];
  const matchedWireNames = new Set<string>();

  for (const recordField of fields) {
    if (FIXED_STATES.has(recordField.state)) continue;
    const slot = binding.byWireName.get(recordField.name);
    if (slot === undefined) {
      uncoveredFields.push(recordField.name);
    } else {
      matchedWireNames.add(recordField.name);
    }
  }

  const unmatchedSlots = [...binding.byWireName.keys()].filter(
    (wireName) => !matchedWireNames.has(wireName) && !isFixedFieldName(fields, wireName),
  );

  if (uncoveredFields.length === 0 && unmatchedSlots.length === 0) return;

  const parts: string[] = [];
  if (uncoveredFields.length > 0) {
    parts.push(`field(s) with no binding slot: ${uncoveredFields.join(', ')}`);
  }
  if (unmatchedSlots.length > 0) {
    parts.push(`slot(s) matching no field: ${unmatchedSlots.join(', ')}`);
  }
  throw new TsonBindMismatchError(
    `binding for "${typeName}" does not match its record type -- ${parts.join('; ')}`,
  );
}

/** True when `wireName` names a FIXED field of `fields` -- a slot bound there is redundant, not wrong, so it is not reported as unmatched. */
function isFixedFieldName(fields: readonly RecordField[], wireName: string): boolean {
  return fields.some((f) => f.name === wireName && FIXED_STATES.has(f.state));
}

/**
 * Dispatches {@link checkRecordBinding} for a `(definition, binding)` pair drawn from a schema
 * compiler and a {@link BindingRegistry} respectively, without the caller narrowing
 * `definition.body` by hand first.
 *
 * A no-op whenever `definition.body.kind` is not `'record'`, or `binding.kind` is not `'record'`
 * once any {@link LazyBinding} wrapping it is resolved -- see this module's own top comment for
 * why field-level coverage has no analogous check for the other body kinds. A `record`-kind
 * definition paired with a non-`record`-kind binding (after resolving `lazy`) is itself a
 * mismatch worth reporting rather than silently skipping, since nothing else in this package
 * would ever catch a binding authored against the wrong shape.
 */
export function checkBinding(
  typeName: string,
  definition: TypeDefinition,
  binding: Binding<unknown>,
): void {
  const body = definition.body;
  // `TemplateBody` (§5.10) carries no `kind` tag at all -- see its own doc -- so membership must
  // be checked before narrowing, exactly as that doc calls out for any code walking `Top`.
  if (!('kind' in body) || body.kind !== 'record') return;
  // `Data.kind` is a plain `string` (a meta-schema's own constructor name), not a literal, so the
  // check above narrows `body` to `RecordBody | Data` rather than `RecordBody` alone -- an
  // open-vocabulary `Data` body can never actually equal the literal `'record'` in practice
  // (that name is the kernel's own PRODUCT constructor), so the remaining `Data` member is
  // asserted away here rather than left for TypeScript to rule out structurally.
  const recordBody = body as RecordBody;

  let resolved = binding;
  while (resolved.kind === 'lazy') resolved = resolved.get();

  if (resolved.kind !== 'record') {
    throw new TsonBindMismatchError(
      `binding for "${typeName}" is a "${resolved.kind}" binding, but the type resolves to a record`,
    );
  }
  checkRecordBinding(typeName, recordBody.fields, resolved);
}
