import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoverAllVectors, suiteAvailable } from '../../../test/conformance/vectors.js';
import { peekSidecarSummary, type SidecarSummary } from '../../../test/conformance/sidecar.js';
import type { Vector } from '../../../test/conformance/vectors.js';
import { fromBytes, fromString, runSync } from '../src/io/bytes.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import { writeDocument } from '../src/write/astWriter.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { createReadContext } from '../src/reader/context.js';
import { throwing } from '../src/core/diagnostic.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { tsonDocument, type TsonDocument, type Value } from '../src/tree/nodes.js';
import { writeTree, writeTreeValue } from '../src/write/treeWriter.js';
import { TsonWriteError } from '../src/core/errors.js';
import { compareDecimal } from '../src/atom/numeric/decimalMath.js';

/**
 * `write/`'s own conformance round trip: **parse, write, re-parse, compare** -- the free round-trip
 * property `PORT-PLAN.md`'s work-package brief names, since every valid vector at these four
 * layers is already a document this implementation can read (see {@link roundTrippableVectors}'s
 * own note on why the lexer layer is not one of them). Two writers are checked against every such
 * vector:
 *
 * - `astWriter.ts` (syntax-preserving): the re-parsed AST must equal the first parse's AST
 *   exactly, because nothing about that writer is entitled to change a single token's form.
 * - `treeWriter.ts` (value-preserving, via the real schemaless reader): the re-parsed tree must
 *   equal the first read's tree, though the *bytes* may differ (a vocabulary atom always writes
 *   quoted, whichever way the source spelled it -- `treeWriter.ts`'s own top note).
 *
 * This file discovers vectors itself rather than reusing `test/conformance/runner.test.ts`'s own
 * per-layer machinery, and it is not the conformance harness: it does not assert a vector's own
 * `sidecar` expectations (that stays `test:conformance`'s job, ungated by whether `write/` exists
 * yet), it only uses each vector's subject bytes as an already-known-good document to round-trip.
 * Skipped, not failed, when `.references/` is absent, mirroring `runner.test.ts`'s own guard.
 */
const suitePresent = suiteAvailable();

function bestEffortSidecarSummary(vector: Vector): SidecarSummary | undefined {
  try {
    return peekSidecarSummary(readFileSync(vector.sidecarPath));
  } catch {
    return undefined;
  }
}

/**
 * Vectors this round trip applies to: a plain valid data document, real UTF-8, no schema splice.
 *
 * **Never the lexer layer.** A lexer-layer `valid` vector's sidecar promises only a well-formed
 * *token stream* (`schemas/lexer-sidecar.tn`'s own `lexer_valid`), not a single parseable
 * data-value document — the corpus's own README is explicit that the layers are pipeline stages,
 * not a nesting of guarantees. `lexer/valid/bidi-mark-at-token-boundary`'s subject (`ab ‎ c`)
 * is exactly such a vector: it tokenizes to two ordinary tokens on purpose, precisely to prove the
 * bidi mark contributes nothing, and two bare tokens are not one data-value — parsing it as a
 * document correctly raises `TsonParseError` ("unexpected content after the document's value").
 * The parser, reader, resolver and vocabulary layers carry no such gap: every one of their
 * subjects is, by the corpus's own construction, a single data-value document (a bare token for
 * resolver/vocabulary, a whole document for parser/reader).
 */
function roundTrippableVectors(): Vector[] {
  return discoverAllVectors().filter((vector) => {
    if (vector.layer === 'lexer') return false;
    const summary = bestEffortSidecarSummary(vector);
    return (
      summary?.outcome === 'valid' && summary.encoding === undefined && summary.meta === undefined
    );
  });
}

/** `unscaled`/`exponent` shaped ({@link TsonDecimal}), never structurally canonical -- see that type's own doc. */
function isTsonDecimalShaped(value: unknown): value is { unscaled: bigint; exponent: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'unscaled' in value &&
    'exponent' in value &&
    typeof (value as { unscaled: unknown }).unscaled === 'bigint'
  );
}

/**
 * `Value` equality for this round trip's own purpose: **by value**, not by stored representation.
 * Identical to structural equality everywhere except at a {@link TsonDecimal} leaf, where
 * `writeTreeValue`'s own `.0`-suffix rule (needed so a whole exact decimal still narrows back to
 * `TsonDecimal` rather than `bigint`, `atomFraming.ts`'s own top note) can change the *stored*
 * `unscaled`/`exponent` pair while leaving the *value* unchanged (`value/types.ts`'s own
 * documented "not canonical" rule, already established for `Rational`) -- `compareDecimal`
 * (`atom/numeric/decimalMath.ts`) is exactly the value-level comparison that rule calls for.
 */
