import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonLexError,
  TsonParseError,
  TsonUnsupportedDocumentError,
} from '../../packages/tson/src/core/errors.js';
import { spliceSchemaDirectives } from './bundled-ids.js';
import { lexTokens } from './lexer.js';
import { parseDocument } from './parser.js';
import { resolveBaseValue } from './resolver.js';
import { readVocabularyValue } from './vocabulary.js';
import { type Category, type Encoding, type Sidecar, parseSidecar } from './sidecar.js';
import {
  SUITE_TESTS_ROOT,
  type Layer,
  type Vector,
  discoverVectors,
  suiteAvailable,
} from './vectors.js';

/**
 * Runs every vector in the sibling `ltr8-io-tson-test-suite` repo (see its own README for the
 * vector/sidecar format) against this implementation's real lexer ({@link lexTokens}, backed by
 * `lexer/lexer.ts`), real Tier 3 parser ({@link parseDocument}, backed by `compiler/dataParser.ts`),
 * real base type resolver ({@link resolveBaseValue}, backed by `base/baseTypeResolver.ts`), and
 * real built-in type vocabulary ({@link readVocabularyValue}, backed by `atom/`) -- each a thin
 * per-layer bridge in its own sibling module, converting between this implementation's own types
 * and the suite's host-representation-neutral `Expected*` shapes (`sidecar.ts`).
 *
 * {@link parseSidecar} is likewise real (dogfooding: every sidecar is itself parsed with this
 * implementation's own Tier 3 parser, per `PORT-PLAN.md` §A5).
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
      // Rule: skip, don't fail, an `encoding: utf-16`/`utf-32` vector -- those are an
      // implementation gap (§9.1 permits the encodings; nothing here reads them), never a
      // conformance failure. `invalid-utf8` is not skipped either way: it must be fed to the
      // real lexer and rejected there. `bestEffortEncoding` re-parses the sidecar in isolation
      // (swallowing any failure) purely to decide registration; the real, unguarded parse
      // happens inside the registered `it` below.
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
