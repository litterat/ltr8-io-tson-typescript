/**
 * A document's content hash ([TSON-DATA] §2.2.1): SHA-256, lowercase hex at full length, of every
 * byte after the first line's terminator. The first line is the `!!id` line (the grammar places
 * the id directive at the very start), so the id line — up to and including its terminator — is
 * excluded; that lets a document carry its own hash on its own id line without the circularity of
 * hashing it. A leading byte-order mark is stripped and never enters the hash input, and a
 * content-addressed document MUST be UTF-8.
 *
 * Ported from the reference implementation's `TsonContentHash`
 * (`tson-compiler/.../TsonContentHash.java`). This module states only what differs in the port.
 *
 * **The digest is a hand-written, pure-JS SHA-256 ({@link sha256Digest}), not `crypto.subtle`.**
 * `crypto.subtle.digest` is Promise-returning in both Node and every browser, with no synchronous
 * form either offers — but registering a schema from source text (`config.ts`'s own
 * `resolveSchema`) is synchronous by deliberate, documented architecture, and needs a real digest
 * to pin-check that registration the same way a fetch is ([TSON-SCHEMA] §10.2). A package
 * dependency is not an option (`CLAUDE.md`'s zero-runtime-dependencies constraint), so this module
 * carries its own FIPS 180-4 implementation instead. {@link sha256HexSync} is the synchronous
 * entry every registration path in this library now uses; {@link sha256Hex} is the same
 * computation wrapped in an already-resolved `Promise`, kept `async`-shaped only so the callers
 * this module already had (`verifyContentHash`, `identity/index.ts`'s public re-export) do not
 * have to change their own signatures. Content hashing is not suspendable input consumption
 * either way, so neither is `Task<T>`-returning: `Task` exists for a suspension the caller's own
 * byte source resumes, which hashing bytes already fully in hand never needs.
 */
import { TsonContentHashMismatchError, TsonSchemaValidationError } from '../core/errors.js';

const BOM = [0xef, 0xbb, 0xbf];

/**
 * The content-hash sentinel recorded for a document with no well-defined hash-input boundary --
 * {@link contentStart} itself throws for this case (a single-line document, no terminator after
 * its `!!id` line). §2.2.1 requires that terminator of a content-addressed document only, so its
 * absence is not a document error: the document still loads, and this sentinel is what makes a
 * *pinned reference* to it fail instead of silently going unverified (§10.2), the same distinction
 * the reference implementation's own `TsonCompiledMetaRegistry.UNADDRESSABLE` draws.
 */
export const UNADDRESSABLE = '';

/**
 * Whether `document` has a well-defined content-hash input boundary at all -- `false` exactly
 * when {@link contentStart} would throw. Synchronous and cheap, unlike {@link sha256Hex}: this
 * walks the bytes once for a line terminator and computes no digest, so a caller that cannot
 * await a hash (a synchronous registration path) can still record {@link UNADDRESSABLE} for an
 * identity it cannot otherwise verify.
 */
export function isAddressable(document: Uint8Array): boolean {
  try {
    contentStart(document);
    return true;
  } catch {
    return false;
  }
}

/**
 * The index where the hash input begins — past a leading BOM and past the first line's
 * terminator (for `CR LF`, after the `LF`). Operates on raw bytes, matching §7.3's own
 * `line-term` set: `LF`, `CR`, `CR LF`, `NEL` (U+0085, UTF-8 `C2 85`), `LS`/`PS` (U+2028/U+2029,
 * UTF-8 `E2 80 A8`/`E2 80 A9`).
 *
 * @throws TsonSchemaValidationError if the first line has no terminator, so there is no
 *   well-defined hash-input boundary.
 */
