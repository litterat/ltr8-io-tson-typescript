/**
 * UTS #39 identifier-hygiene data ([TSON-DATA] §7.7 rule 2, §8.2): `Identifier_Status`, the
 * `Script` partition, and the `Joining_Type`/`Canonical_Combining_Class`/
 * `Indic_Syllabic_Category` tables the joining-control contexts need, generated from Unicode
 * 16.0.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with `npm run gen:uts39`.
 *
 * `Identifier_Status` and the joining-control property tables are extracted **verbatim** from
 * the pinned Java reference implementation (`IdentifierStatus.java`, `JoiningControls.java`),
 * because none of `Identifier_Status`, `Joining_Type`, `Canonical_Combining_Class`, or
 * `Indic_Syllabic_Category` has an ECMAScript `\p{...}` property escape — deriving from the
 * pinned reference is what guarantees this port and the Java return identical verdicts on the
 * same document. `Script` and the four general-category helpers below do have a host escape and
 * are probed from it at generation time instead, the same way `xid.ts` derives `XID_Start`.
 *
 * {@link UTS39_VERSION} is what [TSON-DATA] §8.2 requires a name-hygiene refusal to name: UTS #39
 * carries no version of its own independent of the UCD release its data files ship with, so
 * naming the UCD version names the data version.
 */

/** The Unicode Character Database release every table in this file was computed against. */
export const UTS39_VERSION = '16.0';

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

/** Expands a delta-varint encoded range table into a flat array of inclusive `[start, end]` pairs. */
function decodeTable(encoded: string): Uint32Array {
  const bytes = fromBase64(encoded);
  const bounds: number[] = [];
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

/**
 * Expands a delta-varint encoded table of `[start, end, id]` triples into three parallel flat
 * arrays. The Script partition covers every non-surrogate code point exactly once (verified at
 * generation time), which is what lets a lookup default to {@link SCRIPT_UNKNOWN} rather than
 * needing to represent "no entry" at all — the default only ever applies to a lone surrogate code
 * unit, which cannot occur in a well-formed document.
 */
function decodeScriptTable(encoded: string): {
  starts: Uint32Array;
  ends: Uint32Array;
  ids: Uint16Array;
} {
  const bytes = fromBase64(encoded);
  const starts: number[] = [];
  const ends: number[] = [];
  const ids: number[] = [];
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
    const start = previousEnd + 1 + readVarint();
    const end = start + readVarint();
    const id = readVarint();
    starts.push(start);
    ends.push(end);
    ids.push(id);
    previousEnd = end;
  }

  return {
    starts: Uint32Array.from(starts),
    ends: Uint32Array.from(ends),
    ids: Uint16Array.from(ids),
  };
}

/** Binary search over a decoded script table; {@link SCRIPT_UNKNOWN} for a code point outside every range. */
function scriptIdAt(
  table: { starts: Uint32Array; ends: Uint32Array; ids: Uint16Array },
  codePoint: number,
): number {
  let low = 0;
  let high = table.starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = table.starts[mid];
    const end = table.ends[mid];
    if (start === undefined || end === undefined) break;
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return table.ids[mid] ?? 163;
    }
  }
  return 163;
}

/** UTS #39 §3.1's Allowed set: 391 ranges, 820 bytes encoded. */
const IDENTIFIER_STATUS_ALLOWED = /* @__PURE__ */ decodeTable(
  'JwAFAQEKBhkEAAEZPAAIFgEeATkCCgIHATQQABABDQEcDwEFAgoDAQIjAgEGDSUAYQEvABMEAQYCAgEBBgAHBQQBAQEDAAIBCAACAC8ABQIIAAECAQABEwErLWMqdRAZBAEBJQIAByUDACkAGxoEBSsfARQKCQYCAQAEFAERATEBAA8BBxFQYb4BFwEFEQwFAAIUN0wBAQUBCAMCCQEGAQYBAgEHAgECFQEGAQADAwIIAgECAwgACAMCCwwAAgIBBQQBAhUBBgEAAgACAQIAAQQEAQICDgAJDgwCAQgBAgEVAQYBAQEEAgkBAgECAgAPAwIJCgUBAgEHAgECFQEGAQEBBAIHAwECAgcCBwIECQEAEAEBBQMCAQMDAQEAAQEDAQMCAwsEBAMCAQMCAAYADgkRCwECARYBCQEEAggBAgEDBwEGAAIBBAkQAAEBAQcBAgEWAQkBBAIIAQIBAwcBBgACAwIJAQIMAAEBAQcBAgEoAgYCAgEEBQMIAQQJCgUCAQEJAgUDCwEKAQgBAAIGAwAEBQEAAQYTAA4xAQYFDgEJJwEBAAEEARcBAAELAQkCBAEAAQYBCQQBIAAKABQJCwABAAYEAQMBAwEDAQMBAwELAQIEAQEABQYBAgEMAQMBAwEDAQMBAwELAQIJADlJBk0pAAUAAiAGAwICgAJIAQMCBgEAAQMCKAEDAiABAwIGAQABAwIOATgBAwJCAgIgD/AHIgICAQoCFwIAAQAEAAQAAwmmCSoCAsACmQEEAAFZBhUCBQIlAgUCBwEAAQABAAERAQABAAEAAQABAAEAAzQBBAEABQIBAgEAAQADAgMEBQIBBgEABQIBAgEAAQATAAgADQD/GQAFAFIWCQYBBgEGAQYBBgEGAQYBBqYEAjlVAgECAQFeBigBAHAfwAS/M0D/owH/DACXAQhoAAQABAEWABUKBQEBAAEEjQQXYRYDBYEBBQIFAgUJBgEGNwGYAaNX6kQBAQABAQoAAQABAQIC1zEAAQA3AbO5AQGtggEDDwAdAgIADgOYWx4GBeQCANAOBgEDAQEBDoEw380CILkgBt0BAoEtDrA6D+0EoiPKJgXfIA==',
);

