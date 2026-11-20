/**
 * [TSON-SCHEMA] §8.2's identity for a type written in place: two equal types in place are one type, compared as
 * values -- by structure, never by the order a builder happened to set their members in -- and a name and a type
 * in place are never one.
 */
import { describe, expect, it } from 'vitest';

import type { ArrayBody } from '../src/schema/meta/bodies.js';
import { sameTypeExpr } from '../src/schema/meta/typeInline.js';
import type { TypeInline } from '../src/schema/meta/typedef.js';
import { typeRef } from '../src/schema/meta/typedef.js';

function arrayInPlace(of: ArrayBody): TypeInline {
  return { kind: 'inline', head: 'meta.array', of };
}

describe('§8.2 two equal types written in place are one type', () => {
  const written: ArrayBody = {
    kind: 'array',
    elementType: typeRef('text'),
    voidable: false,
    ordered: true,
    uniqueItems: false,
    minItems: 1n,
  };

  it('whatever order their members were built in', () => {
    const reordered: ArrayBody = {
      minItems: 1n,
      uniqueItems: false,
      ordered: true,
      voidable: false,
      elementType: { annotations: [], name: 'text' },
      kind: 'array',
    };
    expect(sameTypeExpr(arrayInPlace(written), arrayInPlace(reordered))).toBe(true);
  });

  it('annotations take no part', () => {
    const annotated: ArrayBody = {
      ...written,
      elementType: { name: 'text', annotations: [{ name: 'doc', value: 'a list of words' }] },
    };
    expect(sameTypeExpr(arrayInPlace(written), arrayInPlace(annotated))).toBe(true);
  });

  it('a differing facet is a different type', () => {
    expect(sameTypeExpr(arrayInPlace(written), arrayInPlace({ ...written, minItems: 2n }))).toBe(
      false,
    );
    expect(
      sameTypeExpr(
        arrayInPlace(written),
        arrayInPlace({ ...written, elementType: typeRef('int32') }),
      ),
    ).toBe(false);
  });

  it('a name and a type written in place are never one type', () => {
    expect(sameTypeExpr(typeRef('texts'), arrayInPlace(written))).toBe(false);
  });
});
