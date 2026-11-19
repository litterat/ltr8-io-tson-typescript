/**
 * A dependent field's reader, `v?: kind!` ([TSON-SCHEMA] §5.6, [TSON-JSON] §6.1.6): the member is
 * read against the type its sibling's value names in the same object. Ported from the Java
 * reference's `DependentReader`.
 *
 * **Read through its record** (`json/schema/record.ts`), never on its own: only the record knows
 * the sibling's value -- the member written before it, the sibling's default where it is not
 * written, or its pin -- so {@link DependentReader.read} is a fault and {@link
 * DependentReader.readAgainst} is the one entry point. The record hands it the reference the
 * sibling named, as the reference grammar reads it ({@link referenceIn}), and the reader of the
 * member's value is the named entry's.
 *
 * **The dependent read itself is not built yet.** {@link DependentReader.readAgainst} reports
 * `NOT_IMPLEMENTED` and consumes the member, so the record's other members read on and the event
 * stream stays where a reader that understood the position would have left it. What remains to
 * land here is the rule the text encoding's reader states once: the sibling's reference naming no
 * type a value can be read against (a sibling reference, a template, an application the closure
 * does not hold) is refused at the sibling and the member skipped unjudged; every other reference
 * is read through `ctx.resolve` of the entry it denotes past its alias hops (`link/aliasChain.ts`),
 * an application resolved through the sibling type's reference index
 * (`schema/meta/referenceIndex.ts`'s `referenceEntryOf`); and §6.1.6's order exception, a free
 * sibling written after the member it types.
 */
import { TsonAtomParseError, TsonInternalError } from '../../core/errors.js';
import type { Task } from '../../io/bytes.js';
import { parseReference } from '../../atom/referenceGrammar.js';
import type { ReferenceBody } from '../../schema/meta/bodies.js';
import type { Reference } from '../../schema/meta/typedef.js';
import { referenceFromAst } from '../../schema/referenceAtoms.js';
import type { JsonReadContext } from '../readContext.js';
import type { CompileContext } from './compile.js';
import { notImplementedReader } from './notImplemented.js';
import type { JsonTypeReader } from './types.js';

/** A dependent field's reader: read through its record, which knows the value of its sibling. */
export interface DependentReader extends JsonTypeReader {
  /** The dependent field's own name. */
  readonly field: string;
  /** The field whose value names the type this one is read against. */
  readonly sibling: string;
  /**
   * The member at `ctx`'s cursor read against the type `named` names, a refusal of the sibling's
   * value reported at `siblingCtx`; `named` is `undefined` where the sibling's own read was
   * refused, which has been reported, and the member is skipped.
   */
  readAgainst(
    ctx: JsonReadContext,
    named: Reference | undefined,
    siblingCtx: JsonReadContext,
  ): Task<unknown>;
}

/** Whether `reader` is a {@link DependentReader}: the record reads it through {@link DependentReader.readAgainst}. */
export function isDependentReader(reader: JsonTypeReader): reader is DependentReader {
  return typeof (reader as Partial<DependentReader>).readAgainst === 'function';
}

/**
 * The reader for the dependent field `field`, whose type is the value of `sibling`. `siblingType`
 * is the reference body typing the sibling past its alias hops, which resolves an application to
 * its entry, or `undefined` where the sibling is typed by anything else.
 */
export function buildDependentReader(
  displayName: string,
  field: string,
  sibling: string,
  _ctx: CompileContext,
  _siblingType: ReferenceBody | undefined,
): DependentReader {
  const gap = notImplementedReader(`${displayName}.${field}`, 'a dependent field');
  return {
    field,
    sibling,
    read(): Task<unknown> {
      throw new TsonInternalError(
        `the dependent field '${field}' is read through its record, which knows the value of ` +
          `its sibling '${sibling}'`,
      );
    },
    *readAgainst(ctx: JsonReadContext): Task<unknown> {
      return yield* gap.read(ctx);
    },
  };
}

/** A sibling's value as JSON holds it, a string spelling the reference, or `undefined` where it spells none. */
export function referenceIn(text: string | undefined): Reference | undefined {
  if (text === undefined) return undefined;
  try {
    return referenceFromAst(parseReference(text));
  } catch (error) {
    if (error instanceof TsonAtomParseError) return undefined;
    throw error;
  }
}