/**
 * Whether `codePoint` is `Identifier_Status=Allowed` (UTS #39 §3.1) — [TSON-DATA] §8.2
 * mechanism 2. This narrows `XID_Continue` by removing the characters UTS #39 calls Obsolete,
 * Technical, Limited_Use and Exclusion: historic scripts, musical and technical notation, and
 * letters no modern orthography uses. It is per-character with no cross-script judgement in it —
 * it does not reject a mixed-script name such as `id_пользователя` — and it covers the joining
 * controls (ZWNJ, ZWJ) without a special case: both are Restricted here, so a caller needs no
 * hand-picked exclusion for them,
 * and what admits them where they do shaping work is the contextual rule in
 * {@link "./joining-controls.js"} rather than this predicate.
 *
 * This is the *name* profile's rule, not the token profile's: an unquoted value in a historic
 * script stays legal, because a value's content is its own.
 */
export function identifierStatusAllowed(codePoint: number): boolean {
  return contains(IDENTIFIER_STATUS_ALLOWED, codePoint);
}

/** 171 scripts, 1708 ranges, 6085 bytes encoded. */
const SCRIPT_TABLE = /* @__PURE__ */ decodeScriptTable(
  'AEAYABlJAAUYABlJAC4YAABJAA4YAABJAAQYABZJAAAYAB5JAAAYAMADSQAmGAAESQAEGAABDAATGABvOQADLAAAGAACLAABowEAAywAABgAACwAA6MBAAAsAAAYAAAsAAAYAAIsAACjAQAALAAAowEAEywAAKMBAD4sAA0ZAA8sAIQBHQABOQCoAR0AAKMBACUEAAGjAQAxBAABowEAAgQAAKMBADY2AAejAQAaNgADowEABTYACqMBAAQDAAAYAAUDAAAYAA0DAAAYAAIDAAAYAB8DAAAYAAkDAAo5ABkDAAA5AGsDAAAYACEDAA2PAQAAowEAO48BAAGjAQACjwEALwMAMZoBAA2jAQA6aAABowEAAmgALYIBAAGjAQAOggEAAKMBABtUAAGjAQAAVAAAowEACo8BAASjAQAeAwAAowEAAQMABKMBAEoDAAAYABwDAFAfAAM5AA4fAAEYABkfAAMKAACjAQAHCgABowEAAQoAAaMBABUKAACjAQAGCgAAowEAAAoAAqMBAAMKAAGjAQAICgABowEAAQoAAaMBAAMKAAejAQAACgADowEAAQoAAKMBAAQKAAGjAQAYCgABowEAAi8AAKMBAAUvAAOjAQABLwABowEAFS8AAKMBAAYvAACjAQABLwAAowEAAS8AAKMBAAEvAAGjAQAALwAAowEABC8AA6MBAAEvAAGjAQACLwACowEAAC8ABqMBAAMvAACjAQAALwAGowEAEC8ACaMBAAItAACjAQAILQAAowEAAi0AAKMBABUtAACjAQAGLQAAowEAAS0AAKMBAAQtAAGjAQAJLQAAowEAAi0AAKMBAAItAAGjAQAALQAOowEAAy0AAaMBAAstAAajAQAGLQAAowEAAncAAKMBAAd3AAGjAQABdwABowEAFXcAAKMBAAZ3AACjAQABdwAAowEABHcAAaMBAAh3AAGjAQABdwABowEAAncABqMBAAJ3AAOjAQABdwAAowEABHcAAaMBABF3AAmjAQABlgEAAKMBAAWWAQACowEAApYBAACjAQADlgEAAqMBAAGWAQAAowEAAJYBAACjAQABlgEAAqMBAAGWAQACowEAApYBAAKjAQALlgEAA6MBAASWAQACowEAApYBAACjAQADlgEAAaMBAACWAQAFowEAAJYBAA2jAQAUlgEABKMBAAyZAQAAowEAApkBAACjAQAWmQEAAKMBAA+ZAQABowEACJkBAACjAQACmQEAAKMBAAOZAQAGowEAAZkBAACjAQACmQEAAaMBAACZAQABowEAA5kBAAGjAQAJmQEABqMBAAiZAQAMPgAAowEAAj4AAKMBABY+AACjAQAJPgAAowEABD4AAaMBAAg+AACjAQACPgAAowEAAz4ABqMBAAE+AAWjAQABPgAAowEAAz4AAaMBAAk+AACjAQACPgALowEADFMAAKMBAAJTAACjAQAyUwAAowEAAlMAAKMBAAVTAAOjAQAPUwABowEAGVMAAKMBAAKIAQAAowEAEYgBAAKjAQAXiAEAAKMBAAiIAQAAowEAAIgBAAGjAQAGiAEAAqMBAACIAQADowEABYgBAACjAQAAiAEAAKMBAAeIAQAFowEACYgBAAGjAQACiAEAC6MBADmbAQADowEAABgAG5sBACSjAQABSAAAowEAAEgAAKMBAARIAACjAQAXSAAAowEAAEgAAKMBABZIAAGjAQAESAAAowEAAEgAAKMBAAZIAACjAQAJSAABowEAA0gAH6MBAEecAQAAowEAI5wBAAOjAQAmnAEAAKMBACOcAQAAowEADpwBAACjAQAGnAEAAxgAAZwBACSjAQCfAWIAJSgAAKMBAAAoAASjAQAAKAABowEAKigAABgAAygA/wEyAEgmAACjAQADJgABowEABiYAAKMBAAAmAACjAQADJgABowEAKCYAAKMBAAMmAAGjAQAgJgAAowEAAyYAAaMBAAYmAACjAQAAJgAAowEAAyYAAaMBAA4mAACjAQA4JgAAowEAAyYAAaMBAEImAAGjAQAfJgACowEAGSYABaMBAFUWAAGjAQAFFgABowEA/wQRABxrAAKjAQBKgQEAAhgACoEBAAajAQAVkAEACKMBAACQAQAUNAABGAAIowEAExAAC6MBAAyRAQAAowEAApEBAACjAQABkQEAC6MBAF1EAAGjAQAJRAAFowEACUQABaMBAAFfAAEYAABfAAAYABNfAAWjAQBYXwAGowEAKl8ABKMBAEURAAmjAQAeSwAAowEAC0sAA6MBAAtLAAOjAQAASwACowEAC0sAHZIBAAGjAQAEkgEACqMBACtmAAOjAQAZZgAFowEACmYAAqMBAAFmAB9EABsPAAGjAQABDwA+kwEAAKMBAByTAQABowEACpMBAAWjAQAJkwEABaMBAA2TAQABowEAHjkAMKMBAEwGAACjAQAxBgA/jAEAMwkAB6MBAAMJADdKAAKjAQAOSgACowEAAkoAL2wACh0ABKMBACooAAGjAQACKAAHjAEAB6MBAAI5AAAYAAw5AAAYAAY5AAMYAAA5AAUYAAA5AAIYAAE5AAAYAASjAQAlSQAELAAAHQAwSQAELAADSQAELAAMSQAAHQBFSQAALAA/OQD/AUkAFSwAAaMBAAUsAAGjAQAlLAABowEABSwAAaMBAAcsAACjAQAALAAAowEAACwAAKMBAAAsAACjAQAeLAABowEANCwAAKMBAA4sAACjAQANLAABowEABSwAAKMBABIsAAGjAQACLAAAowEACCwAAKMBAAsYAAE5AFYYAACjAQAKGAAASQABowEAChgAAEkADhgAAKMBAAxJAAKjAQAgGAAOowEAIDkADqMBACUYAAAsAAIYAAFJAAUYAABJABoYAABJABAYAChJAAIYAAOjAQCZBRgAFaMBAAoYABSjAQCfBxgA/wEOAPMEGAABowEAHxgAAKMBAGgYAF8pAB9JAHMZAASjAQAGGQAlKAAAowEAACgABKMBAAAoAAGjAQA3nQEABqMBAAGdAQANowEAAJ0BABYmAAijAQAGJgAAowEABiYAAKMBAAYmAACjAQAGJgAAowEABiYAAKMBAAYmAACjAQAGJgAAowEABiYAAKMBAB8dAF0YACGjAQAZMQAAowEAWDEAC6MBANUBMQAZowEAFBgAADEAABgAADEAGBgACDEAAzkAATIABxgAAzEAAxgAAKMBAFU3AAGjAQABOQABGAACNwAAGABZPwABGAACPwAEowEAKgwAAKMBAF0yAACjAQAPGAAfDAAlGAAIowEAABgADz8AHjIAAKMBAD8YAB4yAFAYAC4/AAAYAFc/AKcBGAC/MzEAPxgA/6MBMQCMCakBAAKjAQA2qQEACKMBAC9OAKsCpAEAE6MBAF8dAFcHAAejAQAhGABlSQACGABCSQABowEAAUkAAKMBAABJAACjAQAHSQAUowEADUkALI4BAAKjAQAJGAAFowEAN30AB6MBAEWDAQAHowEAC4MBAAWjAQAfHwAtQQAAGAAAQQAjgAEACqMBAACAAQAcMgACowEATTwAAKMBAAAYAAk8AAOjAQABPAAeYgAAowEANhUACKMBAA0VAAGjAQAJFQABowEAAxUAH2IAQpQBABejAQAElAEAFlkACaMBAAUmAAGjAQAFJgABowEABSYACKMBAAYmAACjAQAGJgAAowEAKkkAABgACEkAACwAA0kAARgAA6MBAE8WAC1ZAAGjAQAJWQAFowEAo1cyAAujAQAWMgADowEAMDIAg0KjAQDtAjEAAaMBAGkxACWjAQAGSQALowEABAQABKMBABk2AACjAQAENgAAowEAADYAAKMBAAE2AACjAQABNgAAowEACTYAcgMAD6MBAOoCAwABGABPAwABowEANQMABqMBAAADAB+jAQAPAwAPOQAJGAAFowEADTkAAR0AIhgAAKMBABIYAACjAQADGAADowEABAMAAKMBAIYBAwABowEAABgAAKMBAB8YABlJAAUYABlJAAoYAAk/AAAYACw/AAEYAB4yAAKjAQAFMgABowEABTIAAaMBAAUyAAGjAQACMgACowEABhgAAKMBAAYYAAmjAQAEGAABowEAC00AAKMBABlNAACjAQASTQAAowEAAU0AAKMBAA5NAAGjAQANTQAhowEAek0ABKMBAAIYAAOjAQAsGAACowEACBgATiwAAKMBAAwYAAKjAQAALAAuowEALBgAADkAgQGjAQAcTwACowEAMBIADqMBAAA5ABoYAAOjAQAjbwAIowEAAm8AGioABKMBACpxAASjAQAdogEAAKMBAACiAQAjcgADowEADXIAKaMBAE8eAC+FAQAdeQABowEACXkABaMBACN4AAOjAQAjeAADowEAJyQAB6MBADMTAAqjAQAAEwAKpQEAAKMBAA6lAQAAowEABqUBAACjAQABpQEAAKMBAAqlAQAAowEADqUBAACjAQAGpQEAAKMBAAGlAQACowEAM58BAAujAQC2AkwACKMBABVMAAmjAQAHTAAXowEABUkAAKMBAClJAACjAQAISQBEowEABRsAAaMBAAAbAACjAQArGwAAowEAARsAAqMBAAAbAAGjAQAAGwAVOAAAowEACDgAH3sAHmMAB6MBAAhjAC+jAQASNQAAowEAATUABKMBAAQ1ABt+AAKjAQAAfgAZUAAEowEAAFAAP6MBAB9cABdbAAOjAQATWwABowEALVsAA0IAAKMBAAFCAASjAQAHQgAAowEAAkIAAKMBABxCAAGjAQACQgADowEACUIABqMBAAhCAAajAQAfdAAfcAAfowEAJlUAA6MBAAtVAAijAQA1BQACowEABgUAFTsAAaMBAAc7ABI6AASjAQAHOgARfwAGowEAA38AC6MBAAZ/AE+jAQBIdQA2owEAMm4ADKMBADJuAAajAQAFbgAnMwAHowEACTMABaMBACUnAAKjAQAcJwAHowEAAScAzwGjAQAeAwAAowEAKagBAACjAQACqAEAAaMBAAGoAQAPowEAAgMANqMBAAMDACdzAAejAQApiQEAFaMBABl2ACWjAQAbFwATowEAFiUACKMBAE0NAAOjAQAjDQAIowEAAA0AQj0ACaMBAAA9AAGjAQAYigEABqMBAAmKAQAFowEANBQAAKMBABEUAAejAQAmUQAIowEAX4QBAACjAQATiAEACqMBABFFAACjAQAuRQA9owEABmEAAKMBAABhAACjAQADYQAAowEADmEAAKMBAAphAAWjAQA6RgAEowEACUYABaMBAAMrAACjAQAHKwABowEAASsAAaMBABUrAACjAQAGKwAAowEAASsAAKMBAAQrAACjAQAAOQAIKwABowEAASsAAaMBAAIrAAGjAQAAKwAFowEAACsABKMBAAYrAAGjAQAGKwACowEABCsACqMBAAmhAQAAowEAAKEBAAGjAQAAoQEAAKMBACWhAQAAowEACaEBAACjAQAAoQEAAaMBAAChAQAAowEAA6EBAACjAQAJoQEAAKMBAAGhAQAHowEAAaEBAByjAQBbZwAAowEABGcAHaMBAEeeAQAHowEACZ4BAKUBowEANYYBAAGjAQAlhgEAIaMBAEReAAqjAQAJXgAFowEADF8AEqMBADmVAQAFowEACZUBAAWjAQATYgAbowEAGgEAAaMBAA4BAAOjAQAWAQC4AaMBADshAGOjAQBSpwEAC6MBAACnAQAGIAABowEAACAAAaMBAAcgAACjAQABIAAAowEAHSAAAKMBAAEgAAGjAQALIAAIowEACSAARaMBAAdlAAGjAQAtZQABowEACmUAGqMBAEeqAQAHowEAUosBAAyjAQAPEQA4fAAGowEACR8AtQGjAQAhjQEADaMBAAmNAQAFowEACAsAAKMBACwLAACjAQANCwAJowEAHAsAAqMBAB9WAAGjAQAVVgAAowEADVYASKMBAAZXAACjAQABVwAAowEAK1cAAqMBAABXAACjAQABVwAAowEACFcAB6MBAAlXAAWjAQAFLgAAowEAAS4AAKMBACQuAACjAQABLgAAowEABS4ABqMBAAkuALUCowEAGFIABqMBABBAAACjAQAoQAACowEAHEAAVKMBAABOAA6jAQAxlgEADKMBAACWAQCZBxoAZaMBAG4aAACjAQAEGgAKowEAwwEaAMsUowEAYhwADKMBANUIIwAJowEAmh8jAASjAQDGBAIAuDWjAQA5MADFDaMBALgEBwAGowEAHmAAAKMBAAlgAAOjAQABYABOlwEAAKMBAAmXAQAFowEAHQgAAaMBAAUIAAmjAQBFegAJowEACXoAAKMBAAZ6AACjAQAUegAEowEAEnoArwOjAQA5RwDFAaMBAFpYAGSjAQBKXQADowEAOF0ABqMBABBdAD+jAQAAmAEAAGkAATEAAEMACqMBAAExAA2jAQD3L5gBAAejAQD/BZgBANUDQwAoowEAAEMACJgBAOZFowEAAz8AAKMBAAY/AACjAQABPwAAowEAAD8AngI3AAI/AA6jAQAANwAcowEAAjcAAaMBAAA/AA2jAQADPwAHowEAiwNpAIMSowEAaiIABKMBAAwiAAKjAQAIIgAGowEACSIAAaMBAAMiAAMYANseowEA+QEYAAWjAQCzAxgAS6MBAC05AAGjAQAWOQAIowEAcxgAO6MBAPUBGAAJowEAJhgAAaMBAD0YAAI5ABAYAAc5AAEYAAY5AB0YAAM5ADwYABSjAQBFLAB5owEAExgAC6MBABMYAAujAQBWGAAIowEAGBgAhgGjAQBUGAAAowEARhgAAKMBAAEYAAGjAQAAGAABowEAARgAAaMBAAMYAACjAQALGAAAowEAABgAAKMBAAYYAACjAQBAGAAAowEAAxgAAaMBAAcYAACjAQAGGAAAowEAGxgAAKMBAAMYAACjAQAEGAAAowEAABgAAqMBAAYYAACjAQDTAhgAAaMBAKMCGAABowEAMRgAiwWHAQAOowEABIcBAACjAQAOhwEAzwijAQAeSQAFowEABUkA1AGjAQAGKQAAowEAECkAAaMBAAYpAACjAQABKQAAowEABCkABKMBAD0dACCjAQAAHQBvowEALGoAAqMBAA1qAAGjAQAJagADowEAAWoAvwKjAQAeoAEAEKMBADmmAQAEowEAAKYBAM8DowEAKWQA1QGjAQAqbQADowEAAG0A3wOjAQAGJgAAowEAAyYAAKMBAAEmAACjAQAOJgAAowEAxAFaAAGjAQAPWgAoowEASwAAA6MBAAkAAAOjAQABAACQBqMBAEMYAEujAQA8GADBAaMBAAMDAACjAQAaAwAAowEAAQMAAKMBAAADAAGjAQAAAwAAowEACQMAAKMBAAMDAACjAQAAAwAAowEAAAMABaMBAAADAAOjAQAAAwAAowEAAAMAAKMBAAADAACjAQACAwAAowEAAQMAAKMBAAADAAGjAQAAAwAAowEAAAMAAKMBAAADAACjAQAAAwAAowEAAAMAAKMBAAEDAACjAQAAAwABowEAAwMAAKMBAAYDAACjAQADAwAAowEAAwMAAKMBAAADAACjAQAJAwAAowEAEAMABKMBAAIDAACjAQAEAwAAowEAEAMAM6MBAAEDAI0CowEAKxgAA6MBAGMYAAujAQAOGAABowEADhgAAKMBAA4YAACjAQAkGAAJowEArQEYADejAQAZGAAANwABGAAMowEAKxgAA6MBAAgYAAajAQABGAANowEABRgAmQGjAQDXBxgAA6MBABAYAAKjAQAMGAACowEAdhgAA6MBAF4YAAWjAQALGAADowEAABgADqMBAAsYAAOjAQA3GAAHowEACRgABaMBACcYAAejAQAdGAABowEACxgAA6MBAAEYAD2jAQDTAhgAC6MBAA0YAAGjAQAMGAACowEACRgABKMBADcYAAajAQAOGAABowEAChgABaMBAAgYAAajAQCSARgAAKMBAGUYAIUIowEA380CMQAfowEAuSAxAAWjAQDdATEAAaMBAIEtMQANowEAsDoxAA6jAQDtBDEAoROjAQCdBDEA4QujAQDKJjEABKMBAN8gMQDQuCujAQAAGAAdowEAXxgAf6MBAO8BOQCP/AujAQ==',
);

