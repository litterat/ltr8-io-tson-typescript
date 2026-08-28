/**
 * Writes a bound host value to TSON text -- the write-side counterpart to `reader/bind.ts`, and
 * the tree/binding analogue of `treeWriter.ts`. The port of `TsonObjectWriter.java`'s public
 * surface, minus the part that no longer exists: Java's writer walks the object graph *and*
 * formats grammar text in the same pass, while this module composes two pieces that already
 * exist -- `bind/encode.ts`'s {@link toDataValue} (host value -> `ast.DataValue`, importing only
 * `ast/`/`bind/`) and `astWriter.ts` (`ast.DataValue` -> text) -- so the object-graph walk and the
 * grammar-level formatting stay two separate, independently testable steps.
 *
 * **This is exactly the seam `CLAUDE.md`'s Layering section describes.** Java's
 * `DefinitionResolver` holds a `TsonObjectWriter` because §5.6's chained atom refinement has to
 * merge on the wire record before binding, which is why the writers cannot leave `tson-compiler`
 * there. Here `bind/encode.ts` already breaks that circularity by exposing the wire-record
 * conversion on its own, with no writer involved -- so this module is free to sit in `write/`,
 * depending on `ast/` and `bind/` only (never `compiler/`), and the resolver merge that needs the
 * *value*, not text, never has to reach for this file at all.
 *
 * **Atom formatting is a caller-supplied seam**, exactly as `reader/bind.ts`'s own `AtomReader`
 * is: a `Binding`'s `AtomBinding` leaf carries only a `wireType` name (`bind/binding.ts`'s own
 * doc: "deliberately inert"), never a parser, so *something* has to turn a leaf's host value into
 * token text. {@link defaultAtomEncoder} is that something, built on `atomFraming.ts`'s vocabulary
 * lookup for a `wireType` this package recognises, falling back to primitive host-type framing
 * (`bigint`/`number`/`boolean`/`string`) for one it doesn't -- a caller binding a leaf to a richer
 * host type (a `Date`, a custom class) supplies its own {@link AtomEncoder} instead, the same way
 * a caller of `reader/bind.ts` supplies its own `AtomReader`.
 */
import { toDataValue, type AtomEncoder } from '../bind/encode.js';
import type { AtomBinding, BindingRef } from '../bind/binding.js';
import { TsonWriteError } from '../core/errors.js';
import type { TokenForm } from '../lexer/token.js';
import { formatKnownAtom } from './atomFraming.js';
import { writeFloat } from '../atom/numeric/float.js';
import { writeDataValueTo } from './astWriter.js';
import type { Emitter, TextSink } from './emitter.js';
import { createEmitter, stringSink } from './emitter.js';

/**
 * The default {@link AtomEncoder}: `binding.wireType` formatted through the built-in vocabulary
 * when it names one (`atomFraming.ts`'s stage 1, so an `int32` field writes `42`, a `uuid` field
 * writes `"…"` quoted, and so on, all under this atom's own type-ref); otherwise `value`'s own
 * primitive JS type decides -- `bigint`/`boolean`/`number`/`string`, the host shapes a plain
 * field binding ordinarily carries (mirrors `AtomWriter.writeDefaultAtom`'s own primitive cases).
 * A `value` that is none of those has no default framing this module can invent; supply a real
 * {@link AtomEncoder} instead.
 */
export const defaultAtomEncoder: AtomEncoder = (binding: AtomBinding<unknown>, value: unknown) => {
  const known = formatKnownAtom(binding.wireType, value);
  if (known !== undefined) {
    const form: TokenForm = known.quoted ? 'single-line' : 'unquoted';
    return { kind: 'token', text: known.text, form };
  }
  return primitiveToken(binding.wireType, value);
};

function primitiveToken(
  wireType: string,
  value: unknown,
): { kind: 'token'; text: string; form: TokenForm } {
  if (typeof value === 'bigint') {
    return { kind: 'token', text: value.toString(), form: 'unquoted' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'token', text: value ? 'true' : 'false', form: 'unquoted' };
  }
  if (typeof value === 'number') {
    return { kind: 'token', text: writeFloat(value), form: 'unquoted' };
  }
  if (typeof value === 'string') {
    return { kind: 'token', text: value, form: 'single-line' };
  }
  throw new TsonWriteError(
    `don't know how to write a value of type '${typeof value}' at an atom position wired as ` +
      `'${wireType}' -- supply an AtomEncoder that knows this host type`,
  );
}

/**
 * Writes `value` through `binding` into `out` -- resolves the whole bound graph to an
 * `ast.DataValue` via {@link toDataValue} (`bind/encode.ts`) and hands that to `astWriter.ts`.
 * `encodeAtom` defaults to {@link defaultAtomEncoder}.
 */
export function writeBindingTo<T>(
  binding: BindingRef<T>,
  value: T,
  out: Emitter,
  encodeAtom: AtomEncoder = defaultAtomEncoder,
): void {
  writeDataValueTo(toDataValue(binding, value, encodeAtom), out);
}

/** {@link writeBindingTo} into a fresh `string`. */
export function writeBinding<T>(
  binding: BindingRef<T>,
  value: T,
  encodeAtom: AtomEncoder = defaultAtomEncoder,
): string {
  const { sink, result } = stringSink();
  writeBindingTo(binding, value, createEmitter(sink), encodeAtom);
  return result();
}

/** {@link writeBindingTo} into any {@link TextSink}. */
export function writeBindingToSink<T>(
  binding: BindingRef<T>,
  value: T,
  sink: TextSink,
  encodeAtom: AtomEncoder = defaultAtomEncoder,
): void {
  writeBindingTo(binding, value, createEmitter(sink), encodeAtom);
}
