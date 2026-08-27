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
 * **Why this is the one async surface in `link/`.** SHA-256 has no synchronous host API in either
 * Node or a browser — `crypto.subtle.digest` is Promise-returning by design, and neither runtime
 * offers a synchronous alternative worth depending on. `sha256Hex`/`verifyContentHash` are
 * therefore the only two `async` exports anywhere in this directory; every other `link/` module
 * (`identity.ts`, `subtypes.ts`, `disjointness.ts`, `referenceValidation.ts`, `link.ts`) stays
 * ordinary synchronous code, and `link.ts` never awaits a hash mid-link — hashing is a fetch-time
 * concern (verify what a loader retrieved before handing it to `link()`), not a linking one. This
 * is deliberately *not* `Task<T>`: `Task` exists for a suspension the caller's own input supply
 * resumes (`yield*` through a byte source that may starve), which content hashing never does —
 * `crypto.subtle` is the platform's own async primitive and composes with `await` directly.
 */
import { TsonContentHashMismatchError, TsonSchemaValidationError } from '../core/errors.js';

/**
 * The one sliver of the Web Crypto API this module needs. Declared locally rather than pulled in
 * via the `dom`/`webworker` lib (`CLAUDE.md`'s hard constraint: no `DOM` lib in this project's
 * type configuration) — `crypto.subtle` is a real global in Node 24 and in every browser, `tsc`
 * simply has no ambient type for it without one of those libs, and a scoped `declare const` here
 * costs nothing outside this file.
 */
declare const crypto: {
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
};

const BOM = [0xef, 0xbb, 0xbf];

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

/**
 * The lowercase-hex SHA-256 over every byte from {@link contentStart} to the end, via
 * `crypto.subtle` — present as a global in Node 24 and in every browser, so this needs no
 * runtime dependency and no platform-conditional export.
 */
export async function sha256Hex(document: Uint8Array): Promise<string> {
  const start = contentStart(document);
  // `crypto.subtle.digest` requires an ArrayBuffer-backed view; `subarray` shares the same
  // underlying buffer rather than copying, so this stays a view, not an allocation.
  const digest = await crypto.subtle.digest('SHA-256', document.subarray(start));
  return toHex(new Uint8Array(digest));
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