/**
 * An opaque id for one Unicode `Script` property value. Comparable by `===`; the only ids a
 * caller ever names are the ones the restriction-level and joining-control checks read by name
 * below — every other script still gets a distinct, stable-within-this-file id, which is all
 * "are these two characters the same script?" needs.
 */
export type ScriptId = number;

/** `Script=Common`. */
export const SCRIPT_COMMON: ScriptId = 24;

/** `Script=Inherited`. */
export const SCRIPT_INHERITED: ScriptId = 57;

/** `Script=Unknown`. */
export const SCRIPT_UNKNOWN: ScriptId = 163;

/** `Script=Latin`. */
export const SCRIPT_LATIN: ScriptId = 73;

/** `Script=Han`. */
export const SCRIPT_HAN: ScriptId = 49;

/** `Script=Hiragana`. */
export const SCRIPT_HIRAGANA: ScriptId = 55;

/** `Script=Katakana`. */
export const SCRIPT_KATAKANA: ScriptId = 63;

/** `Script=Bopomofo`. */
export const SCRIPT_BOPOMOFO: ScriptId = 12;

/** `Script=Hangul`. */
export const SCRIPT_HANGUL: ScriptId = 50;

/** `Script=Cyrillic`. */
export const SCRIPT_CYRILLIC: ScriptId = 29;

