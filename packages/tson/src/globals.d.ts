/**
 * Minimal ambient declarations for WHATWG Encoding globals.
 *
 * `TextEncoder` and `TextDecoder` are standard in both Node and browsers, but TypeScript ships
 * their declarations only in `lib.dom.d.ts`. This package deliberately does not include the DOM
 * lib — it must not accidentally depend on `document`, `window`, or any other browser-only
 * global — and equally does not take `@types/node`, which would let a Node-only API compile in
 * code that has to run in a browser.
 *
 * Declaring the narrow surface actually used is the honest middle: it compiles everywhere the
 * package claims to run, and it fails to compile if someone reaches for something wider.
 *
 * Only `TextEncoder` is declared. Decoding is never done this way — the lexer decodes UTF-8
 * itself, byte by byte, because `TextDecoder` substitutes U+FFFD for malformed input by default
 * and throws without a byte offset when constructed with `{ fatal: true }`. §7.1 requires
 * malformed UTF-8 to be rejected, at a position.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
  readonly encoding: string;
}
