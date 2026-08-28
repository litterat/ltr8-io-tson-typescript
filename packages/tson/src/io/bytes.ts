import { TsonInternalError } from '../core/errors.js';
import { encodeUtf8 } from './utf8.js';

/**
 * Yielded by a {@link Task} that has run out of input and needs the driver to supply more.
 *
 * A unique symbol rather than a sentinel value so it can never collide with a legitimate
 * result, and so `yield*` delegation stays type-safe all the way down the stack.
 */
export const NEED_INPUT: unique symbol = Symbol('tson.need-input');

/**
 * A suspendable computation over the byte stream.
 *
 * The whole read stack — lexer, event stream, parser, readers — is written in
 * *suspendable-but-sync-shaped* style: any function that can starve is declared `function*`
 * returning a `Task`, and every call to one is `yield*`. Two drivers sit at the top:
 * {@link runSync} for input that is already complete, {@link runAsync} for input that arrives
 * in chunks.
 *
 * This exists so the grammar is written **once**. A reference implementation that spelled its
 * parser twice — once sync, once async — would have two things to keep conformant, and the
 * pair would drift.
 *
 * Two consequences worth stating:
 *
 * - **Memory stays proportional to nesting depth.** The suspended state *is* the `yield*`
 *   delegation chain, one generator frame per open container — the same bound an explicit
 *   frame stack gives.
 * - **In sync mode nothing ever suspends.** A complete input reports `ended` from
 *   construction, so `ensure()` failing means genuine EOF, which is an ordinary parse path
 *   rather than a suspension.
 */
export type Task<T> = Generator<typeof NEED_INPUT, T, void>;

/**
 * A pull cursor over bytes.
 *
 * Deliberately byte-at-a-time at the interface while implementations hold a chunk and an
 * index: the lexer decodes UTF-8 itself and must see individual bytes to reject a malformed
 * sequence at the right offset, but paying a function call per byte against a buffered
 * implementation costs nothing meaningful.
 */
export interface ByteInput {
  /** True when at least one more byte is available right now, without suspending. */
  ensure(): boolean;
  /** The next byte, 0..255. Only valid when {@link ensure} has just returned `true`. */
  read(): number;
  /** True once no further chunks will ever arrive. */
  readonly ended: boolean;
}

/** A {@link ByteInput} over a complete buffer. Never suspends. */
export function fromBytes(bytes: Uint8Array): ByteInput {
  let index = 0;
  return {
    ensure: () => index < bytes.length,
    read(): number {
      const byte = bytes[index];
      if (byte === undefined) {
        throw new TsonInternalError('read() called without a preceding successful ensure()');
      }
      index += 1;
      return byte;
    },
    get ended(): boolean {
      return true;
    },
  };
}

/**
 * A {@link ByteInput} over a complete string, encoded as UTF-8.
 *
 * Note this cannot reproduce a malformed-UTF-8 error: a JS string has already been decoded,
 * so a document that tests the lexer's UTF-8 rejection must be fed through {@link fromBytes}
 * as raw bytes. The conformance suite relies on that distinction.
 */
export function fromString(text: string): ByteInput {
  return fromBytes(encodeUtf8(text));
}

/** A {@link ByteInput} fed chunk by chunk, for use with {@link runAsync}. */
export interface ChunkInput extends ByteInput {
  /** Append a chunk. */
  push(chunk: Uint8Array): void;
  /** Declare that no further chunks will arrive. */
  end(): void;
  /**
   * Wait for the next chunk to arrive, or for the stream to end.
   *
   * Resolves as soon as either happens; a driver calls this when a task yields
   * {@link NEED_INPUT}.
   */
  pump(): Promise<void>;
}

/** Create a {@link ChunkInput} driven by an async source. */
export function chunkInput(): ChunkInput {
  const queue: Uint8Array[] = [];
  let current: Uint8Array | undefined;
  let index = 0;
  let finished = false;
  let waiters: (() => void)[] = [];

  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };

  const advance = (): boolean => {
    while (current === undefined || index >= current.length) {
      const next = queue.shift();
      if (next === undefined) return false;
      current = next;
      index = 0;
    }
    return true;
  };

  return {
    ensure: advance,
    read(): number {
      const byte = current?.[index];
      if (byte === undefined) {
        throw new TsonInternalError('read() called without a preceding successful ensure()');
      }
      index += 1;
      return byte;
    },
    get ended(): boolean {
      return finished && queue.length === 0 && (current === undefined || index >= current.length);
    },
    push(chunk: Uint8Array): void {
      if (chunk.length > 0) queue.push(chunk);
      wake();
    },
    end(): void {
      finished = true;
      wake();
    },
    async pump(): Promise<void> {
      if (finished || queue.length > 0) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * Run a {@link Task} to completion over input that is already complete.
 *
 * The throw is an internal-invariant guard, not an error path any document can reach: a
 * complete {@link ByteInput} reports `ended` from construction, so a task over one starves
 * into ordinary EOF handling rather than suspending.
 */
export function runSync<T>(task: Task<T>): T {
  const step = task.next();
  if (!step.done) {
    throw new TsonInternalError('a task suspended on input that was already complete');
  }
  return step.value;
}

/** Run a {@link Task} to completion, pumping the input each time it suspends. */
export async function runAsync<T>(task: Task<T>, input: ChunkInput): Promise<T> {
  let step = task.next();
  while (!step.done) {
    await input.pump();
    step = task.next();
  }
  return step.value;
}

/**
 * Feed an async byte source into a {@link ChunkInput}, then run a task over it.
 *
 * **Demand-driven, one chunk per suspension.** The task is stepped first; a chunk is pulled from
 * `source` only when the task has suspended on {@link NEED_INPUT} and therefore actually needs
 * one. That is what makes `CLAUDE.md`'s "memory is proportional to nesting depth" true of
 * streaming reads: a producer faster than the parser -- a file stream, a fast socket -- cannot run
 * ahead and queue the whole document in memory, because nothing asks it for a second chunk until
 * the first is consumed.
 *
 * It is also what lets a task that finishes early *stop* early. `classifyDocument` reads a
 * document's header and returns; the loop exits, and the `finally` calls the iterator's own
 * `return()`, which runs a generator's `finally` and releases a `ReadableStream`'s reader lock.
 * Nothing further is pulled from the source at all.
 *
 * Once the source is exhausted the loop keeps stepping the task without pulling again: after
 * {@link ChunkInput.end} the input reports `ended`, and a task's remaining steps are its ordinary
 * EOF handling.
 */
export async function runOver<T>(
  source: AsyncIterable<Uint8Array>,
  makeTask: (input: ByteInput) => Task<T>,
): Promise<T> {
  const input = chunkInput();
  const task = makeTask(input);
  const iterator = source[Symbol.asyncIterator]();
  let sourceEnded = false;
  try {
    let step = task.next();
    while (!step.done) {
      if (sourceEnded) {
        await input.pump(); // returns immediately once ended; keeps this a microtask loop
      } else {
        const next = await iterator.next();
        if (next.done === true) {
          sourceEnded = true;
          input.end();
        } else {
          input.push(next.value);
        }
      }
      step = task.next();
    }
    return step.value;
  } finally {
    if (!sourceEnded) {
      await iterator.return?.();
    }
  }
}
