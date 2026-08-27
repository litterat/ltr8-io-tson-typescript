import { describe, expect, it } from 'vitest';

import { checkAtomCoherence, checkAtomNarrows, isAtom } from '../src/compiler/atomChecks.js';
import type { Atom } from '../src/schema/meta/typedef.js';
import type { IntegerType, DecimalType, RationalType } from '../src/schema/meta/atoms-numeric.js';
import type { TextType } from '../src/schema/meta/atoms-text.js';
import type { Cidr4Type } from '../src/schema/meta/atoms-network.js';
import type { EnumBody } from '../src/schema/meta/bodies.js';

const unbounded: IntegerType = { kind: 'integer_type' };

// ── integer_type ─────────────────────────────────────────────────────────────────────────────

describe('integer_type narrowing (§5.7)', () => {
  it('an unconstrained refinement of an unconstrained source is vacuously coherent', () => {
    expect(checkAtomNarrows(unbounded, unbounded)).toEqual([]);
  });

  it('raising the floor and lowering the ceiling both tighten', () => {
    const source: IntegerType = { kind: 'integer_type', min: -10n, max: 10n };
    const refined: IntegerType = { kind: 'integer_type', min: 0n, max: 5n };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });

  it('lowering the floor or raising the ceiling is a violation', () => {
    const source: IntegerType = { kind: 'integer_type', min: -10n, max: 10n };
    const wideLow: IntegerType = { kind: 'integer_type', min: -20n, max: 10n };
    const wideHigh: IntegerType = { kind: 'integer_type', min: -10n, max: 20n };
    expect(checkAtomNarrows(source, wideLow).length).toBeGreaterThan(0);
    expect(checkAtomNarrows(source, wideHigh).length).toBeGreaterThan(0);
  });

  it('folds an implied `size` range into the comparison, so a merely-wider explicit bound the size already excludes is not itself a violation', () => {
    const source: IntegerType = { kind: 'integer_type', size: { bits: 8n, signed: false } };
    const refined: IntegerType = {
      kind: 'integer_type',
      size: { bits: 8n, signed: false },
      max: 300n,
    };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });

  it('narrowing the size (e.g. 16 bits to 8) tightens; widening it does not', () => {
    const source: IntegerType = { kind: 'integer_type', size: { bits: 16n, signed: true } };
    const narrower: IntegerType = { kind: 'integer_type', size: { bits: 8n, signed: true } };
    const wider: IntegerType = { kind: 'integer_type', size: { bits: 32n, signed: true } };
    expect(checkAtomNarrows(source, narrower)).toEqual([]);
    expect(checkAtomNarrows(source, wider).length).toBeGreaterThan(0);
  });

  it("a refined multiple_of must itself be a multiple of the source's own", () => {
    const source: IntegerType = { kind: 'integer_type', multipleOf: 4n };
    expect(checkAtomNarrows(source, { kind: 'integer_type', multipleOf: 8n })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'integer_type', multipleOf: 6n }).length,
    ).toBeGreaterThan(0);
  });

  it('reports a mismatched family rather than throwing', () => {
    const source: IntegerType = { kind: 'integer_type' };
    const refined: TextType = { kind: 'text_type' };
    const violations = checkAtomNarrows(source, refined);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('text_type');
  });
});

