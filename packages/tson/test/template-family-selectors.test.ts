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

describe('only a pin on an unmarked name is a selector (§5.10, §3.2 item 33)', () => {
  const discriminatorsOf = (linked: ReturnType<typeof load>): unknown =>
    (linked.entries.get('pet')?.body as { discriminators?: unknown }).discriminators;

  it('`type: text = N` is a selector', () => {
    expect(discriminatorsOf(load(`pet => <N, T> { type: text = N  pet: T }`))).toEqual(['type']);
  });

  it('`type?: text = N` is an injected pin and selects nothing', () => {
    const linked = load(
      `pet => <N, T> { type?: text = N  pet: T }\ndog => pet<"dog", text>\no => { p: dog }`,
    );
    expect(discriminatorsOf(linked)).toBeUndefined();
    expect(textCodes(linked, 'o', '{ p: { pet: x } }')).toEqual([]);
    expect(jsonCodes(linked, 'o', '{"p":{"pet":"x"}}')).toEqual([]);
  });
});

describe('a thrown family error names its declaration (§5.2, §8.2)', () => {
  it('a member minted at a use site is reported against the declaration that wrote it', () => {
    const message = loadError(
      `pet => { pet_type: text =?  n: text }\ndog_of => <T> pet & { pet_type: = "dog"  breed: T }\no => { k: dog_of<text> }`,
    );
    expect(message).toMatch(/in the declaration of 'o'/);
  });
});
