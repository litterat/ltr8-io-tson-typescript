/**
 * Construction sugar (§5.3): `C<a₁ … aₙ>` over a constructor `C` is the construction `!C { f₁: a₁ … fₙ: aₙ }`,
 * where `f₁ … fₙ` are `C`'s **argument slots** -- its required fields that hold a type, typed `meta.type_expr` or
 * by a reference naming types, and not pinned or defaulted by its chain, in declaration order. At a type slot the
 * construction is written in place. It is a row of §5.3's sugar table beside `[T]` and `{K => V}`, so
 * `meta.array<text>`, `[text]` and `!meta.array { element_type: text }` build one value.
 *
 * **A constructor** here is a closed record IS-A `meta.type`: one whose instances are types. A head that composes
 * `meta.top` alone builds values, and a parametric record substitutes rather than constructs, so neither is one.
 *
 * **The sugar decides only where each argument lands.** Every other verdict is the construction's, the same one
 * `!C { … }` written out gets. Only the argument count is refused here.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import { metaName } from '../schema/meta/kernel.js';
import type { Top } from '../schema/meta/typedef.js';
import { isParametric, supertypesOf } from '../schema/meta/typedef.js';
import { terminal } from '../link/aliasChain.js';
import { namesTypes } from '../link/kindMembers.js';
import type { DefinitionGetter } from './resolverTypes.js';

const TYPE = metaName('type');
const NAMESPACE = metaName('namespace');
/** The kernel's `meta.type_expr`: what a type slot holds, a type's name or a type written in place. */
const TYPE_EXPR = metaName('type_expr');

/**
 * Whether `definition`, the entry at the end of `name`'s alias chain, is a constructor construction sugar applies:
 * a closed record IS-A `meta.type`. A parametric record is applied by substitution, never constructed (§5.10).
 */
export function constructs(name: string, definition: Top | undefined): boolean {
  return (
    definition?.kind === 'record' &&
    !isParametric(definition) &&
    (name === TYPE || supertypesOf(definition).includes(TYPE))
  );
}

/**
 * Refuses `written`, an application at a type slot filling `slots`, where its constructor `name` builds a
 * namespace type: a namespace value carries its type's name as its tag, which a type written in place has none
 * of (§4.2, §5.2), so a namespace type is declared and named.
 */
export function refuseNamespaceInPlace(
  written: string,
  head: string,
  argumentsWritten: readonly string[],
  slots: readonly string[],
  name: string,
  definition: Top,
): void {
  if (name !== NAMESPACE && !supertypesOf(definition).includes(NAMESPACE)) return;
  const bindings = slots
    .slice(0, argumentsWritten.length)
    .map((slot, index) => `${slot}: ${argumentsWritten[index] ?? ''}`);
  throw new TsonSchemaValidationError(
    `'${written}' constructs a namespace type where it is used, and a namespace value carries its type's ` +
      'name as its tag, which a type written in place does not have (§4.2, §5.2): declare it ' +
      `('my_${head.slice(head.lastIndexOf('.') + 1)} => !${head} { ${bindings.join('  ')} }') and write that name`,
  );
}

/** `constructor`'s argument slots, in declaration order: its required fields holding a type and not set by its chain. */
export function slots(constructor: RecordBody, types: DefinitionGetter): string[] {
  const found: string[] = [];
  for (const [name, declared] of constructor.fields.entries) {
    if (
      !declared.optional &&
      declared.role === 'FREE' &&
      declared.type.kind !== 'inline' &&
      holdsAType(declared.type.name, types)
    ) {
      found.push(name);
    }
  }
  return found;
}

/**
 * For each of `constructor`'s argument slots, in order, whether it holds a type written in place: typed
 * `meta.type_expr`, and not by a reference naming types, which holds only a name (§4.2).
 */
export function slotsInPlace(constructor: RecordBody, types: DefinitionGetter): boolean[] {
  return slots(constructor, types).map((slot) => {
    const type = constructor.fields.entries.get(slot)?.type;
    return type !== undefined && type.kind !== 'inline' && terminal(type.name, types) === TYPE_EXPR;
  });
}

/** Whether a field typed `name` holds a type: `meta.type_expr`, or a reference naming types (§5.3). */
export function holdsAType(name: string, types: DefinitionGetter): boolean {
  return terminal(name, types) === TYPE_EXPR || referenceNamesTypes(name, types);
}

/**
 * Refuses `written<…>` with `supplied` arguments over a constructor whose argument slots are `slotNames`, unless
 * there is one argument for each.
 */
export function requireArity(
  written: string,
  slotNames: readonly string[],
  supplied: number,
): void {
  if (slotNames.length === supplied) return;
  throw new TsonSchemaValidationError(
    slotNames.length === 0
      ? `'${written}' is a constructor with no required field typed by a reference naming types, so ` +
          `'${written}<...>' gives arguments it has no field for (§5.3); construct it in braces, ` +
          `'!${written} { ... }', as a declaration`
      : `'${written}' is a constructor whose required fields typed by a reference naming types are ` +
          `[${slotNames.join(', ')}], so '${written}<...>' takes ${String(slotNames.length)} argument` +
          `${slotNames.length === 1 ? '' : 's'}, one for each in that order, but ${String(supplied)} ` +
          `${supplied === 1 ? 'was' : 'were'} applied (§5.3)`,
  );
}

/** Whether the type `name` is a reference naming types, past its alias hops. */
function referenceNamesTypes(name: string, types: DefinitionGetter): boolean {
  const type = types(terminal(name, types));
  return type?.kind === 'ref' && namesTypes(type.of.name, types);
}
