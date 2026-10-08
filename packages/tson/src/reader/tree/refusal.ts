/**
 * Reporting a [TSON-DATA] §8.2 name-hygiene refusal from a schema-directed read: a value of an
 * identifier family is a name wherever it stands, so the per-name mechanisms reach it under the
 * family's own profile, and the keys of an identifier-keyed map and the elements of a set of them
 * are look-alike scopes ([TSON-SCHEMA] §11.4).
 *
 * **A refusal is reported, never raised as a category.** It goes through the read's receiver under
 * its own code (`RESTRICTED_CHARACTER`, `RESTRICTED_SCRIPT`, `CONFUSABLE_NAMES`), apart from §8.1's
 * four categories. Under a fail-fast receiver `ctx.report` throws as a direct consequence of the
 * call; that throw is converted to {@link TsonNameHygieneRefusedError} so a caller testing for a
 * read error does not mistake a policy refusal for one, exactly as the schemaless reader does.
 */
import { diagnosticCodeForMechanism } from '../../core/diagnostic.js';
import { TsonNameHygieneRefusedError, type NameHygieneMechanism } from '../../core/errors.js';
import type { ConfusableCollision } from '../../unicode/skeleton.js';
import type { NameViolation } from '../../unicode/policy.js';
import { UTS39_VERSION } from '../../unicode/uts39.js';
import type { ReadContext } from '../contracts.js';

function refuse(
  ctx: ReadContext,
  mechanism: NameHygieneMechanism,
  names: readonly string[],
  message: string,
  expected: string,
  actual: string,
): void {
  try {
    ctx.report(diagnosticCodeForMechanism(mechanism), message, expected, actual);
  } catch (thrown) {
    throw new TsonNameHygieneRefusedError(message, {
      mechanism,
      names,
      uts39Version: UTS39_VERSION,
      cause: thrown,
    });
  }
}

/** Reports every rule `name` failed, each under its own code -- a character to change and a script to relax want different fixes. */
export function reportNameViolations(
  ctx: ReadContext,
  name: string,
  violations: readonly NameViolation[],
): void {
  for (const violation of violations) {
    refuse(
      ctx,
      violation.mechanism,
      [name],
      `the name ${violation.detail} (refused under [TSON-DATA] §8.2's name-hygiene policy)`,
      'a name this processor will accept',
      `'${name}'`,
    );
  }
}

/** Reports a look-alike pair at the second name, as §8.2 places a refused pair. `scope` names it: "keys", "elements". */
export function reportConfusablePair(
  ctx: ReadContext,
  collision: ConfusableCollision,
  scope: string,
): void {
  refuse(
    ctx,
    'skeleton-distinctness',
    [collision.first, collision.second],
    `'${collision.second}' is confusable with '${collision.first}' -- two ${scope} that ` +
      'read alike (UTS #39 skeleton), so one of them must be renamed ([TSON-DATA] §8.2)',
    `${scope} §8.2 can tell apart`,
    `'${collision.second}'`,
  );
}
