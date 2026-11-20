/**
 * The link's distinctness rule over a choice whose variants reach through externs ([TSON-SCHEMA] §5.4, §5.13): an
 * extern is a hop, so a variant is judged at the entry it lands on, by identity. Two variants that reach one entry --
 * two externs of it, an extern of it beside its imported name, an extern of an extern beside its target -- are one
 * type written twice and are refused. A pair neither of which lands through an extern is `referenceValidation.ts`'s,
 * judged past alias hops alone, and so is a variant that is a choice, through an extern or not.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import type { ChoiceBody } from '../schema/meta/bodies.js';
import type { EntryFacts, Top, TypeInline } from '../schema/meta/typedef.js';
import { mapInPlace } from '../schema/meta/typeInline.js';
import type { ExternHops } from './externHops.js';
import { declaringIdentity } from './externTarget.js';
import { schemaPositionOf } from './facts.js';

/** What {@link checkExternVariants} reports through. */
export interface ExternVariantOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  readonly receiver?: DiagnosticsReceiver;
}

/** Judges every choice of each local entry of `merged`, declared or written in place, against this module's rule. */
export function checkExternVariants(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  hops: ExternHops,
  options: ExternVariantOptions,
): void {
  if (!hops.any()) return;
  for (const name of localNames) {
    const value = merged.get(name);
    if (value === undefined) continue;
    const choices: ChoiceBody[] = value.kind === 'choice' ? [value] : [];
    mapInPlace(value, (inline: TypeInline) => {
      if (inline.of.kind === 'choice') choices.push(inline.of);
      return inline;
    });
    try {
      for (const choice of choices) checkDistinct(name, choice, hops);
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError) || options.receiver === undefined) {
        throw error;
      }
      options.receiver.report({
        code: 'SCHEMA_ERROR',
        message: error.message,
        schemaId: options.schemaId,
        schemaPointer: `/${name}`,
        ...schemaPositionOf(options.facts, name),
      });
    }
  }
}

function checkDistinct(entryName: string, choice: ChoiceBody, hops: ExternHops): void {
  const seen = new Map<string, { readonly text: string; readonly foreign: boolean }>();
  for (const variant of choice.variants) {
    if (variant.kind === 'inline') continue;
    const foreign = hops.landing(variant.name) !== undefined;
    const identity = hops.identity(variant.name);
    const first = seen.get(identity);
    if (first === undefined) {
      seen.set(identity, { text: variant.name, foreign });
      continue;
    }
    // A pair of plain names is judged where every choice's variants are, past their alias hops alone.
    if (!foreign && !first.foreign) continue;
    const end = hops.landing(variant.name) ?? hops.landing(first.text);
    throw new TsonSchemaValidationError(
      `'${entryName}' variants '${first.text}' and '${variant.name}' both resolve to ` +
        (end === undefined
          ? `'${variant.name}'`
          : `'${end.name}' of '${declaringIdentity(end.in, end.name)}'`) +
        ' -- an extern is another name for the entry it lands on, so the two are one type written twice, and ' +
        '§5.4 requires each variant to resolve to a distinct type ([TSON-SCHEMA] §5.13)',
    );
  }
}
