/**
 * The [TSON-DATA] §8.2 policy flags shared by `validate`, `compile` and `policy` -- what each
 * applies to the `Tson`/`Config` it builds, consumed off the argument list before that command's
 * own loop sees it (mirroring the reference implementation's `PolicyOptions.consume`, called from
 * each of `TsonCli`'s `runValidate`/`runCompile`/`runPolicy`).
 *
 * **Why a CLI may configure this at all, when §8.2 asks that a relaxation not be silent.** The
 * rule CLAUDE.md states is about *ambient* authority -- a policy read from the environment is
 * invisible at the call site and absent from review. A flag is the opposite: it is written down
 * in the CI file or the Makefile that runs the command, and `tson policy` (and every
 * `validate`/`compile` report) states the policy this run was judged under. Without a flag, the
 * person running the CLI is told which configuration refused their document and has no way to
 * change it, being the deployment the report is describing.
 *
 * **`@ltr8/tson`'s own `NamePolicy`/`TokenPolicy` types are still not part of any published
 * subpath** (`unicode/index.ts`'s own top note). This module never imports them by name -- it
 * derives their shape from the `Config.identifierPolicy`/`Config.tokenPolicy` fields those types
 * back, so whatever `Config` accepts is exactly what is built here, with no second, drifting copy
 * of either type's shape. The six UTS #39 §5.2 level names below are spec vocabulary (cited in
 * `RestrictionLevel`'s own doc), not library internals, so restating them here is restating the
 * spec, not the library.
 *
 * **Script-combination admission.** `@ltr8/tson`'s `NamePolicy`/`TokenPolicy`
 * (`unicode/policy.ts`) now carry a `permittedScripts` field -- the port of the reference
 * implementation's `TsonUnicodePolicy.permitting` -- so `--identifier-scripts`/`--token-scripts`
 * are honoured rather than refused. `scriptNamed`/`scriptName` (`@ltr8/tson`'s own top-level
 * export, not `unicode/`'s) are what resolve a script named as text to the `ScriptId` a
 * `permittedScripts` combination is built from, and back again for {@link "./policyNode.js"}'s
 * own rendering. **Only the UCD `Script` property's long-form names are accepted** (`Latin`, not
 * `Latn`) -- `scriptNamed`'s own doc explains why the four-letter alias form has no
 * host-accessible source to resolve from.
 */
import { createTson, scriptNamed, type Config, type ScriptId, type Tson } from '@ltr8/tson';
import { UsageError } from './exit.js';

export type NamePolicy = NonNullable<Config['identifierPolicy']>;
export type TokenPolicy = NonNullable<Config['tokenPolicy']>;

/**
 * UTS #39 §5.2's six restriction levels, loosest last -- see `@ltr8/tson`'s own `RestrictionLevel`
 * (`unicode/restriction-level.ts`) for what each admits. Restated here as a runtime list (the type
 * alone cannot be iterated) because that module is not part of this package's public surface; see
 * this file's own top note.
 */
export type RestrictionLevel = NamePolicy['restrictionLevel'];

const LEVELS = [
  'ASCII_ONLY',
  'SINGLE_SCRIPT',
  'HIGHLY_RESTRICTIVE',
  'MODERATELY_RESTRICTIVE',
  'MINIMALLY_RESTRICTIVE',
  'UNRESTRICTED',
] as const satisfies readonly RestrictionLevel[];

// Compile-time exhaustiveness check, the other direction from `satisfies` above: if
// `RestrictionLevel` ever gains a member `LEVELS` does not list, this line stops typechecking
// (assigning `true` to `never`) instead of a level silently becoming unparseable from the command
// line. `satisfies` alone only checks that every listed member is a real level, not the reverse.
type _LevelsAreExhaustive = RestrictionLevel extends (typeof LEVELS)[number] ? true : never;
const _levelsAreExhaustive: _LevelsAreExhaustive = true;
void _levelsAreExhaustive;

/** §8.2's default identifier level -- `@ltr8/tson`'s own `DEFAULT_RESTRICTION_LEVEL`, restated for the reason this whole module gives at its top. */
const DEFAULT_IDENTIFIER_LEVEL: RestrictionLevel = 'HIGHLY_RESTRICTIVE';

/** §8.2's default token level: Unrestricted, so an ordinary read scans no values at all. */
const DEFAULT_TOKEN_LEVEL: RestrictionLevel = 'UNRESTRICTED';

