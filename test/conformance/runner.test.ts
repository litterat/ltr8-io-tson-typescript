import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonLexError,
  TsonNameHygieneRefusedError,
  TsonParseError,
  TsonReadError,
  TsonUnsupportedDocumentError,
} from '../../packages/tson/src/core/errors.js';
import { parseDocument as parseDataDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { UTS39_VERSION } from '../../packages/tson/src/unicode/uts39.js';

import { spliceSchemaDirectives } from './bundled-ids.js';
import { lexTokens } from './lexer.js';
import { parseDocument } from './parser.js';
import { assertReaderValueMatches, readSchemaless } from './reader.js';
import { resolveBaseValue } from './resolver.js';
import { readVocabularyValue } from './vocabulary.js';
import {
  type Category,
  type LexerSidecar,
  type ParserSidecar,
  type ReaderSidecar,
  type ResolverSidecar,
  type SidecarSummary,
  type VocabularySidecar,
  parseLexerSidecar,
  parseParserSidecar,
  parseReaderSidecar,
  parseResolverSidecar,
  parseVocabularySidecar,
  peekSidecarSummary,
} from './sidecar.js';
import {
  LAYERS,
  SUITE_TESTS_ROOT,
  type Vector,
  discoverProposedVectors,
  discoverVectors,
  suiteAvailable,
} from './vectors.js';

/**
 * Runs every vector in the sibling `ltr8-io-tson-test-suite` repo (`RUNNER.md`, normative for
 * this file) against this implementation's real lexer ({@link lexTokens}), real Tier 3 parser
 * ({@link parseDocument}), real schemaless tree reader ({@link readSchemaless}), real base type
 * resolver ({@link resolveBaseValue}), and real built-in type vocabulary
 * ({@link readVocabularyValue}) — each a thin per-layer bridge in its own sibling module,
 * converting between this implementation's own types and the suite's own `Expected*` shapes
 * (`sidecar.ts`).
 *
 * Every sidecar is parsed with this implementation's own Tier 3 parser too (`sidecar.ts`'s own
 * top note: RUNNER.md rule 2, deliberate dogfooding).
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
    for (const layer of LAYERS) {
      describe(layer, () => {
        registerVectors(discoverVectors(layer));
      });
    }

    // Rule 5, skip ground 2: "a class2/ vector under a Class 1 processor. Declared by
    // conformance class, not per vector." This project claims only [TSON-DATA]'s Class 1 (see
    // CLAUDE.md: "the data-format processor") -- `discoverVectors`/`discoverProposedVectors` never
    // walk `class2/` at all, so there is nothing to enumerate or skip one vector at a time. This
    // is the single declaration that ground exists and is being taken, kept visible in test output
    // the same way an actual per-vector skip is (`it.skip`).
    it.skip(
      'class2/: this processor claims the Class 1 conformance class only -- RUNNER.md skip ground 2, ' +
        '"declared by conformance class, not per vector"',
      () => {
        /* declaration only -- see the comment above */
      },
    );

    // Rule: "A runner SHOULD execute [proposed/ vectors] and MUST report them separately. They
    // never count toward a conformance claim, and failing one is not a defect: it means an
    // implementation made the other reasonable choice." Nested under its own `describe` (and so
    // its own `proposed/<layer>/...` test names) precisely so a failure here reads as "the other
    // reasonable choice" rather than a conformance regression. Empty in this checkout (`proposed/`
    // does not exist yet) -- a `describe` with no `it` inside errors in vitest, so this only opens
    // per-layer blocks that actually have vectors, and says so plainly when none do at all. Wired
    // correctly ahead of the first vector landing there.
    describe('proposed (non-normative -- see RUNNER.md\'s own "proposed/" section)', () => {
      const proposedByLayer = LAYERS.map(
        (layer) => [layer, discoverProposedVectors(layer)] as const,
      );
      if (proposedByLayer.every(([, vectors]) => vectors.length === 0)) {
        it.skip('no proposed/ vectors exist in this checkout yet', () => {
          /* declaration only */
        });
        return;
      }
      for (const [layer, vectors] of proposedByLayer) {
        if (vectors.length === 0) continue;
        describe(layer, () => {
          registerVectors(vectors);
        });
      }
    });
  },
);

