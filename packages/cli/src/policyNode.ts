/**
 * Renders a {@link ProcessorPolicy} -- `tson policy`'s own output, and the `policy` field every
 * `validate`/`compile` run carries once (`commands/policy.ts`, `render.ts`). Mirrors the
 * reference implementation's `CliPolicy`/`CliPolicy.CliUnicodePolicy` wire shape: two surfaces
 * (`identifier_policy`, `token_policy`), each a `level`/`per_segment`/`permitting` triple, plus
 * `unicode_data_version`.
 *
 * **`permitting` now carries every admitted combination**, `@ltr8/tson`'s `NamePolicy`/
 * `TokenPolicy` (`unicode/policy.ts`) having gained `permittedScripts` -- each combination
 * resolved back from its `ScriptId`s to script names via `@ltr8/tson`'s `scriptName`, in the
 * order `--identifier-scripts`/`--token-scripts` added them.
 *
 * **`token_policy.per_segment` is always `false`.** `@ltr8/tson`'s `TokenPolicy` has no
 * per-segment axis at all (`unicode/policy.ts`'s own doc: "`_`/`-` are ordinary characters in a
 * value, not word separators"), unlike the reference implementation's `TsonUnicodePolicy`, which
 * both surfaces share. Stating it here keeps the two surfaces' wire shape symmetric rather than
 * omitting the field on one of them.
 */
import { arrayNode, atomNode, recordNode, scriptName, type Value } from '@ltr8/tson';
import type { ProcessorPolicy } from './policyOptions.js';

interface UnicodePolicyJson {
  readonly level: string;
  readonly per_segment: boolean;
  readonly permitting: readonly (readonly string[])[];
}

export interface PolicyJson {
  readonly identifier_policy: UnicodePolicyJson;
  readonly token_policy: UnicodePolicyJson;
  readonly unicode_data_version: string;
}

/** One `permittedScripts` combination, resolved from `ScriptId`s back to the names `scriptNamed` accepts. */
function combinationNames(combination: readonly number[]): readonly string[] {
  return combination.map((id) => scriptName(id));
}

/** Every combination a policy admits, each rendered by {@link combinationNames}, in the order `permitting` added them. */
function permittingNames(
  permittedScripts: readonly (readonly number[])[],
): readonly (readonly string[])[] {
  return permittedScripts.map(combinationNames);
}

function unicodePolicyJson(
  level: string,
  perSegment: boolean,
  permitting: readonly (readonly string[])[],
): UnicodePolicyJson {
  return { level, per_segment: perSegment, permitting };
}

/** {@link ProcessorPolicy} rendered for `--format json`. */
export function policyJson(policy: ProcessorPolicy): PolicyJson {
  return {
    identifier_policy: unicodePolicyJson(
      policy.identifierPolicy.restrictionLevel,
      policy.identifierPolicy.restrictionUnit === 'PER_SEGMENT',
      permittingNames(policy.identifierPolicy.permittedScripts),
    ),
    token_policy: unicodePolicyJson(
      policy.tokenPolicy.restrictionLevel,
      false,
      permittingNames(policy.tokenPolicy.permittedScripts),
    ),
    unicode_data_version: policy.unicodeDataVersion,
  };
}

function unicodePolicyNode(
  level: string,
  perSegment: boolean,
  permitting: readonly (readonly string[])[],
): Value {
  return recordNode(
    new Map<string, Value>([
      ['level', atomNode(level)],
      ['per_segment', atomNode(perSegment)],
      [
        'permitting',
        arrayNode(
          permitting.map((combination) => arrayNode(combination.map((name) => atomNode(name)))),
        ),
      ],
    ]),
  );
}

/** {@link ProcessorPolicy} rendered for `--format tson`, as a `tree/nodes.ts` {@link Value} record. */
export function policyNode(policy: ProcessorPolicy): Value {
  return recordNode(
    new Map<string, Value>([
      [
        'identifier_policy',
        unicodePolicyNode(
          policy.identifierPolicy.restrictionLevel,
          policy.identifierPolicy.restrictionUnit === 'PER_SEGMENT',
          permittingNames(policy.identifierPolicy.permittedScripts),
        ),
      ],
      [
        'token_policy',
        unicodePolicyNode(
          policy.tokenPolicy.restrictionLevel,
          false,
          permittingNames(policy.tokenPolicy.permittedScripts),
        ),
      ],
      ['unicode_data_version', atomNode(policy.unicodeDataVersion)],
    ]),
  );
}

