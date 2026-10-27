/**
 * [TSON-SCHEMA] §11.4's schema-layer name-hygiene scopes, checked at link time over the fully
 * merged namespace `linkSchema` has just assembled ([TSON-DATA] §8.2's three mechanisms, applied
 * through `unicode/policy.ts`'s own `nameHygieneRefusal`).
 *
 * §11.4 names four scopes. This module implements three of them in one pass, because the fourth
 * is not a separate check but a special case of the first:
 *
 * - **The merged namespace at `!!import`** and **the declared names of one schema** are the same
 *   scope, checked the same way, over the same set — `merged`'s keys. §11.4 calls the import
 *   case out as "the sharpest" because it is the one where the check actually has work to do (a
 *   schema with no `!!import` has `merged` equal to its own local entries, so the two scopes
 *   coincide by construction rather than by a second code path).
 * - **The members of one enum** and **the field names of one record** (group labels included —
 *   §5.11's own resolution rule already flattens a group's members into the body's ordinary
 *   `fields` list before this module ever sees it, so no separate handling is needed) are each
 *   entry's own scope, checked once per entry in `merged`, **under the entry's name type's
 *   profile** (§5.2, §7.4, §11.4): every enum's and every record's name type is an identifier
 *   family, so all three mechanisms apply, and what the profile adds (`json_name`'s `@`, a medial
 *   space) is the profile's own and meets no `Identifier_Status` rule. A record that states no
 *   name type has the kernel's `field_name`, §7.7's profile.
 *
 * **A fifth scope §11.4 declines to make one: a template's own type parameters.** §11.4 says so
 * outright — "A template's parameter list is not a scope either (§5.10): one author writes it
 * whole on one line, and the list stays short so that it stays reviewable" — and this module
 * checks it anyway (`typeParameters`, `schema/meta/typedef.ts`, over every entry that declares
 * any), against the spec's own text rather than in a gap it leaves. The reference implementation's
 * `SPEC-FEEDBACK.md` #5 records the same divergence as an open proposal against the same clause,
 * reasoning that a parameter is a name and `<T, Т>` (Latin/Cyrillic) is exactly the substitution
 * hazard §8.2 exists to refuse, whatever §5.10 does or does not need from the reviewability a
 * short parameter list already buys. All three mechanisms apply here exactly as they do for the
 * other schema-layer scopes.
 *
 * **Choice variants are deliberately not a fourth scope.** A variant is a reference to a
 * declared name (§5.4), so two confusable variants are two confusable entries in the namespace
 * scope above and are already caught there — a check over a choice's own `variants` list could
 * never fire, because whichever of the pair arrived second already tripped the namespace check
 * when *it* was declared.
 *
 * **Every entry in `merged` is checked, imported ones included** — the same choice
 * `referenceValidation.ts` makes and states the reasoning for: an imported entry already passed
 * this check in its own schema, so re-checking it here costs work but never produces a false
 * diagnostic, and the alternative (skip imported entries) would miss a spoofed name arriving
 * *through* an import, which is exactly the compositional hazard §11.4 calls out.
 *
 * Ported from the reference implementation's `TsonSchemaLinker.checkNames`
 * (`tson-compiler/.../TsonSchemaLinker.java`); see that method's own comment for the exhaustive
 * rationale. This module states only what differs in the port: the per-scope and per-name
 * checks are not two passes here because `unicode/policy.ts`'s own `nameHygieneRefusal` already
 * does both in one pass per scope — skeleton distinctness first, over the whole scope at once,
 * then the per-name mechanisms in order, matching `checkScope`'s own "its own collision relation,
 * then each name's own two rules" — see that function's own doc.
 */
