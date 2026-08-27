import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonLexError,
  TsonNotImplementedError,
  TsonParseError,
  TsonUnsupportedDocumentError,
} from '../../packages/tson/src/core/errors.js';
import { spliceSchemaDirectives } from './bundled-ids.js';
import {
  type Category,
  type Encoding,
  type ExpectedBaseValue,
  type ExpectedDocument,
  type ExpectedToken,
  type ExpectedVocabularyValue,
  type Sidecar,
  parseSidecar,
} from './sidecar.js';
import {
  SUITE_TESTS_ROOT,
  type Layer,
  type Vector,
  discoverVectors,
  suiteAvailable,
} from './vectors.js';

/**
 * Runs every vector in the sibling `ltr8-io-tson-test-suite` repo (see its own README for the
 * vector/sidecar format) against this implementation's real lexer, parser, base type
 * resolver, and built-in type vocabulary.
 *
 * Nothing past the frozen contract layer (`packages/tson/src/core`, `io`, `ast`, `lexer/token.ts`,
 * `stream/event.ts`) exists yet, so every check below currently fails at one of two points:
 * {@link parseSidecar} throwing on the sidecar itself (dogfooding a parser that doesn't exist),
 * or — once that lands — the per-layer stand-in functions at the bottom of this file throwing
 * {@link TsonNotImplementedError} in its place. That is the correct state for this harness:
 * written now, expected to fail until the lexer and its siblings land (see `PORT-PLAN.md` §A5).
 *
 * The whole project is skipped, not failed, when `.references/` is absent (mirrors the Java
 * reference implementation's own `Assumptions.assumeTrue` behaviour), so CI without the
 * checkout stays green.
 */
const suitePresent = suiteAvailable();

describe.skipIf(!suitePresent)(
  suitePresent
    ? 'TSON conformance suite'
    : `TSON conformance suite (ltr8-io-tson-test-suite not found at ${SUITE_TESTS_ROOT} -- ` +
        `run scripts/fetch-references.sh; skipping conformance vectors)`,
  () => {
    describeLayer('lexer', checkLexerVector);
    describeLayer('parser', checkParserVector);
    describeLayer('resolver', checkResolverVector);
    describeLayer('vocabulary', checkVocabularyVector);
  },
);

type LayerCheck = (vector: Vector, subject: Uint8Array, sidecar: Sidecar) => void;

/** One `describe` block per layer, one named `it` per discovered vector. */
function describeLayer(layer: Layer, check: LayerCheck): void {
  describe(layer, () => {
    for (const vector of discoverVectors(layer)) {
      // Best-effort: once `parseSidecar` is real, an `encoding: utf-16`/`utf-32` vector is
      // skipped rather than run. Today `parseSidecar` always throws, so this never resolves
      // to a skip -- every vector falls through to `it`, which is the correct current state
      // (report as failing, not as skipped; `invalid-utf8` must never be skipped either way).
      const encoding = bestEffortEncoding(vector);
      const skip = encoding === 'utf-16' || encoding === 'utf-32';
      const register = skip ? it.skip : it;
      register(vector.name, () => {
        // Rule: feed the subject's raw bytes, never a decoded-then-re-encoded string --
        // several vectors (malformed UTF-8 among them) only exist as raw bytes.
        const subjectBytes = readFileSync(vector.subjectPath);
        const sidecar = parseSidecar(readFileSync(vector.sidecarPath));
        const subject = resolveSchemaDirectives(subjectBytes, sidecar);
        check(vector, subject, sidecar);
      });
    }
  });
}

function bestEffortEncoding(vector: Vector): Encoding | undefined {
  try {
    return parseSidecar(readFileSync(vector.sidecarPath)).encoding;
  } catch {
    return undefined;
  }
}

/**
 * Splices a schema-governed vector's real `!!meta`/`!!import` directives in, per
 * `bundled-ids.ts`. A no-op for every vector as of this writing -- no vector's sidecar
 * declares `meta` yet -- kept general for the not-yet-added `schema` layer this plumbing
 * exists ahead of.
 */