describe('integer_type coherence (§7.2)', () => {
  it('an empty body is coherent', () => {
    expect(checkAtomCoherence(unbounded)).toEqual([]);
  });

  it('min above max is incoherent', () => {
    const violations = checkAtomCoherence({ kind: 'integer_type', min: 10n, max: 3n });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('min equal to max is coherent (pins a constant)', () => {
    expect(checkAtomCoherence({ kind: 'integer_type', min: 5n, max: 5n })).toEqual([]);
  });

  it('a size-derived range contradicting an explicit bound is caught (the fold, not just the written facets)', () => {
    const violations = checkAtomCoherence({
      kind: 'integer_type',
      size: { bits: 8n, signed: false }, // implies [0, 255]
      max: -5n,
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('multiple_of: 0 is rejected outright -- it divides nothing', () => {
    const violations = checkAtomCoherence({ kind: 'integer_type', multipleOf: 0n });
    expect(violations.some((v) => v.includes('zero'))).toBe(true);
  });

  it('a negative multiple_of is rejected -- a step is a spacing, not a direction', () => {
    const violations = checkAtomCoherence({ kind: 'integer_type', multipleOf: -3n });
    expect(violations.some((v) => v.includes('negative'))).toBe(true);
  });
});

// ── decimal_type / rational_type ────────────────────────────────────────────────────────────

describe('decimal_type', () => {
  it('compares by value, not by written scale: 1.10 (scale 2) narrows the same as 1.1 (scale 1)', () => {
    const source: DecimalType = { kind: 'decimal_type', min: { unscaledValue: 1n, scale: 0 } }; // 1
    const refinedSameValue: DecimalType = {
      kind: 'decimal_type',
      min: { unscaledValue: 100n, scale: 2 },
    }; // 1.00
    expect(checkAtomNarrows(source, refinedSameValue)).toEqual([]);
  });

  it('total_digits/fraction_digits may only fall, and fraction_digits must not exceed total_digits', () => {
    const source: DecimalType = { kind: 'decimal_type', totalDigits: 10, fractionDigits: 4 };
    expect(
      checkAtomNarrows(source, { kind: 'decimal_type', totalDigits: 5, fractionDigits: 2 }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'decimal_type', totalDigits: 12 }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomCoherence({ kind: 'decimal_type', totalDigits: 4, fractionDigits: 6 }).length,
    ).toBeGreaterThan(0);
  });
});

describe('rational_type', () => {
  it('2/4 and 1/2 are the same bound (cross-multiplication equality)', () => {
    const source: RationalType = { kind: 'rational_type', min: { numerator: 1n, denominator: 2n } };
    const refined: RationalType = {
      kind: 'rational_type',
      min: { numerator: 2n, denominator: 4n },
    };
    expect(checkAtomNarrows(source, refined)).toEqual([]);
  });
});

// ── text_type ────────────────────────────────────────────────────────────────────────────────

describe('text_type', () => {
  it('min_length may only rise and max_length may only fall', () => {
    const source: TextType = { kind: 'text_type', minLength: 2, maxLength: 10 };
    expect(checkAtomNarrows(source, { kind: 'text_type', minLength: 4, maxLength: 6 })).toEqual([]);
    expect(checkAtomNarrows(source, { kind: 'text_type', minLength: 1 }).length).toBeGreaterThan(0);
    expect(checkAtomNarrows(source, { kind: 'text_type', maxLength: 20 }).length).toBeGreaterThan(
      0,
    );
  });

  it("`length` is checked against both the source's min and max (an exact length is both a floor and a ceiling)", () => {
    const source: TextType = { kind: 'text_type', minLength: 2, maxLength: 10 };
    expect(checkAtomNarrows(source, { kind: 'text_type', length: 5 })).toEqual([]);
    expect(checkAtomNarrows(source, { kind: 'text_type', length: 20 }).length).toBeGreaterThan(0);
  });

  it('coherence: min_length above max_length admits nothing', () => {
    expect(
      checkAtomCoherence({ kind: 'text_type', minLength: 10, maxLength: 3 }).length,
    ).toBeGreaterThan(0);
  });

  it('coherence leaves `pattern` unchecked (regex containment is undecidable without tson-regex)', () => {
    expect(checkAtomCoherence({ kind: 'text_type', pattern: '[a-z]+' })).toEqual([]);
  });
});

// ── cidr4_type ───────────────────────────────────────────────────────────────────────────────

describe('cidr4_type', () => {
  it("prefix bounds must fall within the address family's own range (0-32)", () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: [],
      excluding: [],
      minPrefix: 40,
    });
    expect(violations.some((v) => v.includes('0-32'))).toBe(true);
  });

  it('`within` may only shrink under refinement', () => {
    const source: Cidr4Type = {
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: [],
    };
    expect(
      checkAtomNarrows(source, {
        kind: 'cidr4_type',
        spec: 'x',
        within: ['10.0.0.0/8', '192.168.0.0/16'],
        excluding: [],
      }).length,
    ).toBeGreaterThan(0);
  });
});

// ── date_type / enum ─────────────────────────────────────────────────────────────────────────

describe('date_type', () => {
  it('min above max is incoherent, ordered by real calendar value not field-by-field', () => {
    const violations = checkAtomCoherence({
      kind: 'date_type',
      min: { year: 2026, month: 1, day: 1 },
      max: { year: 2025, month: 12, day: 31 },
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('min equal to max is coherent', () => {
    const d = { year: 2026, month: 6, day: 15 };
    expect(checkAtomCoherence({ kind: 'date_type', min: d, max: d })).toEqual([]);
  });
});

describe('enum', () => {
  it('members may only shrink under refinement', () => {
    const source: EnumBody = { kind: 'enum', members: ['a', 'b', 'c'] };
    expect(checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b'] })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b', 'd'] }).length,
    ).toBeGreaterThan(0);
  });
});

// ── float_type permission flags ─────────────────────────────────────────────────────────────

describe('float_type', () => {
  it('a permission flag may be withdrawn but never re-granted', () => {
    const source = {
      kind: 'float_type' as const,
      format: 'BINARY64' as const,
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    };
    const tighter = { ...source, allowNan: false };
    const wrong = { ...source, allowNan: true, format: 'BINARY64' as const };
    expect(checkAtomNarrows(source, tighter)).toEqual([]);
    // withdrawing then re-declaring the same value stays valid
    expect(checkAtomNarrows(source, wrong)).toEqual([]);
    const sourceWithdrawn = { ...source, allowNan: false };
    expect(checkAtomNarrows(sourceWithdrawn, source).length).toBeGreaterThan(0);
  });
});

// ── Families with no orderable facet at all ─────────────────────────────────────────────────

describe('families with nothing to narrow or contradict', () => {
  it('unit/uuid_type/duration_type/complex_type always report clean', () => {
    const cases: Atom[] = [
      { kind: 'unit' },
      { kind: 'uuid_type' },
      { kind: 'duration_type' },
      { kind: 'complex_type', component: 'NUMBER' },
    ];
    for (const atom of cases) {
      expect(checkAtomNarrows(atom, atom)).toEqual([]);
      expect(checkAtomCoherence(atom)).toEqual([]);
    }
  });
});

// ── isAtom ───────────────────────────────────────────────────────────────────────────────────

describe('isAtom', () => {
  it('recognises every Atom member and rejects every other Top shape', () => {
    expect(isAtom({ kind: 'integer_type' })).toBe(true);
    expect(isAtom({ kind: 'unit' })).toBe(true);
    expect(isAtom({ kind: 'record', supertypes: [], fields: [], groups: [] })).toBe(false);
    expect(
      isAtom({ kind: 'reference', target: { name: 'x', arguments: [], annotations: [] } }),
    ).toBe(false);
    // A held template body: no `kind` tag at all (schema/meta's own contract).
    expect(isAtom({ names: () => new Set(), applications: () => [] })).toBe(false);
  });
});
