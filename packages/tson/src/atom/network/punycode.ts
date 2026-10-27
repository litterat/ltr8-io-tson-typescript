/**
 * RFC 3492's Punycode with IDNA's parameters (§5): the bootstring encoding an A-label carries its
 * U-label in. Pure arithmetic over code points, with no table. Neither direction applies IDNA's
 * rules -- `xn--`, validity, case -- which are `hostName.ts`'s. Basic code points are copied as
 * given, so a caller folds case before decoding.
 *
 * Both directions return `undefined` rather than throwing where the arithmetic overflows (RFC
 * 3492 §6.4) or the input is not Punycode. The arithmetic is held to the 31-bit bound the
 * reference implementation's `int` arithmetic gives it, so the same labels overflow at both.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;
const MAX_CODE_POINT = 0x10ffff;

/** RFC 3492 §6.1's bias adaptation. */
function adapt(deltaIn: number, numPoints: number, first: boolean): number {
  let delta = Math.floor(first ? deltaIn / DAMP : deltaIn / 2);
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) / 2) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

function digit(d: number): string {
  return String.fromCharCode(d < 26 ? 0x61 + d : 0x30 + d - 26);
}

function digitValue(code: number): number {
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  return -1;
}

function threshold(k: number, bias: number): number {
  if (k <= bias) return T_MIN;
  return Math.min(k - bias, T_MAX);
}

/** `text`'s Punycode, or `undefined` where the arithmetic overflows (RFC 3492 §6.4). */
export function punycodeEncode(text: string): string | undefined {
  const input = Array.from(text, (c) => c.codePointAt(0) ?? 0);
  let output = '';
  for (const codePoint of input) {
    if (codePoint < 0x80) output += String.fromCharCode(codePoint);
  }
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < input.length) {
    let m = MAX_INT;
    for (const codePoint of input) {
      if (codePoint >= n && codePoint < m) m = codePoint;
    }
    if ((m - n) * (handled + 1) > MAX_INT - delta) return undefined;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const codePoint of input) {
      if (codePoint < n) {
        delta += 1;
        if (delta > MAX_INT) return undefined;
      }
      if (codePoint === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = threshold(k, bias);
          if (q < t) break;
          output += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digit(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return output;
}

/**
 * The text `encoded` decodes to, or `undefined` where it is not Punycode: a non-basic code point
 * before the last delimiter, a character that is not a digit after it, a truncated integer, or
 * overflow.
 */
export function punycodeDecode(encoded: string): string | undefined {
  const delimiter = encoded.lastIndexOf('-');
  const result: number[] = [];
  for (let i = 0; i < Math.max(delimiter, 0); i++) {
    const code = encoded.charCodeAt(i);
    if (code >= 0x80) return undefined;
    result.push(code);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let read = delimiter > 0 ? delimiter + 1 : 0; read < encoded.length;) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (read >= encoded.length) return undefined;
      const value = digitValue(encoded.charCodeAt(read));
      read += 1;
      if (value < 0 || value > Math.floor((MAX_INT - i) / w)) return undefined;
      i += value * w;
      const t = threshold(k, bias);
      if (value < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return undefined;
      w *= BASE - t;
    }
    const length = result.length;
    bias = adapt(i - oldI, length + 1, oldI === 0);
    if (Math.floor(i / (length + 1)) > MAX_INT - n) return undefined;
    n += Math.floor(i / (length + 1));
    i %= length + 1;
    if (n > MAX_CODE_POINT || (n >= 0xd800 && n <= 0xdfff)) return undefined;
    result.splice(i, 0, n);
    i += 1;
  }
  let text = '';
  for (let start = 0; start < result.length; start += 4096) {
    text += String.fromCodePoint(...result.slice(start, start + 4096));
  }
  return text;
}