/**
 * Reads just the {@link SidecarSummary}, swallowing any parse failure -- {@link registerVectors}
 * needs `encoding` (rule 5's first skip ground) and, for a `refused` vector, `refusedUnicode`
 * (rule 5's fourth skip ground) before it knows whether to register the vector at all. A malformed
 * sidecar still surfaces as a genuine failure: the real, unguarded parse happens inside the
 * registered `it` itself.
 */
function bestEffortSidecarSummary(vector: Vector): SidecarSummary | undefined {
  try {
    return peekSidecarSummary(readFileSync(vector.sidecarPath));
  } catch {
    return undefined;
  }
}

/**
 * Splices a schema-governed vector's real `!!meta`/`!!import` directives in, per
 * `bundled-ids.ts`. A no-op for every vector as of this writing -- no vector's sidecar declares
 * `meta` yet -- kept general ahead of the first one that does.
 */
function resolveSchemaDirectives(subject: Uint8Array, summary: SidecarSummary): Uint8Array {
  if (summary.meta === undefined) {
    return subject;
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(subject);
  const spliced = spliceSchemaDirectives(raw, summary.meta, summary.import ?? []);
  return new TextEncoder().encode(spliced);
}

/** One `it` per vector in `vectors`, registered under whatever `describe` block is currently open. */
function registerVectors(vectors: readonly Vector[]): void {
  for (const vector of vectors) {
    // Rule 5, skip ground 1: skip, don't fail, an `encoding: utf-16`/`utf-32` vector -- an
    // implementation gap (§9.1 permits the encodings; nothing here reads them), never a
    // conformance failure. `invalid-utf8` is not skipped either way: it must be fed to the real
    // lexer and rejected there. `bestEffortSidecarSummary` re-parses the sidecar in isolation
    // (swallowing any failure) purely to decide registration; the real, unguarded parse happens
    // inside the registered `it` below, so a malformed sidecar still shows up as a genuine
    // failure rather than a silent skip. `it.skip` keeps the skip visible in test output, per
    // rule 5's own "MUST report what it skipped and why".
    const summary = bestEffortSidecarSummary(vector);
    const encodingSkip = summary?.encoding === 'utf-16' || summary?.encoding === 'utf-32';
    // Rule 5, skip ground 4: skip, don't fail or silently pass, a `refused` vector whose
    // `unicode` field names a UTS #39 data version this implementation does not carry -- §8.2
    // says two conforming implementations may legitimately disagree on a refusal, and the data
    // version is the only thing that explains it, so an implementation at a different version has
    // no verdict to give. A vector at *this* implementation's own version (`UTS39_VERSION`) is
    // never skippable on this ground.
    const versionMismatch =
      summary?.outcome === 'refused' &&
      summary.refusedUnicode !== undefined &&
      summary.refusedUnicode !== UTS39_VERSION;
    const skip = encodingSkip || versionMismatch;
    const register = skip ? it.skip : it;
    const name = versionMismatch
      ? `${vector.name} (skipped: computed against UTS #39 data for Unicode ` +
        `${summary.refusedUnicode}; this implementation carries ${UTS39_VERSION})`
      : vector.name;
    register(name, () => {
      // Rule 1: feed the subject's raw bytes, never a decoded-then-re-encoded string -- several
      // vectors (malformed UTF-8 among them) only exist as raw bytes.
      const subjectBytes = readFileSync(vector.subjectPath);
      const sidecarRaw = readFileSync(vector.sidecarPath);
      const summary = peekSidecarSummary(sidecarRaw);
      const subject = resolveSchemaDirectives(subjectBytes, summary);
      checkVector(vector, subject, sidecarRaw);
    });
  }
}

/** Dispatches to the layer-specific parse-sidecar + check pair. */
function checkVector(vector: Vector, subject: Uint8Array, sidecarRaw: Uint8Array): void {
  switch (vector.layer) {
    case 'lexer':
      checkLexerVector(vector, subject, parseLexerSidecar(sidecarRaw));
      return;
    case 'parser':
      checkParserVector(vector, subject, parseParserSidecar(sidecarRaw));
      return;
    case 'reader':
      checkReaderVector(vector, subject, parseReaderSidecar(sidecarRaw));
      return;
    case 'resolver':
      checkResolverVector(vector, subject, parseResolverSidecar(sidecarRaw));
      return;
    case 'vocabulary':
      checkVocabularyVector(vector, subject, parseVocabularySidecar(sidecarRaw));
      return;
  }
}

function requireCategory(vector: Vector, sidecar: { readonly category?: Category }): Category {
  if (sidecar.category === undefined) {
    throw new Error(`${vector.name}: an 'error' outcome vector must declare a category`);
  }
  return sidecar.category;
}

/**
 * The exception class an `error`-outcome vector's §8.1 `category` demands, **at the layer this
 * vector belongs to** — rule 3's own point: "the category is not derivable from the layer... the
 * vocabulary layer raises `resolver` and `validation` errors and never a 'vocabulary' one", so
 * one flat `category -> class` table is wrong on its face. `resolver` means one thing at the
 * vocabulary layer (a malformed token: {@link TsonAtomParseError}) and another at the reader
 * layer (a document-level rule §1.2 leaves to no earlier tier: {@link TsonReadError}) — two
 * different exception classes for the same category name, which is exactly what a layer-blind
 * mapping cannot express.
 */
function errorClassForCategory(
  vector: Vector,
  category: Category,
):
  | typeof TsonLexError
  | typeof TsonParseError
  | typeof TsonReadError
  | typeof TsonAtomParseError
  | typeof TsonAtomValidationError {
  switch (vector.layer) {
    case 'lexer':
      if (category !== 'lexer') throw unexpectedCategory(vector, category, ['lexer']);
      return TsonLexError;
    case 'parser':
      if (category !== 'parser') throw unexpectedCategory(vector, category, ['parser']);
      return TsonParseError;
    case 'reader':
      // reader-sidecar.tn's own doc: "An error vector's category is `resolver` throughout this
      // layer" -- §2.9 names it outright for an absent map key, and §2.5/§2.6's duplicate rules
      // (no category of their own in §8.1) are answered the same way.
      if (category !== 'resolver') throw unexpectedCategory(vector, category, ['resolver']);
      return TsonReadError;
    case 'resolver':
      // §4 never rejects a token (resolver-sidecar.tn has no `error` outcome at all), so this
      // layer's dispatcher (`checkResolverVector`) never calls this function in the first place.
      throw new Error(
        `${vector.name}: the resolver layer has no 'error' outcome (§4 never rejects a token)`,
      );
    case 'vocabulary':
      if (category === 'resolver') return TsonAtomParseError;
      if (category === 'validation') return TsonAtomValidationError;
      throw unexpectedCategory(vector, category, ['resolver', 'validation']);
  }
}

function unexpectedCategory(
  vector: Vector,
  category: Category,
  expected: readonly Category[],
): Error {
  return new Error(
    `${vector.name}: category '${category}' is not valid at the ${vector.layer} layer ` +
      `(expected one of: ${expected.join(', ')})`,
  );
}

// ── Lexer-layer vectors ──────────────────────────────────────────────────

function checkLexerVector(vector: Vector, subject: Uint8Array, sidecar: LexerSidecar): void {
  if (sidecar.outcome === 'valid') {
    expect(lexTokens(subject)).toEqual(sidecar.tokens ?? []);
    return;
  }
  // Rule 4: assert the category only, never the position -- the suite does not pin one.
  expect(() => lexTokens(subject)).toThrow(
    errorClassForCategory(vector, requireCategory(vector, sidecar)),
  );
}

// ── Parser-layer vectors ─────────────────────────────────────────────────

function checkParserVector(vector: Vector, subject: Uint8Array, sidecar: ParserSidecar): void {
  switch (sidecar.outcome) {
    case 'valid':
      expect(parseDocument(subject)).toEqual(sidecar.document);
      return;
    case 'error':
      expect(() => parseDocument(subject)).toThrow(
        errorClassForCategory(vector, requireCategory(vector, sidecar)),
      );
      return;
    case 'schema-document':
      // A header containing !!meta identifies a schema document: a Class 1 processor must
      // recognise and reject it with a distinct diagnostic, never attempt to parse it as data.
      expect(() => parseDocument(subject)).toThrow(TsonUnsupportedDocumentError);
      return;
  }
}

// ── Reader-layer vectors ─────────────────────────────────────────────────

function checkReaderVector(vector: Vector, subject: Uint8Array, sidecar: ReaderSidecar): void {
  if (sidecar.outcome === 'valid') {
    if (sidecar.value === undefined) {
      throw new Error(
        `${vector.name}: a 'valid' reader-layer vector must declare its expected value`,
      );
    }
    assertReaderValueMatches(sidecar.value, readSchemaless(subject));
    return;
  }
  if (sidecar.outcome === 'refused') {
    checkRefusedReaderVector(vector, subject, sidecar);
    return;
  }
  // Rule 3a: parse the subject cleanly first, so the failure asserted below is genuinely the
  // reader's own verdict -- a vector that had accidentally become a parse error must not pass
  // here for the wrong reason.
  runSync(parseDataDocument(fromBytes(subject)));
  expect(() => readSchemaless(subject)).toThrow(
    errorClassForCategory(vector, requireCategory(vector, sidecar)),
  );
}

/**
 * Rule 3d: "a `refused` vector is a fifth, distinct outcome, never one of the four categories...
 * A runner must assert both halves: something was refused, *and* nothing was also reported as one
 * of §8.1's four categories."
 *
 * The document is not malformed -- §8.2's own text is "refused by this processor", not invalid --
 * so, mirroring rule 3a, the subject must parse cleanly first: a vector that had accidentally
 * become a parse error would otherwise pass here for the wrong reason.
 *
 * The second half is asserted explicitly, not merely relied on: {@link TsonNameHygieneRefusedError}
 * extends the library's base error class directly (see its own doc comment, `core/errors.ts`),
 * never {@link TsonReadError} or any of the other family classes an `error`-outcome reader vector
 * can throw, so `instanceof` against every one of them answers `false` structurally. Checking that
 * here is what makes rule 3d's second half a runner assertion rather than an assumption about the
 * library's class hierarchy.
 */
function checkRefusedReaderVector(vector: Vector, subject: Uint8Array, sidecar: ReaderSidecar): void {
  if (sidecar.refused === undefined) {
    throw new Error(`${vector.name}: a 'refused' reader-layer vector must declare its mechanism`);
  }
  runSync(parseDataDocument(fromBytes(subject)));

  let thrown: unknown;
  try {
    readSchemaless(subject);
  } catch (error) {
    thrown = error;
  }

  // First half: something was refused, under the mechanism the vector names.
  expect(thrown).toBeInstanceOf(TsonNameHygieneRefusedError);
  const refusal = thrown as TsonNameHygieneRefusedError;
  expect(refusal.mechanism).toBe(sidecar.refused.mechanism);

  // Second half: nothing was also reported as one of §8.1's four categories.
  expect(refusal).not.toBeInstanceOf(TsonLexError);
  expect(refusal).not.toBeInstanceOf(TsonParseError);
  expect(refusal).not.toBeInstanceOf(TsonReadError);
  expect(refusal).not.toBeInstanceOf(TsonAtomParseError);
  expect(refusal).not.toBeInstanceOf(TsonAtomValidationError);
}

// ── Resolver-layer vectors ───────────────────────────────────────────────

function checkResolverVector(_vector: Vector, subject: Uint8Array, sidecar: ResolverSidecar): void {
  // §4: base type resolution never rejects a token, so the resolver layer has no `invalid`
  // bucket and no `error` outcome -- unlike every other layer.
  expect(resolveBaseValue(subject)).toEqual(sidecar.baseValue);
}

// ── Vocabulary-layer vectors (§5) ────────────────────────────────────────

function checkVocabularyVector(
  vector: Vector,
  subject: Uint8Array,
  sidecar: VocabularySidecar,
): void {
  switch (sidecar.outcome) {
    case 'valid':
      expect(readVocabularyValue(subject, sidecar.typeRef)).toEqual(sidecar.value);
      return;
    case 'error':
      // category is 'resolver' (the atom's grammar rejected the token) or 'validation' (a
      // correctly-shaped value outside a declared bound) -- never asserted by position.
      expect(() => readVocabularyValue(subject, sidecar.typeRef)).toThrow(
        errorClassForCategory(vector, requireCategory(vector, sidecar)),
      );
      return;
  }
}
