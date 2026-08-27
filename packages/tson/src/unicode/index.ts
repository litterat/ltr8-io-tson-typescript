/**
 * Unicode support for the lexer: identifier tables, the unquoted-token profile built on them,
 * NFC checking, and whitespace classification. Internal to the package — not part of the public
 * subpath surface in `package.json`'s `exports` — but consolidated into one barrel so `lexer/`
 * and `base/` import one path instead of reaching into each file individually.
 */
export * from './xid.js';
export * from './token-profile.js';
export * from './nfc.js';
export * from './whitespace.js';
