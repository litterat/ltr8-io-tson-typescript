/**
 * `familyJoiners` ([TSON-SCHEMA] §3.4.1 rule 1, §5.2): the declarations not yet ready that may be the member of a
 * family a value's pins select, judged from what each writes and never by resolving one -- a composition, a
 * refinement's source, an alias's target or an application's head reaching the base, the nearest written pin
 * agreeing with the value's; a subtraction joins nothing (§5.9) and a parametric record is no member (§5.10).
 */
import { describe, expect, it } from 'vitest';

import { familyJoiners } from '../src/compiler/familyJoiners.js';
import { desugar } from '../src/compiler/desugar.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { fromString, runSync } from '../src/io/bytes.js';
import type { Top } from '../src/schema/meta/typedef.js';

function declarationsOf(body: string) {
  const document = runSync(parseSchemaDocument(fromString(`!schema {\n${body}\n}\n`)));
  return desugar(document).body.declarations;
}

const ready = new Map<string, Top>();
const none = (name: string): Top | undefined => ready.get(name);

describe('§3.4.1 the declarations that may join a family placed by pins', () => {
  const declarations = declarationsOf(`
    rss      => feed & { format?: = "rss" }
    atomish  => feed & { format?: = "atom" }
    plain    => feed & { note: text }
    deeper   => plain & { extra: text }
    alias    => rss
    cut      => feed - { url }
    other    => { format: text }
    box      => <T> feed & { v: T }
  `);
  const joiners = (pin: string) =>
    familyJoiners(
      'feed',
      ['format'],
      (_selector, written) => written === pin,
      declarations,
      none,
      () => true,
    );

  it('a composition reaching the base, directly or through a declaration that may join, and an alias of one', () => {
    expect(joiners('rss')).toEqual(['rss', 'plain', 'deeper', 'alias']);
  });

  it('a declaration whose nearest written pin differs is none; one stating no pin may still be the member', () => {
    expect(joiners('atom')).toEqual(['atomish', 'plain', 'deeper']);
  });

  it('only declarations the read has not made ready are asked', () => {
    expect(
      familyJoiners(
        'feed',
        ['format'],
        () => true,
        declarations,
        none,
        (name) => name !== 'rss',
      ),
    ).not.toContain('rss');
  });
});