/** `Script=Greek`. */
export const SCRIPT_GREEK: ScriptId = 44;

/**
 * The `Script` property value of `codePoint` (UAX #24), as one of the ids above. Total over
 * every code point: a lone surrogate code unit — never producible from a well-formed document —
 * reads as {@link SCRIPT_UNKNOWN} rather than throwing.
 */
export function scriptOf(codePoint: number): ScriptId {
  return scriptIdAt(SCRIPT_TABLE, codePoint);
}

/** Joining_Type Dual_Joining or Left_Joining ($LJ): 76 ranges, 163 bytes encoded. */
const LEFT_JOINING = /* @__PURE__ */ decodeTable(
  'oAwABQABAAEEBAwBBgEBIwEIDxIlAQEJAAEAAQEoAgIAEgIFAwEIAQABAAEBHwoDDgIDAQACAgIFSiBWBAIAAQkBAAoAAQMCAB0AAgQSCQUBAgUBDr4eABhYDiEBAJWfAjLNxAEECAAFCQECCgORAQABAAMCAQEBAAIAHAHRAiEBAJ8DAWsCARAMAhwDAgsuAAEBBAACAQEBAQACAAUBtLIDQw==',
);

/** Joining_Type Dual_Joining or Right_Joining ($RJ): 48 ranges, 107 bytes encoded. */
const RIGHT_JOINING = /* @__PURE__ */ decodeTable(
  'oAwAAR0BCSMBAQIBXgEAGAEKAgIAEAABHR0ySiBVGAcAAQMBAwUSAwACBREMARq+HgAYWA4hAQCVnwIxzsQBBQEAAQEDCAEJAgAGBJABERcF0gIingMCaxQMAxsRLgABBAEHAQMEAbWyA0M=',
);

