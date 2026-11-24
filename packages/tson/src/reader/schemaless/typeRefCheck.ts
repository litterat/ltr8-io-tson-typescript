/**
 * The wire type-ref rules a schemaless read applies -- the port of `reader/TypeRefCheck.java`,
 * minus its object-binding-only second rule (`names`/`declares`, matching a target class's own
 * name): "a tree read has no target to name" (`TypeRefCheck.java`'s own top note), and this port's
 * schemaless object-binding path (`reader/bind.ts`) already applies its own equivalent --
 * `readVariant` matching a wire type-ref against `VariantBinding.members[].wireName` -- because a
 * `Binding` names its own wire names structurally rather than through a `Typename`-annotated host
 * class the way the Java reference's reflection-based binder does.
 *
 * Given `!X` on a value read with no schema in scope:
 *
 * 1. `X` **is** a built-in (`vocabulary.ts`, [TSON-DATA] §5) -- the core-value must be a token
 *    ({@link reportNotScalar}), and the token must satisfy the atom (a caller-side
 *    `ATOM_FORM_INVALID`/`ATOM_CONSTRAINT_VIOLATION`, since only the caller holds the thrown
 *    {@link TsonAtomTypeError} -- see `tree.ts`'s own `leaf`).
 * 2. Otherwise the name links to nothing and is {@link reportUnknownTypeRef}.
 *
 * **Rule 2 is a resolver error** ([TSON-DATA] §3.2, §5.1): a schemaless document has no source of
 * type names but §5's vocabulary, so a name outside it names no type, at every processor -- a
 * portable finding about the document, never a refusal. The event stream and structural
 * annotation capture keep every name they see, which is what lets a reader report one at its
 * position; a typo like `!Uuid` (case-sensitive per §5.1, so not `!uuid`) would otherwise disable
 * the validation its author intended and report nothing. Both schemaless readers report it -- the
 * tree (`tree.ts`) and the binder (`reader/bind.ts`), a host-typed read being no exception -- and
 * `SchemalessTreeReaderOptions.preserveUnknownTypeRefs` is the caller's explicit opt-out, for
 * reading the wire form of a document whose own schema is deliberately not in scope.
 */
import type { TsonAtomTypeError } from '../../core/errors.js';
import { diagnosticCodeForAtomError } from '../../core/diagnostic.js';
import type { TsonEvent } from '../../stream/event.js';
import type { ReadContext } from '../contracts.js';

/** A core-value's shape as a word, for a diagnostic's `actual` -- this module's own copy of `TypeRefCheck.describe`; see `reader/bind.ts`'s own `describeEvent` for why every leaf work package carries one rather than sharing a schema-driven sibling's. */
export function describeEvent(e: TsonEvent): string {
  switch (e.kind) {
    case 'record-start':
      return 'a record';
    case 'map-start':
      return 'a map';
    case 'array-start':
      return 'an array';
    case 'empty-brace':
      return '{}';
    case 'void':
      return "the void sentinel '_'";
    case 'token':
      return `token '${e.text}'`;
    default:
      return e.kind;
  }
}

/** A type-ref naming nothing this read can link it to -- `TypeRefCheck.unknown` in the Java reference. */
export function reportUnknownTypeRef(ctx: ReadContext, name: string): void {
  ctx.report(
    'UNKNOWN_TYPE_REF',
    `unknown type '!${name}' -- not a built-in type, and no schema is in scope to define it`,
    'a built-in type name',
    `!${name}`,
  );
}

/** A built-in type-ref on a value that isn't a token -- every built-in atom is scalar. */
export function reportNotScalar(ctx: ReadContext, name: string, core: TsonEvent): void {
  ctx.report(
    'TYPE_MISMATCH',
    `built-in type '!${name}' expects a scalar value`,
    `a scalar for !${name}`,
    describeEvent(core),
  );
}

/**
 * A token the built-in atom named `name` rejected -- both {@link TsonAtomTypeError} subtypes land
 * here and are told apart by {@link diagnosticCodeForAtomError} (`ATOM_FORM_INVALID` for a shape
 * the atom's grammar never accepts at all, `ATOM_CONSTRAINT_VIOLATION` for a correctly-shaped
 * value outside its constraints, §5.2). `error.expected` is the atom's own account of the violated
 * constraint, never the atom's name (`core/errors.ts`'s own six-shape vocabulary).
 */
export function reportAtomViolation(
  ctx: ReadContext,
  name: string,
  error: TsonAtomTypeError,
  text: string,
): void {
  ctx.report(
    diagnosticCodeForAtomError(error),
    `'${name}': ${error.message}`,
    error.expected,
    text,
  );
}
