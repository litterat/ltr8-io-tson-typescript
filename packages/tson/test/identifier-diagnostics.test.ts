/**
 * Identifier diagnostics and per-name refusals in both readers.
 */
import { describe, expect, it } from 'vitest';

import { jsonMessages, load, textMessages } from './schema-read-helpers.js';

describe('identifier diagnostics index code points, never UTF-16 units (§2.6, §7.7)', () => {
  const linked = load(`n => !identifier_type { }\nh => { n: n }`);

  it('names the code point index of a character after a supplementary one, in both readers', () => {
    const text = textMessages(linked, 'h', '{ n: "a\\u{1D400}!" }');
    const json = jsonMessages(linked, 'h', '{"n":"a\u{1D400}!"}');
    expect(text.join(' ')).toContain('at index 2');
    expect(json.join(' ')).toContain('at index 2');
  });

  it('counts a medial run in code points', () => {
    const profile = load(`m => !identifier_type { medial: "." }\nh => { n: m }`);
    const message = textMessages(profile, 'h', '{ n: "a\\u{1D400}..b" }').join(' ');
    expect(message).toContain('at index 3');
  });
});

describe('a per-name refusal reads the same in both readers (§8.2)', () => {
  it('a per-name refusal reads the same in the text and the JSON reader (§8.2)', () => {
    const linked = load(`n => !identifier_type { }\nh => { n: n }`);
    const text = textMessages(linked, 'h', '{ n: "a\\u{AD}b" }');
    const json = jsonMessages(linked, 'h', '{"n":"a­b"}');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toEqual(json);
  });
});
