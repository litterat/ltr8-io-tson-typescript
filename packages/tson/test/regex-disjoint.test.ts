import { describe, expect, it } from 'vitest';
import { parseRegex } from '../src/regex/index.js';

function disjoint(a: string, b: string): boolean {
  const result = parseRegex(a).isDisjointFrom(parseRegex(b));
  // Disjointness is symmetric — verify both directions agree.
  expect(parseRegex(b).isDisjointFrom(parseRegex(a)), `disjoint(${a},${b}) is not symmetric`).toBe(
    result,
  );
  return result;
}

/**
 * `Regex.isDisjointFrom`: does any string match both patterns? Exact regular-language
 * intersection emptiness, so every case has a definite answer — the building block
 * [TSON-SCHEMA] §5.4's own choice-disjointness rule stops short of (patterns never make a choice
 * disjoint by that rule), available here for a schema author's own reasoning about their
 * patterns.
 */
describe('I-Regexp disjointness (product-NFA emptiness)', () => {
  it('finds genuinely disjoint patterns disjoint', () => {
    expect(disjoint('[a-z]+', '[0-9]+')).toBe(true);
    expect(disjoint('abc', 'abd')).toBe(true);
    expect(disjoint('a+', 'b+')).toBe(true); // every a+ string starts with 'a', every b+ with 'b'
    expect(disjoint('[a-m]', '[n-z]')).toBe(true);
    expect(disjoint('cat', 'dog')).toBe(true);
    expect(disjoint('\\p{Lu}', '\\p{Ll}')).toBe(true); // uppercase vs lowercase letters
    expect(disjoint('\\p{Nd}', '\\p{L}')).toBe(true); // digits vs letters
    expect(disjoint('foo|bar', 'baz')).toBe(true);
    expect(disjoint('a{3}', 'a{4}')).toBe(true); // exactly three vs exactly four
  });

  it('finds overlapping patterns not disjoint', () => {
    expect(disjoint('a*', 'b*')).toBe(false); // both match the empty string
    expect(disjoint('\\p{Nd}', '[0-9]')).toBe(false); // ASCII digits are also category Nd
    expect(disjoint('[a-c]', '[b-d]')).toBe(false); // 'b' and 'c' are common
    expect(disjoint('abc', 'ab.')).toBe(false); // "abc" matches both ('.' matches 'c')
    expect(disjoint('.', 'a')).toBe(false); // '.' matches "a"
    expect(disjoint('hello|world', 'world')).toBe(false);
    expect(disjoint('a+', 'a{2}')).toBe(false); // "aa" matches both
    expect(disjoint('[a-z]+', 'abc')).toBe(false);
  });

  it('is never disjoint from itself', () => {
    expect(disjoint('[a-z]+', '[a-z]+')).toBe(false);
    expect(disjoint('\\p{L}\\p{Nd}*', '\\p{L}\\p{Nd}*')).toBe(false);
  });

  it('decides disjointness for the empty pattern correctly', () => {
    // "" matches only the empty string; anything that can also match "" is not disjoint from it.
    expect(disjoint('', 'a*')).toBe(false);
    expect(disjoint('', 'a+')).toBe(true);
  });
});