/** explicitly Joining_Type=Transparent beyond the General_Category default: 1 ranges, 4 bytes encoded. */
const TRANSPARENT_ADDED = /* @__PURE__ */ decodeTable('y9IHAA==');

/** explicitly not Joining_Type=Transparent where the General_Category default would say so: 9 ranges, 25 bytes encoded. */
const TRANSPARENT_REMOVED = /* @__PURE__ */ decodeTable('gAwF1wEAsgMBUACrHgD9DwFYA9PgAwAPAA==');

/** Canonical_Combining_Class=9 ($V): 58 ranges, 145 bytes encoded. */
const VIRAMA = /* @__PURE__ */ decodeTable(
  'zRIAfwB/AH8AfwB/AH8AfwBtARAAfABvAH8AyQEAtAEB2Q0BHgCdAQCNBQDjAQBlAUYBiyMAhvUBACUAlwEAjgEAbAC1AgD2AQDRvAEAhgwAKQAOADkAeQGLAQB0ALQBAGIAgAECcQB/APwBAH8AdgB0AI0CAIMCAaEBAFMAEgBRAKUDAIQCAVEAqQMB7IMBAA==',
);

/** Canonical_Combining_Class other than 0 ($M₁): 196 ranges, 447 bytes encoded. */
const NONZERO_COMBINING = /* @__PURE__ */ decodeTable(
  'gAZOAR+TAgSJAiwBAAEBAQEBAEgKMBQQAGUGAgUCAQEDIwAeGqABCAkAGAMBCAECAQQrAjsIKhcBHDwAEAADA2cAEAAwAD0AEABuABAAbgAQAH8AbgAQAAcBZQAQAG0BEAB8AG0CDQNsAg0DTAEbAAEAAQA3AQEABQMCAAECAQE+AHAAAQFSAM8FArQHAR4AnQEACgDLAQCPAQLbAQFHABQHAgAwDQEPZQAPACYINgE6AAsBQwCYAQIBDAEGBAAGAAMBxgE/0AUMBAADC/4XAo0BAGAfqgQFaQHU6wEABAkgAVABlAIAJQCXAQAbETkCJQBfAAwA7wEAAQICAQUBAQA0APYBALCeAQCBBg/NBwDiAQCVAQSSDQABACgCBAClAQG9BANBBL0CAVACRgoxA8ABACkADgA5AUUCMAE+AEwACQBqAbIBAVABEAAYBgMEWQJxAAMAFwBjAfsBAX4AdgFzAI0CAYICAQQAnAEAUwASAFEApQMAggIAAQFRAKkDAeyDAQDAEwQ7BrkJAayZAQDGKQQDBQgHAgYeA5QBArsbBgEQAgYBAQEEZACgAQb3AgA9A/wDA/4BAeAFBm0G',
);

