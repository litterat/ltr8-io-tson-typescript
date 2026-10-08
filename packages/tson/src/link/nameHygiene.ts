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
 *   entry's own scope, checked once per entry in `merged`. **An enum's own scope is conditional on
 *   its `type`** (§7.4, §11.4): where `type` is an identifier family every mechanism applies,
 *   as always; under any other type the members are values, not names, so mechanisms 2
 *   (`Identifier_Status`) and 3 (restriction level) do not reach them — only mechanism 1
 *   (skeleton distinctness) still relates two members that read alike, and `textProfileScopePolicy`
 *   is the one-line policy that drops the other two for exactly that scope's check.
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
  DEFAULT_NAME_POLICY,
  nameHygieneRefusal,
  type NameHygieneRefusal,
  type NamePolicy,
} from '../unicode/policy.js';
import { UTS39_VERSION } from '../unicode/uts39.js';
import { identifierProfileOf } from '../unicode/identifier-profile.js';
import { applyNormalization } from '../unicode/normalization.js';
import { judgeName } from '../unicode/policy.js';
import { isDataBody } from './bodyKind.js';
import type { EnumLabelProfile } from './enumLabels.js';
import type { SourcePosition } from '../schema/meta/position.js';
import type { Top, TypeDefinition } from '../schema/meta/typedef.js';
import { typeParameters } from '../schema/meta/typedef.js';
import { terminalDefinition } from './referenceChain.js';

/** Dependencies {@link checkNameHygiene} needs beyond the merged namespace itself. */
export interface CheckNameHygieneOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy, applied over every scope this module checks.
   * Defaults to {@link DEFAULT_NAME_POLICY} — mechanisms 1 and 2 enforced, mechanism 3 at
   * Highly Restrictive over the whole name — matching §8.2's own defaults, the same default
   * `reader/schemaless/tree.ts` applies to its own Part 1 scope.
   */
  readonly identifierPolicy?: NamePolicy;
  /**
   * Where a refusal is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first refusal throws {@link TsonNameHygieneRefusedError} — never {@link
   * TsonSchemaValidationError} (`core/errors.ts`'s own note explains why a refusal must not be
   * one of §8.1's four categories).
   */
  readonly receiver?: DiagnosticsReceiver;
  /**
   * The enums whose `type` is not an identifier family (`LinkedSchema.textEnums`, [TSON-SCHEMA]
   * §7.4): their members are values rather than names, so only mechanism 1 reaches them.
   */
  readonly textEnums?: ReadonlySet<string>;
  /**
   * The enums whose members linking has already refused as not values of their `type`: judging
   * those members as names too would report the one mistake twice.
   */
  readonly refusedEnums?: ReadonlySet<string>;
  /**
   * The enums whose `type` is an identifier family, with the profile each member is judged under
   * and the form it is put into ([TSON-SCHEMA] §7.4): a member is a value of that type, so what
   * the profile adds is exempt for it as it is for a value at a position typed by the family.
   */
  readonly enumProfiles?: ReadonlyMap<string, EnumLabelProfile>;
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
  merged: ReadonlyMap<string, TypeDefinition>,
  options: CheckNameHygieneOptions,
): void {
  const { schemaId, receiver } = options;
  const identifierPolicy = options.identifierPolicy ?? DEFAULT_NAME_POLICY;

  const namespaceRefusal = nameHygieneRefusal(merged.keys(), identifierPolicy);
  if (namespaceRefusal !== undefined) {
    const at = namespaceRefusal.names[namespaceRefusal.names.length - 1] ?? '';
    const message =
      `the namespace of '${schemaId}' is refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's merged-namespace scope): ${namespaceRefusal.detail} (computed ` +
      `against UTS #39 version ${UTS39_VERSION})`;
    reportOrThrow(namespaceRefusal, message, schemaId, at, merged.get(at)?.position, receiver);
  }

  const textEnums = options.textEnums ?? new Set<string>();
  const refusedEnums = options.refusedEnums ?? new Set<string>();

  const enumProfiles = options.enumProfiles ?? new Map<string, EnumLabelProfile>();

  for (const [name, def] of merged) {
    const labelProfile = refusedEnums.has(name) ? undefined : enumProfiles.get(name);
    const scope =
      labelProfile === undefined
        ? entryScope(def, textEnums.has(name), refusedEnums.has(name))
        : undefined;
    if (labelProfile !== undefined) {
      checkEnumMembers(name, def, labelProfile, identifierPolicy, schemaId, receiver);
    }
    if (scope !== undefined) {
      const scopePolicy = scope.textProfile
        ? textProfileScopePolicy(identifierPolicy)
        : identifierPolicy;
      const refusal = nameHygieneRefusal(scope.names, scopePolicy);
      if (refusal !== undefined) {
        const message =
          `'${name}' has ${scope.noun} refused under [TSON-DATA] §8.2's name-hygiene policy ` +
          `([TSON-SCHEMA] §11.4's ${scope.noun} scope): ${refusal.detail} (computed against ` +
          `UTS #39 version ${UTS39_VERSION})`;
        reportOrThrow(refusal, message, schemaId, name, def.position, receiver);
      }
    }
    checkFieldValues(name, def, merged, identifierPolicy, schemaId, receiver);
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
        reportOrThrow(refusal, message, schemaId, name, def.position, receiver);
      }
    }
  }
}

