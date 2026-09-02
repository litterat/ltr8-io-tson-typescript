import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  contentStart,
  declaredSha256,
  sha256Hex,
  verifyContentHash,
  withSha256Pin,
} from '../src/link/contentHash.js';
import { TsonContentHashMismatchError, TsonSchemaValidationError } from '../src/core/errors.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('contentStart (§2.2.1)', () => {
  it('starts after the first LF', () => {
    const doc = bytes('!!id:"x"\nrest');
    expect(contentStart(doc)).toBe(9);
  });

  it('starts after CR LF, not after the bare CR', () => {
    const doc = bytes('!!id:"x"\r\nrest');
    expect(contentStart(doc)).toBe(10);
  });

  it('starts after a bare CR with no following LF', () => {
    const doc = bytes('!!id:"x"\rrest');
    expect(contentStart(doc)).toBe(9);
  });

  it('skips a leading UTF-8 BOM before scanning for the terminator', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('!!id:"x"\nrest')]);
    expect(contentStart(withBom)).toBe(3 + 9);
  });

  it('recognises NEL (U+0085) as a line terminator', () => {
    const doc = new Uint8Array([...bytes('!!id:"x"'), 0xc2, 0x85, ...bytes('rest')]);
    expect(contentStart(doc)).toBe(8 + 2);
  });

  it('recognises LS (U+2028) and PS (U+2029) as line terminators', () => {
    const ls = new Uint8Array([...bytes('!!id:"x"'), 0xe2, 0x80, 0xa8, ...bytes('rest')]);
    expect(contentStart(ls)).toBe(8 + 3);
    const ps = new Uint8Array([...bytes('!!id:"x"'), 0xe2, 0x80, 0xa9, ...bytes('rest')]);
    expect(contentStart(ps)).toBe(8 + 3);
  });

  it('throws when the first line has no terminator at all', () => {
    expect(() => contentStart(bytes('!!id:"x" with no newline'))).toThrow(
      TsonSchemaValidationError,
    );
  });
});

describe('sha256Hex', () => {
  it('hashes only the bytes past the first line, matching a cross-check via node:crypto', async () => {
    const doc = bytes('!!id:"https://example.com/s.tn"\n{ a: 1 }');
    const contentOnly = doc.subarray(contentStart(doc));
    const expected = createHash('sha256').update(contentOnly).digest('hex');
    expect(await sha256Hex(doc)).toBe(expected);
  });

  it('produces 64 lowercase hex characters', async () => {
    const hash = await sha256Hex(bytes('!!id:"x"\nbody'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('declaredSha256', () => {
  it('is undefined with no query at all', () => {
    expect(declaredSha256('https://tson.io/x.tn')).toBeUndefined();
  });

  it('reads a well-formed sha256 pin', () => {
    const hash = 'a'.repeat(64);
    expect(declaredSha256(`https://tson.io/x.tn?sha256=${hash}`)).toBe(hash);
  });

  it('rejects a query parameter that is not sha256', () => {
    expect(() => declaredSha256('https://tson.io/x.tn?sha512=' + 'a'.repeat(64))).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects a pin that is not 64 lowercase hex characters', () => {
    expect(() => declaredSha256('https://tson.io/x.tn?sha256=deadBEEF')).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => declaredSha256('https://tson.io/x.tn?sha256=abc')).toThrow(
      TsonSchemaValidationError,
    );
  });
});

describe('verifyContentHash', () => {
  it('is a no-op when the reference carries no pin', async () => {
    await expect(
      verifyContentHash(bytes('!!id:"x"\nbody'), 'https://tson.io/x.tn'),
    ).resolves.toBeUndefined();
  });

  it('resolves silently when the pin matches', async () => {
    const doc = bytes('!!id:"x"\nbody');
    const actual = await sha256Hex(doc);
    await expect(
      verifyContentHash(doc, `https://tson.io/x.tn?sha256=${actual}`),
    ).resolves.toBeUndefined();
  });

  it('throws TsonContentHashMismatchError when the pin does not match', async () => {
    const doc = bytes('!!id:"x"\nbody');
    const wrong = '0'.repeat(64);
    await expect(
      verifyContentHash(doc, `https://tson.io/x.tn?sha256=${wrong}`),
    ).rejects.toBeInstanceOf(TsonContentHashMismatchError);
  });
});

describe('withSha256Pin (§2.2.1)', () => {
  const HEX = 'ab'.repeat(32);

  it('appends the query when the reference carries none', () => {
    expect(withSha256Pin('https://example.com/s.tn', HEX)).toBe(
      `https://example.com/s.tn?sha256=${HEX}`,
    );
  });

  it('replaces an existing sha256 and keeps every other parameter in place', () => {
    expect(withSha256Pin(`https://example.com/s.tn?a=1&sha256=${'cd'.repeat(32)}&b=2`, HEX)).toBe(
      `https://example.com/s.tn?a=1&b=2&sha256=${HEX}`,
    );
  });

  it('round-trips through declaredSha256, which is the point of the pair', () => {
    expect(declaredSha256(withSha256Pin('https://example.com/s.tn', HEX))).toBe(HEX);
  });

  it('refuses to stamp anything that is not a full-length lowercase hex digest', () => {
    // §2.2.1 fixes the value's shape. A pin that declaredSha256 would then reject is not a pin,
    // and writing one produces a reference nothing can resolve.
    for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${HEX}0`]) {
      expect(() => withSha256Pin('https://example.com/s.tn', bad)).toThrow(
        TsonSchemaValidationError,
      );
    }
  });

  it('does not leave an empty parameter behind when it replaces the only one', () => {
    expect(withSha256Pin('https://example.com/s.tn?sha256=old', HEX)).toBe(
      `https://example.com/s.tn?sha256=${HEX}`,
    );
  });
});