/** Indic_Syllabic_Category=Vowel_Dependent ($D): 143 ranges, 309 bytes encoded. */
const VOWEL_DEPENDENT = /* @__PURE__ */ decodeTable(
  'uhIBAg4BAQUCCgFaBgIBAgEKAAoBWgQEAQIBcQcBAgEBFQFaBgIBAgEIAgoBWgQDAgECCgBmBgECAQIIAQsBWgYBAgECCAELAVoGAQIBAgoACgFrBQEAAQcSATwJBgUBAGgJAQAEBKwBDAIBqQEKIAMIAAQBCAMOAxUB9AwBHgEeAR4BQg8CANcCCBEAdRBWBEUSwQEOYAU9CDYG1ZcCACAEjQEOOwBHB2UIKABDCX0OLATzAQeWvAECAQEFAaoMDS0BOwgJAGQLEgFsDAsBAQBdBw0AngEIVQYCAQIBCgAKAVQIAQACAAECawxuDvABBgIDIAFSDAMAbAhqCoECCvkBBQEBmAEGAgMGABwJRgrTAwcBA3QEfAUDAAEBAQADAEYEAQEBAd4CAz0GAwLdgwELuRgH',
);

/** `Joining_Type` Dual_Joining or Left_Joining (`$LJ` in UTS #39 §3.1.1.1). */
export function isLeftJoining(codePoint: number): boolean {
  return contains(LEFT_JOINING, codePoint);
}