/**
 * The level a script list brings with it on a surface whose default scans nothing -- mirrors the
 * reference implementation's `PolicyOptions.IMPLIED_BY_SCRIPTS`. `permittedScripts` is consulted
 * only by a level that scans, so naming scripts for the token surface (`UNRESTRICTED` by default)
 * would otherwise configure nothing at all; Single Script is the level at which a list of
 * combinations *is* the whole configuration.
 */
const IMPLIED_BY_SCRIPTS: RestrictionLevel = 'SINGLE_SCRIPT';

/** `level`, in the hyphenated lower-case spelling a person types (`highly-restrictive`), for a usage message. */
function spellLevel(level: RestrictionLevel): string {
  return level.toLowerCase().replaceAll('_', '-');
}

/**
 * Parses `raw` as a {@link RestrictionLevel}, accepting either spelling: `ascii-only` (what a
 * person types) or `ASCII_ONLY` (what `tson policy` prints), case-insensitively, so a level
 * copied out of this build's own output is a level it accepts back.
 */
function parseLevel(raw: string, flag: string): RestrictionLevel {
  const normalized = raw.toUpperCase().replaceAll('-', '_');
  const match = LEVELS.find((level) => level === normalized);
  if (match === undefined) {
    throw new UsageError(
      `${flag}: unknown restriction level '${raw}' -- expected one of ` +
        LEVELS.map(spellLevel).join(', '),
    );
  }
  return match;
}

/**
 * Whether `level` scans script combinations at all -- UTS #39 §5.2's two no-scan levels.
 * Restated here rather than imported for the reason this module's own top note gives; mirrors the
 * reference implementation's `TsonUnicodePolicy#checksScripts`.
 */
