/**
 * Renders a {@link ProcessorPolicy} -- `tson policy`'s own output, and the `policy` field every
 * `validate`/`compile` run carries once (`commands/policy.ts`, `render.ts`). The machine formats
 * are `policy.tn`'s `policy.processor` (spec/m/policy.tn): `identifier_policy`
 * (`policy.identifier_policy`: `level`, `per_segment`, `skeleton_distinctness`, `permitting`),
 * `token_policy` (`policy.token_policy`: `level`, `permitting`), `unicode_data_version`, and
 * `limits` (`policy.limits`). A report is therefore valid data under that type, which
 * `policyNode.test.ts` checks by reading one against it.
 *
 * **`permitting` carries every admitted combination**, each resolved from its `ScriptId`s to the
 * script's UAX #24 Script property value alias (`Latin`, `Old_Italic`, `SignWriting`) via
 * `@ltr8/tson`'s `scriptName`, in the order `--identifier-scripts`/`--token-scripts` added them.
 *
 * **`limits` states the whole of `policy.limits`**, every member in the schema's order: a limit
 * this processor does not yet count is still its stated threshold, and a report that left it out
 * would leave a sender guessing at it. Each is a `policy.limit`, an `int64`, so the TSON form
 * writes it as a `bigint`-valued atom.
 */
import { arrayNode, atomNode, recordNode, scriptName, type Value } from '@ltr8/tson';
import { DEFAULT_LIMITS, type LimitsPolicy } from '@ltr8/tson';
import type { ProcessorPolicy } from './policyOptions.js';

/** What `policy.identifier_policy` and `policy.token_policy` each state: a level and the combinations admitted over it. */
interface ScriptRuleJson {
  readonly level: string;
  readonly permitting: readonly (readonly string[])[];
}

interface IdentifierPolicyJson extends ScriptRuleJson {
  readonly per_segment: boolean;
  readonly skeleton_distinctness: boolean;
}

/** `policy.limits`' members in the schema's order, each paired with the {@link LimitsPolicy} field that holds it. */
const LIMIT_MEMBERS = [
  ['max_depth', 'maxNestingDepth'],
  ['max_token_length', 'maxTokenLength'],
  ['max_text_length', 'maxTextLength'],
  ['max_numeric_literal_length', 'maxNumericLiteralLength'],
  ['max_binary_size', 'maxBinarySize'],
  ['max_document_size', 'maxDocumentSize'],
  ['max_elements', 'maxElements'],
  ['max_entries', 'maxEntries'],
  ['max_fields', 'maxFields'],
  ['max_annotations', 'maxAnnotations'],
  ['max_values', 'maxValues'],
  ['max_import_closure', 'maxImportClosure'],
  ['max_schema_entries', 'maxSchemaEntries'],
  ['max_alias_chain', 'maxAliasChain'],
  ['max_supertype_chain', 'maxSupertypeChain'],
  ['max_wait_depth', 'maxWaitDepth'],
] as const satisfies readonly (readonly [string, keyof LimitsPolicy])[];

// Every `LimitsPolicy` field is a member: a limit added there without a row above stops this
// line typechecking, rather than going unreported.
type _LimitsAreExhaustive = keyof LimitsPolicy extends (typeof LIMIT_MEMBERS)[number][1]
  ? true
  : never;
const _limitsAreExhaustive: _LimitsAreExhaustive = true;
void _limitsAreExhaustive;

export interface PolicyJson {
  readonly identifier_policy: IdentifierPolicyJson;
  readonly token_policy: ScriptRuleJson;
  readonly unicode_data_version: string;
  readonly limits: Readonly<Record<(typeof LIMIT_MEMBERS)[number][0], number>>;
}

/** `limits` as `policy.limits`' members, each a number. */
function limitsJson(limits: LimitsPolicy): PolicyJson['limits'] {
  return Object.fromEntries(
    LIMIT_MEMBERS.map(([member, field]) => [member, limits[field]]),
  ) as PolicyJson['limits'];
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
    limits: limitsJson(policy.limits),
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
          new Map<string, Value>(
            LIMIT_MEMBERS.map(([member, field]) => [
              member,
              atomNode(BigInt(policy.limits[field])),
            ]),
          ),
        ),
      ],
    ]),
  );
}

/** One admitted combination, spelled the way a `--identifier-scripts`/`--token-scripts` flag would (`Latin+Cyrillic`). */
function combinationText(combination: readonly string[]): string {
  return combination.join('+');
}

function scriptRuleSummary(
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
  const summary = scriptRuleSummary(
    identifierPolicy.restrictionLevel,
    permittingNames(identifierPolicy.permittedScripts),
    identifierPolicy.perSegment ? ['per segment'] : [],
  );
  return identifierPolicy.skeletonDistinctness
    ? summary
    : `${summary} without skeleton distinctness`;
}

function tokenSummary(policy: ProcessorPolicy): string {
  return scriptRuleSummary(
    policy.tokenPolicy.restrictionLevel,
    permittingNames(policy.tokenPolicy.permittedScripts),
  );
}

/** Each limit other than the nesting depth that differs from its default, as `max wait depth 8` -- the defaults go unsaid. */
function changedLimits(policy: ProcessorPolicy): readonly string[] {
  return LIMIT_MEMBERS.filter(
    ([member, field]) => member !== 'max_depth' && policy.limits[field] !== DEFAULT_LIMITS[field],
  ).map(([member, field]) => `${member.replaceAll('_', ' ')} ${String(policy.limits[field])}`);
}

/** The widest label {@link policyText} prints, with its colon and one space. */
const LABEL_WIDTH = 'max numeric literal length: '.length;

function labelled(label: string, value: string): string {
  return `${label}:${' '.repeat(LABEL_WIDTH - label.length - 1)}${value}`;
}

/** One line per surface, the data version, and then every limit in `policy.limits`' order, each value aligned: what differs between two deployments that disagree about one name -- `tson policy`'s own `--format text`. */
export function policyText(policy: ProcessorPolicy): string {
  return [
    labelled('identifier policy', identifierSummary(policy)),
    labelled('token policy', tokenSummary(policy)),
    labelled('unicode data', policy.unicodeDataVersion),
    ...LIMIT_MEMBERS.map(([member, field]) =>
      labelled(member.replaceAll('_', ' '), String(policy.limits[field])),
    ),
  ].join('\n');
}

/** Policy summary embedded in a `validate`/`compile` text run, one line: `identifier policy X, token policy Y, Unicode Z, max depth N`. */
export function policySummary(policy: ProcessorPolicy): string {
  return (
    `identifier policy ${identifierSummary(policy)}, token policy ${tokenSummary(policy)}, ` +
    `Unicode ${policy.unicodeDataVersion}, max depth ${String(policy.limits.maxNestingDepth)}` +
    changedLimits(policy)
      .map((limit) => `, ${limit}`)
      .join('')
  );
}

/** §8.2's own defaults and §9.1's and §11.5's -- what a run configures by giving no policy flags at all. */
export function isDefaultPolicy(policy: ProcessorPolicy): boolean {
  return (
    policy.identifierPolicy.restrictionLevel === 'HIGHLY_RESTRICTIVE' &&
    !policy.identifierPolicy.perSegment &&
    policy.identifierPolicy.skeletonDistinctness &&
    policy.identifierPolicy.permittedScripts.length === 0 &&
    policy.tokenPolicy.restrictionLevel === 'UNRESTRICTED' &&
    policy.tokenPolicy.permittedScripts.length === 0 &&
    LIMIT_MEMBERS.every(([, field]) => policy.limits[field] === DEFAULT_LIMITS[field])
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
