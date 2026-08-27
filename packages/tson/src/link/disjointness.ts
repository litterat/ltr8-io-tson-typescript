/**
 * Derives {@link TypeDefinition.disjoint} for every choice entry (§5.4): a namespace-wide pass,
 * like `subtypes.ts`'s own {@link computeSubtypes}, since a variant's discrimination class is
 * only knowable with every entry resolved.
 *
 * Ported from the reference implementation's `ChoiceDisjointness`/`DiscriminationClass`
 * (`tson-compiler/.../ChoiceDisjointness.java`, `.../reader/DiscriminationClass.java`); see those
 * files' own module docs for the exhaustive rationale. This module states only what differs in
 * the port.
 *
 * **The derivation is total and two-valued, and deliberately coarse.** §5.4 states exactly what a
 * resolver may prove: "a resolver MUST record exactly this — it MUST NOT prove more (value-set
 * separation such as disjoint numeric bounds or disjoint patterns does not make a choice
 * disjoint) or less". So this module does not reach for `regex/`'s product-NFA pattern
 * disjointness at all, even though two `regex`-refined string variants might provably never
 * share a value: both classify as `STRING` and are therefore *not* disjoint by this rule, however
 * separated their patterns are, because separating them would need the very second, type-directed
 * inspection of the value's form that [TSON-DATA] §2.4's once-only-pass rule forbids a reader.
 * `regex/disjoint.ts`'s `isDisjointFrom` is real and tested (Wave 1), but this is the one place in
 * the linker it is deliberately *not* wired in — see this package's own report on this work
 * package for the citation.
 */
import { resolveBaseType } from '../base/baseTypeResolver.js';
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import { isDataBody } from './bodyKind.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Reference, TypeDefinition } from '../schema/meta/typedef.js';

/**
 * The granularity at which TSON text discriminates an untagged value ([TSON-DATA] §4's four
 * scalar base-type classes plus the two container delimiter forms). Records and maps share
 * `BRACE` deliberately (and arrays and tuples `BRACKET`): both are `{...}`/`[...]` on the wire
 * and the empty `{}` is ambiguous between record and map, so calling them distinct would promise
 * a discrimination the encoding cannot deliver on every value.
 */
export type DiscriminationClass = 'NULL' | 'BOOLEAN' | 'NUMBER' | 'STRING' | 'BRACE' | 'BRACKET';

/** An enum's class is its members' shared base-type class (e.g. `[true false]` is BOOLEAN); mixed → `undefined`. */
function classifyEnum(body: EnumBody): DiscriminationClass | undefined {
  let common: DiscriminationClass | undefined;
  for (const member of body.members) {
    const base = resolveBaseType({ text: member, form: 'unquoted' });
    const memberClass: DiscriminationClass =
      base.kind === 'null'
        ? 'NULL'
        : base.kind === 'boolean'
          ? 'BOOLEAN'
          : base.kind === 'number'
            ? 'NUMBER'
            : 'STRING';
    if (common === undefined) {
      common = memberClass;
    } else if (common !== memberClass) {
      return undefined;
    }
  }
  return common;
}

function classify(def: TypeDefinition): DiscriminationClass | undefined {
  const body = def.body;
  if (!('kind' in body)) {
    return undefined; // a held TemplateBody: no class until an application closes it
  }
  if (isDataBody(body)) {
    return undefined; // a body describing something other than a data value has no class
  }
  switch (body.kind) {
    case 'integer_type':
    case 'decimal_type':
    case 'float_type':
      return 'NUMBER';
    case 'text_type':
    case 'uri_type':
    case 'regex_type':
    case 'uuid_type':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'binary':
    case 'email_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'mac_type':
      return 'STRING';
    case 'enum':
      return classifyEnum(body);
    case 'record':
    case 'map':
      return 'BRACE';
    case 'array':
    case 'tuple':
      return 'BRACKET';
    // rational/complex need a tag (their typed forms straddle classes); unit, unknown_type,
    // choice, extern, and a Data body all have no class either.
    default:
      return undefined;
  }
}

/**
 * The class of `name`'s untagged wire values, or `undefined` when it has none. A reference chain
 * is followed to its terminal entry first (§8.3 makes an alias and its target one type); a cycle,
 * having no terminal, has no class. An `undefined` result makes the enclosing choice
 * non-disjoint and blocks untagged recovery — the conservative side, the tag stays required.
 */