import { diagnosticCodeForMechanism } from '../core/diagnostic.js';
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonNameHygieneRefusedError } from '../core/errors.js';
import {
  DEFAULT_IDENTIFIER_POLICY,
  nameHygieneRefusal,
  type NameHygieneRefusal,
  type IdentifierPolicy,
} from '../unicode/policy.js';
import { UTS39_VERSION } from '../unicode/uts39.js';
import { identifierProfileOf } from '../unicode/identifier-profile.js';
import { applyNormalization } from '../unicode/normalization.js';
import { judgeName } from '../unicode/policy.js';
import type { EnumLabelProfile } from './enumLabels.js';
import type { FieldNameType } from './fieldNames.js';
import type { SourcePosition } from '../schema/meta/position.js';
import type { Top } from '../schema/meta/typedef.js';
import { isTemplateBody, typeParameters } from '../schema/meta/typedef.js';
import type { FactsTable } from './facts.js';
import { terminalDefinition } from './referenceChain.js';

/** Dependencies {@link checkNameHygiene} needs beyond the merged namespace itself. */
export interface CheckNameHygieneOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /** Each entry's facts, for a diagnostic's position. */
  readonly facts?: FactsTable;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy, applied over every scope this module checks.
   * Defaults to {@link DEFAULT_IDENTIFIER_POLICY} — mechanisms 1 and 2 enforced, mechanism 3 at
   * Highly Restrictive over the whole name — matching §8.2's own defaults, the same default
   * `reader/schemaless/tree.ts` applies to its own Part 1 scope.
   */
  readonly identifierPolicy?: IdentifierPolicy;
  /**
   * Where a refusal is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first refusal throws {@link TsonNameHygieneRefusedError} — never {@link
   * TsonSchemaValidationError} (`core/errors.ts`'s own note explains why a refusal must not be
   * one of §8.1's four categories).
   */
  readonly receiver?: DiagnosticsReceiver;
  /**
   * The enums and records whose members or field names linking has already refused as not values
   * of their name type: judging those names under the hygiene rules too would report the one
   * mistake twice.
   */
  readonly refusedEnums?: ReadonlySet<string>;
  /**
   * The enums whose `type` is an identifier family, with the profile each member is judged under
   * and the form it is put into ([TSON-SCHEMA] §7.4): a member is a value of that type, so what
   * the profile adds is exempt for it as it is for a value at a position typed by the family.
   */
  readonly enumProfiles?: ReadonlyMap<string, EnumLabelProfile>;
  /**
   * The records that state a `name_type`, with the identifier family their field names are values
   * of ([TSON-SCHEMA] §5.2, §11.4): each name is judged under that family's profile and in its form,
   * so what the profile adds (`json_name`'s `@`, a medial space) is exempt as it is for a value of
   * the family. A record absent here has the kernel's `field_name`, §7.7's profile.
   */
  readonly nameTypes?: ReadonlyMap<string, FieldNameType>;
}

/**
 * Checks every §11.4 scope over `merged` — the fully-merged namespace {@link linkSchema} has
 * already assembled, `subtypes`/`disjoint` populated — reporting (or throwing) a refusal per
 * scope that fails. Call this after `computeSubtypes`/`computeDisjointness`, before {@link
 * validateReferences}, matching the reference implementation's own ordering: name hygiene is a
 * policy question about the names themselves, independent of whether the namespace they occupy
 * is otherwise well-formed.
 */