/** `Joining_Type` Dual_Joining or Right_Joining (`$RJ`). */
export function isRightJoining(codePoint: number): boolean {
  return contains(RIGHT_JOINING, codePoint);
}

/** Explicitly `Joining_Type=Transparent` where the `General_Category` default would not say so. */
export function isExplicitlyTransparent(codePoint: number): boolean {
  return contains(TRANSPARENT_ADDED, codePoint);
}

/** Explicitly not `Joining_Type=Transparent` where the `General_Category` default would say so. */
export function isExplicitlyNotTransparent(codePoint: number): boolean {
  return contains(TRANSPARENT_REMOVED, codePoint);
}

/** `Canonical_Combining_Class=9`, Virama (`$V`). */
export function isVirama(codePoint: number): boolean {
  return contains(VIRAMA, codePoint);
}

/** `Canonical_Combining_Class` other than 0 (`$M₁`). */
export function isNonzeroCombiningClass(codePoint: number): boolean {
  return contains(NONZERO_COMBINING, codePoint);
}

/** `Indic_Syllabic_Category=Vowel_Dependent` (`$D`). */
export function isVowelDependent(codePoint: number): boolean {
  return contains(VOWEL_DEPENDENT, codePoint);
}

/** non-spacing mark (Mn): 357 ranges, 767 bytes encoded. */
const GC_MN = /* @__PURE__ */ decodeTable(
  'gAZvkwIEiQIsAQABAQEBAQBICjAUEABlBgIFAgEBAyMAHhpbCjoICQAYAwEIAQIBBCsCOwgqFwEfNwABAAQHBAADBgoBHQA6AAQDCAAUARoAAgE5AAQBBAECAgMAHgEDAAsBOQAEBAEBBAAUARYFAQA6AAIAAQMIAAcBCwEeAD0ADAAyAAMANwABAgUCAQMHAQsBHQA6AAIABgAFARQBHAE5AQQDCAAUAR0ASAAHAgEAWgACBgwHYgACCAsGSQEbAAEAAQA3DQEEAQEFCgEjCQBmAwEFAQECARkBBAIQAw0AAgEGAA8AvwUCsgcCHQEeAR4BQAEBBggAAgoJAC0CAQB1ASIAdgIEAQkABgLbAQECADoAAQYBAAEAAgcGCQIAMA0BDzEDMAABBAEABQAoCAwBIAMCAQECOAABAQMAAQI6BwIBmAECAQwBBgQABgADAcYBP9AFDAQAAwv+FwKNAQBgH6oEA2sB1OsBAAQJIAFQAZACAAMABAAZAQUAlwEBGhENACYHGQouAjAAAgMCAScAQwUCAQIBDAAIAC8AMwABAgIBBQEBACoBCADuAQACAAQAsJ4BAOEFDxAPzQcA4gEAlQEEhg0CAQEFAygCBAClAQG9BANBBL0CAU8DRgoxA3sANg4pAAIBCgIxAwIBBwA9AiQEAQc+AAwBNAgKAwIAXwICAAEBBgACAJ0BAAMHFQE5AQMAJQYDBEYFDQABAAEADgFVBwICAQAXAFQFAQAEAQEB7gEDBgEBARsBVQcCAAEBagABAAIFAQBlAAEAAgMBBIMCCAEBgAIBAQAEAJABAwIBBAAgCSgFAgMIAAkFAgIuDAEBlgMGAQUBAFIVAgYBAQEBegUDAAEBAQYBAEgBAwABANsCAQsBNAQFAAEAFwDlKQAGDshZCwMCwBMEOwaYCAA/A1EAuJkBAeEkLQIWoAQCEQcCBh4DlAECuw82BDEIAA4AFgQBDtAKBgEQAgYBAQEEZACgAQb3AgA9A/wDA/4BAeAFBm0Gta8w7wE=',
);

/** enclosing mark (Me): 5 ranges, 15 bytes encoded. */
const GC_ME = /* @__PURE__ */ decodeTable('iAkBtCwAngwDAQKLiwIC');

/** format (Cf): 21 ranges, 58 bytes encoded. */
const GC_CF = /* @__PURE__ */ decodeTable(
  'rQEA0goFFgDAAQAxAIADAVAAqx4A/A8EGgQxBAEJj70DAPkBAsEhAA8A4kYP4JACA88pB4bdMAAeXw==',
);

