/**
 * Part 2 §5.7's rule for a restated field's type, which §5.8 applies to a composition's tightening
 * entries: refinement only restricts, so a field a record restates is typed by its source's type or a type
 * IS-A it (§7.2), past alias hops on both sides, and nothing structural beside it -- `[int8]` restating
 * `[int32]` is no narrowing. §5.7's one other narrowing is `void` at a voidable position, whose value set
 * `{_}` is inside every voidable position's.
 *
 * The resolver binds a restatement before the names it holds need be ready, so the IS-A is asked here, over
 * the one namespace both names resolve in. It is a rule of the schema, not of an encoding, so it lives in
 * `link/` where both encodings' schema loads reach it.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import { typeNameOf } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';
import { isTemplateBody, supertypesOf } from '../schema/meta/typedef.js';
import { terminal, type EntryLookup } from './aliasChain.js';

/**
 * §7.2's IS-A between two names of `namespace`: past their alias hops they are one entry, or the first's
 * chain lists the second.
 */
export function isA(sub: string, sup: string, namespace: EntryLookup): boolean {
  const wanted = terminal(sup, namespace);
  const end = terminal(sub, namespace);
  if (end === wanted) return true;
  const definition = namespace(end);
  return (
    definition !== undefined &&
    supertypesOf(definition).some((supertype) => terminal(supertype, namespace) === wanted)
  );
}

/** Whether `restated`'s type narrows `inherited`'s: the same entry or one IS-A it, or `void` at a voidable position. */
function narrows(inherited: RecordField, restated: RecordField, namespace: EntryLookup): boolean {
  if (inherited.type.kind === 'sibling' || restated.type.kind === 'sibling') return true;
  const from = inherited.type;
  const to = restated.type;
  if (
    from.arguments.length > 0 ||
    to.arguments.length > 0 ||
    namespace(from.name) === undefined ||
    namespace(to.name) === undefined
  ) {
    // A field typed by an application not yet closed, or by a name no entry holds, is the reference checks' to report.
    return true;
  }
  if (isA(to.name, from.name, namespace)) return true;
  const end = namespace(terminal(to.name, namespace));
  return restated.voidable && end !== undefined && !isTemplateBody(end) && end.kind === 'void_type';
}

/**
 * Judges the fields `record` restates against the nearest closed record on its chain. A supertype another
 * supertype lists was judged when that one linked, so only the minimal ones are asked, and the diagnostic
 * names the source the author wrote. A supertype that is still open (the family base an applied operand
 * reaches) has parameter-typed fields and is skipped.
 *
 * @throws TsonSchemaValidationError naming the first source whose restated fields do not narrow.
 */
export function checkRestatedFieldTypes(
  entryName: string,
  record: RecordBody,
  namespace: ReadonlyMap<string, Top>,
  shown: (name: string) => string = (name) => name,
): void {
  const lookup: EntryLookup = (name) => namespace.get(name);
  const supertypes = supertypesOf(record);
  for (const supertype of supertypes) {
    const nearest = supertypes.every(
      (other) =>
        other === supertype || !supertypesOf(lookup(terminal(other, lookup))).includes(supertype),
    );
    const source = lookup(terminal(supertype, lookup));
    if (!nearest || source === undefined || isTemplateBody(source) || source.kind !== 'record') {
      continue;
    }
    const violations: string[] = [];
    for (const [fieldName, inherited] of source.fields.entries) {
      const restated = record.fields.entries.get(fieldName);
      if (restated === undefined) continue;
      if (!narrows(inherited, restated, lookup)) {
        violations.push(
          `field '${fieldName}' is typed '${shown(typeNameOf(restated))}', which is not ` +
            `'${shown(typeNameOf(inherited))}' or IS-A it`,
        );
      }
    }
    if (violations.length > 0) {
      throw new TsonSchemaValidationError(
        `'${entryName}': not a valid refinement of '${shown(supertype)}' (§5.7): ${violations.join('; ')}`,
      );
    }
  }
}
