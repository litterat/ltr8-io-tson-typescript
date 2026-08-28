/**
 * Shared test-only fixtures for `reader/tree/*.test.ts` -- not itself a `*.test.ts` file, so vitest
 * never tries to run it. A real `ReadContext` over real lexed/streamed source text (never a hand-rolled
 * event list), matching `reader-context.test.ts`'s own approach: the shared-cursor semantics these
 * readers depend on are only really exercised by driving actual events.
 */
import { fromString, runSync } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { createReadContext } from '../src/reader/context.js';
import {
  collector,
  throwing,
  type DiagnosticsCollector,
  type DiagnosticsReceiver,
} from '../src/core/diagnostic.js';
import type { ReadContext } from '../src/reader/contracts.js';
import type { AtomType, AtomToken } from '../src/atom/contract.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';

/** A `ReadContext` over `text`'s real event stream, reporting through `receiver` -- fail-fast by default. */
export function contextOver(text: string, receiver?: DiagnosticsReceiver): ReadContext {
  const source = createDataStream(fromString(text));
  return createReadContext(
    source,
    receiver ?? throwing((d) => new Error(`${d.code}: ${d.message}`)),
  );
}

/** As {@link contextOver}, positioned right after `document-start` -- the position every reader in this directory actually reads from. */
export function bodyContextOver(text: string, receiver?: DiagnosticsReceiver): ReadContext {
  const ctx = contextOver(text, receiver);
  runSync(ctx.next()); // document-start
  return ctx;
}

/** A collecting `ReadContext` over `text`, and the collector it reports through. */
export function collectingContextOver(text: string): {
  ctx: ReadContext;
  diagnostics: DiagnosticsCollector;
} {
  const diagnostics = collector();
  const ctx = bodyContextOver(text, diagnostics);
  return { ctx, diagnostics };
}

/**
 * A minimal `!int32`-shaped {@link AtomType}: any base-10 integer token, rejecting anything else as a
 * parse error and a magnitude outside the given bound as a validation error -- enough to exercise both
 * of `AtomType`'s two failure shapes without pulling in the real `atom/numeric/integer.ts` parser.
 */
export function stubIntType(max = 2147483647): AtomType<number> {
  return {
    read(token: AtomToken): number {
      if (!/^-?\d+$/.test(token.text)) {
        throw new TsonAtomParseError(
          'int32',
          `'${token.text}' is not an integer token`,
          'an integer token',
        );
      }
      const value = Number(token.text);
      if (value > max) {
        throw new TsonAtomValidationError(
          'int32',
          `${token.text} exceeds ${String(max)}`,
          `<= ${String(max)}`,
        );
      }
      return value;
    },
    write: (value) => String(value),
  };
}

/** A minimal `!text`-shaped {@link AtomType}: every token text is a valid value, verbatim. */
export function stubTextType(): AtomType<string> {
  return {
    read: (token: AtomToken) => token.text,
    write: (value) => value,
  };
}