export function checkNameHygiene(
  merged: ReadonlyMap<string, Top>,
  options: CheckNameHygieneOptions,
): void {
  const { schemaId, receiver } = options;
  const positionOf = (name: string): SourcePosition | undefined =>
    options.facts?.get(name)?.position;
  const identifierPolicy = options.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;

  const namespaceRefusal = nameHygieneRefusal(merged.keys(), identifierPolicy);
  if (namespaceRefusal !== undefined) {
    const at = namespaceRefusal.names[namespaceRefusal.names.length - 1] ?? '';
    const message =
      `the namespace of '${schemaId}' is refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's merged-namespace scope): ${namespaceRefusal.detail} (computed ` +
      `against UTS #39 version ${UTS39_VERSION})`;
    reportOrThrow(namespaceRefusal, message, schemaId, at, positionOf(at), receiver);
  }

  const refusedEnums = options.refusedEnums ?? new Set<string>();

  const enumProfiles = options.enumProfiles ?? new Map<string, EnumLabelProfile>();

  for (const [name, def] of merged) {
    const nameType = options.nameTypes?.get(name);
    const labelProfile = refusedEnums.has(name)
      ? undefined
      : (enumProfiles.get(name) ?? (nameType === undefined ? undefined : profileOf(nameType)));
    const scope = labelProfile === undefined ? entryScope(def, refusedEnums.has(name)) : undefined;
    if (labelProfile !== undefined) {
      checkProfiledNames(
        name,
        def,
        positionOf(name),
        labelProfile,
        identifierPolicy,
        schemaId,
        receiver,
      );
    }
    if (scope !== undefined) {
      const refusal = nameHygieneRefusal(scope.names, identifierPolicy);
      if (refusal !== undefined) {
        const message =
          `'${name}' has ${scope.noun} refused under [TSON-DATA] §8.2's name-hygiene policy ` +
          `([TSON-SCHEMA] §11.4's ${scope.noun} scope): ${refusal.detail} (computed against ` +
          `UTS #39 version ${UTS39_VERSION})`;
        reportOrThrow(refusal, message, schemaId, name, positionOf(name), receiver);
      }
    }
    checkFieldValues(name, def, positionOf(name), merged, identifierPolicy, schemaId, receiver);
    const parameters = typeParameters(def);
    if (parameters.length > 0) {
      const refusal = nameHygieneRefusal(parameters, identifierPolicy);
      if (refusal !== undefined) {
        const message =
          `'${name}' has its own type parameters refused under [TSON-DATA] §8.2's ` +
          `name-hygiene policy (this implementation's own scope, against [TSON-SCHEMA] §11.4's ` +
          `own text declining to make one -- a parameter is a name and the substitution hazard ` +
          `§8.2 exists to refuse applies to it the same as any other declared name): ` +
          `${refusal.detail} (computed against UTS #39 version ${UTS39_VERSION})`;
        reportOrThrow(refusal, message, schemaId, name, positionOf(name), receiver);
      }
    }
  }
}

/** The profile and form a record's field names are judged under: its name type's (§5.2). */
function profileOf(nameType: FieldNameType): EnumLabelProfile {
  return {
    profile: identifierProfileOf(nameType.definition),
    form: nameType.definition.normalization,
  };
}

/**
 * The members of an enum, or the field names of a record, whose name type is an identifier family
 * (§5.2, §7.4, §11.4): each is a value of that type, so it is judged under the family's profile and
 * in its form, as a value of the family is anywhere; skeleton distinctness relates the names as one
 * scope, first, and every per-name rule a name fails is reported (a throw reports the first).
 */
function checkProfiledNames(
  entry: string,
  def: Top,
  position: SourcePosition | undefined,
  label: EnumLabelProfile,
  policy: IdentifierPolicy,
  schemaId: string,
  receiver: DiagnosticsReceiver | undefined,
): void {
  const body = def;
  if (isTemplateBody(body) || (body.kind !== 'enum' && body.kind !== 'record')) return;
  const names = body.kind === 'enum' ? body.members : [...body.fields.entries.keys()];
  const noun = body.kind === 'enum' ? 'enum members' : 'field names';
  const values = names.map((member) => applyNormalization(label.form, member));
  const relation = nameHygieneRefusal(values, relationOnly(policy));
  if (relation !== undefined) {
    const message =
      `'${entry}' has ${noun} refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's ${noun} scope): ${relation.detail} (computed against ` +
      `UTS #39 version ${UTS39_VERSION})`;
    reportOrThrow(relation, message, schemaId, entry, position, receiver);
  }
  for (const value of values) {
    for (const violation of judgeName(value, label.profile, policy)) {
      const refusal: NameHygieneRefusal = {
        mechanism: violation.mechanism,
        names: [value],
        detail: violation.detail,
      };
      const message =
        `'${entry}' has ${noun} refused under [TSON-DATA] §8.2's name-hygiene policy ` +
        `([TSON-SCHEMA] §11.4's ${noun} scope): ${violation.detail} (computed against ` +
        `UTS #39 version ${UTS39_VERSION})`;
      reportOrThrow(refusal, message, schemaId, entry, position, receiver);
    }
  }
}

