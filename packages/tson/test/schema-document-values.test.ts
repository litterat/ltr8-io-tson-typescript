/**
 * A schema document's values are read in that document's namespace, whatever schema declared their type
 * ([TSON-SCHEMA] §3.3, §3.4.1, §6; change log §4.5 "Other rules", item 101): a value placed by its pins selects a
 * member the reading schema declares of an imported family, and waits on each declaration that may be that member,
 * so one declared after the value is ready when the value is placed; an annotation inside such a value names a type
 * of the reading schema's namespace.
 */
import { describe, expect, it } from 'vitest';

import type { Tson } from '../src/config.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { subtypesIn } from './model-fixtures.js';

const FEED_ID = 'https://example.test/feed.tn';

/** A family selected by its pins, declared by a schema importing meta.tn alone, and records holding it. */
const FEED = `!!id:"${FEED_ID}"
!!import:"https://tson.io/2026/40/m/meta.tn"
!schema {
  feed         => { format: text =?  url: text }
  atom_feed    => feed & { format?: = "atom" }
  subscription => { feed: feed }
  bookmark     => { url: text }
}
`;

function withFeed(): Tson {
  const tson = standardLibrary();
  tson.resolveSchema(FEED);
  return tson;
}

function reading(body: string, core = true): string {
  return (
    `!!id:"https://example.test/app.tn"\n!!import:"${FEED_ID}"\n` +
    (core ? '!!import:"https://tson.io/2026/40/m/core.tn"\n' : '') +
    `!schema {\n${body}\n}\n`
  );
}

function resolve(body: string, core = true): LinkedSchema {
  return withFeed().resolveSchema(reading(body, core));
}

describe('§3.4.1, §5.2 a value placed by its pins selects the reading schema’s own member', () => {
  it('in a value entry, the member declared after the value that selects it', () => {
    const linked = resolve(`
      mine     => !subscription { feed: { format: rss  url: "/rss" } }
      rss_feed => feed & { format?: = "rss" }`);
    expect(linked.entries.get('mine')?.kind).toBe('value_entry');
    expect(subtypesIn(linked.entries.get('feed'))).toEqual(['atom_feed', 'rss_feed']);
  });

  it('in an annotation’s value of an imported type, the member declared after the annotated entry (item 101)', () => {
    const linked = resolve(`
      reader   => @subscription:{ feed: { format: rss  url: "/rss" } } { name: text }
      rss_feed => feed & { format?: = "rss" }`);
    expect(linked.entries.has('reader')).toBe(true);
  });

  it('a member the imports declare is placed as before', () => {
    expect(() =>
      resolve('mine => !subscription { feed: { format: atom  url: "/a" } }'),
    ).not.toThrow();
  });

  it('a pin no member states is refused; a declaration whose written pin differs is no candidate, and is not waited on', () => {
    expect(() =>
      resolve(`
        mine     => !subscription { feed: { format: gopher  url: "/g" } }
        rss_feed => feed & { format?: = "rss" }`),
    ).toThrow(/no member of 'feed' pins format: gopher, .* expected one of \(atom_feed\)/u);
  });
});

describe('§6 an annotation inside a value of an imported type resolves in the reading schema', () => {
  it('names a type the reading schema’s closure holds, though the declaring schema’s does not', () => {
    const linked = resolve('home => !bookmark { url: @title:"Home" "/" }');
    const home = linked.entries.get('home');
    if (home?.kind !== 'value_entry' || home.value.form !== 'record') {
      throw new Error('expected a record value entry');
    }
    expect(home.value.fields.get('url')).toMatchObject({
      form: 'token',
      annotations: [{ name: 'title' }],
    });
  });

  it('an annotation naming nothing in the reading schema’s namespace is refused', () => {
    expect(() => resolve('home => !bookmark { url: @title:"Home" "/" }', false)).toThrow(
      /the annotation '@title' names no type of this schema's namespace/,
    );
  });

  it('its value is judged against the type it names', () => {
    expect(() => resolve('home => !bookmark { url: @title:{ a: b } "/" }')).toThrow(
      /at \/url\/@title: expected a value of 'text', found a record/,
    );
  });
});
