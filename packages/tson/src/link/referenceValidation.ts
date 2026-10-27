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
 * **One simplification from the Java: error attribution.** The reference implementation walks
 * back from a derived (sugar-lifted or template-materialised) entry to the nearest declaration
 * that has a source position of its own (`reportedAgainst`/`heldDeclarationNaming`), so a defect
 * inside a synthetic entry — `array_some_typo_95c9a10f` — is blamed on the author's own line
 * rather than on a name nobody typed. This port reports every failure against the entry it was
 * found on instead, synthetic or not. A synthetic entry still carries no `position`
 * (`schema/meta/typedef.ts`'s own contract), so a diagnostic against one still locates
 * correctly — it simply omits `schemaPosition` rather than borrowing the referrer's — and the
 * message still names the entry `EntryDisplayName` would render, since a synthetic name is never
 * hidden, only decorated. The richer walk-back is a diagnostic-quality improvement, not a
 * correctness one, and is left as follow-up work.
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
import { atomParserFor, isScalarBody } from '../atom/forType.js';
import { lexerFormOfMeta } from '../compiler/tokenForms.js';
import { heldOf } from '../compiler/heldBody.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import { resolvesToConstructor, terminal, type EntryLookup } from './referenceChain.js';
import { isKindMember } from './kindMembers.js';
import type {
  ArrayBody,
  ChoiceBody,
  MapBody,
  NamedField,
  RecordBody,
  TupleBody,
} from '../schema/meta/bodies.js';
import { namedFields } from '../schema/meta/bodies.js';
import type { Token, Top, TypeArgument, TypeRef } from '../schema/meta/typedef.js';
import {
  isFamilyBase,
  isNamespaceValue,
  isTemplateBody,
  parentsOf,
  subtypesOf,
  supertypesOf,
  typeParameters,
} from '../schema/meta/typedef.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Dependencies {@link validateReferences} needs beyond the merged namespace itself. */
export interface ValidateReferencesOptions {
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
 * entry, every field/element/key/value/variant type, every held template's applications, and
 * every declared parameter's actual use (§5.10) — reporting (or throwing) a
 * {@link TsonSchemaValidationError} per entry that fails, or a {@link TsonBindMismatchError} when
 * a `Data` body breaks its own `references()` contract (see {@link validateBody}).
 */
export function validateReferences(
  merged: ReadonlyMap<string, Top>,
  options: ValidateReferencesOptions,
): void {
  const { schemaId, structureNamespace, receiver, facts } = options;
  const enumForms = options.enumForms ?? NO_ENUM_FORMS;
  for (const [name, def] of merged) {
    try {
      validateEntry(name, def, facts?.get(name)?.head, merged, structureNamespace, enumForms);
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
  structureNamespace: ReadonlyMap<string, Top> | undefined,
  enumForms: ReadonlyMap<string, Normalization>,
): void {
  checkOpenEntryUsesEveryParameter(name, def);

  if (head !== undefined) {
    // The constructor an entry's tag names was consumed at a *constructor role* (§3.3.1) when the
    // entry was resolved, unlike an ordinary type-ref (§3.3.2), so it gets the structure
    // namespace's fallback.
    const headLookup =
      structureNamespace === undefined || structureNamespace.size === 0
        ? namespace
        : mergeWithFallback(namespace, structureNamespace);
    validateTypeRef(
      { name: head, arguments: [], annotations: [] },
      headLookup,
      typeParameters(def),
      name,
      ' constructor',
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
    validateTypeRef(parent, lookup, typeParameters(def), name, ' parent');
  }

  validateBody(name, def, namespace, typeParameters(def), enumForms);
}

function validateBody(
  entryName: string,
  def: Top,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  enumForms: ReadonlyMap<string, Normalization>,
): void {
  const body = def;
  if (isTemplateBody(body)) {
    // A held TemplateBody: opaque to everything that needs to know what a reference *resolves
    // to* (that cannot be settled until substitution supplies arguments) except arity, which is
    // decidable without substituting -- see checkHeldArity's own note.
    checkHeldArity(entryName, heldOf(body)?.applications() ?? [], namespace, ownParameters);
    return;
  }
  switch (body.kind) {
    case 'namespace':
      // A value of a meta layer's own vocabulary: the names it holds are judged by its own slots'
      // types (a kind's, a reference's), which the linker reads at link (§4.2, §5.12).
      return;
    case 'record': {
      const r: RecordBody = body;
      for (const field of namedFields(r)) {
        validateTypeRef(field.type, namespace, ownParameters, entryName, ` field '${field.name}'`);
        checkFieldValue(entryName, field, namespace, ownParameters, enumForms);
      }
      for (const group of r.groups) {
        for (const member of group.members.flat()) {
          if (!r.fields.entries.has(member)) {
            throw new TsonSchemaValidationError(
              `'${entryName}' has a field group referencing unknown field '${member}'`,
            );
          }
        }
      }
      return;
    }
    // A reference body holds a `type_name`, so there is no argument list to check arity or
    // nested references against beyond the target itself.
    case 'reference':
      validateTypeRef(body.target, namespace, ownParameters, entryName, '');
      return;
    case 'map': {
      const m: MapBody = body;
      validateTypeRef(m.keyType, namespace, ownParameters, entryName, ' key_type');
      validateTypeRef(m.valueType, namespace, ownParameters, entryName, ' value_type');
      return;
    }
    case 'array': {
      const a: ArrayBody = body;
      validateTypeRef(a.elementType, namespace, ownParameters, entryName, ' element_type');
      return;
    }
    case 'tuple': {
      const t: TupleBody = body;
      t.elements.forEach((element, index) => {
        validateTypeRef(
          element.elementType,
          namespace,
          ownParameters,
          entryName,
          ` element[${String(index)}]`,
        );
      });
      return;
    }
    case 'choice': {
      const c: ChoiceBody = body;
      c.variants.forEach((variant, index) => {
        validateTypeRef(variant, namespace, ownParameters, entryName, ` variant[${String(index)}]`);
      });
      checkVariantsAreDistinct(entryName, c, namespace);
      checkVariantsAreNotVoid(entryName, c, namespace);
      return;
    }
    case 'value_type':
    case 'void_type':
    case 'enum':
    case 'kind_type':
    case 'ref_type':
    case 'integer_type':
    case 'text_type':
    case 'identifier_type':
    case 'uri_type':
    case 'iri_type':
    case 'regex_type':
    case 'decimal_type':
    case 'float_type':
    case 'rational_type':
    case 'uuid_type':
    case 'bytes_type':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'period_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'email_type':
    case 'mac_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'hostname_type':
    case 'host_type':
    case 'media_type_type':
    case 'complex_type':
    case 'scoped':
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
 * **A field whose own type is one of `ownParameters` is skipped by construction.** A held body is
 * not read as this vocabulary at all, so the only parametric field reaching this function has
 * already been substituted by materialisation and is checked against the concrete type it was
 * closed with.
 */
function checkFieldValue(
  entryName: string,
  field: NamedField,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  enumForms: ReadonlyMap<string, Normalization>,
): void {
  if (field.value === undefined || ownParameters.includes(field.type.name)) {
    return;
  }
  // A parametric `= P` / `~ P` in a record template (§5.7, §5.10): the parameter rides `value`
  // where it is written, and materialisation substitutes the argument, which is checked then.
  if (field.value.form === 'UNQUOTED' && ownParameters.includes(field.value.text)) {
    return;
  }
  const terminalName = terminal(field.type.name, lookupIn(namespace));
  const target = namespace.get(terminalName);
  // An unresolved reference is already reported by validateTypeRef, above (a name the walk itself
  // does not reach, undeclared or a cycle, resolves no `target` here either). A target that is
  // still open (or an application of one) has no single body to check against until
  // materialisation closes it. A held body (no `kind` of its own) is excluded by the parameters
  // check just above, kept here too as a defensive no-op; a namespace value is not a type at all,
  // already rejected as this field's own type reference by `validateTypeRef`; and a
  // `reference`-bodied target cannot occur here -- {@link terminal} does not stop on one except at
  // a cycle or an argument-bearing target, both already excluded by `target === undefined`/
  // `field.type.arguments.length > 0` respectively (an alias's own `target` never carries
  // arguments once closed, §8.1).
  if (
    target === undefined ||
    typeParameters(target).length > 0 ||
    field.type.arguments.length > 0 ||
    isTemplateBody(target) ||
    target.kind === 'namespace' ||
    target.kind === 'reference'
  ) {
    return;
  }
  const body = target;
  const value = field.value;
  if (body.kind === 'kind_type') {
    checkKindValue(entryName, field, value, body.of, namespace);
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
      `'${entryName}': field '${field.name}' is declared '${field.type.name}', but its ` +
        `${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ${asWritten(value)} is ` +
        `not a value of that type -- ${e.message}. §5.2 makes a field's fixed or default value a ` +
        "value of the field's own declared type",
    );
  }
}

/**
 * A `~`/`=` value at a kind-typed field ([TSON-SCHEMA] §4.2, §5.2): a type name, judged a member of
 * the kind by the walk over the entry it resolves to (`kindMembers.ts`) -- `enum => enum_type ^ {
 * name_type?: = identifier }` pins a name, and the pin is judged here, where it is written, rather
 * than at the first schema applying the constructor. A fixed or default value is a value of its
 * field's own type, so a name resolving to nothing, or to an entry not built with the kind's
 * constructor, is refused with the field's two halves named.
 */
function checkKindValue(
  entryName: string,
  field: NamedField,
  value: Token,
  of: string,
  namespace: ReadonlyMap<string, Top>,
): void {
  const lookup = lookupIn(namespace);
  if (isKindMember(value.text, of, lookup, () => undefined, lookup)) return;
  throw new TsonSchemaValidationError(
    `'${entryName}': field '${field.name}' is declared '${field.type.name}', but its ` +
      `${field.role === 'DEFAULT' ? 'default' : 'fixed value'} ${asWritten(value)} is not a ` +
      'value of that type -- ' +
      (namespace.has(value.text)
        ? `'${value.text}' is not a member of the kind, the names of the types built with '${of}'`
        : 'it names nothing in scope') +
      ". §5.2 makes a field's fixed or default value a value of the field's own declared type",
  );
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
    `'${entryName}': field '${field.name}' is declared '${field.type.name}', which is ` +
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
    case 'reference':
      return 'an alias';
    case 'void_type':
      return 'the void type'; // reached only when isScalarBody already refused this same body
    case 'scoped':
      return "a scoped type, whose value names its own type rather than taking one from the position's own token shape";
    default:
      return 'not a scalar type';
  }
}

/** A token echoed the way the schema spells it, so a quoted value is visibly quoted in the message. */
function asWritten(token: Token): string {
  return token.form === 'UNQUOTED' ? token.text : `"${token.text}"`;
}

// ── Type references ──────────────────────────────────────────────────────────────────────────

function validateTypeRef(
  ref: TypeRef,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
): void {
  const context = `'${subject}'${trail}`;
  const target = namespace.get(ref.name);
  if (target !== undefined && !ownParameters.includes(ref.name) && isNamespaceValue(target)) {
    // An entry applying a namespace type is a value, never a type (§4.1): without this check the
    // misuse resolves, links AND compiles, and fails only when a document is read against it.
    throw new TsonSchemaValidationError(
      `${context} names '${ref.name}', which is a value and not a type -- an entry applying a ` +
        'namespace type is a value of it, so nothing can be typed by it (§4.1)',
    );
  }
  if (!namespace.has(ref.name) && !ownParameters.includes(ref.name)) {
    throw new TsonSchemaValidationError(`${context} has an unresolved reference '${ref.name}'`);
  }
  checkArity(ref, namespace, ownParameters, context);
  for (const arg of ref.arguments) {
    if (arg.kind === 'ref') {
      validateTypeRef(arg.ref, namespace, ownParameters, subject, trail);
    }
    // A TypeArgumentValue is a literal token, not a type reference -- nothing to validate.
  }
}

/**
 * §5.10's arity rule over the **applications** a held body writes: `chain => <T> { tail:
 * chain<T, T>? }` applies two arguments to a one-parameter template, and nothing ever closes
 * that application, so deferring the check would let the template ship with the mistake in it.
 * Decidable without substituting: arity compares the argument count written against the
 * parameter count the referenced entry declares, neither of which depends on what the arguments
 * resolve to.
 */
function checkHeldArity(
  entryName: string,
  applications: readonly TypeRef[],
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
): void {
  for (const application of applications) {
    checkArity(application, namespace, ownParameters, `'${entryName}'`);
    for (const argument of application.arguments) {
      if (argument.kind === 'ref') {
        checkArity(argument.ref, namespace, ownParameters, `'${entryName}'`);
      }
    }
  }
}

/**
 * §5.10's arity rule over every reference in the schema: a reference supplies exactly as many
 * arguments as the entry it names declares parameters. Three author-error shapes collapse into
 * this: too many, too few, and none at all (a template named without applying it).
 *
 * A reference naming one of the enclosing declaration's own parameters has no arity to check --
 * but is not simply skipped: §5.10 admits no head abstraction, so a parameter carrying an
 * argument list is refused here, where the author wrote it.
 */
function checkArity(
  ref: TypeRef,
  namespace: ReadonlyMap<string, Top>,
  ownParameters: readonly string[],
  context: string,
): void {
  if (ownParameters.includes(ref.name)) {
    if (ref.arguments.length > 0) {
      throw new TsonSchemaValidationError(
        `${context}: '${ref.name}' is a type parameter applied to arguments -- a parameter ` +
          'stands for a type, never for a template, and §5.10 admits no head abstraction, so ' +
          `'${ref.name}<...>' is no form. Name the template and apply that, or take the applied ` +
          'type as the parameter instead',
      );
    }
    return;
  }
  const referenced = namespace.get(ref.name);
  if (referenced === undefined) {
    return; // reached only through the structure-namespace fallback, which the caller already allowed
  }
  const referencedParameters = typeParameters(referenced);
  const declared = referencedParameters.length;
  const supplied = ref.arguments.length;
  if (declared === supplied) {
    return;
  }
  if (declared === 0) {
    throw new TsonSchemaValidationError(
      `${context}: '${ref.name}' declares no type parameters, so '${ref.name}<...>' applies ` +
        'arguments to something that takes none (§5.10); drop the argument list',
    );
  }
  if (supplied === 0) {
    // §5.10: a record template is a family base, the one open entry that IS a type without
    // being applied -- never a reference, container, constructor-application or atom template,
    // which stay refused below.
    if (isFamilyBase(referenced)) {
      return;
    }
    throw new TsonSchemaValidationError(
      `${context}: '${ref.name}' is a template taking ${String(declared)} type argument` +
        `${declared === 1 ? '' : 's'} [${referencedParameters.join(', ')}], and a template is ` +
        `not a type until it is applied -- write '${ref.name}<...>' with its arguments (§5.10)`,
    );
  }
  throw new TsonSchemaValidationError(
    `${context}: '${ref.name}' takes ${String(declared)} type argument${declared === 1 ? '' : 's'} ` +
      `[${referencedParameters.join(', ')}], but ${String(supplied)} ${supplied === 1 ? 'was' : 'were'} ` +
      'applied (§5.10)',
  );
}

// ── Choice variants ──────────────────────────────────────────────────────────────────────────

/** A stable structural key for a {@link TypeRef}, ignoring `annotations` (identity is where a reference *points*). */
function typeRefKey(ref: TypeRef): string {
  return `${ref.name}<${ref.arguments.map(typeArgumentKey).join(',')}>`;
}

function typeArgumentKey(arg: TypeArgument): string {
  return arg.kind === 'ref' ? `r:${typeRefKey(arg.ref)}` : `v:${arg.value.form}:${arg.value.text}`;
}

/** {@link terminal}'s `EntryLookup` over a finished namespace `Map`. */
function lookupIn(namespace: ReadonlyMap<string, Top>): EntryLookup {
  return (name) => namespace.get(name);
}

/**
 * §5.4: "The resolver validates that each variant resolves to a distinct type." Judged at the end
 * of each variant's reference chain (§8.3: an alias and its target are one type), so `(text |
 * my_text)` with `my_text => text` is caught the same way `(text | text)` is.
 */
function checkVariantsAreDistinct(
  entryName: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, Top>,
): void {
  const lookup = lookupIn(namespace);
  const seen = new Map<string, string>();
  for (const variant of choice.variants) {
    const atEnd: TypeRef = {
      name: terminal(variant.name, lookup),
      arguments: variant.arguments,
      annotations: [],
    };
    const key = typeRefKey(atEnd);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, variant.name);
      continue;
    }
    throw new TsonSchemaValidationError(
      `'${entryName}' ${
        first === variant.name
          ? `lists the variant '${variant.name}' twice`
          : `variants '${first}' and '${variant.name}' both resolve to '${atEnd.name}'`
      } -- §5.4 requires each variant to resolve to a distinct type`,
    );
  }
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
 * §5.10's parameter-usage rule: an *open* entry references every parameter it declares.
 * `box => <T> { v: text }` declares `T` and never uses it, so no application of it could differ
 * from any other -- the parameter is a mistake, not a degenerate-but-legal template.
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

function collectNames(ref: TypeRef, into: Set<string>): void {
  into.add(ref.name);
  for (const argument of ref.arguments) {
    if (argument.kind === 'ref') {
      collectNames(argument.ref, into);
    }
  }
}

/** Every name an entry's body mentions: for {@link checkOpenEntryUsesEveryParameter}, and for finding the declaration that wrote a minted entry's name (`recordExtension.ts`). */
export function collectBodyNames(body: Top, into: Set<string>): void {
  if (isTemplateBody(body)) {
    // The one question a held body answers without being resolved, and it answers it about
    // tokens rather than references -- the same rule substitution follows when deciding what to
    // rewrite.
    for (const n of heldOf(body)?.names() ?? []) into.add(n);
    return;
  }
  switch (body.kind) {
    case 'namespace':
      return; // a namespace value names no type parameter -- there is nothing to introspect
    case 'record':
      for (const parent of parentsOf(body)) collectNames(parent, into);
      for (const field of body.fields.entries.values()) {
        collectNames(field.type, into);
        // A routed parameter rides `value` like any other token, so it is named here too --
        // which is what keeps `<S> base ^ { status: = S }` from reading as a template that
        // never uses S.
        if (field.value !== undefined) into.add(field.value.text);
      }
      return;
    case 'array':
      collectNames(body.elementType, into);
      return;
    case 'map':
      collectNames(body.keyType, into);
      collectNames(body.valueType, into);
      return;
    case 'tuple':
      for (const element of body.elements) collectNames(element.elementType, into);
      return;
    case 'choice':
      for (const variant of body.variants) collectNames(variant, into);
      return;
    case 'reference':
      collectNames(body.target, into);
      return;
    default:
      return; // an atom body, an EnumBody, or a Scoped names no type parameter
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
