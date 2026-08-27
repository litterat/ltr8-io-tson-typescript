import { describe, expect, it } from 'vitest';
import { parseRegex } from '../src/regex/index.js';

function matches(pattern: string, input: string): boolean {
  return parseRegex(pattern).matches(input);
}

/**
 * `Regex.matches`: full-match (whole-string) I-Regexp matching (RFC 9485 §3, XSD Boolean
 * semantics). Covers the combinators and quantifiers, Unicode category and code-point handling,
 * I-Regexp's own quirks (anchors are literals, `.` excludes line terminators), and — the point
 * of a Thompson NFA / Pike VM — that a pattern which hangs a backtracking engine runs in linear
 * time here.
 */
describe('I-Regexp matching (RFC 9485 §3)', () => {
  it('matches the whole string, never a substring', () => {
    expect(matches('abc', 'abc')).toBe(true);
    expect(matches('abc', 'abcd')).toBe(false);
    expect(matches('abc', 'ab')).toBe(false);
    expect(matches('abc', 'xabc')).toBe(false);
  });

  it('handles alternation and grouping', () => {
    expect(matches('a|b|c', 'b')).toBe(true);
    expect(matches('a|b|c', 'd')).toBe(false);
    expect(matches('(ab)+', 'abab')).toBe(true);
    expect(matches('(ab)+', 'aba')).toBe(false);
    expect(matches('(a|b)*c', 'aabbc')).toBe(true);
    expect(matches('(a|b)*c', 'c')).toBe(true);
    expect(matches('(a|b)*c', 'aab')).toBe(false);
  });

  it('handles every quantifier form', () => {
    expect(matches('a*', '')).toBe(true);
    expect(matches('a*', 'aaa')).toBe(true);
    expect(matches('a+', '')).toBe(false);
    expect(matches('a+', 'aaa')).toBe(true);
    expect(matches('colou?r', 'color')).toBe(true);
    expect(matches('colou?r', 'colour')).toBe(true);
    expect(matches('colou?r', 'colouur')).toBe(false);
    expect(matches('a{2,3}', 'aa')).toBe(true);
    expect(matches('a{2,3}', 'aaa')).toBe(true);
    expect(matches('a{2,3}', 'a')).toBe(false);
    expect(matches('a{2,3}', 'aaaa')).toBe(false);
    expect(matches('a{2,}', 'aaaaa')).toBe(true);
    expect(matches('a{3}', 'aaa')).toBe(true);
  });

  it('handles character classes and dot', () => {
    expect(matches('[a-z]+', 'abc')).toBe(true);
    expect(matches('[a-z]+', 'abc1')).toBe(false);
    expect(matches('[a-z]+', '')).toBe(false);
    expect(matches('[^0-9]', 'a')).toBe(true);
    expect(matches('[^0-9]', '5')).toBe(false);
    expect(matches('a.c', 'abc')).toBe(true);
    expect(matches('a.c', 'a c')).toBe(true);
    expect(matches('a.c', 'a\nc')).toBe(false); // '.' excludes line terminators
    expect(matches('.', '\n')).toBe(false);
    expect(matches('.', '\r')).toBe(false);
    expect(matches('.', '')).toBe(false);
  });

  it('resolves \\p{...}/\\P{...} against Unicode general categories', () => {
    expect(matches('\\p{Nd}+', '2026')).toBe(true);
    expect(matches('\\p{Nd}', '٥')).toBe(true); // Arabic-Indic digit five is also Nd
    expect(matches('\\p{Nd}+', '12a')).toBe(false);
    expect(matches('\\p{Lu}\\p{Ll}*', 'Hello')).toBe(true);
    expect(matches('\\p{Lu}\\p{Ll}*', 'hello')).toBe(false); // must start uppercase
    expect(matches('\\P{Nd}', 'a')).toBe(true);
    expect(matches('\\P{Nd}', '5')).toBe(false);
  });

  it('treats code points, not UTF-16 units, as the unit of matching', () => {
    expect(matches('café', 'café')).toBe(true); // accented literal
    expect(matches('😀+', '😀😀')).toBe(true); // supplementary-plane atom (emoji)
    expect(matches('😀+', '😀x')).toBe(false);
    expect(matches('.', '😀')).toBe(true); // one atom, not two UTF-16 units
  });

  it('treats ^ and $ as literal characters, and matches the empty pattern only against the empty string', () => {
    expect(matches('^a$', '^a$')).toBe(true);
    expect(matches('^a$', 'a')).toBe(false);
    expect(matches('', '')).toBe(true);
    expect(matches('', 'x')).toBe(false);
  });

  it('reuses the compiled program across repeated calls to the same Regex', () => {
    const regex = parseRegex('a{2,4}b');
    expect(regex.matches('aaab')).toBe(true);
    expect(regex.matches('ab')).toBe(false);
    expect(regex.matches('aaaab')).toBe(true);
    expect(regex.matches('aaaaab')).toBe(false);
  });

  it('runs in linear time on a pattern that hangs a backtracking engine', () => {
    // (a+)+b over a long run of 'a' with no 'b' is a classic catastrophic-backtracking case; a
    // Thompson NFA / Pike VM decides it without exponential blow-up. This is the ReDoS-safety
    // property WP9 exists to provide.
    const input = 'a'.repeat(2000);
    const start = performance.now();
    expect(matches('(a+)+b', input)).toBe(false);
    expect(matches('(a+)+b', input + 'b')).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
