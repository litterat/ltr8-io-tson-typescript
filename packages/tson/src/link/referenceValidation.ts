/**
 * Every type reference in a linked schema resolves — with a diagnostic naming the reference and
 * its location when it does not (§3.3.1, §3.3.2, §5.10).
 *
 * Ported from the reference implementation's `TsonSchemaLinker`'s own validation half
 * (`validateEntry`/`validateBody`/`validateTypeRef`/`checkArity`/`checkHeldArity`/
 * `checkOpenEntryUsesEveryParameter`/`checkVariantsAreDistinct`/`checkVariantsAreNotVoid`,
 * `tson-compiler/.../TsonSchemaLinker.java`); see that file's own module doc for the exhaustive
 * rationale. This module states only what differs in the port.
 *
 * **A type written in place is walked where it stands** (§4.2): every name at any depth of it is validated
 * against the namespace, and a failure is reported against the entry holding it, naming the field path.
 *
 * **Every entry in the merged namespace is validated, imported entries included** — matching the
 * reference implementation's own loop (`for (Map.Entry<...> entry : merged.entrySet())`), not
 * only its prose gloss ("only the importer's own new material gets validated here"): an imported
 * entry, already valid in its own schema, resolves again trivially against the merged (superset)
 * namespace here, so re-checking it costs work but never a false diagnostic.
 */