function resolveSchemaDirectives(subject: Uint8Array, sidecar: Sidecar): Uint8Array {
  if (sidecar.meta === undefined) {
    return subject;
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(subject);
  const spliced = spliceSchemaDirectives(raw, sidecar.meta, sidecar.import ?? []);
  return new TextEncoder().encode(spliced);
}

function requireCategory(vector: Vector, sidecar: Sidecar): Category {
  if (sidecar.category === undefined) {
    throw new Error(`${vector.name}: an 'error' outcome vector must declare a category`);
  }
  return sidecar.category;
}

/** The error class an `outcome: error` vector's `category` maps to. */
function errorClassForCategory(category: Category) {
  switch (category) {
    case 'lexer':
      return TsonLexError;
    case 'parser':
      return TsonParseError;
    case 'resolver':
      return TsonAtomParseError;
    case 'validation':
      return TsonAtomValidationError;
  }
}

// ── Lexer-layer vectors ──────────────────────────────────────────────────

function checkLexerVector(vector: Vector, subject: Uint8Array, sidecar: Sidecar): void {
  switch (sidecar.outcome) {
    case 'valid':
      expect(lexTokens(subject)).toEqual(sidecar.tokens ?? []);
      return;
    case 'error':
      // Rule: assert the category only, never the position -- the suite does not pin one.
      expect(() => lexTokens(subject)).toThrow(
        errorClassForCategory(requireCategory(vector, sidecar)),
      );
      return;
    default:
      throw new Error(`${vector.name}: unknown lexer-layer outcome '${sidecar.outcome}'`);
  }
}

// ── Parser-layer vectors ─────────────────────────────────────────────────

function checkParserVector(vector: Vector, subject: Uint8Array, sidecar: Sidecar): void {
  switch (sidecar.outcome) {
    case 'valid':
      expect(parseDocument(subject)).toEqual(sidecar.document);
      return;
    case 'error':
      expect(() => parseDocument(subject)).toThrow(
        errorClassForCategory(requireCategory(vector, sidecar)),
      );
      return;
    case 'schema-document':
      // A header containing !!meta identifies a schema document: a Class 1 processor must
      // recognise and reject it with a distinct diagnostic, never attempt to parse it as data.
      expect(() => parseDocument(subject)).toThrow(TsonUnsupportedDocumentError);
      return;
    default:
      throw new Error(`${vector.name}: unknown parser-layer outcome '${String(sidecar.outcome)}'`);
  }
}

// ── Resolver-layer vectors ───────────────────────────────────────────────

function checkResolverVector(vector: Vector, subject: Uint8Array, sidecar: Sidecar): void {
  // §4: base type resolution never rejects a token, so the resolver layer has no `invalid`
  // bucket and no `error` outcome -- unlike every other layer.
  if (sidecar.outcome !== 'valid') {
    throw new Error(`${vector.name}: unknown resolver-layer outcome '${sidecar.outcome}'`);
  }
  expect(resolveBaseValue(subject)).toEqual(sidecar.baseValue);
}

// ── Vocabulary-layer vectors (§5) ────────────────────────────────────────

function checkVocabularyVector(vector: Vector, subject: Uint8Array, sidecar: Sidecar): void {
  const typeRef = sidecar.typeRef;
  if (typeRef === undefined) {
    throw new Error(`${vector.name}: vocabulary vector sidecar must declare type-ref`);
  }
  switch (sidecar.outcome) {
    case 'valid':
      expect(readVocabularyValue(subject, typeRef)).toEqual(sidecar.value);
      return;
    case 'error':
      // category is 'resolver' (the atom's grammar rejected the token) or 'validation' (a
      // correctly-shaped value outside a declared bound) -- never asserted by position.
      expect(() => readVocabularyValue(subject, typeRef)).toThrow(
        errorClassForCategory(requireCategory(vector, sidecar)),
      );
      return;
    default:
      throw new Error(`${vector.name}: unknown vocabulary-layer outcome '${sidecar.outcome}'`);
  }
}

// ── Stand-ins for the not-yet-written Part 1 implementation ─────────────
//
// Everything below throws `TsonNotImplementedError`, unconditionally, because no Lexer,
// DataParser, BaseTypeResolver, or built-in type vocabulary exists in `packages/tson` yet
// (Wave 1 of `PORT-PLAN.md`). Each is replaced by a real call into `@ltr8/tson` as its work
// package lands; nothing else in this file needs to change when that happens.

function lexTokens(subject: Uint8Array): readonly ExpectedToken[] {
  throw new TsonNotImplementedError(
    `no Lexer implementation exists yet (${String(subject.length)} subject bytes)`,
  );
}

function parseDocument(subject: Uint8Array): ExpectedDocument {
  throw new TsonNotImplementedError(
    `no DataParser implementation exists yet (${String(subject.length)} subject bytes)`,
  );
}

function resolveBaseValue(subject: Uint8Array): ExpectedBaseValue {
  throw new TsonNotImplementedError(
    `no BaseTypeResolver implementation exists yet (${String(subject.length)} subject bytes)`,
  );
}

function readVocabularyValue(subject: Uint8Array, typeRef: string): ExpectedVocabularyValue {
  throw new TsonNotImplementedError(
    `no built-in type vocabulary implementation exists yet (type-ref '${typeRef}', ${String(subject.length)} subject bytes)`,
  );
}