function scansScripts(level: RestrictionLevel): boolean {
  return level !== 'MINIMALLY_RESTRICTIVE' && level !== 'UNRESTRICTED';
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

/**
 * Parses `value` as one `Latin+Cyrillic`-style script combination for `flag` -- UTS #39 §5.2's
 * own device for its Latn+Jpan/Latn+Hanb/Latn+Kore augmented sets, opened to a caller. Each
 * `+`-separated name is resolved through `@ltr8/tson`'s `scriptNamed`, which accepts only the UCD
 * `Script` property's long-form names (`scriptNamed`'s own doc).
 *
 * @throws {UsageError} a name `scriptNamed` does not recognize, naming the offending name and the
 *   whole combination it was found in.
 */
function parseScriptCombination(value: string, flag: string): readonly ScriptId[] {
  return value.split('+').map((rawName) => {
    const name = rawName.trim();
    const id = scriptNamed(name);
    if (id === undefined) {
      throw new UsageError(
        `${flag}: unknown script '${name}' in '${value}' -- expected UCD Script property names ` +
          "joined by '+', such as Latin+Cyrillic",
      );
    }
    return id;
  });
}

/**
 * One surface's policy level: the stated level or the default, adjusted for the relaxations
 * layered on it -- mirrors the reference implementation's `PolicyOptions.assemble`.
 *
 * **A script list brings its own level where the default scans nothing** ({@link
 * IMPLIED_BY_SCRIPTS}): `--token-scripts Latin+Cyrillic` on its own means "values are one script,
 * or one of these combinations". A level the caller stated is never overridden.
 *
 * **A relaxation against a level that scans nothing is refused, not ignored** -- `--token-policy
 * unrestricted --token-scripts Latin+Cyrillic` configures nothing whatever, and silently
 * accepting it would leave the caller believing a restriction is in force.
 *
 * @throws {UsageError} `perSegment` or a non-empty `scripts` paired with a level (stated or
 *   defaulted) that scans no scripts.
 */
function assembleLevel(
  surface: 'identifier' | 'token',
  stated: RestrictionLevel | undefined,
  fallback: RestrictionLevel,
  perSegment: boolean,
  scripts: readonly (readonly ScriptId[])[],
): RestrictionLevel {
  const relaxed = perSegment || scripts.length > 0;
  const level = stated ?? (relaxed && !scansScripts(fallback) ? IMPLIED_BY_SCRIPTS : fallback);

  if (relaxed && !scansScripts(level)) {
    const given =
      scripts.length === 0
        ? `--${surface}-per-segment`
        : `--${surface}-scripts${perSegment ? ` and --${surface}-per-segment` : ''}`;
    throw new UsageError(
      `--${surface}-policy ${spellLevel(level)} scans no scripts, so the ${given} given with it ` +
        'would configure nothing -- state a level that scans, or drop the relaxation',
    );
  }
  return level;
}

/** [TSON-DATA] §8.2's policy for one run, always concrete -- what a run configures by giving no flags at all is `identifierPolicy`/`tokenPolicy` at their own §8.2 defaults, not an absent value. */
export interface PolicyOptions {
  readonly identifierPolicy: NamePolicy;
  readonly tokenPolicy: TokenPolicy;
}

export interface ConsumedPolicyOptions {
  readonly policy: PolicyOptions;
  /** `args` with every recognized policy flag removed, in order, for the command's own loop. */
  readonly rest: readonly string[];
}

/**
 * Removes every policy flag from `args` and returns what they configure -- §8.2's own defaults
 * when none was given.
 *
 * **Order-independent**: every flag is collected first and the two policies assembled after, so a
 * level stated before or after a relaxation that rides on it reads the same, matching the
 * reference implementation's own `PolicyOptions.consume`.
 *
 * **`--identifier-scripts`/`--token-scripts` are repeatable**, each occurrence naming one
 * combination (`Latin+Cyrillic`) admitted in addition to whatever the level already allows,
 * matching the reference implementation's own accumulating `List<UnicodeScript[]>`.
 *
 * @throws {UsageError} a bad level or script name, a flag missing its value, or
 *   `--identifier-per-segment`/`--identifier-scripts`/`--token-scripts` paired with a stated (or
 *   defaulted) level that scans no scripts.
 */
export function consumePolicyOptions(args: readonly string[]): ConsumedPolicyOptions {
  let identifierLevel: RestrictionLevel | undefined;
  let tokenLevel: RestrictionLevel | undefined;
  let identifierPerSegment = false;
  const identifierScripts: (readonly ScriptId[])[] = [];
  const tokenScripts: (readonly ScriptId[])[] = [];
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--identifier-policy':
        identifierLevel = parseLevel(
          requireValue(args, ++i, '--identifier-policy'),
          '--identifier-policy',
        );
        break;
      case '--identifier-per-segment':
        identifierPerSegment = true;
        break;
      case '--identifier-scripts':
        identifierScripts.push(
          parseScriptCombination(
            requireValue(args, ++i, '--identifier-scripts'),
            '--identifier-scripts',
          ),
        );
        break;
      case '--token-policy':
        tokenLevel = parseLevel(requireValue(args, ++i, '--token-policy'), '--token-policy');
        break;
      case '--token-scripts':
        tokenScripts.push(
          parseScriptCombination(requireValue(args, ++i, '--token-scripts'), '--token-scripts'),
        );
        break;
      default:
        rest.push(arg);
    }
  }

  const resolvedIdentifierLevel = assembleLevel(
    'identifier',
    identifierLevel,
    DEFAULT_IDENTIFIER_LEVEL,
    identifierPerSegment,
    identifierScripts,
  );
  const resolvedTokenLevel = assembleLevel(
    'token',
    tokenLevel,
    DEFAULT_TOKEN_LEVEL,
    false,
    tokenScripts,
  );

  return {
    policy: {
      identifierPolicy: {
        // §8.2's own defaults for the two mechanisms this CLI exposes no flag for (matching the
        // reference implementation, whose own PolicyOptions/TsonUnicodePolicy carry no flag for
        // either): both stay enforced regardless of what the level/unit flags above say.
        skeletonDistinctness: true,
        identifierStatus: true,
        restrictionLevel: resolvedIdentifierLevel,
        restrictionUnit: identifierPerSegment ? 'PER_SEGMENT' : 'WHOLE_NAME',
        permittedScripts: identifierScripts,
      },
      tokenPolicy: { restrictionLevel: resolvedTokenLevel, permittedScripts: tokenScripts },
    },
    rest,
  };
}

/** [TSON-DATA] §8.2's policy this instance judges under -- `Tson.processorPolicy`'s own type, named here without importing it (also not part of any published subpath) by deriving it from `Tson`'s own exported shape. */
export type ProcessorPolicy = Tson['processorPolicy'];

/**
 * The {@link ProcessorPolicy} `options` would apply, read back through a real, ephemeral
 * `createTson` instance rather than echoed from the flags directly -- the same principle the
 * reference implementation's `PolicyCommand` states ("this prints what a read would actually be
 * judged under, which is the question, and the two would only ever agree by inspection
 * otherwise"). No schema registry is needed for this: `Tson.processorPolicy` is a pure function
 * of `Config.identifierPolicy`/`Config.tokenPolicy`, unaffected by what is registered.
 */
export function processorPolicyOf(options: PolicyOptions): ProcessorPolicy {
  return createTson({
    identifierPolicy: options.identifierPolicy,
    tokenPolicy: options.tokenPolicy,
  }).processorPolicy;
}
