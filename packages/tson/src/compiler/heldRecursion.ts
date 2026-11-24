/**
 * [TSON-SCHEMA] §5.10.1's held recursion: a parametric record holding, where it would close in place, an application
 * of a recursive parametric record whose recursion does not pass back through it could never be closed, and is
 * refused at its own declaration.
 *
 * **Why it is decidable from the heads.** Closing an application ties a recursion only to the declaration closing it,
 * and an application at a slot is never looked up, so closing `R` ends only where every cycle the closing reaches
 * passes back through `R`. Regularity passes each parameter through unchanged and an argument is a name, so a cycle of
 * heads is a cycle of applications, and the graph of which parametric record holds which in place decides it.
 *
 * **Judged one hop out.** `R` is refused where it holds `S` itself and `S` lies on a cycle that avoids `R`. A record
 * reaching such a cycle only through another, `outer` holding `wrap<T>` over `wrap` holding `node<T>`, has that other
 * on its path one hop from the cycle, refused at its own declaration; `outer` is a consequence, closing against the
 * refused record's placeholder as an application of any refused parametric record does, and its remedy is `wrap`'s.
 *
 * **Fields only, not parents.** An applied parent's fields are absorbed into the record that composes it, so they are
 * its own and are walked as its fields; the parent itself is absorbed, never closed, and takes no part.
 *
 * @module
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { ApplyBody, Top } from '../schema/meta/typedef.js';
import { applyText, isParametric, typeParameters } from '../schema/meta/typedef.js';
import { namedFields } from '../schema/meta/bodies.js';
import * as TypeSlots from '../schema/meta/typeSlots.js';
import { terminal } from '../link/aliasChain.js';
import { suggestedName } from './parametricMaterialiser.js';

/** One application of a parametric record held where it closes in place, under the field holding it. */
interface Held {
  readonly field: string;
  readonly whole: boolean;
  readonly written: ApplyBody;
  readonly head: string;
}

/** The held-recursion judgement over one resolution's namespace. */
export interface HeldRecursion {
  /**
   * Whether an application of `head` closes against a placeholder: its head is this document's own and refused here,
   * so the refusal is `head`'s to report and not its applier's.
   */
  refusedLocally(head: string): boolean;
  /** The refusal of the parametric record `name`, or `undefined` where it can be closed or is no parametric record. */
  refusal(name: string): TsonSchemaValidationError | undefined;
  /**
   * Forgets every verdict: one reached while declarations were made ready reads the records as they were then, and a
   * record replaced by its placeholder since holds nothing.
   */
  forget(): void;
}

/**
 * A judgement over `lookup`, every entry visible to the schema, resolved on demand; `local` says whether a name is
 * this document's own declaration, which this resolution reports.
 */
export function createHeldRecursion(
  lookup: (name: string) => Top | undefined,
  local: (name: string) => boolean,
): HeldRecursion {
  const judged = new Map<string, TsonSchemaValidationError | null>();
  const heldBy = new Map<string, Held[]>();

  function refusal(name: string): TsonSchemaValidationError | undefined {
    const known = judged.get(name);
    if (known !== undefined) return known ?? undefined;
    const verdict = judge(name);
    judged.set(name, verdict ?? null);
    return verdict;
  }

  function judge(name: string): TsonSchemaValidationError | undefined {
    const record = lookup(name);
    if (!isParametric(record)) return undefined;
    for (const one of held(name)) {
      if (one.head !== name && onCycleAvoiding(one.head, name)) {
        return refused(name, typeParameters(record), one);
      }
    }
    return undefined;
  }

  /** Whether `from` reaches itself through the records it holds, never passing `avoiding`. */
  function onCycleAvoiding(from: string, avoiding: string): boolean {
    const seen = new Set<string>();
    const pending = held(from).map((one) => one.head);
    for (let head = pending.pop(); head !== undefined; head = pending.pop()) {
      if (head === from) return true;
      if (head === avoiding || seen.has(head)) continue;
      seen.add(head);
      for (const one of held(head)) pending.push(one.head);
    }
    return false;
  }

  function held(name: string): Held[] {
    const known = heldBy.get(name);
    if (known !== undefined) return known;
    const found: Held[] = [];
    const record = lookup(name);
    if (record?.kind === 'record' && isParametric(record)) {
      for (const field of namedFields(record)) {
        // Every application of a parametric record the field's type holds, at any depth of types written in place:
        // one where it closes in place once the record holding it is applied.
        TypeSlots.applications(field.type, (application) => {
          const head = terminal(application.head.name, lookup);
          if (isParametric(lookup(head))) {
            const whole = field.type.kind === 'inline' && field.type.of === application;
            found.push({ field: field.name, whole, written: application, head });
          }
        });
      }
    }
    heldBy.set(name, found);
    return found;
  }

  return {
    refusedLocally: (head) => local(head) && refusal(head) !== undefined,
    refusal,
    forget(): void {
      judged.clear();
      heldBy.clear();
    },
  };
}

function refused(
  name: string,
  parameters: readonly string[],
  held: Held,
): TsonSchemaValidationError {
  const parameter = fresh(parameters);
  const closed = held.written.arguments.every((argument) => !parameters.includes(argument.name));
  const headName = held.written.head.name;
  const declared = closed
    ? `${suggestedName(held.written)} => ${applyText(held.written)}`
    : `my_${headName.slice(headName.lastIndexOf('.') + 1)} => ${headName}<${held.written.arguments
        .map(() => '...')
        .join(' ')}>`;
  const spelled = applyText(held.written);
  const written = held.whole
    ? `write '${held.field}: ${parameter}', '${parameter}' a parameter of '${name}'`
    : `write a parameter '${parameter}' of '${name}' where '${spelled}' stands`;
  return new TsonSchemaValidationError(
    `'${name}' holds '${spelled}' at '${held.field}', an application of the recursive parametric record ` +
      `'${held.head}', which closes in place wherever '${name}' is applied; a recursion ties only to a ` +
      `declaration closing that record itself (§5.10.1), so '${name}' could never be closed. Take the closed ` +
      `type as a parameter: ${written}, and apply '${name}' to a declared application of '${held.head}' ` +
      `('${declared}', passed for '${parameter}')`,
  );
}

/** A parameter name the record does not declare, for the remedy. */
function fresh(parameters: readonly string[]): string {
  let candidate = 'N';
  for (let i = 2; parameters.includes(candidate); i++) candidate = `N${String(i)}`;
  return candidate;
}
