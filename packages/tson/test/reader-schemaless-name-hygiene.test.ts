import { describe, expect, it } from 'vitest';
import { runSync } from '../src/io/bytes.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { bodyContextOver, collectingContextOver } from './reader-tree-helpers.js';
import {
  TsonLexError,
  TsonParseError,
  TsonReadError,
  TsonNameHygieneRefusedError,
} from '../src/core/errors.js';
import { UTS39_VERSION } from '../src/unicode/uts39.js';
import {
  DEFAULT_NAME_POLICY,
  perSegment,
  withIdentifierStatus,
  withRestrictionLevel,
  withSkeletonDistinctness,
  type NamePolicy,
} from '../src/unicode/policy.js';
import type { RecordNode, Value } from '../src/tree/nodes.js';

/**
 * `reader/schemaless/tree.ts`'s wiring of [TSON-DATA] §8.2's name-hygiene policy over "the field
 * names of one record" -- §8.2's one Part 1 scope. Follows `reader-schemaless-tree.test.ts`'s own
 * local `readFail`/`readCollect` convention rather than importing it, since that module's copy
 * takes no `namePolicy` parameter.
 */

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

const CYR_A = cp(0x0430); // Cyrillic а
const RESTRICTED = cp(0x07e8); // NKo letter: XID_Continue, Identifier_Status=Restricted
const ID_POLZOVATELYA =
  'id_' +
  cp(
    0x043f,
    0x043e,
    0x043b,
    0x044c,
    0x0437,
    0x043e,
    0x0432,
    0x0430,
    0x0442,
    0x0435,
    0x043b,
    0x044f,
  );

function readFail(text: string, namePolicy?: NamePolicy): Value {
  const options = namePolicy === undefined ? {} : { namePolicy };
  return runSync(schemalessTreeReader(options).read(bodyContextOver(text)));
}

function readCollect(text: string, namePolicy?: NamePolicy) {
  const { ctx, diagnostics } = collectingContextOver(text);
  const options = namePolicy === undefined ? {} : { namePolicy };
  const value = runSync(schemalessTreeReader(options).read(ctx));
  return { value, diagnostics: diagnostics.diagnostics };
}

describe('schemalessTreeReader -- name hygiene (§8.2), the record-scope check', () => {
  it('refuses the Latin/Cyrillic admin/аdmin pair in one record', () => {
    const text = `{ admin: 1, "${CYR_A}dmin": 2 }`;
    expect(() => readFail(text)).toThrow(TsonNameHygieneRefusedError);
  });

  it('refuses the whole-script aec/аес pair', () => {
    const text = `{ aec: 1, "${cp(0x0430, 0x0435, 0x0441)}": 2 }`;
    expect(() => readFail(text)).toThrow(TsonNameHygieneRefusedError);
  });

  it('a lone id_пользователя field is not refused by mechanism 1 (never fires alone) but is refused by mechanism 3s default whole-name unit, and is admitted once the unit is per-segment', () => {
    const text = `{ "${ID_POLZOVATELYA}": 1 }`;
    expect(() => readFail(text)).toThrow(TsonNameHygieneRefusedError);
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    // Mechanism 1 never fires on a lone name: the refusal above is mechanism 3's, not 1's.
    expect(refused?.mechanism).toBe('restriction-level');

    expect(() => readFail(text, perSegment(DEFAULT_NAME_POLICY))).not.toThrow();
  });

  it('refuses a name carrying an Identifier_Status=Restricted character (mechanism 2)', () => {
    const text = `{ "${RESTRICTED}": 1 }`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused?.mechanism).toBe('identifier-status');
  });

  it('names the UTS #39 data version in the refusal (§8.2)', () => {
    const text = `{ admin: 1, "${CYR_A}dmin": 2 }`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused).toBeInstanceOf(TsonNameHygieneRefusedError);
    expect(refused?.uts39Version).toBe(UTS39_VERSION);
    expect(refused?.message).toContain(UTS39_VERSION);
  });

  it('a fail-fast refusal is a fifth outcome -- never a TsonReadError, TsonLexError, or TsonParseError (§8.1)', () => {
    const text = `{ admin: 1, "${CYR_A}dmin": 2 }`;
    try {
      readFail(text);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonNameHygieneRefusedError);
      expect(error).not.toBeInstanceOf(TsonReadError);
      expect(error).not.toBeInstanceOf(TsonLexError);
      expect(error).not.toBeInstanceOf(TsonParseError);
    }
  });

  it('a collecting read reports NAME_HYGIENE_REFUSED as a diagnostic, and still builds the record', () => {
    const text = `{ admin: 1, "${CYR_A}dmin": 2 }`;
    const { value, diagnostics } = readCollect(text);
    expect(diagnostics.map((d) => d.code)).toEqual(['NAME_HYGIENE_REFUSED']);
    expect((value as RecordNode).fields.size).toBe(2);
  });

  it('a relaxed policy admits each of the three mechanisms', () => {
    // Single-script each, so only mechanism 1 sees this pair (mechanism 3 alone would admit it).
    const skeletonPair = `{ aec: 1, "${cp(0x0430, 0x0435, 0x0441)}": 2 }`;
    expect(() =>
      readFail(skeletonPair, withSkeletonDistinctness(DEFAULT_NAME_POLICY, false)),
    ).not.toThrow();

    const restrictedChar = `{ "${RESTRICTED}": 1 }`;
    expect(() =>
      readFail(restrictedChar, withIdentifierStatus(DEFAULT_NAME_POLICY, false)),
    ).not.toThrow();

    const mixedScript = `{ "${ID_POLZOVATELYA}": 1 }`;
    expect(() =>
      readFail(mixedScript, withRestrictionLevel(DEFAULT_NAME_POLICY, 'MINIMALLY_RESTRICTIVE')),
    ).not.toThrow();
  });

  it('a map key is a value, not a name, and is never checked by this scope', () => {
    // Same confusable pair, but as map keys rather than record field names.
    const text = `{ "admin" => 1, "${CYR_A}dmin" => 2 }`;
    expect(() => readFail(text)).not.toThrow();
  });
});
