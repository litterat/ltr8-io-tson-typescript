/**
 * Parses and validates against meta-kernel's `uuid_type` constructor (§5.5's `!uuid` atom, RFC
 * 9562) -- the port of `atom/UuidParser.java`. A pure format check (§5.2: "the remaining atoms
 * are pure format checks") unless `version` is set, which no built-in instance does -- `uuid =>
 * !uuid_type {}` in core.tn is fully unconstrained.
 *
 * **Validates the token's canonical shape itself, exactly as `UuidParser.java` does, for the
 * same documented reason** (`CONFORMANCE.md`): `UUID.fromString` is materially more lenient than
 * RFC 9562's canonical 8-4-4-4-12 grouping -- `UUID.fromString("1-2-3-4-5")` succeeds, silently
 * reinterpreting where the groups fall, and a group one hex digit short still parses the same
 * way. This port has no host UUID parser to be lenient in the first place, but the shape check
 * still matters on its own terms: it is what makes "one hex digit short" a parse failure instead
 * of a byte sequence quietly built from the wrong digit boundaries.
 *
 * **Host value is {@link Uuid}'s raw 16 bytes**, so any of RFC 9562's versions/variants
 * round-trips losslessly with no version/variant interpretation baked into the shape itself --
 * `version` is read out of the bytes only when a constraint asks for it.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { UuidType } from '../../schema/meta/atoms-text.js';
import type { Uuid } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_F = 0x46;
const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_F = 0x66;
const ASCII_HYPHEN = 0x2d;

/** RFC 9562's canonical grouping -- 8-4-4-4-12 hex digits, hyphen-separated. */
const GROUP_LENGTHS: readonly number[] = [8, 4, 4, 4, 12];

function isHexDigitCode(code: number): boolean {
  return (
    (code >= ASCII_ZERO && code <= ASCII_NINE) ||
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_F) ||
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_F)
  );
}

/**
 * The 16 decoded bytes, or `undefined` if `text` is not exactly RFC 9562's canonical 8-4-4-4-12
 * hex-and-hyphen grouping -- no shorter or longer group, no missing or extra hyphen, nothing
 * trailing. Walking the fixed group lengths directly (rather than splitting on `-` first) is what
 * catches a short last group without silently reinterpreting where the groups fall, the exact
 * leniency `UUID.fromString` has that this shape check exists to shut out.
 */
function tryParseUuidBytes(text: string): Uint8Array | undefined {
  let pos = 0;
  const hexGroups: string[] = [];
  for (const length of GROUP_LENGTHS) {
    if (hexGroups.length > 0) {
      if (text.charCodeAt(pos) !== ASCII_HYPHEN) return undefined;
      pos += 1;
    }
    if (pos + length > text.length) return undefined;
    for (let i = 0; i < length; i++) {
      if (!isHexDigitCode(text.charCodeAt(pos + i))) return undefined;
    }
    hexGroups.push(text.slice(pos, pos + length));
    pos += length;
  }
  if (pos !== text.length) return undefined;

  const hex = hexGroups.join('');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The version nibble -- the high nibble of byte 6 (RFC 9562's `ver` field, the first hex digit of
 * the third hyphen-separated group) -- matching `UUID.version()`'s own `(mostSigBits >> 12) &
 * 0x0f`, the same bit position expressed against the 64-bit `mostSigBits` the JDK type stores.
 */
function versionOf(bytes: Uint8Array): number {
  const byte6 = bytes.at(6) ?? 0; // unreachable: `bytes` is always this module's own 16-byte parse
  return (byte6 >> 4) & 0xf;
}

function toLowercaseHexPair(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** `read`'s inverse: RFC 9562's canonical 8-4-4-4-12 form, always lowercase (matching
 * `UUID#toString()`'s own canonical spelling, regardless of which case the token was read in). */
export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, toLowercaseHexPair).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds the `AtomType` for one fully-parameterised `uuid_type` instance. `typeRef` names the
 * type for error reporting, e.g. `'uuid'` for §5.5's unconstrained `uuid => !uuid_type {}`.
 */
export function createUuidParser(typeRef: string, constraints: UuidType): AtomType<Uuid> {
  function read(token: AtomToken): Uuid {
    const text = token.text;
    const bytes = tryParseUuidBytes(text);
    if (bytes === undefined) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid UUID -- expected RFC 9562's 8-4-4-4-12 hex-and-hyphen form (§5.5)`,
        'a UUID',
      );
    }
    if (constraints.version !== undefined) {
      const version = versionOf(bytes);
      if (version !== constraints.version) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is version ${String(version)}, expected version ${String(constraints.version)}`,
          `version ${String(constraints.version)}`,
        );
      }
    }
    return { bytes };
  }

  function write(value: Uuid): string {
    return formatUuid(value.bytes);
  }

  return { read, write };
}
