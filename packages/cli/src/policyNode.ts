/**
 * Renders a {@link ProcessorPolicy} -- `tson policy`'s own output, and the `policy` field every
 * `validate`/`compile` run carries once (`commands/policy.ts`, `render.ts`). The machine formats
 * are `policy.tn`'s `policy` type (spec/m/policy.tn): `identifier_policy` (`level`, `per_segment`,
 * `skeleton_distinctness`, `permitting`), `token_policy` (`level`, `permitting`),
 * `unicode_data_version`, and `limits` (`max_depth`). A report is therefore valid data under that
 * type, which `policyNode.test.ts` checks by reading one against it.
 *
 * **`permitting` carries every admitted combination**, each resolved from its `ScriptId`s to the
 * script's UAX #24 Script property value alias (`Latin`, `Old_Italic`, `SignWriting`) via
 * `@ltr8/tson`'s `scriptName`, in the order `--identifier-scripts`/`--token-scripts` added them.
 *
 * **`limits` states the one limit `policy.tn` declares**, `max_depth`: the nesting depth this
 * processor enforces. `Tson.processorPolicy.limits` also carries the fixed schema-side values of
 * [TSON-SCHEMA] §11.5, which `policy.tn` has no member for and which no flag configures, so they
 * are not reported.
 */
import { arrayNode, atomNode, recordNode, scriptName, type Value } from '@ltr8/tson';
import type { ProcessorPolicy } from './policyOptions.js';

interface ScriptPolicyJson {
  readonly level: string;
  readonly permitting: readonly (readonly string[])[];
}

interface IdentifierPolicyJson extends ScriptPolicyJson {
  readonly per_segment: boolean;
  readonly skeleton_distinctness: boolean;
}

export interface PolicyJson {
  readonly identifier_policy: IdentifierPolicyJson;
  readonly token_policy: ScriptPolicyJson;
  readonly unicode_data_version: string;
  readonly limits: { readonly max_depth: number };
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

/** {@link ProcessorPolicy} rendered for `--format json`. */
export function policyJson(policy: ProcessorPolicy): PolicyJson {
  const { identifierPolicy, tokenPolicy } = policy;
  return {
    identifier_policy: {
      level: identifierPolicy.restrictionLevel,
      per_segment: identifierPolicy.perSegment,
      skeleton_distinctness: identifierPolicy.skeletonDistinctness,
      permitting: permittingNames(identifierPolicy.permittedScripts),
    },
    token_policy: {
      level: tokenPolicy.restrictionLevel,
      permitting: permittingNames(tokenPolicy.permittedScripts),
    },
    unicode_data_version: policy.unicodeDataVersion,
    limits: { max_depth: policy.limits.maxNestingDepth },
  };
}

function permittingNode(permitting: readonly (readonly string[])[]): Value {
  return arrayNode(
    permitting.map((combination) => arrayNode(combination.map((name) => atomNode(name)))),
  );
}

/** {@link ProcessorPolicy} rendered for `--format tson`, as a `tree/nodes.ts` {@link Value} record. */
export function policyNode(policy: ProcessorPolicy): Value {
  const { identifierPolicy, tokenPolicy } = policy;
  return recordNode(
    new Map<string, Value>([
      [
        'identifier_policy',
        recordNode(
          new Map<string, Value>([
            ['level', atomNode(identifierPolicy.restrictionLevel)],
            ['per_segment', atomNode(identifierPolicy.perSegment)],
            ['skeleton_distinctness', atomNode(identifierPolicy.skeletonDistinctness)],
            ['permitting', permittingNode(permittingNames(identifierPolicy.permittedScripts))],
          ]),
        ),
      ],
      [
        'token_policy',
        recordNode(
          new Map<string, Value>([
            ['level', atomNode(tokenPolicy.restrictionLevel)],
            ['permitting', permittingNode(permittingNames(tokenPolicy.permittedScripts))],
          ]),
        ),
      ],
      ['unicode_data_version', atomNode(policy.unicodeDataVersion)],
      [
        'limits',
        recordNode(
          new Map<string, Value>([['max_depth', atomNode(BigInt(policy.limits.maxNestingDepth))]]),
        ),
      ],
    ]),
  );
}

/** One admitted combination, spelled the way a `--identifier-scripts`/`--token-scripts` flag would (`Latin+Cyrillic`). */
function combinationText(combination: readonly string[]): string {
  return combination.join('+');
}

function scriptPolicySummary(
  level: string,
  permitting: readonly (readonly string[])[],
  extra: readonly string[] = [],
): string {
  const parts = [level, ...extra];
  if (permitting.length > 0) parts.push(`permitting ${permitting.map(combinationText).join(', ')}`);
  return parts.join(' ');
}

function identifierSummary(policy: ProcessorPolicy): string {
  const { identifierPolicy } = policy;
  const summary = scriptPolicySummary(
    identifierPolicy.restrictionLevel,
    permittingNames(identifierPolicy.permittedScripts),
    identifierPolicy.perSegment ? ['per segment'] : [],
  );
  return identifierPolicy.skeletonDistinctness
    ? summary
    : `${summary} without skeleton distinctness`;
}

function tokenSummary(policy: ProcessorPolicy): string {
  return scriptPolicySummary(
    policy.tokenPolicy.restrictionLevel,
    permittingNames(policy.tokenPolicy.permittedScripts),
  );
}

/** One line per surface, then the data version and depth limit: what differs between two deployments that disagree about one name -- `tson policy`'s own `--format text`. */
export function policyText(policy: ProcessorPolicy): string {
  return [
    `identifier policy: ${identifierSummary(policy)}`,
    `token policy:      ${tokenSummary(policy)}`,
    `unicode data:      ${policy.unicodeDataVersion}`,
    `max depth:         ${String(policy.limits.maxNestingDepth)}`,
  ].join('\n');
}

/** Policy summary embedded in a `validate`/`compile` text run, one line: `identifier policy X, token policy Y, Unicode Z, max depth N`. */
export function policySummary(policy: ProcessorPolicy): string {
  return (
    `identifier policy ${identifierSummary(policy)}, token policy ${tokenSummary(policy)}, ` +
    `Unicode ${policy.unicodeDataVersion}, max depth ${String(policy.limits.maxNestingDepth)}`
  );
}

/** §8.2's own defaults -- what a run configures by giving no policy flags at all. */
export function isDefaultPolicy(policy: ProcessorPolicy): boolean {
  return (
    policy.identifierPolicy.restrictionLevel === 'HIGHLY_RESTRICTIVE' &&
    !policy.identifierPolicy.perSegment &&
    policy.identifierPolicy.skeletonDistinctness &&
    policy.identifierPolicy.permittedScripts.length === 0 &&
    policy.tokenPolicy.restrictionLevel === 'UNRESTRICTED' &&
    policy.tokenPolicy.permittedScripts.length === 0
  );
}

/** The refusals {@link ProcessorPolicy} explains: [TSON-DATA] §8.2's name codes and §9.1's limit. */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'CONFUSABLE_NAMES',
  'RESTRICTED_CHARACTER',
  'RESTRICTED_SCRIPT',
  'LIMIT_REFUSED',
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
  const refused = codes.some((code) => REFUSAL_CODES.has(code));
  if (!refused && isDefaultPolicy(policy)) return '';
  return (
    `note: ${refused ? 'refused' : 'judged'} under ${policySummary(policy)} -- this processor's ` +
    'own configuration, not a property of your document. `tson policy` prints it in full.'
  );
}