/** One admitted combination, spelled the way a `--identifier-scripts`/`--token-scripts` flag would (`Latin+Cyrillic`). */
function combinationText(combination: readonly string[]): string {
  return combination.join('+');
}

function unicodePolicySummary(
  level: string,
  perSegment: boolean,
  permitting: readonly (readonly string[])[],
): string {
  const parts = [level];
  if (perSegment) parts.push('per segment');
  if (permitting.length > 0) parts.push(`permitting ${permitting.map(combinationText).join(', ')}`);
  return parts.join(' ');
}

/** One line per surface: what differs between two deployments that disagree about one name -- `tson policy`'s own `--format text`. */
export function policyText(policy: ProcessorPolicy): string {
  return [
    `identifier policy: ${unicodePolicySummary(
      policy.identifierPolicy.restrictionLevel,
      policy.identifierPolicy.restrictionUnit === 'PER_SEGMENT',
      permittingNames(policy.identifierPolicy.permittedScripts),
    )}`,
    `token policy:      ${unicodePolicySummary(
      policy.tokenPolicy.restrictionLevel,
      false,
      permittingNames(policy.tokenPolicy.permittedScripts),
    )}`,
    `unicode data:      ${policy.unicodeDataVersion}`,
  ].join('\n');
}

/** Policy summary embedded in a `validate`/`compile` text run, one line: `identifier policy X, token policy Y, Unicode Z`. */
export function policySummary(policy: ProcessorPolicy): string {
  const identifier = unicodePolicySummary(
    policy.identifierPolicy.restrictionLevel,
    policy.identifierPolicy.restrictionUnit === 'PER_SEGMENT',
    permittingNames(policy.identifierPolicy.permittedScripts),
  );
  const token = unicodePolicySummary(
    policy.tokenPolicy.restrictionLevel,
    false,
    permittingNames(policy.tokenPolicy.permittedScripts),
  );
  return `identifier policy ${identifier}, token policy ${token}, Unicode ${policy.unicodeDataVersion}`;
}

/** §8.2's own defaults -- what a run configures by giving no policy flags at all. */
export function isDefaultPolicy(policy: ProcessorPolicy): boolean {
  return (
    policy.identifierPolicy.restrictionLevel === 'HIGHLY_RESTRICTIVE' &&
    policy.identifierPolicy.restrictionUnit === 'WHOLE_NAME' &&
    policy.identifierPolicy.permittedScripts.length === 0 &&
    policy.tokenPolicy.restrictionLevel === 'UNRESTRICTED' &&
    policy.tokenPolicy.permittedScripts.length === 0
  );
}

/** [TSON-DATA] §8.2's three name-hygiene codes -- the outcomes {@link ProcessorPolicy} explains. */
const NAME_HYGIENE_CODES: ReadonlySet<string> = new Set([
  'CONFUSABLE_NAMES',
  'RESTRICTED_CHARACTER',
  'RESTRICTED_SCRIPT',
]);

/**
 * The policy note a `validate`/`compile` text run appends, printed only when it is load-bearing --
 * mirrors the reference implementation's `OutputFormat#policyNote`.
 *
 * Two cases where a person needs it, both different questions from "does this document pass":
 * something in `codes` was refused under this policy (why does it pass on another machine?), or
 * the policy itself was configured away from §8.2's own defaults (a relaxation must not be
 * silent). Neither applies on an ordinary clean run under the defaults, so this returns `''` then
 * -- the machine formats state `policy` unconditionally instead, for a consumer that always wants
 * one shape.
 */
export function policyNote(policy: ProcessorPolicy, codes: readonly string[]): string {
  const refused = codes.some((code) => NAME_HYGIENE_CODES.has(code));
  if (!refused && isDefaultPolicy(policy)) return '';
  return (
    `note: ${refused ? 'refused' : 'judged'} under ${policySummary(policy)} -- this processor's ` +
    'own configuration, not a property of your document. `tson policy` prints it in full.'
  );
}
