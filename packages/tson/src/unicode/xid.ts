/**
 * Unicode identifier tables, generated from Unicode 16.0.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with `npm run gen:unicode`.
 *
 * These exist so identifier validity is a property of the document, not of the host. A TSON
 * document's identity can be a hash of its bytes, so two runtimes disagreeing about whether an
 * identifier is well-formed would make the same bytes valid in one place and invalid in another.
 * Consulting the host's `\p{XID_Start}` at runtime would do exactly that.
 *
 * {@link UNICODE_VERSION} records the version these tables were derived from. A build whose host
 * disagrees is still correct — the tables, not the host, are authoritative — but the difference is
 * worth knowing about, which is why the constant is exported rather than hidden.
 */

/** The Unicode version {@link isXidStart}, {@link isXidContinue} and {@link isNd} describe. */
export const UNICODE_VERSION = '16.0';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a base64 string to bytes without `atob` or `Buffer`.
 *
 * The package declares no ambient host globals beyond what it already needs, and this runs in both
 * Node and browsers, so the decode is spelled out rather than delegated.
 */
function fromBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  // A character outside the alphabet reads as -1, which is also what an out-of-range index
  // yields here. Padding is the only such character these tables contain.
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

/** Expands a delta-varint encoded table into a flat array of inclusive `[start, end]` pairs. */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const bounds: number[] = [];
  let i = 0;
  let previousEnd = -1;

  // Running off the end of a well-formed table is impossible; treating it as a terminator rather
  // than asserting keeps the decode total, so a truncated table yields a short table instead of a
  // crash at module load.
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
    const start = previousEnd + 1 + gap;
    const end = start + width;
    bounds.push(start, end);
    previousEnd = end;
  }

  return Uint32Array.from(bounds);
}

