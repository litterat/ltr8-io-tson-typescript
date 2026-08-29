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
 *   entry's own scope, checked once per entry in `merged`.
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
 * rationale. This module states only what differs in the port: the per-name and per-scope
 * checks are not two passes here because `unicode/policy.ts`'s own `nameHygieneRefusal` already
 * does both in one pass per scope (per-name mechanisms first, in order; skeleton distinctness
 * last, once the whole scope is collected) — see that function's own doc.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonNameHygieneRefusedError } from '../core/errors.js';
import {
  DEFAULT_NAME_POLICY,
  nameHygieneRefusal,
  type NameHygieneRefusal,
  type NamePolicy,
} from '../unicode/policy.js';
import { UTS39_VERSION } from '../unicode/uts39.js';
import { isDataBody } from './bodyKind.js';
import type { SourcePosition } from '../schema/meta/position.js';
import type { TypeDefinition } from '../schema/meta/typedef.js';

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
  readonly namePolicy?: NamePolicy;
  /**
   * Where a refusal is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first refusal throws {@link TsonNameHygieneRefusedError} — never {@link
   * TsonSchemaValidationError} (`core/errors.ts`'s own note explains why a refusal must not be
   * one of §8.1's four categories).
   */
  readonly receiver?: DiagnosticsReceiver;
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
  const namePolicy = options.namePolicy ?? DEFAULT_NAME_POLICY;

  const namespaceRefusal = nameHygieneRefusal(merged.keys(), namePolicy);
  if (namespaceRefusal !== undefined) {
    const at = namespaceRefusal.names[namespaceRefusal.names.length - 1] ?? '';
    const message =
      `the namespace of '${schemaId}' is refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's merged-namespace scope): ${namespaceRefusal.detail} (computed ` +
      `against UTS #39 version ${UTS39_VERSION})`;
    reportOrThrow(namespaceRefusal, message, schemaId, at, merged.get(at)?.position, receiver);
  }

  for (const [name, def] of merged) {
    const scope = entryScope(def);
    if (scope === undefined) continue;
    const refusal = nameHygieneRefusal(scope.names, namePolicy);
    if (refusal === undefined) continue;
    const message =
      `'${name}' has ${scope.noun} refused under [TSON-DATA] §8.2's name-hygiene policy ` +
      `([TSON-SCHEMA] §11.4's ${scope.noun} scope): ${refusal.detail} (computed against UTS #39 ` +
      `version ${UTS39_VERSION})`;
    reportOrThrow(refusal, message, schemaId, name, def.position, receiver);
  }
}

/** One entry's own §11.4 scope — its record field names or its enum members — or `undefined` for every other body shape, which declares no scope of its own. */
function entryScope(
  def: TypeDefinition,
): { readonly names: readonly string[]; readonly noun: string } | undefined {
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
      return { names: body.fields.map((field) => field.name), noun: 'field names' };
    case 'enum':
      return { names: body.members, noun: 'enum members' };
    default:
      return undefined;
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
    code: 'NAME_HYGIENE_REFUSED',
    message,
    schemaId,
    schemaPointer: `/${pointerName}`,
    ...(position === undefined ? {} : { schemaPosition: position }),
  });
}