/** letter (L): 677 ranges, 1426 bytes encoded. */
const GC_LETTER = /* @__PURE__ */ decodeTable(
  'QRkGGS8ACgAEAAUWAR4ByQMECw4EBwABAIEBBAEBAgMBAAYAAQIBAAETAVIBigEIpQEBJQIABihHGgQDLSojAQFiAQAPAQcBCgICABAAAR0dWAsAGCAJAQQABRUEAAkAAwAXGAcKBRcBBREpOjUDABIABwkPDwQHAgECFQEGAQADAwMAEAANAQECDgEKAAgFBAECFQEGAQEBAQEBHwMBABMCEAgBAgEVAQYBAQEEAwASAA8BFwALBwIBAhUBBgEBAQQDAB4BAQIPABEAAQUDAgEDAwEBAAEBAwEDAgMLFgA0BwECARYBDwMAGgICAAIBHgAEBwECARYBCQEEAwAfAQEBDwERCAECASgCABAABQIIAhgFBREDFwEIAQACBjovAQEMBjoBAQABBAEXAQABCQEBCQACBAEAFQMgAD8HASMbBHMqFAAQBQQDAwADAQcCBAwMABElAQAFAAIqAcwCAQMCBgEAAQMCKAEDAiABAwIGAQABAwIOATgBAwJCJQ8QVQIFA+sEAhABGQVKBgcHEQ0SDhEODAECDzMjAAQAQ1gHBAIhAQAFRQoeMR0CBAsrBBk2Fgk0UgBdLhEHNh0NAQorGiMpAgojAgoFKgICKQMBBQEBAwAFvwFAlQICBQIlAgUCBwEAAQABAAEeAjQBBgEAAwIBBgMDAgUEDAUCAQZ0AA0AEAxlAAQAAgkBAAMEBgABAAEAAQMBCgIDBQQEADQB+xTkAQYDAwEMJQEABQACNwcAEBYJBgEGAQYBBgEGAQYBBgEGUADVAwEqBAUBBFUGAgFZAQMFKgFdER8wD4AEvzNAjK0BQy0CjAIDDwoBFC4QHgJFMQgCZgJCAgEBAAEHFQ8BAgEDARYdMw4xPgUDAAEBCxsKFhkcBy4cABAEAQkKBAEoFwIBBxQWAwADMQEAAwECBAIAAQAYAgIKBwIMBQIFAgUJBgEGASoBDQZyHaNXDBYEMIRC7QICaSYGDAQFAAEJAQwBBAEAAQEBAQFrIeoCEj8CNSgLdAQBhgEkGQYZC1gDBQIFAgUCAiMLARkBEgEBAQ4CDSJ6hQMcAzAvHw0TAQcGJQodAiMEBzCdARIjBCMEJwgzDAoBDgEGAQEBCgEOAQYBAQMzDLYCCRUKBxgFASkBCEUFAgABKwEBAwACFgoWCR5BEgEBChUKGUY3BgFAAA8DAQIBHCocAxwjBwEbGzUKFQoSDRFuSDcyDTINIyYbCRb6ASkGARACOxwKAAgVKhEuFBsWDDQ5AQIADSwgGBojHQACAAgiAwAMLw4DFQABACMRARgTAT8GAQABAwEOAQkHLiYHAgECFQEGAQEBBAMAEgAMBB4JAQACAAElAQAZAAEALDQSAxQCHi8UAQEAuAEuKQMkLxQAOyoNAEcaJQa5ASt0Px8HAgACBwEBARcPAAEAXgcCJhAAAQAcAAonBwAVAAstEwASSMcBIB8IASQRADEdcAYBAQElFQAZBQEBAR8OAMcCEg8AAQwBIXwAT5kH5gHDAcwUYA+vCBEFGZofBcYEuTUd4g24BAceEU4RHRIvEAMfFAUSsAMs0wE/gAFKBQBCDEABAQAc9y8I1QkpCedFAwEGAQEBogIPAB0CAgAOAwiLA4QSagUMAwgHCeYuVAFGAQECAAIBAgMBCwEAAQYBQAEDAgcBBgEbAQMBBAEAAwYB0wICGAEYAR4BGAEeARgBHgEYAR4BGAEHtA4eBgWFAj2SASwKBhAAwQIdEivkAxvkAR0CAO8DBgEDAQEBDgHEATtDBwC0CQMBGgEBAQACAAEJAQMBAAEABgAEAAEAAQABAgEBAQACAAEAAQABAAEAAQEBAAIDAQYBAwEDAQABCQEQBQIBBAEQxCLfzQIguSAG3QECgS0OsDoP7QSiE50E4gvKJgXfIA==',
);

/** General category `Mn`, non-spacing mark. */
export function isNonSpacingMark(codePoint: number): boolean {
  return contains(GC_MN, codePoint);
}

/** General category `Me`, enclosing mark. */
export function isEnclosingMark(codePoint: number): boolean {
  return contains(GC_ME, codePoint);
}

/** General category `Cf`, format. */
export function isFormatControl(codePoint: number): boolean {
  return contains(GC_CF, codePoint);
}

/** General category `L` (`Lu`/`Ll`/`Lt`/`Lm`/`Lo`), letter. */
export function isLetter(codePoint: number): boolean {
  return contains(GC_LETTER, codePoint);
}
