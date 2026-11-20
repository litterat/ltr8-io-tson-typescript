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
import { typeExprText, typeNameOf } from '../schema/meta/bodies.js';
import type { Restatement, Top } from '../schema/meta/typedef.js';
import { dependentOn, supertypesOf } from '../schema/meta/typedef.js';
import { sameTypeExpr } from '../schema/meta/typeInline.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { restatesDependent } from './dependentFields.js';

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

/**
 * Whether `restated`'s type narrows `inherited`'s: two names when the same entry or one IS-A it, or `void` at a
 * voidable position; two types written in place only when equal; and a name and a type in place never (§8.2).
 */
function narrows(inherited: RecordField, restated: RecordField, namespace: EntryLookup): boolean {
  // A dependent field is restated only as itself, which `restatesDependent` judges before this is asked.
  if (dependentOn(inherited.type) !== undefined || dependentOn(restated.type) !== undefined) {
    return true;
  }
  const from = inherited.type;
  const to = restated.type;
  if (from.kind === 'inline' || to.kind === 'inline') return sameTypeExpr(from, to);
  if (namespace(from.name) === undefined || namespace(to.name) === undefined) {
    // A field typed by a name no entry holds is the reference checks' to report.
    return true;
  }
  if (isA(to.name, from.name, namespace)) return true;
  const end = namespace(terminal(to.name, namespace));
  return restated.voidable && end?.kind === 'void_type';
}

/**
 * Judges the fields `record` restates against the nearest closed record on its chain. A supertype another
 * supertype lists was judged when that one linked, so only the minimal ones are asked, and the diagnostic
 * names the source the author wrote. A supertype that is still open (the family base an applied operand
 * reaches) has parameter-typed fields and is skipped.
 *
 * @throws TsonSchemaValidationError naming the first source whose restated fields do not narrow.
 */
/**
 * §5.8's rule over the restatements no record on the entry's closed chain holds: over an application at an operand,
 * which reaches no edge to its head and none at all where no declaration names it, and over a subtraction's
 * operands, which reach none. The verdict is the one {@link checkRestatedFieldTypes} gives a supertype, whether or not
 * a declaration names the application.
 *
 * @throws TsonSchemaValidationError naming the first source whose restated fields do not narrow.
 */
export function checkRestatementsOffTheChain(
  entryName: string,
  restatements: readonly Restatement[],
  namespace: ReadonlyMap<string, Top>,
): void {
  const lookup: EntryLookup = (name) => namespace.get(name);
  const violations = new Map<string, string[]>();
  for (const restatement of restatements) {
    const violation = restatementViolation(
      restatement.field,
      restatement.inherited,
      restatement.restated,
      lookup,
    );
    if (violation === undefined) continue;
    const source = typeExprText(restatement.source);
    const found = violations.get(source) ?? [];
    found.push(violation);
    violations.set(source, found);
  }
  for (const [source, found] of violations) refuseRestatement(entryName, source, found);
}

/** Why `restated` is no restatement of `inherited`, the field `field`; `undefined` where it is one. */
function restatementViolation(
  field: string,
  inherited: RecordField,
  restated: RecordField,
  lookup: EntryLookup,
  shown: (name: string) => string = (name) => name,
): string | undefined {
  const dependent = restatesDependent(field, inherited, restated);
  if (dependent !== undefined) return dependent;
  if (narrows(inherited, restated, lookup)) return undefined;
  const oneIsANameOneInPlace =
    (restated.type.kind === 'inline') !== (inherited.type.kind === 'inline');
  return (
    `field '${field}' is typed '${shown(typeNameOf(restated))}', which is not ` +
    `'${shown(typeNameOf(inherited))}' or IS-A it` +
    (oneIsANameOneInPlace
      ? ` -- a name and a type written in place are never one type (§8.2), so write ` +
        `'${shown(typeNameOf(inherited))}' as it is inherited`
      : '')
  );
}

function refuseRestatement(entryName: string, source: string, violations: readonly string[]): void {
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${entryName}': not a valid restatement of '${source}''s fields (§5.8): ${violations.join('; ')}`,
    );
  }
}

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
    if (!nearest || source?.kind !== 'record') {
      continue;
    }
    const violations: string[] = [];
    for (const [fieldName, inherited] of source.fields.entries) {
      const restated = record.fields.entries.get(fieldName);
      if (restated === undefined) continue;
      const violation = restatementViolation(fieldName, inherited, restated, lookup, shown);
      if (violation !== undefined) violations.push(violation);
    }
    refuseRestatement(entryName, shown(supertype), violations);
  }
}