import type { Diagnostic, DiagnosticsReceiver } from '../core/diagnostic.js';
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonBindMismatchError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import type { NonHeldTop } from './bodyKind.js';
import { schemaPositionOf, type FactsTable } from './facts.js';
import { checkDependentFields } from './dependentFields.js';
import { checkRestatedFieldTypes } from './restatedFields.js';
import { namesTypes } from './kindMembers.js';
import { ValuesByName } from './valuesByName.js';
import { atomParserFor, isScalarBody } from '../atom/forType.js';
import { lexerFormOfMeta } from '../compiler/tokenForms.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import {
  resolvesToConstructor,
  terminal,
  terminalDefinition,
  type EntryLookup,
} from './aliasChain.js';
import type { ChoiceBody, NamedField } from '../schema/meta/bodies.js';
import { isNestedMap } from '../schema/meta/schemaPaths.js';
import { namedFields, typeExprText, typeNameOf } from '../schema/meta/bodies.js';
import type { Token, Top, Type, TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import {
  dependentOn,
  isParametric,
  isValueEntry,
  parentsOf,
  subtypesOf,
  parametersOf,
  supertypesOf,
  typeParameters,
} from '../schema/meta/typedef.js';
import { inlineRefusal, sameTypeExpr } from '../schema/meta/typeInline.js';
import { isChoiceDisjoint } from './disjointness.js';
import { noType } from '../compiler/incompleteEntries.js';
import { sealedExtern } from './externs.js';
import { isAThroughHops, NO_HOPS, type ExternHops } from './externHops.js';
import { landingDefinition } from './externTarget.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Dependencies {@link validateReferences} needs beyond the merged namespace itself. */
export interface ValidateReferencesOptions {
  /**
   * The namespace's hops through its externs ([TSON-SCHEMA] §5.13): every IS-A this module asks -- a restated
   * field's type, a bound, a variant that is a choice -- is asked of the entry a name lands on, by identity.
   */
  readonly hops?: ExternHops;
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /**
   * The governing meta-schema's own entries (§3.3.1) — consulted only as a fallback for a
   * `source`/composition-supertype reference, never for an ordinary field/element/variant type
   * (§3.3.2: "NOT extended by the structure namespace"). Omitted means "no governing meta in
   * scope" (the meta-kernel bootstrap route), which every `source`/supertype reference must then
   * resolve in `merged` alone.
   */
  readonly structureNamespace?: ReadonlyMap<string, Top>;
  /** Each entry's facts: its position for a diagnostic, and the constructor its tag names. */
  readonly facts?: FactsTable;
  /**
   * Where a failing entry is reported, letting every other entry still be checked ([TSON-DATA]
   * §8.1: continue past an error to report multiple issues in one pass). Omitted means fail-fast:
   * the first {@link TsonSchemaValidationError} propagates.
   */
  readonly receiver?: DiagnosticsReceiver;
  /**
   * Each enum's label-type `normalization` (`LinkedSchema.enumForms`, [TSON-SCHEMA] §7.4), so a
   * field's default or pin naming an enum is read in the form the enum matches in. Omitted means
   * every enum matches as written.
   */
  readonly enumForms?: ReadonlyMap<string, Normalization>;
}

/**
 * Validates every reference in `merged` — every declared `source`, every `supertypes`/`subtypes`
 * entry, every field/element/key/value/variant type, every application written in place, and
 * every declared parameter's actual use (§5.10) — reporting (or throwing) a
 * {@link TsonSchemaValidationError} per entry that fails, or a {@link TsonBindMismatchError} when
 * a `Data` body breaks its own `references()` contract (see {@link validateBody}).
 */
export function validateReferences(
  merged: ReadonlyMap<string, Top>,
  options: ValidateReferencesOptions,
): void {
  const { schemaId, structureNamespace, receiver, facts } = options;
  const hops = options.hops ?? NO_HOPS;
  const enumForms = options.enumForms ?? NO_ENUM_FORMS;
  // A field's default or pin at a reference over a type that is no constructor is a value's qualified name,
  // judged by the walk a value body's names take (§5.12).
  const byName = new ValuesByName(merged, {
    schemaId,
    facts: facts ?? new Map(),
    structureNamespace: merged,
    ...(facts === undefined ? {} : { structureFacts: facts }),
  });
  for (const [name, def] of merged) {
    try {
      validateEntry(
        name,
        def,
        facts?.get(name)?.head,
        merged,
        hops,
        structureNamespace,
        enumForms,
        byName,
      );
    } catch (e: unknown) {
      if (!isReportableLinkError(e)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      receiver.report(linkProblem(schemaId, name, facts, e));
    }
  }
}

/**
 * The exception types a failing entry is ever reported under here. `TsonBindMismatchError`
 * covers a `Data` body's broken `references()` contract -- the reading application's own
 * mistake, not the schema's, but still located at the entry it was found on -- classified
 * `BIND_MISMATCH` by {@link linkProblem} rather than lumped in with `SCHEMA_ERROR`, mirroring
 * `compiler/schemaResolver.ts`'s own `isReportable`/`schemaProblemCode` pattern.
 */
type ReportableLinkError = TsonSchemaValidationError | TsonBindMismatchError;

function isReportableLinkError(e: unknown): e is ReportableLinkError {
  return e instanceof TsonSchemaValidationError || e instanceof TsonBindMismatchError;
}

/** One entry's link-time failure as a {@link Diagnostic}, located at that entry's own declaration. */
function linkProblem(
  schemaId: string,
  name: string,
  facts: FactsTable | undefined,
  error: ReportableLinkError,
): Diagnostic {
  return {
    code: error instanceof TsonBindMismatchError ? 'BIND_MISMATCH' : 'SCHEMA_ERROR',
    message: error.message,
    schemaId,
    schemaPointer: `/${name}`,
    ...schemaPositionOf(facts, name),
  };
}

// ── Per-entry validation ─────────────────────────────────────────────────────────────────────

const NO_ENUM_FORMS: ReadonlyMap<string, Normalization> = new Map();

function validateEntry(
  name: string,
  def: Top,
  head: string | undefined,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
  structureNamespace: ReadonlyMap<string, Top> | undefined,
  enumForms: ReadonlyMap<string, Normalization>,
  byName: ValuesByName,
): void {
  checkOpenEntryUsesEveryParameter(name, def);

  // A nested map's tag names the pre-loaded kernel's `meta.schema` whatever the schema imports (§2.1, §4.1).
  if (head !== undefined && !isNestedMap(def)) {
    // The constructor an entry's tag names was consumed at a *constructor role* (§3.3.1) when the
    // entry was resolved, unlike an ordinary type-ref (§3.3.2), so it gets the structure
    // namespace's fallback.
    const headLookup =
      structureNamespace === undefined || structureNamespace.size === 0
        ? namespace
        : mergeWithFallback(namespace, structureNamespace);
    validateName(
      { name: head, annotations: [] },
      headLookup,
      typeParameters(def),
      name,
      ' constructor',
      {
        construction: true,
      },
    );
  }

  for (const supertype of supertypesOf(def)) {
    if (!namespace.has(supertype) && !(structureNamespace?.has(supertype) ?? false)) {
      throw new TsonSchemaValidationError(`'${name}' has an unresolved supertype '${supertype}'`);
    }
  }
  for (const subtype of subtypesOf(def)) {
    if (!namespace.has(subtype)) {
      throw new TsonSchemaValidationError(`'${name}' has an unresolved subtype '${subtype}'`);
    }
  }
  for (const parent of parentsOf(def)) {
    const lookup =
      structureNamespace === undefined
        ? namespace
        : mergeWithFallback(namespace, structureNamespace);
    validateTypeExpr(parent, lookup, hops, typeParameters(def), name, ' parent');
  }

  validateBody(name, def, namespace, hops, typeParameters(def), enumForms, byName);
}

function validateBody(
  entryName: string,
  def: Top,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
  ownParameters: readonly string[],
  enumForms: ReadonlyMap<string, Normalization>,
  byName: ValuesByName,
): void {
  switch (def.kind) {
    case 'value_entry':
      // A value of a meta layer's own vocabulary: the names it holds are judged by its own slots'
      // types (a reference's), which the linker reads at link (§4.2, §5.12).
      return;
    case 'incomplete':
      // No type: what it writes is judged where it is completed (§5.5).
      return;
    case 'extern':
      // A name of another schema's namespace, judged where that schema is loaded (§5.13).
      return;
    case 'alias':
      validateName(def.target, namespace, ownParameters, entryName, '', { alias: true });
      return;
    case 'record': {
      // The chain is checked by validateEntry. A dependent field names a sibling, judged with its sibling
      // by §5.2's rules, and carries no value.
      checkDependentFields(entryName, def, namespace);
      for (const field of namedFields(def)) {
        validateTypeExpr(
          field.type,
          namespace,
          hops,
          ownParameters,
          entryName,
          ` field '${field.name}'`,
          true,
        );
        if (dependentOn(field.type) !== undefined) continue;
        checkFieldValue(entryName, field, namespace, ownParameters, enumForms, byName);
      }
      for (const group of def.groups) {
        for (const member of group.members.flat()) {
          if (!def.fields.entries.has(member)) {
            throw new TsonSchemaValidationError(
              `'${entryName}' has a field group referencing unknown field '${member}'`,
            );
          }
        }
      }
      checkRestatedFieldTypes(entryName, def, namespace, hops);
      return;
    }
    default:
      validateType(def, namespace, hops, ownParameters, entryName, '');
  }
}

/** The names a type body holds at its slots, at any depth of a type written in place (§4.2). */
function validateType(
  body: Type,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
): void {
  switch (body.kind) {
    case 'namespace':
      validateName(body.keyType, namespace, ownParameters, subject, `${trail} key_type`);
      validateTypeExpr(
        body.valueType,
        namespace,
        hops,
        ownParameters,
        subject,
        `${trail} value_type`,
      );
      return;
    case 'ref':
      validateName(body.of, namespace, ownParameters, subject, `${trail} of`);
      return;
    case 'map':
      validateName(body.keyType, namespace, ownParameters, subject, `${trail} key_type`);
      validateTypeExpr(
        body.valueType,
        namespace,
        hops,
        ownParameters,
        subject,
        `${trail} value_type`,
      );
      return;
    case 'array':
      validateTypeExpr(
        body.elementType,
        namespace,
        hops,
        ownParameters,
        subject,
        `${trail} element_type`,
      );
      return;
    case 'tuple':
      body.elements.forEach((element, index) => {
        validateTypeExpr(
          element.elementType,
          namespace,
          hops,
          ownParameters,
          subject,
          `${trail} element[${String(index)}]`,
        );
      });
      return;
    case 'choice': {
      body.variants.forEach((variant, index) => {
        validateTypeExpr(
          variant,
          namespace,
          hops,
          ownParameters,
          subject,
          `${trail} variant[${String(index)}]`,
        );
      });
      checkVariantsAreDistinct(subject, body, namespace);
      checkVariantsAreNotVoid(subject, body, namespace);
      checkVariantsAreNamed(subject, trail, body, namespace);
      checkChoiceVariantsAreDisjoint(subject, trail, body, namespace, hops);
      return;
    }
    case 'record':
      for (const field of namedFields(body)) {
        validateTypeExpr(
          field.type,
          namespace,
          hops,
          ownParameters,
          subject,
          `${trail} field '${field.name}'`,
          true,
        );
      }
      return;
    case 'apply':
      validateApplication(
        body.head,
        body.arguments,
        namespace,
        hops,
        ownParameters,
        subject,
        trail,
      );
      return;
    default:
      return; // no type reference of their own to validate
  }
}

// ── Field values (§5.2) ──────────────────────────────────────────────────────────────────────

/**
 * §5.2's "a fixed or default value is available on a scalar-typed field and nowhere else",
 * checked against `field`'s own *resolved* type -- which is why this runs here rather than in
 * `compiler/fieldModifiers.ts`'s own `resolveFieldModifiers` (that table answers before a field's
 * type is even known; see its own doc). Mirrors the reference implementation's own
 * `TsonSchemaLinker.checkFieldValue`.
 *
 * **The chain end is what has to be checked, not the hop.** A field typed by an alias (`a =>
 * text`, `f: a = hello`) states a value of whatever the alias names, and resolved output states
 * the chain rather than rewriting the use site past it (§8.3), so the walk happens here --
 * `field.type.name` is what the error names (the author's own spelling), and `terminal(...)` is
 * what decides whether the value reads.
 *
 * **Atoms and enums only, and the rest is not silently blessed.** A field typed by a record,
 * container or choice needs a compiled reader to check a value against, and compilation happens
 * after linking, so those are left for `compile.ts`'s own construction-time read (`STATUS.md`
 * tracks nothing extra here: a non-scalar default is caught below regardless, before any reader
 * is ever built).
 *
 * **A field whose own type is one of `ownParameters` is refused before it gets here**: a field typed by a
 * parameter takes no value (§5.10), so a value is checked only against a type that is the same in every
 * application.
 */
function checkFieldValue(
  entryName: string,
  field: NamedField,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  enumForms: ReadonlyMap<string, Normalization>,
  byName: ValuesByName,
): void {
  if (field.value === undefined) return;
  if (field.type.kind === 'inline') {
    // A value on a type written in place is admitted on a reference alone (§5.2, item 42), read as a name.
    const inPlace = field.type.of;
    if (inPlace.kind !== 'ref') throw notAScalarType(entryName, field, field.value, inPlace);
    if (!namesTypes(inPlace.of.name, lookupIn(namespace))) {
      byName.reach(
        `'${entryName}': field '${field.name}''s ${field.role === 'DEFAULT' ? 'default' : 'fixed value'}`,
        field.value.text,
        inPlace.of.name,
      );
    }
    return;
  }
  const fieldType: TypeRef = field.type;
  if (fieldType.param === true || ownParameters.includes(fieldType.name)) return;
  const terminalName = terminal(fieldType.name, lookupIn(namespace));
  const target = namespace.get(terminalName);
  if (target?.kind === 'extern') {
    // An extern is sealed: a field typed by it takes no default or pin (§5.13).
    throw sealedExtern(
      `'${entryName}': field '${field.name}'`,
      `its ${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ${asWritten(field.value)} is a value of`,
      fieldType.name,
      terminalName,
      target,
    );
  }
  // An unresolved reference is already reported by validateTypeExpr, above (a name the walk itself
  // does not reach, undeclared or a cycle, resolves no `target` here either). A parametric record or an
  // incomplete entry is no type and is refused at the field's type; a namespace value is not a type at all,
  // already rejected there too; and an alias target is past its hops by {@link terminal}, except at a cycle.
  if (
    target === undefined ||
    typeParameters(target).length > 0 ||
    target.kind === 'value_entry' ||
    target.kind === 'alias' ||
    target.kind === 'incomplete'
  ) {
    return;
  }
  const body = target;
  const value = field.value;
  if (body.kind === 'ref') {
    // A value at a reference-typed field is a name. Over a constructor it is a type's name, judged a member of
    // the reference by `namespaceTypes.ts`'s `checkReferencePins` (§4.2); over any other type it is a value's
    // qualified name, judged by what it reaches as a value body's names are (§5.12), against this entry.
    if (!namesTypes(body.of.name, lookupIn(namespace))) {
      byName.reach(
        `'${entryName}': field '${field.name}''s ${field.role === 'DEFAULT' ? 'default' : 'fixed value'}`,
        value.text,
        body.of.name,
      );
    }
    return;
  }
  if (!isScalarBody(body)) {
    throw notAScalarType(entryName, field, value, body);
  }
  const parser = atomParserFor(terminalName, body, enumForms.get(terminalName));
  if (parser === undefined) {
    return; // scalar but unchecked here -- see `atom/forType.ts`'s own top note
  }
  try {
    parser.read({ text: value.text, form: lexerFormOfMeta(value.form) });
  } catch (e: unknown) {
    if (!(e instanceof TsonAtomParseError || e instanceof TsonAtomValidationError)) {
      throw e;
    }
    // The field's two halves are what the author has to reconcile, so both are named, in the
    // order they are written, and the value is echoed as the schema spells it -- quoted if it was
    // quoted, so the author reads back their own line rather than a normalisation of it. The
    // atom's own message follows: it already states the rule and cites the section, so nothing
    // here restates it.
    throw new TsonSchemaValidationError(
      `'${entryName}': field '${field.name}' is declared '${typeNameOf(field)}', but its ` +
        `${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ${asWritten(value)} is ` +
        `not a value of that type -- ${e.message}. §5.2 makes a field's fixed or default value a ` +
        "value of the field's own declared type",
    );
  }
}

/**
 * §5.2's "Which fields may carry a value" -- only a scalar-typed field may, and the verdict is
 * about the field rather than about the token: §12.1 admits only a bare token after `~`/`=`
 * (writing `~ [...]` or `~ { ... }` is a syntax error, not another value), so for a non-scalar
 * field there is no better token to suggest.
 */
function notAScalarType(
  entryName: string,
  field: NamedField,
  value: Token,
  body: NonHeldTop,
): Error {
  return new TsonSchemaValidationError(
    `'${entryName}': field '${field.name}' is declared '${typeNameOf(field)}', which is ` +
      `${describeBody(body)}, so it cannot have ` +
      `${field.role === 'DEFAULT' ? 'a default' : 'a fixed value'} -- ${asWritten(value)} ` +
      'is a token, and §5.2 admits only a bare token there. A fixed or default value is ' +
      'available on a field typed by an atom or an enum, and nowhere else: drop the modifier, or ' +
      'declare the field with a scalar type',
  );
}

/** What a non-scalar body is, for the message -- named the way an author would name it, not by class. */
function describeBody(body: NonHeldTop): string {
  switch (body.kind) {
    case 'array':
      return 'an array';
    case 'map':
      return 'a map';
    case 'tuple':
      return 'a tuple';
    case 'record':
      return 'a record';
    case 'choice':
      return 'a choice';
    case 'alias':
      return 'an alias';
    case 'void_type':
      return 'the void type'; // reached only when isScalarBody already refused this same body
    case 'declared_type':
      return "a declared type, whose value names its own type rather than taking one from the position's own token shape";
    default:
      return 'not a scalar type';
  }
}

/** A token echoed the way the schema spells it, so a quoted value is visibly quoted in the message. */
function asWritten(token: Token): string {
  return token.form === 'UNQUOTED' ? token.text : `"${token.text}"`;
}

// ── Type references ──────────────────────────────────────────────────────────────────────────

/**
 * A type slot: a name, or a type written in place, walked where it stands (§4.2). A type in place is one only a
 * container, a tuple, a choice, a reference, a record or an application may be, carrying no chain; a dependent
 * type stands directly at a record field's type alone (`atField`, §5.2).
 */
function validateTypeExpr(
  expr: TypeExpr,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
  atField = false,
): void {
  if (expr.kind === 'inline') {
    const context = `'${subject}'${trail}`;
    const refusal = inlineRefusal(expr);
    if (refusal !== undefined) throw new TsonSchemaValidationError(`${context}: ${refusal}`);
    if (expr.of.kind === 'dependent' && !atField) {
      throw new TsonSchemaValidationError(
        `${context}: '${expr.of.on}!' is a dependent type, and stands only as a record field's type -- never ` +
          'inside a type, nor at any other slot (§5.2)',
      );
    }
    validateType(expr.of, namespace, hops, ownParameters, subject, trail);
    return;
  }
  validateName(expr, namespace, ownParameters, subject, trail);
}

/** What a name's position admits beyond a type: a construction head, an alias's target. */
interface NamePosition {
  /** A construction's head: a constructor, which a type slot would not take bare. */
  readonly construction?: true;
  /** An alias's target: another name for anything, a parametric record or an incomplete entry included. */
  readonly alias?: true;
}

/**
 * A name at a slot: it resolves, names no value entry (§4.1), names no parametric record bare -- no position
 * names one bare (§5.10) -- and names no incomplete entry, which is no type (§5.5). A parameter of the enclosing
 * parametric record is admitted at a type slot.
 */
function validateName(
  ref: TypeRef,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
  position: NamePosition = {},
): void {
  const context = `'${subject}'${trail}`;
  if (ref.param === true || ownParameters.includes(ref.name)) return;
  const target = namespace.get(ref.name);
  if (target === undefined) {
    throw new TsonSchemaValidationError(`${context} has an unresolved reference '${ref.name}'`);
  }
  if (position.alias === true) {
    // `meta.alias.target` is a `meta.type_ref`, whose `of` is `meta.type`: a value entry is no member of it, at
    // the immediate target or at the end of its hops (§4.1, §8.3). Anything else an alias may name.
    const end = namespace.get(terminal(ref.name, lookupIn(namespace)));
    if (end !== undefined && isValueEntry(end)) {
      throw new TsonSchemaValidationError(
        `${context} names '${ref.name}', which ${end === target ? 'is' : 'reaches'} a value and not a type -- ` +
          'an alias is another name for a type, and an entry applying a namespace type is a value of it (§4.1, §8.3)',
      );
    }
    return;
  }
  if (position.construction === true) return;
  if (isValueEntry(target)) {
    // An entry applying a namespace type is a value, never a type (§4.1).
    throw new TsonSchemaValidationError(
      `${context} names '${ref.name}', which is a value and not a type -- an entry applying a ` +
        'namespace type is a value of it, so nothing can be typed by it (§4.1)',
    );
  }
  // A reference's `of` names a type or a constructor, and like every slot names no incomplete entry and no
  // parametric record bare (§4.2).
  const end = namespace.get(terminal(ref.name, lookupIn(namespace)));
  if (end?.kind === 'incomplete') {
    throw new TsonSchemaValidationError(
      `${context} names '${ref.name}', ${noType(ref.name, end)} (§5.5)`,
    );
  }
  if (end !== undefined && isParametric(end)) {
    const parameters = typeParameters(end);
    throw new TsonSchemaValidationError(
      `${context}: '${ref.name}' is a parametric record taking ${String(parameters.length)} type argument` +
        `${parameters.length === 1 ? '' : 's'} [${parameters.join(', ')}], and a parametric record is not a ` +
        `type until it is applied -- write '${ref.name}<...>' with its arguments (§5.10)`,
    );
  }
}

/**
 * An application written in place, `head<arguments>` (§5.10): the head names a parametric record and takes as
 * many arguments as it declares parameters, each argument a name or a parameter. A parameter is never the head
 * -- §5.10 admits no head abstraction.
 */
function validateApplication(
  head: TypeRef,
  argumentsWritten: readonly TypeRef[],
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
): void {
  const context = `'${subject}'${trail}`;
  if (head.param === true || ownParameters.includes(head.name)) {
    throw new TsonSchemaValidationError(
      `${context}: '${head.name}' is a type parameter applied to arguments -- a parameter stands for a ` +
        'type, never for a parametric record, and §5.10 admits no head abstraction, so ' +
        `'${head.name}<...>' is no form. Take the applied type as the parameter instead`,
    );
  }
  const referenced = namespace.get(terminal(head.name, lookupIn(namespace)));
  if (namespace.get(head.name) === undefined || referenced === undefined) {
    throw new TsonSchemaValidationError(`${context} has an unresolved reference '${head.name}'`);
  }
  const parameters = typeParameters(referenced);
  if (parameters.length === 0) {
    throw new TsonSchemaValidationError(
      `${context}: '${head.name}' declares no type parameters, so '${head.name}<...>' applies ` +
        'arguments to something that takes none (§5.10); drop the argument list',
    );
  }
  if (parameters.length !== argumentsWritten.length) {
    throw new TsonSchemaValidationError(
      `${context}: '${head.name}' takes ${String(parameters.length)} type argument` +
        `${parameters.length === 1 ? '' : 's'} [${parameters.join(', ')}], but ` +
        `${String(argumentsWritten.length)} ${argumentsWritten.length === 1 ? 'was' : 'were'} applied (§5.10)`,
    );
  }
  const declared = parametersOf(referenced);
  argumentsWritten.forEach((argument, index) => {
    validateName(argument, namespace, ownParameters, subject, trail);
    const bound = declared[index]?.bound;
    if (bound === undefined || argument.param === true || ownParameters.includes(argument.name))
      return;
    if (!isA(argument.name, bound.name, namespace, hops)) {
      throw new TsonSchemaValidationError(
        `${context}: '${head.name}<...>' binds '${declared[index]?.name ?? ''}' to '${argument.name}', which is ` +
          `not a type that IS-A ${bound.name} -- an argument names a type that IS-A its parameter's written ` +
          'bound, past its alias hops (§5.10)',
      );
    }
  });
}

/**
 * Whether the type `name` IS-A `bound`: one type past their hops, alias and extern alike, by identity (§8.3, §5.13),
 * or `bound` among its supertypes, in the namespace holding the entry it lands on.
 */
function isA(
  name: string,
  bound: string,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
): boolean {
  const lookup = lookupIn(namespace);
  const own = terminal(name, lookup);
  const theirs = terminal(bound, lookup);
  if (own === theirs) return true;
  const supertypes = supertypesOf(namespace.get(own));
  return (
    supertypes.includes(theirs) ||
    supertypes.includes(bound) ||
    isAThroughHops(name, bound, lookup, hops)
  );
}

// ── Choice variants ──────────────────────────────────────────────────────────────────────────

/** {@link terminal}'s `EntryLookup` over a finished namespace `Map`. */
function lookupIn(namespace: ReadonlyMap<string, Top>): EntryLookup {
  return (name) => namespace.get(name);
}

/**
 * §5.4: "The resolver validates that each variant resolves to a distinct type." Judged at the end
 * of each variant's alias chain (§8.3: an alias and its target are one type), so `(text |
 * my_text)` with `my_text => text` is caught the same way `(text | text)` is.
 */
function checkVariantsAreDistinct(
  entryName: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const lookup = lookupIn(namespace);
  const seen: { readonly expr: TypeExpr; readonly key: TypeExpr }[] = [];
  for (const variant of choice.variants) {
    // A name is compared past its alias hops; a type written in place by its construction (§8.2). A name and a
    // type in place are never one type.
    const key: TypeExpr =
      variant.kind === 'inline'
        ? variant
        : { name: terminal(variant.name, lookup), annotations: [] };
    const first = seen.find((held) => sameTypeExpr(held.key, key));
    if (first === undefined) {
      seen.push({ expr: variant, key });
      continue;
    }
    const firstText = typeExprText(first.expr);
    const variantText = typeExprText(variant);
    throw new TsonSchemaValidationError(
      `'${entryName}' ${
        firstText === variantText
          ? `lists the variant '${variantText}' twice`
          : `variants '${firstText}' and '${variantText}' both resolve to '${typeExprText(key)}'`
      } -- §5.4 requires each variant to resolve to a distinct type`,
    );
  }
}

/**
 * A choice that is not disjoint names every variant (§5.4): its values are told apart by their tags, and a type
 * written in place is named by no tag, so one standing as a variant there could never be selected.
 */
function checkVariantsAreNamed(
  subject: string,
  trail: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const inPlace = choice.variants.find((variant) => variant.kind === 'inline');
  if (inPlace === undefined || isChoiceDisjoint(choice.variants, namespace)) return;
  throw new TsonSchemaValidationError(
    `'${subject}'${trail}: the choice '${typeExprText({ kind: 'inline', head: 'meta.choice', of: choice })}' ` +
      `is not disjoint, so each value names its variant with a tag, and the variant '${typeExprText(inPlace)}' ` +
      'is written in place, which no tag names (§4.2, §5.4): declare it under a name and list that name',
  );
}

/**
 * A variant that is a choice is disjoint, judged at the entry it reaches past its alias chain and any extern (§5.4,
 * §8.3, §5.13): a value of it carries the tag naming it, and a value carries one tag ([TSON-DATA] §3.2), so it is read
 * at the nested choice untagged, where a choice that is not disjoint could select nothing. A choice nests one deep.
 * One rule for both: a choice reached through an extern is a choice of another schema, whose variants are no names of
 * this one, so the advice for it is an extern per variant.
 */
function checkChoiceVariantsAreDisjoint(
  subject: string,
  trail: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, Top>,
  hops: ExternHops,
): void {
  const lookup = lookupIn(namespace);
  const nested = new Map<string, readonly string[]>();
  const foreign = new Set<string>();
  for (const variant of choice.variants) {
    if (variant.kind === 'inline' || variant.param === true) continue;
    const landing = hops.landing(variant.name);
    if (landing !== undefined) {
      const reached = landingDefinition(landing);
      if (reached?.kind !== 'choice' || reached.disjoint !== false) continue;
      nested.set(variant.name, reached.variants.map(typeExprText));
      foreign.add(variant.name);
      continue;
    }
    const inner = terminalDefinition(variant.name, lookup);
    if (inner?.kind !== 'choice' || isChoiceDisjoint(inner.variants, namespace, hops)) continue;
    nested.set(variant.name, inner.variants.map(typeExprText));
  }
  if (nested.size === 0) return;
  const written = choice.variants.map(typeExprText);
  const listed = [
    ...new Set(
      written.flatMap((variant) =>
        foreign.has(variant) ? [variant] : (nested.get(variant) ?? [variant]),
      ),
    ),
  ];
  const names = [...nested.keys()].join(', ');
  const inPlace = `'( ${listed.join(' | ')} )'`;
  const advice =
    foreign.size === 0
      ? `list its variants in its place, ${inPlace}`
      : foreign.size === nested.size
        ? 'name each of its variants by an extern of its own and list those in its place'
        : `list its variants in its place, ${inPlace}, naming each variant of [${[...foreign].join(', ')}] by an ` +
          'extern of its own';
  throw new TsonSchemaValidationError(
    `'${subject}'${trail}: the choice '( ${written.join(' | ')} )' has ` +
      (nested.size === 1
        ? `a variant '${names}' that is a choice`
        : `variants [${names}] that are choices`) +
      ' not disjoint -- a value of one carries the tag naming it and no other, so it is read there untagged ' +
      `and none of its variants could be selected (§5.4${foreign.size === 0 ? '' : ', §5.13'}): ${advice}`,
  );
}

/**
 * A variant must not resolve to `void` (§5.4): `(T | void)` spells optionality as a choice, and
 * optionality belongs to the position -- a field's `?` state, the `_` sentinel -- never to the
 * type occupying it. Judged at the end of the chain, like distinctness, so an alias of `void` is
 * caught under whatever name the author wrote.
 */
function checkVariantsAreNotVoid(
  entryName: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const lookup = lookupIn(namespace);
  for (const variant of choice.variants) {
    if (variant.kind === 'inline') continue;
    if (resolvesToConstructor(variant.name, lookup, 'void_type')) {
      throw new TsonSchemaValidationError(
        `'${entryName}' has a variant${variant.name === 'void' ? '' : ` '${variant.name}'`} ` +
          "resolving to 'void' -- optionality is not choice (§5.4): a value's absence is the " +
          "position's own state, so mark the position optional ('?') instead of uniting its " +
          'type with void',
      );
    }
  }
}

// ── Parameter usage (§5.10) ──────────────────────────────────────────────────────────────────

/**
 * §5.10's parameter-usage rule: a parametric record references every parameter it declares. `box => <T> { v:
 * text }` declares `T` and never uses it, so no application of it could differ from any other.
 */
function checkOpenEntryUsesEveryParameter(name: string, def: Top): void {
  const parameters = typeParameters(def);
  if (parameters.length === 0) {
    return;
  }
  const referenced = new Set<string>();
  collectBodyNames(def, referenced);
  for (const parameter of parameters) {
    if (!referenced.has(parameter)) {
      throw new TsonSchemaValidationError(
        `'${name}' declares the type parameter '${parameter}' and never references it, so every ` +
          'application of it would denote the same type -- a declared parameter must be used (§5.10)',
      );
    }
  }
}

/** Every name an entry's body mentions at its slots, at any depth of a type written in place, its parents included. */
export function collectBodyNames(body: Top, into: Set<string>): void {
  for (const parent of parentsOf(body)) collectExprNames(parent, into);
  if (body.kind === 'alias') {
    into.add(body.target.name);
    return;
  }
  if (body.kind === 'value_entry' || body.kind === 'incomplete' || body.kind === 'extern') return;
  collectTypeNames(body, into);
}

function collectExprNames(expr: TypeExpr, into: Set<string>): void {
  if (expr.kind === 'inline') collectTypeNames(expr.of, into);
  else into.add(expr.name);
}

function collectTypeNames(body: Type, into: Set<string>): void {
  switch (body.kind) {
    case 'record':
      for (const field of body.fields.entries.values()) collectExprNames(field.type, into);
      return;
    case 'array':
      collectExprNames(body.elementType, into);
      return;
    case 'map':
    case 'namespace':
      into.add(body.keyType.name);
      collectExprNames(body.valueType, into);
      return;
    case 'tuple':
      for (const element of body.elements) collectExprNames(element.elementType, into);
      return;
    case 'choice':
      for (const variant of body.variants) collectExprNames(variant, into);
      return;
    case 'ref':
      into.add(body.of.name);
      return;
    case 'apply':
      into.add(body.head.name);
      for (const argument of body.arguments) into.add(argument.name);
      return;
    default:
      return; // an atom body names no type
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

/** `fallback` entries, overridden by `primary` on collision -- `primary` isn't mutated. */
function mergeWithFallback(
  primary: ReadonlyMap<string, Top>,
  fallback: ReadonlyMap<string, Top>,
): Map<string, Top> {
  return new Map([...fallback, ...primary]);
}
