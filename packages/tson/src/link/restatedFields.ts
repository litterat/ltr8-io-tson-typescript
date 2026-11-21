/**
 * Part 2 §5.7's rule for a restated field's type, which §5.8 applies to a composition's tightening
 * entries: refinement only restricts, so a field a record restates is typed by its source's type or a type
 * IS-A it (§7.2), past alias hops on both sides, and nothing structural beside it -- `[int8]` restating
 * `[int32]` is no narrowing. §5.7's one other narrowing is `void` at a voidable position, whose value set
 * `{_}` is inside every voidable position's.
 *
 * §5.8's other rule, that a restatement MUST NOT change a pin, is asked here too ({@link changedPin}): the two
 * values are read at the inherited field's type, where the pin was set, and compared by the equality a written
 * value meets a pin with (§5.5), so `= 255` restates `= 0xFF`.
 *
 * The resolver binds a restatement before the names it holds need be ready, so the IS-A is asked here, over
 * the one namespace both names resolve in, and a value is read at a type those names reach. It is a rule of the
 * schema, not of an encoding, so it lives in `link/` where both encodings' schema loads reach it.
 */
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonReadError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { buildAtomReader } from '../compiler/atomBuilder.js';
import { isAtom } from '../compiler/atomChecks.js';
import { valuesEqual } from '../reader/tree/equality.js';
import { readSchemaLiteral } from '../reader/tree/support.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import { typeExprText, typeNameOf } from '../schema/meta/bodies.js';
import type { Restatement, Token, Top, TypeExpr } from '../schema/meta/typedef.js';
import { dependentOn, isParametric, supertypesOf } from '../schema/meta/typedef.js';
import { parameterIn, sameTypeExpr } from '../schema/meta/typeInline.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { namesTypes } from './kindMembers.js';
import { restatesDependent } from './dependentFields.js';
import { isAThroughHops, NO_HOPS, type ExternHops } from './externHops.js';

/**
 * §7.2's IS-A between two names of `namespace`: past their hops, alias and extern alike, they are one entry by
 * identity, or the first's chain lists the second (`externHops.ts`'s {@link isAThroughHops}).
 */
export function isA(
  sub: string,
  sup: string,
  namespace: EntryLookup,
  hops: ExternHops = NO_HOPS,
): boolean {
  return isAThroughHops(sub, sup, namespace, hops);
}

/**
 * Whether `restated`'s type narrows `inherited`'s: two names when the same entry or one IS-A it, or `void` at a
 * voidable position; two types written in place only when equal; and a name and a type in place never (§8.2).
 */
function narrows(
  inherited: RecordField,
  restated: RecordField,
  namespace: EntryLookup,
  hops: ExternHops,
): boolean {
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
  if (isA(to.name, from.name, namespace, hops)) return true;
  const end = namespace(terminal(to.name, namespace));
  return restated.voidable && end?.kind === 'void_type';
}

/**
 * §5.8's rule over the restatements no record on the entry's closed chain holds: over an application at an operand,
 * which reaches no edge to its head and none at all where no declaration names it, and over a subtraction's
 * operands, which reach none. The verdict is the one {@link checkRestatedFieldTypes} gives a supertype, whether or not
 * a declaration names the application. At a parametric record's declaration (`pinsOnly`) the restatements are
 * judged for a changed pin alone.
 *
 * @throws TsonSchemaValidationError naming the first source whose restated fields do not narrow.
 */
export function checkRestatementsOffTheChain(
  entryName: string,
  restatements: readonly Restatement[],
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops = NO_HOPS,
  pinsOnly = false,
  enumForms: ReadonlyMap<string, Normalization> = NO_ENUM_FORMS,
): void {
  const lookup: EntryLookup = (name) => namespace.get(name);
  const violations = new Map<string, string[]>();
  for (const restatement of restatements) {
    const violation = restatementViolation(
      restatement.field,
      restatement.inherited,
      restatement.restated,
      lookup,
      hops,
      (name) => name,
      pinsOnly,
      enumForms,
    );
    if (violation === undefined) continue;
    const source = typeExprText(restatement.source);
    const found = violations.get(source) ?? [];
    found.push(violation);
    violations.set(source, found);
  }
  for (const [source, found] of violations) refuseRestatement(entryName, source, found);
}

const NO_ENUM_FORMS: ReadonlyMap<string, Normalization> = new Map();

/**
 * Why `restated` is no restatement of `inherited`, the field `field`; `undefined` where it is one. At a parametric
 * record's declaration (`pinsOnly`) only a changed pin under a type naming no parameter is judged, its verdict being
 * every application's (§5.8, §5.10); whether the restated type narrows waits for the application, a parameter's
 * argument deciding it (`wrap => <T> box<T> & { v: int32 }` is sound for `wrap<int32>`).
 */