/**
 * The members of an enum whose `type` is an identifier family (§7.4, §11.4): each is a value of
 * that type, so it is judged under the family's profile and in its form, as a value of the family
 * is anywhere; skeleton distinctness relates the members as one scope, first, and every per-name
 * rule a member fails is reported (a throw reports the first).
 */
function checkEnumMembers(
  entry: string,
  def: TypeDefinition,
  label: EnumLabelProfile,
  policy: NamePolicy,
  schemaId: string,
  receiver: DiagnosticsReceiver | undefined,
): void {
  const body = def.body;
  if (!('kind' in body) || isDataBody(body) || body.kind !== 'enum') return;
  const values = body.members.map((member) => applyNormalization(label.form, member));
  const relation = nameHygieneRefusal(values, textProfileScopePolicy(policy));
  if (relation !== undefined) {
    const message =
      `'${entry}' has enum members refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's enum members scope): ${relation.detail} (computed against ` +
      `UTS #39 version ${UTS39_VERSION})`;
    reportOrThrow(relation, message, schemaId, entry, def.position, receiver);
  }
  for (const value of values) {
    for (const violation of judgeName(value, label.profile, policy)) {
      const refusal: NameHygieneRefusal = {
        mechanism: violation.mechanism,
        names: [value],
        detail: violation.detail,
      };
      const message =
        `'${entry}' has enum members refused under [TSON-DATA] §8.2's name-hygiene policy ` +
        `([TSON-SCHEMA] §11.4's enum members scope): ${violation.detail} (computed against ` +
        `UTS #39 version ${UTS39_VERSION})`;
      reportOrThrow(refusal, message, schemaId, entry, def.position, receiver);
    }
  }
}

/**
 * A `TEXT`-profile enum's own scope policy (§7.4, §11.4, #21): mechanism 1 (skeleton
 * distinctness) still relates two members that read alike, but mechanisms 2 and 3 do not reach
 * values that are not names -- "a `TEXT` enum's members are values, and mechanisms 2 and 3 do not
 * reach them". Built from `base`, the caller's own configured policy, so a deployment's mechanism-1
 * relaxation still applies here too; only mechanisms 2 and 3 are unconditionally dropped.
 */
function textProfileScopePolicy(base: NamePolicy): NamePolicy {
  return { ...base, identifierStatus: false, restrictionLevel: 'UNRESTRICTED' };
}

/** One entry's own §11.4 scope — its record field names or its enum members — or `undefined` for every other body shape, which declares no scope of its own. */
function entryScope(
  def: TypeDefinition,
  isTextEnum: boolean,
  isRefused: boolean,
):
  | { readonly names: readonly string[]; readonly noun: string; readonly textProfile: boolean }
  | undefined {
  const body = def.body;
  if (!('kind' in body) || isDataBody(body)) {
    // A held TemplateBody is unresolved (no field/member list exists yet to check), and a Data
    // body describes something other than a data value -- §11.4 names no scope for either.
    return undefined;
  }
  switch (body.kind) {
    case 'record':
      // Group labels are already ordinary `record_field`s here (§5.11's own resolution rule:
      // "each member becomes an ordinary record_field"), so no separate group-label pass exists.
      return {
        names: body.fields.map((field) => field.name),
        noun: 'field names',
        textProfile: false,
      };
    case 'enum':
      return {
        names: isRefused ? [] : body.members,
        noun: 'enum members',
        textProfile: isTextEnum,
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
  def: TypeDefinition,
  merged: ReadonlyMap<string, TypeDefinition>,
  policy: NamePolicy,
  schemaId: string,
  receiver: DiagnosticsReceiver | undefined,
): void {
  const body: Top = def.body;
  if (!('kind' in body) || isDataBody(body) || body.kind !== 'record') return;
  for (const field of body.fields) {
    if (field.value === undefined) continue;
    const family = terminalDefinition(field.type.name, (n) => merged.get(n))?.body;
    if (
      family === undefined ||
      !('kind' in family) ||
      isDataBody(family) ||
      family.kind !== 'identifier_type'
    ) {
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
        `'${entry}' has ${what} for '${field.name}' where ${violation.detail} (refused under ` +
        `[TSON-DATA] §8.2's name-hygiene policy; computed against UTS #39 version ${UTS39_VERSION})`;
      reportOrThrow(refusal, message, schemaId, entry, def.position, receiver);
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