export function discriminationClassOf(
  name: string,
  namespace: ReadonlyMap<string, TypeDefinition>,
): DiscriminationClass | undefined {
  const walked = new Set<string>();
  let current = name;
  for (;;) {
    if (walked.has(current)) {
      return undefined; // a reference cycle has no terminal entry, so no class
    }
    walked.add(current);
    const def = namespace.get(current);
    if (def === undefined) {
      return undefined;
    }
    const body = def.body;
    // An argument-bearing target is an application rather than a hop, and has no entry to
    // classify until materialisation mints one -- which it has, for every entry a compiled
    // choice can reach.
    if ('kind' in body && !isDataBody(body) && body.kind === 'reference') {
      const reference: Reference = body;
      if (reference.target.arguments.length === 0) {
        current = reference.target.name;
        continue;
      }
    }
    return classify(def);
  }
}

/** `true` exactly when every variant has a class and no class repeats (§5.4). */
export function isChoiceDisjoint(
  variants: readonly { readonly name: string }[],
  namespace: ReadonlyMap<string, TypeDefinition>,
): boolean {
  const seen = new Set<DiscriminationClass>();
  for (const variant of variants) {
    const variantClass = discriminationClassOf(variant.name, namespace);
    if (variantClass === undefined || seen.has(variantClass)) {
      return false;
    }
    seen.add(variantClass);
  }
  return true;
}

/**
 * Derives `disjoint` for every `choice`-bodied entry in `merged`, over the fully-merged
 * namespace. Pure: entries with no `choice` body keep their identity, and `merged` itself is
 * returned unchanged when it holds no choice at all.
 */
export function computeDisjointness(
  merged: ReadonlyMap<string, TypeDefinition>,
): Map<string, TypeDefinition> {
  const result = new Map(merged);
  for (const [name, def] of merged) {
    const body = def.body;
    if ('kind' in body && !isDataBody(body) && body.kind === 'choice') {
      result.set(name, { ...def, disjoint: isChoiceDisjoint(body.variants, merged) });
    }
  }
  return result;
}

/** Dependencies {@link checkDisjointAssertions} needs beyond the merged namespace itself. */
export interface CheckDisjointAssertionsOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /** Where a failing assertion is reported; omitted means fail-fast (see `referenceValidation.ts`'s own note). */
  readonly receiver?: DiagnosticsReceiver;
}

/**
 * §5.4's `@disjoint` assertion, checked against the fact {@link computeDisjointness} derived. The
 * annotation carries no decode force -- the resolver computes `type_definition.disjoint` whether
 * or not it is present -- and exists to be checked against that derived fact, converting a silent
 * drift into a diagnostic. Two outcomes, because the fact is two-valued: `disjoint: true`
 * verifies the assertion silently; `false` makes it an error. There is no third, unprovable
 * outcome to report, which is what makes `@disjoint` mean *machine-verified* rather than merely
 * asserted.
 *
 * **Local entries only.** An imported entry was checked when its own schema linked, and a
 * diagnostic here stamps *this* schema's own identity -- re-checking an imported entry would
 * report another document's problem against this one.
 *
 * **Checked against `def.annotations` only, not key annotations.** §6 lets `@disjoint` appear
 * before the declared name too, but a resolved schema's key annotations
 * (`schemaResolver.ts`'s own `Schema.keyAnnotations`) are a project-tracked gap
 * (`STATUS.md`: "`annotations` is bound as an ordinary wire field, not as a record's annotations
 * carrier"). A caller with a `Schema.keyAnnotations` map in hand may extend the check this
 * function performs by also testing that map for the marker; this function itself sees only the
 * definition's own `annotations`.
 */
export function checkDisjointAssertions(
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
  options: CheckDisjointAssertionsOptions,
): void {
  const { schemaId, receiver } = options;
  for (const name of localNames) {
    const def = merged.get(name);
    if (def === undefined) continue;
    const body = def.body;
    if (!('kind' in body) || isDataBody(body) || body.kind !== 'choice') continue;
    if (!def.annotations.some((a) => a.name === 'disjoint')) continue;
    if (def.disjoint === true) continue; // verified -- the assertion holds, and says so

    const variants = body.variants.map((v) => v.name);
    const message =
      `'${name}' asserts @disjoint, but its variants [${variants.join(', ')}] are not ` +
      'disjoint (§5.4) -- two of them occupy the same discrimination class (or one has no class ' +
      "at all), so no encoding's single form-resolution pass can tell them apart and every value " +
      'keeps its !variant tag; drop the assertion, or use a field group (§5.11), which ' +
      'discriminates by label and needs no disjointness';
    if (receiver === undefined) {
      throw new TsonSchemaValidationError(message);
    }
    receiver.report({
      code: 'SCHEMA_ERROR',
      message,
      schemaId,
      schemaPointer: `/${name}`,
      ...(def.position === undefined ? {} : { schemaPosition: def.position }),
    });
  }
}