function restatementViolation(
  field: string,
  inherited: RecordField,
  restated: RecordField,
  lookup: EntryLookup,
  hops: ExternHops,
  shown: (name: string) => string,
  pinsOnly: boolean,
  enumForms: ReadonlyMap<string, Normalization>,
): string | undefined {
  if (pinsOnly) {
    return parameterIn(inherited.type) === undefined
      ? changedPin(field, inherited, restated, lookup, hops, enumForms)
      : undefined;
  }
  const dependent = restatesDependent(field, inherited, restated);
  if (dependent !== undefined) return dependent;
  if (narrows(inherited, restated, lookup, hops)) {
    return changedPin(field, inherited, restated, lookup, hops, enumForms);
  }
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

/** A token echoed the way the schema spells it, so a quoted value is visibly quoted in the message. */
function asWritten(token: Token): string {
  return token.form === 'UNQUOTED' ? token.text : `"${token.text}"`;
}

/**
 * §5.8: a restatement MUST NOT change a pin. The two values are compared as values of the inherited field's type,
 * where the pin was set, by the equality a written value meets a FIXED one with (§5.5), so `= 255` restates
 * `= 0xFF`; a reference to types compares the types its names denote, past their hops (§8.2). A value its type
 * refuses is the field-value check's to report, and a type with no value to read against gives no verdict.
 */
function changedPin(
  field: string,
  inherited: RecordField,
  restated: RecordField,
  lookup: EntryLookup,
  hops: ExternHops,
  enumForms: ReadonlyMap<string, Normalization>,
): string | undefined {
  const pin = inherited.value;
  const restatedPin = restated.value;
  if (
    inherited.role !== 'FIXED' ||
    pin === undefined ||
    restatedPin === undefined ||
    (pin.text === restatedPin.text && pin.form === restatedPin.form)
  ) {
    return undefined;
  }
  const target = valueBody(inherited.type, lookup);
  if (target === undefined) return undefined;
  if (target.kind === 'ref') {
    const same = namesTypes(target.of.name, lookup)
      ? hops.identity(pin.text) === hops.identity(restatedPin.text)
      : pin.text === restatedPin.text;
    if (same) return undefined;
  } else {
    const same = sameValue(inherited.type, target, pin, restatedPin, lookup, enumForms);
    if (same !== false) return undefined;
  }
  return (
    `field '${field}' is pinned to ${asWritten(pin)} and restated as ${asWritten(restatedPin)} -- a ` +
    `restatement may change a default and never a pin, so restate it as ${asWritten(pin)} or leave it out`
  );
}

/**
 * The body a field's `~`/`=` value is read against, at the end of its type's alias chain: `undefined` where the
 * name is unresolved, or names a parametric record, an application not yet closed, or an alias the walk stopped
 * on, none of which has one body to read against.
 */
function valueBody(type: TypeExpr, lookup: EntryLookup): Top | undefined {
  const target = type.kind === 'inline' ? type.of : lookup(terminal(type.name, lookup));
  return target === undefined ||
    isParametric(target) ||
    target.kind === 'apply' ||
    target.kind === 'alias'
    ? undefined
    : target;
}

/**
 * Whether the two tokens read to one value at `target`, an atom or an enum read in its label form; `undefined`
 * where `target` is no atom, or a token is no value of it.
 */
function sameValue(
  type: TypeExpr,
  target: Top,
  pin: Token,
  restatedPin: Token,
  lookup: EntryLookup,
  enumForms: ReadonlyMap<string, Normalization>,
): boolean | undefined {
  if (!isAtom(target)) return undefined;
  const name = type.kind === 'inline' ? type.head : terminal(type.name, lookup);
  const enumForm = enumForms.get(name);
  const reader = buildAtomReader(name, target, enumForm === undefined ? {} : { enumForm });
  try {
    return valuesEqual(readSchemaLiteral(pin, reader), readSchemaLiteral(restatedPin, reader));
  } catch (error: unknown) {
    if (
      error instanceof TsonReadError ||
      error instanceof TsonAtomParseError ||
      error instanceof TsonAtomValidationError
    ) {
      return undefined;
    }
    throw error;
  }
}

function refuseRestatement(entryName: string, source: string, violations: readonly string[]): void {
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${entryName}': not a valid restatement of '${source}''s fields (§5.8): ${violations.join('; ')}`,
    );
  }
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
  hops: ExternHops = NO_HOPS,
  shown: (name: string) => string = (name) => name,
  pinsOnly = false,
  enumForms: ReadonlyMap<string, Normalization> = NO_ENUM_FORMS,
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
      const violation = restatementViolation(
        fieldName,
        inherited,
        restated,
        lookup,
        hops,
        shown,
        pinsOnly,
        enumForms,
      );
      if (violation !== undefined) violations.push(violation);
    }
    refuseRestatement(entryName, shown(supertype), violations);
  }
}
