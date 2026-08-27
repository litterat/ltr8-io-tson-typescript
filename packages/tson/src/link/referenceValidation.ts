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
import { TsonSchemaValidationError } from '../core/errors.js';
import { isDataBody } from './bodyKind.js';
import type {
  ArrayBody,
  ChoiceBody,
  MapBody,
  RecordBody,
  TupleBody,
} from '../schema/meta/bodies.js';
import type { TypeArgument, TypeDefinition, TypeRef } from '../schema/meta/typedef.js';

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
  readonly structureNamespace?: ReadonlyMap<string, TypeDefinition>;
  /**
   * Where a failing entry is reported, letting every other entry still be checked ([TSON-DATA]
   * §8.1: continue past an error to report multiple issues in one pass). Omitted means fail-fast:
   * the first {@link TsonSchemaValidationError} propagates.
   */
  readonly receiver?: DiagnosticsReceiver;
}

/**
 * Validates every reference in `merged` — every declared `source`, every `supertypes`/`subtypes`
 * entry, every field/element/key/value/variant type, every held template's applications, and
 * every declared parameter's actual use (§5.10) — reporting (or throwing) a
 * {@link TsonSchemaValidationError} per entry that fails.
 */
export function validateReferences(
  merged: ReadonlyMap<string, TypeDefinition>,
  options: ValidateReferencesOptions,
): void {
  const { schemaId, structureNamespace, receiver } = options;
  for (const [name, def] of merged) {
    try {
      validateEntry(name, def, merged, structureNamespace);
    } catch (e: unknown) {
      if (!(e instanceof TsonSchemaValidationError)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      receiver.report(linkProblem(schemaId, name, def, e));
    }
  }
}

/** One entry's link-time failure as a {@link Diagnostic}, located at that entry's own declaration. */
function linkProblem(
  schemaId: string,
  name: string,
  def: TypeDefinition,
  error: TsonSchemaValidationError,
): Diagnostic {
  return {
    code: 'SCHEMA_ERROR',
    message: error.message,
    schemaId,
    schemaPointer: `/${name}`,
    ...(def.position === undefined ? {} : { schemaPosition: def.position }),
  };
}

// ── Per-entry validation ─────────────────────────────────────────────────────────────────────

function validateEntry(
  name: string,
  def: TypeDefinition,
  namespace: ReadonlyMap<string, TypeDefinition>,
  structureNamespace: ReadonlyMap<string, TypeDefinition> | undefined,
): void {
  checkOpenEntryUsesEveryParameter(name, def);

  if (def.source !== undefined) {
    // Unlike every other reference, `source` gets the structure-namespace fallback: the name it
    // records was consumed at a *constructor role* (§3.3.1) when this entry was originally
    // resolved, unlike an ordinary type-ref (§3.3.2). The one shape the fallback does not cover
    // is an application (`source.arguments` non-empty) -- desugar rewrites every constructor
    // application before resolution, so arguments surviving to here mean a §5.10 user-template
    // head, resolved in the type-name namespace only (§3.3.1).
    const source = def.source;
    const sourceLookup =
      structureNamespace === undefined ||
      structureNamespace.size === 0 ||
      source.arguments.length > 0
        ? namespace
        : mergeWithFallback(namespace, structureNamespace);
    validateTypeRef(source, sourceLookup, def.parameters, name, ' source');
  }

  for (const supertype of def.supertypes) {
    if (!namespace.has(supertype) && !(structureNamespace?.has(supertype) ?? false)) {
      throw new TsonSchemaValidationError(`'${name}' has an unresolved supertype '${supertype}'`);
    }
  }
  for (const subtype of def.subtypes) {
    if (!namespace.has(subtype)) {
      throw new TsonSchemaValidationError(`'${name}' has an unresolved subtype '${subtype}'`);
    }
  }

  validateBody(name, def, namespace, def.parameters);
}

function validateBody(
  entryName: string,
  def: TypeDefinition,
  namespace: ReadonlyMap<string, TypeDefinition>,
  ownParameters: readonly string[],
): void {
  const body = def.body;
  if (!('kind' in body)) {
    // A held TemplateBody: opaque to everything that needs to know what a reference *resolves
    // to* (that cannot be settled until substitution supplies arguments) except arity, which is
    // decidable without substituting -- see checkHeldArity's own note.
    checkHeldArity(entryName, body.applications(), namespace, ownParameters);
    return;
  }
  if (isDataBody(body)) {
    // A body describing something other than a data value, whose own type references (if any)
    // are declared rather than discovered (`Data.references()`, `schema/meta/typedef.ts`'s own
    // note).
    for (const reference of body.references?.() ?? []) {
      validateTypeRef(reference, namespace, ownParameters, entryName, ` (!${body.kind})`);
    }
    return;
  }
  switch (body.kind) {
    case 'record': {
      const r: RecordBody = body;
      for (const supertype of r.supertypes) {
        if (!namespace.has(supertype)) {
          throw new TsonSchemaValidationError(
            `'${entryName}' has an unresolved supertype '${supertype}'`,
          );
        }
      }
      for (const field of r.fields) {
        validateTypeRef(field.type, namespace, ownParameters, entryName, ` field '${field.name}'`);
      }
      for (const group of r.groups) {
        for (const member of group.members) {
          if (!r.fields.some((f) => f.name === member)) {
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
    case 'unit':
    case 'enum':
    case 'integer_type':
    case 'text_type':
    case 'uri_type':
    case 'regex_type':
    case 'decimal_type':
    case 'float_type':
    case 'rational_type':
    case 'uuid_type':
    case 'binary':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'email_type':
    case 'mac_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'complex_type':
    case 'unknown_type':
    case 'extern':
      return; // no type reference of their own to validate
  }
}

// ── Type references ──────────────────────────────────────────────────────────────────────────

function validateTypeRef(
  ref: TypeRef,
  namespace: ReadonlyMap<string, TypeDefinition>,
  ownParameters: readonly string[],
  subject: string,
  trail: string,
): void {
  const context = `'${subject}'${trail}`;
  const target = namespace.get(ref.name);
  if (target?.kind === 'DATA') {
    // §8.1's schema map holds only type definitions, so an entry describing something else has
    // no way to say "declare me, but do not let anything name me as a type" other than this
    // check. Without it the misuse resolves, links AND compiles, and fails only when a document
    // is read against it (§4.1: naming a DATA entry where a type is expected is a resolver error).
    throw new TsonSchemaValidationError(
      `${context} names '${ref.name}', which describes something other than a data value -- it ` +
        'is declared by this schema but is not a type, so nothing can be typed by it',
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
  namespace: ReadonlyMap<string, TypeDefinition>,
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
  namespace: ReadonlyMap<string, TypeDefinition>,
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
  const declared = referenced.parameters.length;
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
    throw new TsonSchemaValidationError(
      `${context}: '${ref.name}' is a template taking ${String(declared)} type argument` +
        `${declared === 1 ? '' : 's'} [${referenced.parameters.join(', ')}], and a template is ` +
        `not a type until it is applied -- write '${ref.name}<...>' with its arguments (§5.10)`,
    );
  }
  throw new TsonSchemaValidationError(
    `${context}: '${ref.name}' takes ${String(declared)} type argument${declared === 1 ? '' : 's'} ` +
      `[${referenced.parameters.join(', ')}], but ${String(supplied)} ${supplied === 1 ? 'was' : 'were'} ` +
      'applied (§5.10)',
  );
}

// ── Choice variants ──────────────────────────────────────────────────────────────────────────

/** The name a reference chain ends at (§8.3). A cycle stops the walk rather than hanging. */
function terminalName(name: string, namespace: ReadonlyMap<string, TypeDefinition>): string {
  const walked = new Set<string>();
  let current = name;
  while (!walked.has(current)) {
    walked.add(current);
    const def = namespace.get(current);
    const body = def?.body;
    if (
      def === undefined ||
      body === undefined ||
      !('kind' in body) ||
      isDataBody(body) ||
      body.kind !== 'reference' ||
      body.target.arguments.length > 0
    ) {
      return current; // an argument-bearing target is an application, not a hop to another entry
    }
    current = body.target.name;
  }
  return current;
}

/** A stable structural key for a {@link TypeRef}, ignoring `annotations` (identity is where a reference *points*). */
function typeRefKey(ref: TypeRef): string {
  return `${ref.name}<${ref.arguments.map(typeArgumentKey).join(',')}>`;
}

function typeArgumentKey(arg: TypeArgument): string {
  return arg.kind === 'ref' ? `r:${typeRefKey(arg.ref)}` : `v:${arg.value.form}:${arg.value.text}`;
}

/**
 * §5.4: "The resolver validates that each variant resolves to a distinct type." Judged after
 * §8.3 flattening (an alias and its target are one type), so `(text | my_text)` with
 * `my_text => text` is caught the same way `(text | text)` is.
 */
function checkVariantsAreDistinct(
  entryName: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, TypeDefinition>,
): void {
  const seen = new Map<string, string>();
  for (const variant of choice.variants) {
    const flattened: TypeRef = {
      name: terminalName(variant.name, namespace),
      arguments: variant.arguments,
      annotations: [],
    };
    const key = typeRefKey(flattened);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, variant.name);
      continue;
    }
    throw new TsonSchemaValidationError(
      `'${entryName}' ${
        first === variant.name
          ? `lists the variant '${variant.name}' twice`
          : `variants '${first}' and '${variant.name}' both resolve to '${flattened.name}'`
      } -- §5.4 requires each variant to resolve to a distinct type`,
    );
  }
}

/**
 * A variant must not resolve to `void` (§5.4): `(T | void)` spells optionality as a choice, and
 * optionality belongs to the position -- a field's `?` state, the `_` sentinel -- never to the
 * type occupying it.
 */
function checkVariantsAreNotVoid(
  entryName: string,
  choice: ChoiceBody,
  namespace: ReadonlyMap<string, TypeDefinition>,
): void {
  for (const variant of choice.variants) {
    if (terminalName(variant.name, namespace) === 'void') {
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
function checkOpenEntryUsesEveryParameter(name: string, def: TypeDefinition): void {
  if (def.parameters.length === 0) {
    return;
  }
  const referenced = new Set<string>();
  if (def.source !== undefined) collectNames(def.source, referenced);
  collectBodyNames(def.body, referenced);
  for (const parameter of def.parameters) {
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

/** Every name an entry's body mentions, for {@link checkOpenEntryUsesEveryParameter}. */
function collectBodyNames(body: TypeDefinition['body'], into: Set<string>): void {
  if (!('kind' in body)) {
    // The one question a held body answers without being resolved, and it answers it about
    // tokens rather than references -- the same rule substitution follows when deciding what to
    // rewrite.
    for (const n of body.names()) into.add(n);
    return;
  }
  if (isDataBody(body)) {
    return; // a Data body names no type parameter -- there is nothing to introspect
  }
  switch (body.kind) {
    case 'record':
      for (const field of body.fields) {
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
      return; // an atom body, Data, Unit, EnumBody, UnknownType, or Extern names no type parameter
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

/** `fallback` entries, overridden by `primary` on collision -- `primary` isn't mutated. */
function mergeWithFallback(
  primary: ReadonlyMap<string, TypeDefinition>,
  fallback: ReadonlyMap<string, TypeDefinition>,
): Map<string, TypeDefinition> {
  return new Map([...fallback, ...primary]);
}
