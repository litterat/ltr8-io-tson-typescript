/**
 * Template-backed families: pins, selectors and error attribution.
 */
import { describe, expect, it } from 'vitest';

import { jsonCodes, load, loadError, textCodes } from './schema-read-helpers.js';

describe('a family whose base is a record-bodied template is judged (§5.2, §5.10)', () => {
  it('two declared members pinning one value are refused', () => {
    const message = loadError(
      `pet => <N, T> { type: text = N  pet: T }\ndog => pet<"dog", text>\ndog2 => pet<"dog", int32>`,
    );
    expect(message).toMatch(/dog.*dog2|dog2.*dog/);
    expect(message).toMatch(/same value/);
  });

  it('pins compare under the selector type: "dog" and "DOG" collide under ASCII_CASEFOLD', () => {
    const header = '';
    const message = loadError(
      `sel => !text_type { normalization: ASCII_CASEFOLD }\npet => <N, T> { type: sel = N  pet: T }\ndog => pet<"dog", text>\ndog2 => pet<"DOG", int32>`,
      header,
    );
    expect(message).toMatch(/same value/);
  });

  it('distinct pins load', () => {
    expect(() =>
      load(
        `pet => <N, T> { type: text = N  pet: T }\ndog => pet<"dog", text>\ncat => pet<"cat", int32>`,
      ),
    ).not.toThrow();
  });
});

describe('a parameter pin is a selector whatever its name’s mark (§5.10, change log #21)', () => {
  const discriminatorsOf = (linked: ReturnType<typeof load>): unknown =>
    (linked.entries.get('pet') as { discriminators?: unknown }).discriminators;

  it('`type: text = N` is a selector', () => {
    expect(discriminatorsOf(load(`pet => <N, T> { type: text = N  pet: T }`))).toEqual(['type']);
  });

  it('`type?: text = N` is a selector too: the base reads it required, each member pins it', () => {
    const linked = load(
      `pet => <N, T> { type?: text = N  pet: T }\ndog => pet<"dog", text>\no => { p: pet }`,
    );
    expect(discriminatorsOf(linked)).toEqual(['type']);
    // The member is FIXED to its argument, optional as the name was marked (§5.7).
    const dog = linked.entries.get('dog') as {
      fields: { entries: ReadonlyMap<string, { optional: boolean; role: string }> };
    };
    expect(dog.fields.entries.get('type')).toMatchObject({ optional: true, role: 'FIXED' });
    // A position typed by the base dispatches on the selector, which it reads required.
    expect(textCodes(linked, 'o', '{ p: { type: dog  pet: x } }')).toEqual([]);
    expect(textCodes(linked, 'o', '{ p: { pet: x } }')).toEqual(['FIELD_REQUIRED']);
    expect(jsonCodes(linked, 'o', '{"p":{"type":"dog","pet":"x"}}')).toEqual([]);
  });

  it('a pin whose field type is itself a parameter is no selector', () => {
    expect(discriminatorsOf(load(`pet => <N, T> { v: T = N  pet: text }`))).toBeUndefined();
  });
});

describe('a member minted at a use site is refused (§3.3.4, §8.2)', () => {
  it('names the application the author wrote and the declaration that would admit it', () => {
    const message = loadError(
      `pet => { pet_type: text =?  n: text }\ndog_of => <T> pet & { pet_type: = "dog"  breed: T }\no => { k: dog_of<text> }`,
    );
    expect(message).toMatch(/'dog_of<text>' composes onto 'pet'/);
    expect(message).toMatch(/my_name => dog_of<text>/);
  });
});