export function contentStart(document: Uint8Array): number {
  let i =
    document.length >= 3 &&
    document[0] === BOM[0] &&
    document[1] === BOM[1] &&
    document[2] === BOM[2]
      ? 3
      : 0;
  for (; i < document.length; i++) {
    const b = document[i];
    if (b === 0x0a) {
      return i + 1; // LF
    }
    if (b === 0x0d) {
      return i + 1 < document.length && document[i + 1] === 0x0a ? i + 2 : i + 1; // CR LF or CR
    }
    if (b === 0xc2 && i + 1 < document.length && document[i + 1] === 0x85) {
      return i + 2; // NEL U+0085
    }
    if (b === 0xe2 && i + 2 < document.length && document[i + 1] === 0x80) {
      const c = document[i + 2];
      if (c === 0xa8 || c === 0xa9) {
        return i + 3; // LS U+2028 / PS U+2029
      }
    }
  }
  throw new TsonSchemaValidationError(
    'the first line has no terminator -- a content-addressed document must follow its !!id line ' +
      'with one ([TSON-DATA] §2.2.1)',
  );
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** SHA-256's eight initial hash values, FIPS 180-4 §5.3.3 — the first 32 bits of the fractional parts of the square roots of the first eight primes. */
const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** SHA-256's 64 round constants, FIPS 180-4 §4.2.2 — the first 32 bits of the fractional parts of the cube roots of the first sixty-four primes. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Element `i` of `array`, asserted present -- every call site below reads at an index its own
 * loop bound already guarantees is in range (a fixed 8/16/64-element pass, or a byte offset
 * computed from `totalLength`), a guarantee `noUncheckedIndexedAccess` cannot see from the type
 * alone. One assertion here rather than one at every read.
 */
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see this function's own doc.
const at = (array: Uint8Array | Uint32Array, i: number): number => array[i]!;

/**
 * `data`'s 32-byte SHA-256 digest (FIPS 180-4), computed from scratch: this project ships zero
 * runtime dependencies, and neither Node nor a browser offers a synchronous digest primitive
 * this module could delegate to instead (`sha256Hex`'s own top note). Message schedule and
 * compression run per FIPS 180-4 §6.2 exactly, over one or more 64-byte blocks built by padding
 * `data` per §5.1.1 (a `1` bit, `0` bits, then the 64-bit big-endian bit length).
 */
function sha256Digest(data: Uint8Array): Uint8Array {
  const h = SHA256_H0.slice();

  const bitLength = BigInt(data.length) * 8n;
  const withOneBit = data.length + 1;
  const mod = withOneBit % 64;
  const zeroPadding = mod <= 56 ? 56 - mod : 120 - mod;
  const totalLength = withOneBit + zeroPadding + 8;
  const padded = new Uint8Array(totalLength);
  padded.set(data);
  padded[data.length] = 0x80;
  for (let i = 0; i < 8; i += 1) {
    padded[totalLength - 1 - i] = Number((bitLength >> BigInt(8 * i)) & 0xffn);
  }

  const w = new Uint32Array(64);
  for (let block = 0; block < totalLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const o = block + i * 4;
      w[i] =
        (at(padded, o) << 24) |
        (at(padded, o + 1) << 16) |
        (at(padded, o + 2) << 8) |
        at(padded, o + 3);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = at(w, i - 15);
      const w2 = at(w, i - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) | 0;
    }

    let a = at(h, 0);
    let b = at(h, 1);
    let c = at(h, 2);
    let d = at(h, 3);
    let e = at(h, 4);
    let f = at(h, 5);
    let g = at(h, 6);
    let hh = at(h, 7);
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + at(SHA256_K, i) + at(w, i)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (at(h, 0) + a) | 0;
    h[1] = (at(h, 1) + b) | 0;
    h[2] = (at(h, 2) + c) | 0;
    h[3] = (at(h, 3) + d) | 0;
    h[4] = (at(h, 4) + e) | 0;
    h[5] = (at(h, 5) + f) | 0;
    h[6] = (at(h, 6) + g) | 0;
    h[7] = (at(h, 7) + hh) | 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const word = at(h, i);
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
  return out;
}

/**
 * The lowercase-hex SHA-256 over every byte from {@link contentStart} to the end -- the
 * synchronous entry point every registration path in this library uses (`config.ts`'s own
 * `resolveSchema`/`preload`), since neither can await a digest and this module's own
 * {@link sha256Digest} does not need to.
 */
export function sha256HexSync(document: Uint8Array): string {
  const start = contentStart(document);
  return toHex(sha256Digest(document.subarray(start)));
}

/**
 * {@link sha256HexSync}, wrapped in an already-resolved `Promise` -- kept `async`-shaped only
 * for the callers this module already had before a synchronous digest existed
 * ({@link verifyContentHash}, and the public re-export `identity/index.ts` makes of this
 * function). Prefer {@link sha256HexSync} in new code; there is no `crypto.subtle` I/O left
 * here to actually await.
 */
export function sha256Hex(document: Uint8Array): Promise<string> {
  return Promise.resolve(sha256HexSync(document));
}

const FULL_LOWERCASE_HEX = /^[0-9a-f]{64}$/u;

/**
 * The `sha256` content-hash pin declared on a reference URI's query (`?sha256=<hex>`), or
 * `undefined` if the URI carries no query. Per [TSON-DATA] §2.2.1 a content-address query may
 * contain *only* recognised hash-algorithm parameters, and the value is full-length (64)
 * lowercase hex.
 *
 * @throws TsonSchemaValidationError if the query carries an unrecognised parameter name or a
 *   malformed `sha256` value (never silently retained).
 */
export function declaredSha256(uri: string): string | undefined {
  const q = uri.indexOf('?');
  if (q < 0 || q === uri.length - 1) {
    return undefined;
  }
  let sha256: string | undefined;
  for (const param of uri.slice(q + 1).split('&')) {
    const eq = param.indexOf('=');
    const name = eq < 0 ? param : param.slice(0, eq);
    if (name !== 'sha256') {
      throw new TsonSchemaValidationError(
        `unrecognized query parameter '${name}' in "${uri}" -- a content-address query may ` +
          'contain only hash-algorithm parameters ([TSON-DATA] §2.2.1)',
      );
    }
    const value = eq < 0 ? '' : param.slice(eq + 1);
    if (!FULL_LOWERCASE_HEX.test(value)) {
      throw new TsonSchemaValidationError(
        `malformed sha256 pin "${value}" in "${uri}" -- expected 64 lowercase hex digits ` +
          '([TSON-DATA] §2.2.1)',
      );
    }
    sha256 = value;
  }
  return sha256;
}

/**
 * Verifies `content` against the `sha256` pin declared on `referenceUri`, if any — the
 * [TSON-DATA] §2.2.1 rule that a consumer holding a hashed reference MUST verify before use and
 * MUST NOT use mismatched content. A reference with no pin is a no-op (resolves unverified).
 *
 * @throws TsonContentHashMismatchError if a pin is declared and the content's hash differs from it.
 */
export async function verifyContentHash(content: Uint8Array, referenceUri: string): Promise<void> {
  const declared = declaredSha256(referenceUri);
  if (declared === undefined) {
    return;
  }
  const actual = await sha256Hex(content);
  if (actual !== declared) {
    throw new TsonContentHashMismatchError(referenceUri, declared, actual);
  }
}
/**
 * `reference` with its `sha256` content-hash parameter set to `hex` — the pinning half of
 * [TSON-DATA] §2.2.1, and the inverse of {@link declaredSha256}. Any existing `sha256` parameter
 * is replaced; every other query parameter is left untouched and in place, because a reference
 * that already carries one is not this function's to rewrite.
 *
 * The result is exactly what {@link verifyContentHash} then checks: pinning and verifying are
 * the two ends of one mechanism, so they live in one module rather than being re-derived by
 * every tool that wants to stamp a hash onto an id it just computed.
 */
export function withSha256Pin(reference: string, hex: string): string {
  if (!FULL_LOWERCASE_HEX.test(hex)) {
    throw new TsonSchemaValidationError(
      `'${hex}' is not a content hash -- expected 64 lowercase hex digits ([TSON-DATA] §2.2.1)`,
    );
  }
  const q = reference.indexOf('?');
  if (q < 0) {
    return `${reference}?sha256=${hex}`;
  }
  const params = reference
    .slice(q + 1)
    .split('&')
    .filter((param) => param !== '' && !param.startsWith('sha256='));
  params.push(`sha256=${hex}`);
  return `${reference.slice(0, q)}?${params.join('&')}`;
}
