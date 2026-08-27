import { describe, expect, it } from 'vitest';
import { TsonAtomParseError } from '../src/core/errors.js';
import { createComplexParser } from '../src/atom/numeric/complex.js';
import type { AtomToken } from '../src/atom/contract.js';

// §5.6's `!complex` atom, defined against §7.6's `complex = [sign] magnitude sign magnitude
// imag-unit / [sign] magnitude imag-unit` production.

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

describe('§7.6 complex -- both grammar alternatives', () => {
  it('the two-part form: real and imaginary components', () => {
    const parser = createComplexParser('complex');
    expect(parser.read(token('3+4i'))).toEqual({
      real: { unscaled: 3n, exponent: 0 },
      imaginary: { unscaled: 4n, exponent: 0 },
    });
  });

  it('the imaginary-only form: real part implicitly zero (-2.5j)', () => {
    const parser = createComplexParser('complex');
    expect(parser.read(token('-2.5j'))).toEqual({
      real: { unscaled: 0n, exponent: 0 },
      imaginary: { unscaled: -25n, exponent: -1 },
    });
  });

  it('!complex also accepts a bare integer/float token as a real-only complex number', () => {
    const parser = createComplexParser('complex');
    expect(parser.read(token('42'))).toEqual({
      real: { unscaled: 42n, exponent: 0 },
      imaginary: { unscaled: 0n, exponent: 0 },
    });
  });

  it('a magnitude may be zero-led (decimal-natural admits a leading "0")', () => {
    const parser = createComplexParser('complex');
    expect(parser.read(token('0.5-0.25i'))).toEqual({
      real: { unscaled: 5n, exponent: -1 },
      imaginary: { unscaled: -25n, exponent: -2 },
    });
    expect(parser.read(token('0.5i'))).toEqual({
      real: { unscaled: 0n, exponent: 0 },
      imaginary: { unscaled: 5n, exponent: -1 },
    });
  });
});

describe('§5.6 complex -- rejected forms', () => {
  it("!complex's accepted forms are complex/float/integer, not based-integer", () => {
    expect(() => createComplexParser('complex').read(token('0xFF'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.6 complex -- write round-trips through read', () => {
  it('always writes an explicit middle sign and an "i" suffix', () => {
    const parser = createComplexParser('complex');
    const value = parser.read(token('3+4i'));
    expect(parser.write(value)).toBe('3+4i');
    expect(parser.read(token(parser.write(value)))).toEqual(value);
  });

  it('a negative imaginary part still writes with an explicit sign', () => {
    const parser = createComplexParser('complex');
    const value = {
      real: { unscaled: 0n, exponent: 0 },
      imaginary: { unscaled: -25n, exponent: -1 },
    };
    expect(parser.write(value)).toBe('0-2.5i');
  });
});
