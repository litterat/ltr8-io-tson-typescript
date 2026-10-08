/**
 * Field group declaration rules over a `!record` literal.
 */
import { describe, expect, it } from 'vitest';

import { load, loadError } from './schema-read-helpers.js';

describe('§5.11 declaration rules hold for a group written as a `!record` literal', () => {
  const fields = (...names: string[]): string =>
    `fields: [ ${names.map((n) => `{ name: ${n} type: text optional: true }`).join(' ')} ]`;

  it('accepts the shapes the sugar accepts', () => {
    expect(() =>
      load(`r => !record { ${fields('a', 'b')} groups: [ { members: [[a] [b]] } ] }`),
    ).not.toThrow();
    expect(() =>
      load(
        `r => !record { ${fields('a', 'b')} groups: [ { members: [[a b]] optional_members: [a b] } ] }`,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'an optional_members entry that is no member',
      `${fields('a', 'b')} groups: [ { members: [[a] [b]] optional_members: [c] } ]`,
    ],
    [
      'a marked only member of an option',
      `${fields('a', 'b')} groups: [ { members: [[a] [b]] optional_members: [a] } ]`,
    ],
    [
      'a bare single option with an unmarked member',
      `${fields('a', 'b')} groups: [ { members: [[a b]] optional_members: [a] } ]`,
    ],
    [
      'an optional single option of one member',
      `${fields('a')} groups: [ { members: [[a]] optional: true } ]`,
    ],
    [
      'a member in two groups',
      `${fields('a', 'b', 'c')} groups: [ { members: [[a] [b]] } { members: [[a] [c]] } ]`,
    ],
    [
      'a member that is not optional',
      `fields: [ { name: a type: text } { name: b type: text optional: true } ] groups: [ { members: [[a] [b]] } ]`,
    ],
    ['a member naming no field', `${fields('a')} groups: [ { members: [[a] [z]] } ]`],
  ])('refuses %s', (_label, body) => {
    expect(loadError(`r => !record { ${body} }`)).toMatch(/field group is refused/);
  });
});
