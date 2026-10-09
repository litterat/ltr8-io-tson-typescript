/**
 * Enum refinement and member sets.
 */
import { describe, expect, it } from 'vitest';

import { load, loadError } from './schema-read-helpers.js';

describe('an enum refinement loads through the public API (§7.4, §5.6)', () => {
  it('!enum refined by members narrows the member set', () => {
    expect(() => load(`e => !enum [a b c]\ne2 => !e ^ { members: [a b] }`)).not.toThrow();
  });

  it('!text_enum and !enum_type{type} refinements load', () => {
    expect(() => load(`e => !text_enum [a b c]\ne2 => !e ^ { members: [a b] }`)).not.toThrow();
    expect(() =>
      load(
        `k => !identifier_type { }\ne => !enum_type { type: k members: [a b c] }\ne2 => !e ^ { members: [a b] }`,
      ),
    ).not.toThrow();
  });
});

describe('enum members are judged under the label type’s profile (§7.4)', () => {
  it('a member the profile adds is exempt, as a value of the family at a position is', () => {
    expect(
      loadError(
        `k => !identifier_type { continue_add: "+" }\ne => !enum_type { type: k members: ["a+b"] }`,
      ),
    ).toBeUndefined();
  });

  it('a member the profile does not add is still refused', () => {
    expect(
      loadError(
        `k => !identifier_type { continue_add: "+" }\ne => !enum_type { type: k members: ["a$b"] }`,
      ),
    ).toBeDefined();
  });
});

describe('a narrowed member set keeps the inherited order (§7.5)', () => {
  const membersOf = (linked: ReturnType<typeof load>, name: string): unknown =>
    (linked.entries.get(name)?.body as { members?: unknown; schemes?: unknown }).members;

  it('an enum refined to a reordered subset resolves in the inherited order', () => {
    const linked = load(`e => !enum [a b c]\ne2 => !e ^ { members: [c a] }`);
    expect(membersOf(linked, 'e2')).toEqual(['a', 'c']);
  });

  it('schemes compare ASCII-folded and resolve in the inherited order', () => {
    const linked = load(
      `u => !uri_reference ^ { schemes: [https http ftp] }\nu2 => !u ^ { schemes: [FTP https] }`,
    );
    expect((linked.entries.get('u2')?.body as { schemes?: unknown }).schemes).toEqual([
      'https',
      'ftp',
    ]);
  });
});
