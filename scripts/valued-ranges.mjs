/**
 * The `(gap, width, value)` range encoding `gen-idna-tables.mjs` and `gen-bidi-tables.mjs` share,
 * and the TypeScript decoder each emits into its generated file.
 *
 * A table is a sorted list of non-overlapping inclusive code-point ranges, each carrying a
 * non-zero value; a code point in no range has value zero and is not stored. Each range is three
 * varints: the gap from the previous range's end, the range's own width, and its value. The result
 * is base64-wrapped. The decoder is emitted into each generated file rather than imported, as in
 * `gen-unicode-tables.mjs`, so a generated table is one self-contained module.
 */

/** @typedef {[number, number, number]} Run an inclusive range `[start, end]` and its non-zero value */

/**
 * @param {number[]} out
 * @param {number} value
 */
function pushVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** @param {Run[]} runs */
function encode(runs) {
  /** @type {number[]} */
  const out = [];
  let previousEnd = -1;
  for (const [start, end, value] of runs) {
    pushVarint(out, start - previousEnd - 1);
    pushVarint(out, end - start);
    pushVarint(out, value);
    previousEnd = end;
  }
  return Uint8Array.from(out);
}

/** @param {Uint8Array} bytes */
function decode(bytes) {
  /** @type {Run[]} */
  const runs = [];
  let i = 0;
  let previousEnd = -1;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = /** @type {number} */ (bytes[i++]);
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const start = previousEnd + 1 + readVarint();
    const end = start + readVarint();
    runs.push([start, end, readVarint()]);
    previousEnd = end;
  }
  return runs;
}

/**
 * Encodes `runs`, verifying the round trip so a table is never emitted unread.
 *
 * @param {string} label
 * @param {Run[]} runs
 */
export function encodeVerified(label, runs) {
  const bytes = encode(runs);
  const back = decode(bytes);
  const same =
    back.length === runs.length &&
    back.every((r, i) => r[0] === runs[i][0] && r[1] === runs[i][1] && r[2] === runs[i][2]);
  if (!same) throw new Error(`${label}: encode/decode round trip disagreed`);
  return { base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.length };
}

/**
 * The emitted constant for one table.
 *
 * @param {{constant: string, label: string, runs: Run[]}} table
 */
export function emitTable(table) {
  const { base64, byteLength } = encodeVerified(table.constant, table.runs);
  return `/** ${table.label}: ${String(table.runs.length)} ranges, ${String(byteLength)} bytes encoded. */
const ${table.constant} = /* @__PURE__ */ decodeTable(
  '${base64}',
);
`;
}

/** The decoder and lookup every generated file carries. */
export const EMITTED_RUNTIME = `const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes a base64 string to bytes without \`atob\` or \`Buffer\`, which this package may not assume. */
function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  const sextet = (index: number): number => lookup[text.charCodeAt(index)] ?? -1;

  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 0x3d /* '=' */) padding++;

  const bytes = new Uint8Array((text.length >> 2) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = sextet(i);
    const b = sextet(i + 1);
    const c = sextet(i + 2);
    const d = sextet(i + 3);
    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (out < bytes.length) bytes[out++] = (chunk >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (chunk >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = chunk & 0xff;
  }
  return bytes;
}

/**
 * Expands a \`(gap, width, value)\` varint table into a flat \`[start, end, value, ...]\` array of
 * inclusive ranges. A truncated table yields a short one rather than a crash at module load.
 */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const triples: number[] = [];
  let i = 0;
  let previousEnd = -1;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      if (byte === undefined) return result >>> 0;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };

  while (i < bytes.length) {
    const gap = readVarint();
    const width = readVarint();
    const value = readVarint();
    const start = previousEnd + 1 + gap;
    const end = start + width;
    triples.push(start, end, value);
    previousEnd = end;
  }
  return Uint32Array.from(triples);
}

/** Binary search over a flat \`[start, end, value, ...]\` array; zero for a code point in no range. */
function valueAt(table: Uint32Array, codePoint: number): number {
  let low = 0;
  let high = Math.floor(table.length / 3) - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = table[mid * 3];
    const end = table[mid * 3 + 1];
    const value = table[mid * 3 + 2];
    if (start === undefined || end === undefined || value === undefined) return 0;

    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return value;
    }
  }
  return 0;
}`;