/**
 * `base` with only its look-alike relation left (§8.2 mechanism 1): what a profiled scope asks of
 * the whole set before {@link judgeName} asks each name its per-name rules under the profile,
 * which §7.7's fixed profile could not judge fairly. A deployment's mechanism-1 relaxation still
 * applies.
 */
function relationOnly(base: IdentifierPolicy): IdentifierPolicy {
  return { ...base, restrictionLevel: 'UNRESTRICTED' };
}

/** One entry's own §11.4 scope — its record field names or its enum members — or `undefined` for every other body shape, which declares no scope of its own. */
function entryScope(
  def: Top,
  isRefused: boolean,
): { readonly names: readonly string[]; readonly noun: string } | undefined {
  const body = def;
  if (isTemplateBody(body)) {
    // A held TemplateBody is unresolved (no field/member list exists yet to check) -- §11.4 names
    // no scope for one.
    return undefined;
  }
  switch (body.kind) {
    case 'record':
      // Group labels are already ordinary `record_field`s here (§5.11's own resolution rule:
      // "each member becomes an ordinary record_field"), so no separate group-label pass exists.
      return {
        names: isRefused ? [] : [...body.fields.entries.keys()],
        noun: 'field names',
      };
    case 'enum':
      return {
        names: isRefused ? [] : body.members,
        noun: 'enum members',
      };
    default:
      return undefined;
  }
}

/**
 * §8.2's per-name rules over the values a schema supplies for its data: a field's default or fixed
 * value, where the field's type is an identifier family. Such a value is a name, as the same token
 * written in a document is -- and a default reaches every document that omits the field, so a value
 * the reader would refuse if the document wrote it must not be one the reader injects. Judged under
 * the family's own profile, as a read judges it: over the value, the text in the family's
 * normalization form. Every rule the value fails is reported (a throw reports the first).
 */
function checkFieldValues(
  entry: string,
  def: Top,
  position: SourcePosition | undefined,
  merged: ReadonlyMap<string, Top>,
  policy: IdentifierPolicy,
  schemaId: string,
  receiver: DiagnosticsReceiver | undefined,
): void {
  const body: Top = def;
  if (isTemplateBody(body) || body.kind !== 'record') return;
  for (const [fieldName, field] of body.fields.entries) {
    if (field.value === undefined) continue;
    const family = terminalDefinition(field.type.name, (n) => merged.get(n));
    if (family === undefined || isTemplateBody(family) || family.kind !== 'identifier_type') {
      continue;
    }
    const value = applyNormalization(family.normalization, field.value.text);
    const what = field.role === 'FIXED' ? 'a fixed value' : 'a default';
    for (const violation of judgeName(value, identifierProfileOf(family), policy)) {
      const refusal: NameHygieneRefusal = {
        mechanism: violation.mechanism,
        names: [value],
        detail: violation.detail,
      };
      const message =
        `'${entry}' has ${what} for '${fieldName}' where ${violation.detail} (refused under ` +
        `[TSON-DATA] §8.2's name-hygiene policy; computed against UTS #39 version ${UTS39_VERSION})`;
      reportOrThrow(refusal, message, schemaId, entry, position, receiver);
    }
  }
}

/** Reports `refusal` through `receiver`, or throws {@link TsonNameHygieneRefusedError} when there is none. */
function reportOrThrow(
  refusal: NameHygieneRefusal,
  message: string,
  schemaId: string,
  pointerName: string,
  position: SourcePosition | undefined,
  receiver: DiagnosticsReceiver | undefined,
): void {
  if (receiver === undefined) {
    throw new TsonNameHygieneRefusedError(message, {
      mechanism: refusal.mechanism,
      names: refusal.names,
      uts39Version: UTS39_VERSION,
      schemaId,
      pointer: `/${pointerName}`,
    });
  }
  receiver.report({
    code: diagnosticCodeForMechanism(refusal.mechanism),
    message,
    schemaId,
    schemaPointer: `/${pointerName}`,
    ...(position === undefined ? {} : { schemaPosition: position }),
  });
}
