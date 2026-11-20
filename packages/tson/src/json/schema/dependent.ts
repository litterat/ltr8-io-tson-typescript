/**
 * A dependent field's reader, `v?: kind!` ([TSON-SCHEMA] §5.2, [TSON-JSON] §6.1.6): the member is
 * read against the type its sibling's value names in the same object.
 *
 * **Read through its record** (`json/schema/record.ts`), never on its own: only the record knows
 * the sibling's value -- the member written before it, the sibling's default where it is not
 * written, or its pin -- so {@link DependentReader.read} is a fault and {@link
 * DependentReader.readAgainst} is the one entry point. The record hands it the reference the
 * sibling named, as the reference grammar reads it (`link/dependentFields.ts`'s `referenceIn`),
 * and the reader of the member's value is the named entry's. The rule for what a sibling's value
 * types the member by is `link/dependentFields.ts`'s `typeNamed`, the one the text encoding's
 * reader and a value entry's link judgement apply too: a name reaching no type, a parametric record, or an
 * incomplete entry names no type a value can be read against, is refused at
 * the sibling, and the member is skipped unjudged.
 */
import { TsonInternalError } from '../../core/errors.js';
import type { Task } from '../../io/bytes.js';
import { siblingNamesNoType, typeNamed } from '../../link/dependentFields.js';
import type { RefBody } from '../../schema/meta/bodies.js';
import type { Top, TypeRef } from '../../schema/meta/typedef.js';
import type { JsonReadContext } from '../readContext.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
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
    named: TypeRef | undefined,
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
  ctx: CompileContext,
  siblingType: RefBody | undefined,
): DependentReader {
  const entries = (name: string): Top | undefined => ctx.linkedSchema.entries.get(name);
  return {
    field,
    sibling,
    read(): Task<unknown> {
      throw new TsonInternalError(
        `the dependent field '${field}' is read through its record, which knows the value of ` +
          `its sibling '${sibling}'`,
      );
    },
    *readAgainst(
      at: JsonReadContext,
      named: TypeRef | undefined,
      siblingCtx: JsonReadContext,
    ): Task<unknown> {
      if (named === undefined) {
        yield* skipNextValue(at);
        return undefined;
      }
      const typed = typeNamed(named, siblingType, entries);
      if (typed.kind === 'none') {
        const refusal = siblingNamesNoType(displayName, sibling, field, typed.held, named.name);
        siblingCtx.report(refusal.code, refusal.message, refusal.expected, refusal.found);
        yield* skipNextValue(at);
        return undefined;
      }
      return yield* ctx.resolve(typed.name).read(at);
    },
  };
}
