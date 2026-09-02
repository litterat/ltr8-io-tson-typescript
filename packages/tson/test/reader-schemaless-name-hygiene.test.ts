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
  withSkeletonDistinctness,
  type NamePolicy,
} from '../src/unicode/policy.js';
import type { RecordNode, Value } from '../src/tree/nodes.js';

/**
 * `reader/schemaless/tree.ts`'s wiring of [TSON-DATA] §8.2's name-hygiene policy over its two
 * Part 1 scopes: a record's own field names (mechanism 1 only -- lexical, not `identifier`), and
 * a type-ref or annotation name (mechanisms 2 and 3 only -- a lone `identifier` position, no
 * scope for mechanism 1 to relate). Follows `reader-schemaless-tree.test.ts`'s own local
 * `readFail`/`readCollect` convention rather than importing it, since that module's copy takes no
 * `identifierPolicy` parameter.
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

function readFail(text: string, identifierPolicy?: NamePolicy): Value {
  const options = identifierPolicy === undefined ? {} : { identifierPolicy };
  return runSync(schemalessTreeReader(options).read(bodyContextOver(text)));
}

function readCollect(text: string, identifierPolicy?: NamePolicy) {
  const { ctx, diagnostics } = collectingContextOver(text);
  const options = identifierPolicy === undefined ? {} : { identifierPolicy };
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

  it('a lone id_пользователя field is not refused at all -- mechanism 1 never fires alone, and mechanisms 2/3 do not run over a field-name scope in the first place', () => {
    // Contrast `unicode/policy.test.ts`'s own coverage of `id_пользователя`: over an
    // `identifier` scope (a type-ref/annotation name, or a schema-layer name) this same text
    // is refused by mechanism 3's default whole-name unit. A `field-name` is lexical, not
    // `identifier` (§2.5, §7.7), so that mechanism never applies here at all -- not even to
    // relax, since there is nothing this scope was checking against it to begin with.
    const text = `{ "${ID_POLZOVATELYA}": 1 }`;
    expect(() => readFail(text)).not.toThrow();
  });

  it('a lone field name carrying an Identifier_Status=Restricted character is not refused -- mechanism 2 does not run over a field-name scope', () => {
    const text = `{ "${RESTRICTED}": 1 }`;
    expect(() => readFail(text)).not.toThrow();
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
    // The version rides on the thrown error, and is stated once per instance on
    // `Tson.processorPolicy` -- it is deliberately *not* repeated inside the message. A version is
    // constant for the run, so a copy in every refusal is waste, and it says what refused you
    // rather than what would be accepted.
    expect(refused?.uts39Version).toBe(UTS39_VERSION);
    expect(refused?.message).not.toContain(UTS39_VERSION);
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

  it('a collecting read reports CONFUSABLE_NAMES as a diagnostic, and still builds the record', () => {
    const text = `{ admin: 1, "${CYR_A}dmin": 2 }`;
    const { value, diagnostics } = readCollect(text);
    expect(diagnostics.map((d) => d.code)).toEqual(['CONFUSABLE_NAMES']);
    expect((value as RecordNode).fields.size).toBe(2);
  });

  it('relaxing mechanism 1 admits what the default policy refuses -- the only mechanism this scope ever applies', () => {
    // Single-script each, so only mechanism 1 sees this pair (mechanism 3 alone would admit it,
    // and does not run over a field-name scope regardless -- see this describe block's other
    // cases).
    const skeletonPair = `{ aec: 1, "${cp(0x0430, 0x0435, 0x0441)}": 2 }`;
    expect(() =>
      readFail(skeletonPair, withSkeletonDistinctness(DEFAULT_NAME_POLICY, false)),
    ).not.toThrow();
  });

  it('a map key is a value, not a name, and is never checked by this scope', () => {
    // Same confusable pair, but as map keys rather than record field names.
    const text = `{ "admin" => 1, "${CYR_A}dmin" => 2 }`;
    expect(() => readFail(text)).not.toThrow();
  });
});

describe('schemalessTreeReader -- name hygiene (§8.2), the type-ref/annotation-name scope', () => {
  it('refuses a mixed-script annotation name under mechanism 3s default whole-name unit', () => {
    const text = `@${ID_POLZOVATELYA} "x"`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused?.mechanism).toBe('restriction-level');
  });

  it('refuses a mixed-script type-ref name the same way', () => {
    const text = `!${ID_POLZOVATELYA} "x"`;
    expect(() => readFail(text)).toThrow(TsonNameHygieneRefusedError);
  });

  it('refuses an annotation name carrying an Identifier_Status=Restricted character (mechanism 2)', () => {
    const text = `@${RESTRICTED} "x"`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused?.mechanism).toBe('identifier-status');
  });

  it('refuses a type-ref name carrying an Identifier_Status=Restricted character the same way', () => {
    const text = `!${RESTRICTED} "x"`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused?.mechanism).toBe('identifier-status');
  });

  it('mechanism 1 never applies here -- two annotation names confusable with each other, but never compared, are each judged alone', () => {
    // `aec`/whole-Cyrillic-`аес` is the pair `link-nameHygiene.test.ts` uses to isolate mechanism
    // 1 over a real scope; here each name is a lone annotation with nothing to be distinct from,
    // so neither is refused (each is single-script and Identifier_Status=Allowed on its own).
    // Annotation names, not type-refs, so the assertion isolates name hygiene from
    // `typeRefCheck.ts`'s unrelated UNKNOWN_TYPE_REF rule.
    const text = `{ a: @aec "1", b: @${cp(0x0430, 0x0435, 0x0441)} "2" }`;
    expect(() => readFail(text)).not.toThrow();
  });

  it('a relaxed policy admits a mixed-script annotation name once the unit is per-segment', () => {
    const text = `@${ID_POLZOVATELYA} "x"`;
    expect(() => readFail(text, perSegment(DEFAULT_NAME_POLICY))).not.toThrow();
  });

  it('checks a nested annotation values own annotation name too (§3.1s recursive value)', () => {
    const text = `@outer:@${ID_POLZOVATELYA} "x"`;
    expect(() => readFail(text)).toThrow(TsonNameHygieneRefusedError);
  });

  it('a collecting read reports exactly one RESTRICTED_SCRIPT diagnostic for one bad name', () => {
    const text = `@${ID_POLZOVATELYA} "x"`;
    const { diagnostics } = readCollect(text);
    expect(diagnostics.map((d) => d.code)).toEqual(['RESTRICTED_SCRIPT']);
  });

  it('names the UTS #39 data version in the refusal, same as the field-name scope', () => {
    const text = `@${ID_POLZOVATELYA} "x"`;
    let refused: TsonNameHygieneRefusedError | undefined;
    try {
      readFail(text);
    } catch (error) {
      refused = error as TsonNameHygieneRefusedError;
    }
    expect(refused?.uts39Version).toBe(UTS39_VERSION);
  });
});