function valueEqual(a: Value, b: Value): boolean {
  if (a.kind === 'atom' && b.kind === 'atom') {
    if (isTsonDecimalShaped(a.value) && isTsonDecimalShaped(b.value)) {
      return (
        compareDecimal(a.value, b.value) === 0 &&
        a.typeRef === b.typeRef &&
        JSON.stringify(a.annotations) === JSON.stringify(b.annotations)
      );
    }
  }
  if (a.kind === 'record' && b.kind === 'record') {
    if (a.fields.size !== b.fields.size) return false;
    for (const [key, av] of a.fields) {
      const bv = b.fields.get(key);
      if (bv === undefined || !valueEqual(av, bv)) return false;
    }
    return a.typeRef === b.typeRef;
  }
  if ((a.kind === 'array' && b.kind === 'array') || (a.kind === 'tuple' && b.kind === 'tuple')) {
    if (a.elements.length !== b.elements.length) return false;
    if (a.typeRef !== b.typeRef) return false;
    for (let i = 0; i < a.elements.length; i += 1) {
      const av = a.elements[i];
      const bv = b.elements[i];
      if (av === undefined || bv === undefined || !valueEqual(av, bv)) return false;
    }
    return true;
  }
  if (a.kind === 'map' && b.kind === 'map') {
    if (a.entries.length !== b.entries.length) return false;
    if (a.typeRef !== b.typeRef) return false;
    for (let i = 0; i < a.entries.length; i += 1) {
      const ae = a.entries[i];
      const be = b.entries[i];
      if (ae === undefined || be === undefined) return false;
      if (!valueEqual(ae.key, be.key) || !valueEqual(ae.value, be.value)) return false;
    }
    return true;
  }
  return JSON.stringify(a, jsonBigintReplacer) === JSON.stringify(b, jsonBigintReplacer);
}

function jsonBigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value;
}

function readSchemaless(bytes: Uint8Array): TsonDocument {
  const source = createDataStream(fromBytes(bytes));
  const ctx = createReadContext(
    source,
    throwing((d) => new Error(`${d.code}: ${d.message}`)),
  );
  const start = runSync(ctx.next());
  if (start.kind !== 'document-start')
    throw new Error(`expected document-start, got ${start.kind}`);
  const root = runSync(schemalessTreeReader({ preserveUnknownTypeRefs: true }).read(ctx));
  const end = runSync(ctx.next());
  if (end.kind !== 'document-end') throw new Error(`expected document-end, got ${end.kind}`);
  return tsonDocument(root, start.id, start.schema);
}

describe.skipIf(!suitePresent)(
  suitePresent
    ? 'write/ round trip against the shared conformance suite'
    : 'write/ round trip against the shared conformance suite (skipped -- .references/ absent)',
  () => {
    const vectors = suitePresent ? roundTrippableVectors() : [];

    describe('astWriter.ts -- parse, write, re-parse: identical AST', () => {
      for (const vector of vectors) {
        it(vector.name, () => {
          const subjectBytes = readFileSync(vector.subjectPath);
          const first = runSync(parseDocument(fromBytes(subjectBytes)));
          const written = writeDocument(first.document);
          const second = runSync(parseDocument(fromString(written)));
          expect(second.document).toEqual(first.document);
        });
      }
    });

    describe('treeWriter.ts -- schemaless read, write, re-read: identical tree (by value)', () => {
      for (const vector of vectors) {
        it(vector.name, () => {
          const subjectBytes = readFileSync(vector.subjectPath);
          const first = readSchemaless(subjectBytes);
          if (
            first.schema !== undefined &&
            (first.root.kind === 'missing' || first.root.typeRef === undefined)
          ) {
            // A document can legitimately declare `!!schema` over a root with no type annotation
            // of its own (§2.2/§3.2: the annotation is permitted, not required) -- a schema-driven
            // read would attach the declared type itself, but a schemaless read has no schema in
            // scope to attach one from, so `writeTree`'s own header/root consistency check
            // (`treeWriter.ts`'s own doc, mirroring `TsonTreeWriter.write`) correctly refuses to
            // write a document it cannot select a type for. The root *value* still round-trips
            // fine on its own; only the full header+root document write is inapplicable here.
            expect(() => writeTree(first)).toThrow(TsonWriteError);
            const writtenValue = writeTreeValue(first.root);
            const rereadValue = readSchemaless(new TextEncoder().encode(writtenValue)).root;
            expect(valueEqual(rereadValue, first.root)).toBe(true);
            return;
          }
          const written = writeTree(first);
          const second = readSchemaless(new TextEncoder().encode(written));
          expect(valueEqual(second.root, first.root)).toBe(true);
          expect(second.id).toBe(first.id);
          expect(second.schema).toBe(first.schema);
        });
      }
    });
  },
);