/** Binary search over a flat `[start, end, start, end, ...]` array of inclusive ranges. */
function contains(table: Uint32Array, codePoint: number): boolean {
  let low = 0;
  let high = (table.length >> 1) - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = table[mid << 1];
    const end = table[(mid << 1) + 1];
    // Both indices are in bounds for any table this module decodes; the guard is what lets the
    // reads stay unasserted, and a missing bound can only mean "not in the table".
    if (start === undefined || end === undefined) return false;

    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** XID_Start: 684 ranges, 1439 bytes encoded. */
const XID_START = /* @__PURE__ */ decodeTable(
  'QRkGGS8ACgAEAAUWAR4ByQMECw4EBwABAIEBBAEBAwIBAAYAAQIBAAETAVIBigEIpQEBJQIABihHGgQDLSojAQFiAQAPAQcBCgICABAAAR0dWAsAGCAJAQQABRUEAAkAAwAXGAcKBRcBBREpOjUDABIABwkPDwQHAgECFQEGAQADAwMAEAANAQECDgEKAAgFBAECFQEGAQEBAQEBHwMBABMCEAgBAgEVAQYBAQEEAwASAA8BFwALBwIBAhUBBgEBAQQDAB4BAQIPABEAAQUDAgEDAwEBAAEBAwEDAgMLFgA0BwECARYBDwMAGgICAAIBHgAEBwECARYBCQEEAwAfAQEBDwERCAECASgCABAABQIIAhgFBREDFwEIAQACBjovAQANBjoBAQABBAEXAQABCQEACgACBAEAFQMgAD8HASMbBHMqFAAQBQQDAwADAQcCBAwMABElAQAFAAIqAcwCAQMCBgEAAQMCKAEDAiABAwIGAQABAwIOATgBAwJCJQ8QVQIFA+sEAhABGQVKAwoHEQ0SDhEODAECDzMjAAQAQ1gHKAEABUUKHjEdAgQLKwQZNhYJNFIAXS4RBzYdDQEKKxojKQIKIwIKBSoCAikDAQUBAQMABb8BQJUCAgUCJQIFAgcBAAEAAQABHgI0AQYBAAMCAQYDAwIFBAwFAgEGdAANABAMZQAEAAIJAQACBQYAAQABAAEPAgMFBAQAESj3FOQBBgMDAQwlAQAFAAI3BwAQFgkGAQYBBgEGAQYBBgEGAQamBAIZCAcEAgQEVQYCAVkBAwUqAV0RHzAPgAS/M0CMrQFDLQKMAgMPCgEULhAeAk8nCAJmAkICAQEAAQcVDwECAQMBFh0zDjE+BQMAAQELGwoWGRwHLhwAEAQBCQoEASgXAgEHFBYDAAMxAQADAQIEAgABABgCAgoHAgwFAgUCBQkGAQYBKgENBnIdo1cMFgQwhELtAgJpJgYMBAUAAQkBDAEEAQABAQEBAWshigEG2QESPwI1KAl3AAEAAwABAAEAAQABfSQZBhkLNwIeAwUCBQIFAgIjCwEZARIBAQEOAg0iekU0iwIcAzAvHw0dBSUKHQIjBAcBBCqdARIjBCMEJwgzDAoBDgEGAQEBCgEOAQYBAQMzDLYCCRUKBxgFASkBCEUFAgABKwEBAwACFgoWCR5BEgEBChUKGUY3BgFAAA8DAQIBHCocAxwjBwEbGzUKFQoSDRFuSDcyDTINIyYbCRb6ASkGARACOxwKAAgVKhEuFBsWDDQ5AQIADSwgGBojHQACAAgiAwAMLw4DFQABACMRARgTAT8GAQABAwEOAQkHLiYHAgECFQEGAQEBBAMAEgAMBB4JAQACAAElAQAZAAEALDQSAxQCHi8UAQEAuAEuKQMkLxQAOyoNAEcaJQa5ASt0Px8HAgACBwEBARcPAAEAXgcCJhAAAQAcAAonBwAVAAstEwASSMcBIB8IASQRADEdcAYBAQElFQAZBQEBAR8OAMcCEg8AAQwBIXwAT5kHZm4RwwHMFGAPrwgRBRmaHwXGBLk1HeINuAQHHhFOER0SLxADHxQFErADLNMBP4ABSgUAQgxAAQEAHPcvCNUJKQnnRQMBBgEBAaICDwAdAgIADgMIiwOEEmoFDAMIBwnmLlQBRgEBAgACAQIDAQsBAAEGAUABAwIHAQYBGwEDAQQBAAMGAdMCAhgBGAEeARgBHgEYAR4BGAEeARgBB7QOHgYFhQI9kgEsCgYQAMECHRIr5AMb5AEdAgDvAwYBAwEBAQ4BxAE7QwcAtAkDARoBAQEAAgABCQEDAQABAAYABAABAAEAAQIBAQEAAgABAAEAAQABAAEBAQACAwEGAQMBAwEAAQkBEAUCAQQBEMQi380CILkgBt0BAoEtDrA6D+0EohOdBOILyiYF3yA=',
);

/** XID_Continue: 800 ranges, 1679 bytes encoded. */
const XID_CONTINUE = /* @__PURE__ */ decodeTable(
  'MAkHGQQAARkvAAoAAQACAAUWAR4ByQMECw4EBwABABF0AQEDAgEABgQBAAETAVIBigEBBAKlAQElAgAGKAgsAQABAQEBAQAIGgQDHQoFSQRlAQcCCQESAgAQOgJkDjUEAAIAAi0SGwQKBRcBBQhKAYABAgkBEgEHAgECFQEGAQADAwIIAgECAwgABAEBBAILCgABAAICAQUEAQIVAQYBAQEBAQECAAEEBAECAgMABwMBAAcPCwIBCAECARUBBgEBAQQCCQECAQICAA8DAgkJBgECAQcCAQIVAQYBAQEEAggCAQICBwIEAQEEAgkBABABAQUDAgEDAwEBAAEBAwEDAgMLBAQDAgEDAgAGAA4JEAwBAgEWAQ8CCAECAQMHAQECAgACAwIJEAMBBwECARYBCQEEAggBAgEDBwEGAQEDAgkBAgwMAQIBMgECAQQFAwcEAgkKBQECAREDFwEIAQACBgMABAUBAAEHBgkCAQ05BQ4BCScBAQABBAEXAQABFgIEAQABBgEJAgMgABcBBgkLAAEAAQAECQEjBBMBEQEjCQA5SQZNAiUBAAUAAioBzAIBAwIGAQABAwIoAQMCIAEDAgYBAAEDAg4BOAEDAkICAgkIDg8QVQIFA+sEAhABGQVKAwoHFQkVCxMMDAECAQEMUwMABAECCSECAQoGWAcqBUUKHgELBAsKJwIECysEGQYKJRsEPgEcAgoGCQ0ACA0BDzFMAwkRCAxzDDcICQMwAgoFKgICEAIBJgWVBAIFAiUCBQIHAQABAAEAAR4CNAEGAQADAgEGAwMCBQQMBQIBBg8BMQETABwADQAQDDMMBAADCxEABAACCQEAAgUGAAEAAQABDwIDBQQEABEo9xTkAQYIDCUBAAUAAjcHAA8XCQYBBgEGAQYBBgEGAQYBBgEfhQQCGQ4BBAIEBFUCAQICAV4FKgFdER8wD4AEvzNAjK0BQy0CjAIDGxQvBAkBciUIAmYCQgIBAQABBxU1BAATMwxFCgkGFwMAATACIwwcA0AOCgYeATYJDQIJBhYDSBgCAg8CBAoFAgUCBQkGAQYBKgENBnoBAQIJBqNXDBYEMIRC7QICaSYGDAQFCwEMAQQBAAEBAQEBayGKAQbZARI/AjUoCQYPEA8DARgCIQABAAMAAQABAAEAAX0TCQcZBAABGQpZAwUCBQIFAgIjCwEZARIBAQEOAg0iekU0iAEAggEcAzAPAB8fDR0FKgUdAiMEBwEEKp0BAgkGIwQjBCcIMwwKAQ4BBgEBAQoBDgEGAQEDMwy2AgkVCgcYBQEpAQhFBQIAASsBAQMAAhYKFgkeQRIBAQoVChlGNwYBQAMBAQUHAQIBHAICBAAgHAMcIwcBHRk1ChUKEg0Rbkg3Mg0yDScICQYlAwQBFvoBKQEBAwEQAjcgCgAIIB8VKhQbFglGHw8JOwcADRgHCQY0AQkEAwgjAgAJRAQDAQwBACMRASQGAz4GAQABAwEOAQkHOgUJBgMBBwIBAhUBBgEBAQQBCQIBAgICAAYABQYCBgMECwkBAAIAASUBCQEAAgABAwEHDQEdSgUJBAMeRQEACAmmATUCCBcFIkADAAsJJjgHCQYTHBoCDgQJBga5ATplSRUHAgACBwEBAR0BAQIIDAlGBwItAgcBARs+CAAISQMAEkjHASAPCQYIASwBCA8JGB0CFQENSQYBAQErAwABAQEICAkGBQEBASQBAQEFBwm2AhYJEAEoAwQNClUAT5kHZm4RwwHMFGAPrwgQFQqaHwXGBLk1OcYNuAQHHgEJBk4BCQYdAgQLNgkDDAkJFAUSsAMsAwnGAT+AAUoEOAcQQAEBAQsBDvcvCNUJKQnnRQMBBgEBAaICDwAdAgIADgMIiwOEEmoFDAMIBwkDAdEgCYYELQIWngQEAwUIBwIGHgOUAQK7A1QBRgEBAgACAQIDAQsBAAEGAUABAwIHAQYBGwEDAQQBAAMGAdMCAhgBGAEeARgBHgEYAR4BGAEeARgBBwIxgAQ2BDEIAA4AFgQBDtAIHgYF1QEGARACBgEBAQQFPSEAcCwDDQIJBADBAh4ROdYDKdYBKuUDBgEDAQEBDgHEAQsGKUsECaYJAwEaAQEBAAIAAQkBAwEAAQAGAAQAAQABAAECAQEBAAIAAQABAAEAAQABAQEAAgMBBgEDAQMBAAEJARAFAgEEARC0GgmGCN/NAiC5IAbdAQKBLQ6wOg/tBKITnQTiC8omBd8g0Lor7wE=',
);

/** Nd: 71 ranges, 186 bytes encoded. */
const DECIMAL_DIGIT = /* @__PURE__ */ decodeTable(
  'MAmmDAmGAQnGAQmcAwl2CXYJdgl2CXYJdgl2CXYJdglgCXYJRgmWAglGCcYOCSYJrAIJgAEJpgEJBgm2AQlWCYYBCQYJxpMCCaYFCSYJxgEJFglWCZYDCZamAQmGCwmGEQkGCZwGCYABCTwJkAEJlgIJ1gIJdgn2AglmCQYTTAmmAwlmCZYFCVYJ9gEJRgmmAwnWgwEJphIJVgmGAQmWBAn2vgEJ1BUxwBIJpgMJ9gMJ9wEJ1QYJliUJ',
);

const ASCII_LIMIT = 0x80;
const ASCII_XID_START = 1;
const ASCII_XID_CONTINUE = 2;
const ASCII_ND = 4;

/**
 * Membership for the ASCII range as a bitmask per code point.
 *
 * Almost every identifier in almost every document is ASCII, and this is the lexer's hottest loop.
 * Built from the tables above rather than written out, so it cannot drift from them.
 */
const ASCII = /* @__PURE__ */ (() => {
  const flags = new Uint8Array(ASCII_LIMIT);
  for (let cp = 0; cp < ASCII_LIMIT; cp++) {
    let mask = 0;
    if (contains(XID_START, cp)) mask |= ASCII_XID_START;
    if (contains(XID_CONTINUE, cp)) mask |= ASCII_XID_CONTINUE;
    if (contains(DECIMAL_DIGIT, cp)) mask |= ASCII_ND;
    flags[cp] = mask;
  }
  return flags;
})();

function asciiHas(codePoint: number, flag: number): boolean {
  return ((ASCII[codePoint] ?? 0) & flag) !== 0;
}

/** Whether `codePoint` may start an identifier (UAX #31 `XID_Start`). */
export function isXidStart(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT
    ? asciiHas(codePoint, ASCII_XID_START)
    : contains(XID_START, codePoint);
}

/** Whether `codePoint` may continue an identifier (UAX #31 `XID_Continue`). */
export function isXidContinue(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT
    ? asciiHas(codePoint, ASCII_XID_CONTINUE)
    : contains(XID_CONTINUE, codePoint);
}

/**
 * Whether `codePoint` is in general category `Nd`, decimal number.
 *
 * This is the Unicode category, not the ASCII digits: §7.5's unquoted-token profile admits any
 * `Nd` as an identifier start. The number grammar's digits are ASCII-only and are matched there
 * by code, not by this table.
 */
export function isNd(codePoint: number): boolean {
  return codePoint < ASCII_LIMIT
    ? asciiHas(codePoint, ASCII_ND)
    : contains(DECIMAL_DIGIT, codePoint);
}
