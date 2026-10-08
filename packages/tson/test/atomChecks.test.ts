import { describe, expect, it } from 'vitest';

import { checkAtomCoherence, checkAtomNarrows, isAtom } from '../src/compiler/atomChecks.js';
import type { Atom } from '../src/schema/meta/typedef.js';
import type {
  ComplexType,
  DecimalType,
  FloatType,
  IntegerType,
  RationalType,
} from '../src/schema/meta/atoms-numeric.js';
import type { BytesType } from '../src/schema/meta/atoms-bytes.js';
import type { DurationType, PeriodType } from '../src/schema/meta/atoms-temporal.js';
import type { IdentifierType, IriType, TextType, UriType } from '../src/schema/meta/atoms-text.js';
import type { Cidr4Type, Ipv4Type } from '../src/schema/meta/atoms-network.js';
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
    const refined: TextType = { kind: 'text_type', normalization: 'NONE' };
    const violations = checkAtomNarrows(source, refined);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('text_type');
  });

  it('a sparse member set may only shrink to a subset, compared by value (§5.7)', () => {
    const source: IntegerType = { kind: 'integer_type', members: [80n, 443n, 8080n] };
    expect(checkAtomNarrows(source, { kind: 'integer_type', members: [80n, 443n] })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'integer_type', members: [80n, 443n, 22n] }).length,
    ).toBeGreaterThan(0);
    // Dropping the facet entirely widens back to every integer -- also a violation.
    expect(checkAtomNarrows(source, { kind: 'integer_type' }).length).toBeGreaterThan(0);
  });
});

describe("integer_type coherence (§7.4's 'Coherence of a body's facets')", () => {
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

  it("every member of `members` must satisfy the body's other facets (§7.4)", () => {
    // 443 is outside an 8-bit unsigned range -- the same failure a stated `max` would report.
    expect(
      checkAtomCoherence({
        kind: 'integer_type',
        members: [443n],
        size: { bits: 8n, signed: false },
      }).length,
    ).toBeGreaterThan(0);
    // 80/443/8080 all fit an unconstrained integer.
    expect(checkAtomCoherence({ kind: 'integer_type', members: [80n, 443n, 8080n] })).toEqual([]);
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
    const source: DecimalType = { kind: 'decimal_type', totalDigits: 10n, fractionDigits: 4n };
    expect(
      checkAtomNarrows(source, { kind: 'decimal_type', totalDigits: 5n, fractionDigits: 2n }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'decimal_type', totalDigits: 12n }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomCoherence({ kind: 'decimal_type', totalDigits: 4n, fractionDigits: 6n }).length,
    ).toBeGreaterThan(0);
  });

  it('a sparse member set narrows by value -- 1 and 1.0 are one member, not two (§5.5, §5.7)', () => {
    const source: DecimalType = {
      kind: 'decimal_type',
      members: [
        { unscaledValue: 1n, scale: 0 },
        { unscaledValue: 250n, scale: 2 },
      ], // 1, 2.50
    };
    // 1.00 restates the source's own `1` by value -- a vacuous (legal) narrowing.
    expect(
      checkAtomNarrows(source, {
        kind: 'decimal_type',
        members: [{ unscaledValue: 100n, scale: 2 }],
      }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, {
        kind: 'decimal_type',
        members: [
          { unscaledValue: 1n, scale: 0 },
          { unscaledValue: 3n, scale: 0 },
        ],
      }).length,
    ).toBeGreaterThan(0);
  });

  it("every member of `members` must satisfy the body's other facets (§7.4)", () => {
    expect(
      checkAtomCoherence({
        kind: 'decimal_type',
        members: [{ unscaledValue: 3n, scale: 0 }],
        max: { unscaledValue: 2n, scale: 0 },
      }).length,
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
    const source: TextType = {
      kind: 'text_type',
      normalization: 'NONE',
      minLength: 2n,
      maxLength: 10n,
    };
    expect(
      checkAtomNarrows(source, {
        kind: 'text_type',
        normalization: 'NONE',
        minLength: 4n,
        maxLength: 6n,
      }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', minLength: 1n }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', maxLength: 20n }).length,
    ).toBeGreaterThan(0);
  });

  it("`length` is checked against both the source's min and max (an exact length is both a floor and a ceiling)", () => {
    const source: TextType = {
      kind: 'text_type',
      normalization: 'NONE',
      minLength: 2n,
      maxLength: 10n,
    };
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', length: 5n }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', length: 20n }).length,
    ).toBeGreaterThan(0);
  });

  it('coherence: min_length above max_length admits nothing', () => {
    expect(
      checkAtomCoherence({
        kind: 'text_type',
        normalization: 'NONE',
        minLength: 10n,
        maxLength: 3n,
      }).length,
    ).toBeGreaterThan(0);
  });

  it('coherence leaves `pattern` narrowing unchecked (regex containment is undecidable), but a pattern alone with no `members` has nothing else to check', () => {
    expect(
      checkAtomCoherence({ kind: 'text_type', normalization: 'NONE', pattern: '[a-z]+' }),
    ).toEqual([]);
  });

  // ── §5.7's settable-once facets: `pattern` and `members` (#22) ───────────────────────────────

  it('pattern is settable once: unset -> set narrows, restated verbatim narrows, changed is refused', () => {
    const unset: TextType = { kind: 'text_type', normalization: 'NONE' };
    const source: TextType = { kind: 'text_type', normalization: 'NONE', pattern: '[A-Z]{2}' };
    expect(checkAtomNarrows(unset, source)).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', pattern: '[A-Z]{2}' }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', pattern: '[a-z]{2}' })
        .length,
    ).toBeGreaterThan(0);
  });

  it('members is settable once, the same as pattern: unset -> set narrows, restated verbatim narrows, changed (even by shrinking) is refused', () => {
    const unset: TextType = { kind: 'text_type', normalization: 'NONE' };
    const source: TextType = {
      kind: 'text_type',
      normalization: 'NONE',
      members: ['SE', 'NO', 'DK'],
    };
    expect(checkAtomNarrows(unset, source)).toEqual([]);
    expect(
      checkAtomNarrows(source, {
        kind: 'text_type',
        normalization: 'NONE',
        members: ['SE', 'NO', 'DK'],
      }),
    ).toEqual([]);
    // A member set narrows a plain member-set facet (§7.4's numeric tiers) by shrinking, but
    // `text_type.members` is settable-once, not a member-set facet -- even a subset is a change.
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', members: ['SE', 'NO'] })
        .length,
    ).toBeGreaterThan(0);
  });

  // ── §7.4's uniform members rule: every member satisfies the body's other facets ──────────────

  it('coherence: every member of `members` must satisfy min_length/max_length/length, counted in code points', () => {
    expect(
      checkAtomCoherence({
        kind: 'text_type',
        normalization: 'NONE',
        minLength: 2n,
        members: ['AU', 'A'],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomCoherence({
        kind: 'text_type',
        normalization: 'NONE',
        length: 2n,
        members: ['AU', 'NZ'],
      }),
    ).toEqual([]);
  });

  it('coherence: every member of `members` must match `pattern` -- the one member check needing a regex match rather than a comparison', () => {
    const violations = checkAtomCoherence({
      kind: 'text_type',
      normalization: 'NONE',
      pattern: '[A-Z]{2}',
      members: ['AU', 'nz'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('nz');
  });

  it('coherence: a member set with no facets beside it to violate is coherent', () => {
    expect(
      checkAtomCoherence({ kind: 'text_type', normalization: 'NONE', members: ['a', 'b'] }),
    ).toEqual([]);
  });

  // ── `text_member_set`'s own non-emptiness and uniqueness (§7.4) ────────────────────────────

  it('coherence: an empty `members` admits no value, exactly as an empty numeric member set does', () => {
    expect(
      checkAtomCoherence({ kind: 'text_type', normalization: 'NONE', members: [] }).length,
    ).toBeGreaterThan(0);
  });

  it('coherence: a member stated twice is refused -- text_member_set is unique_items: true (§7.4)', () => {
    const violations = checkAtomCoherence({
      kind: 'text_type',
      normalization: 'NONE',
      members: ['SE', 'SE'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('SE');
  });

  it('coherence: members compare as text, NFC -- two spellings of one string are one member stated twice (§7.4)', () => {
    const decomposedE = 'café'; // "café" spelled with a combining acute accent
    const precomposedE = 'café'; // "café" spelled precomposed
    expect(
      checkAtomCoherence({
        kind: 'text_type',
        normalization: 'NONE',
        members: [decomposedE, precomposedE],
      }).length,
    ).toBeGreaterThan(0);
  });

  // ── `pattern` syntax is validated at coherence, not silently skipped (§5.7, RFC 9485) ───────

  it('coherence: a syntactically invalid pattern is itself a coherence violation, not a silently skipped member check', () => {
    const violations = checkAtomCoherence({
      kind: 'text_type',
      normalization: 'NONE',
      pattern: '[',
      members: ['x'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('I-Regexp'))).toBe(true);
  });

  // ── settable-once `members` narrows by NFC-compared set, not written order (§7.5, §7.4) ─────

  it('narrows: members restated in another order is a restatement, not a change -- §7.5 gives set element order no meaning', () => {
    const source: TextType = { kind: 'text_type', normalization: 'NONE', members: ['SE', 'NO'] };
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', members: ['NO', 'SE'] }),
    ).toEqual([]);
  });
});

// ── regex_type: a member's own parsing contract is "a valid I-Regexp pattern" (§7.4) ───────────

describe('regex_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc9485';

  it("coherence: every member must itself parse as I-Regexp -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'regex_type',
      normalization: 'NONE',
      spec,
      members: ['[a-z]+', '['],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('I-Regexp'))).toBe(true);
  });

  it('coherence: a member set of well-formed patterns is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'regex_type',
        normalization: 'NONE',
        spec,
        members: ['[a-z]+', '[0-9]+'],
      }),
    ).toEqual([]);
  });
});

// ── uri_type/email_type: a member must satisfy the family's OWN facets too (§7.4) ──────────
//
// `text_type`'s shared length/pattern member rule is `textMemberCoherence`'s (tested above, and
// reused here through `textCoherence`); this is the family-specific half that rule deliberately
// leaves alone -- `scheme` and RFC 3986's grammar for `uri_type`, RFC 5322's dot-atom grammar for
// `email_type` -- run through each family's own compiled parser, the same one a read uses.

describe('uri_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc3986';

  it("coherence: every member must itself parse as a URI -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec,
      members: ['https://example.com', 'not a uri'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('not a uri'))).toBe(true);
  });

  it('coherence: every member must satisfy `schemes` too, not merely parse as some URI', () => {
    const violations = checkAtomCoherence({
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec,
      schemes: ['https'],
      members: ['https://example.com', 'ftp://example.com'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('ftp://example.com'))).toBe(true);
  });

  it('coherence: a member set of well-formed, scheme-conforming URIs is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'uri_type',
        allowRelative: true,
        allowFragment: true,
        normalization: 'NONE',
        spec,
        schemes: ['https'],
        members: ['https://a.example', 'https://b.example'],
      }),
    ).toEqual([]);
  });
});

describe('uri_type and iri_type narrowing (§5.7)', () => {
  const uri: UriType = {
    kind: 'uri_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc3986',
    allowRelative: true,
    allowFragment: true,
    normalization: 'NONE',
  };

  it('schemes narrows as a set, compared with ASCII case folded', () => {
    const source = { ...uri, schemes: ['http', 'https'] };
    expect(checkAtomNarrows(source, { ...uri, schemes: ['HTTPS'] })).toEqual([]);
    expect(checkAtomNarrows(source, { ...uri, schemes: ['ftp'] }).join(' ')).toContain('schemes');
    // An unset source admits every scheme, so setting one narrows it.
    expect(checkAtomNarrows(uri, { ...uri, schemes: ['https'] })).toEqual([]);
  });

  it('allow_relative and allow_fragment may be withdrawn and never granted back', () => {
    expect(checkAtomNarrows(uri, { ...uri, allowRelative: false })).toEqual([]);
    expect(checkAtomNarrows(uri, { ...uri, allowFragment: false })).toEqual([]);
    expect(checkAtomNarrows({ ...uri, allowRelative: false }, uri).join(' ')).toContain(
      'allow_relative',
    );
    expect(checkAtomNarrows({ ...uri, allowFragment: false }, uri).join(' ')).toContain(
      'allow_fragment',
    );
  });

  it('an iri_type narrows by the same rules, and refines only another iri_type', () => {
    const iri: IriType = {
      ...uri,
      kind: 'iri_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc3987',
    };
    expect(checkAtomNarrows(iri, { ...iri, allowRelative: false })).toEqual([]);
    expect(checkAtomNarrows(iri, { ...iri, schemes: ['https'] })).toEqual([]);
    expect(checkAtomNarrows(iri, uri).join(' ')).toContain('refines an iri');
  });
});

describe('identifier_type (§5.5, §7.7)', () => {
  const identifier: IdentifierType = {
    kind: 'identifier_type',
    spec: 'https://www.unicode.org/reports/tr31/',
    normalization: 'NFC',
    start: 'XID',
    continue: 'XID',
    continueAdd: '-',
  };

  it('narrows by text_type facets: a length bound tightens, a looser one is refused', () => {
    const source = { ...identifier, maxLength: 10n };
    expect(checkAtomNarrows(source, { ...source, maxLength: 5n })).toEqual([]);
    expect(checkAtomNarrows(source, { ...source, maxLength: 20n }).join(' ')).toContain(
      'max_length',
    );
  });

  it('is coherent when its length facets are, and incoherent when min_length exceeds max_length', () => {
    expect(checkAtomCoherence(identifier)).toEqual([]);
    expect(
      checkAtomCoherence({ ...identifier, minLength: 5n, maxLength: 2n }).length,
    ).toBeGreaterThan(0);
  });
});

describe('email_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc5322';

  it("coherence: every member must itself parse as an email address -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'email_type',
      normalization: 'NONE',
      spec,
      members: ['a@example.com', 'not an address'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('not an address'))).toBe(true);
  });

  it('coherence: a member set of well-formed addresses is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'email_type',
        normalization: 'NONE',
        spec,
        members: ['a@example.com', 'b@example.com'],
      }),
    ).toEqual([]);
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
      minPrefix: 40n,
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

  it('`excluding` may only grow under refinement -- dropping an exclusion widens (§5.7)', () => {
    const source: Cidr4Type = {
      kind: 'cidr4_type',
      spec: 'x',
      within: [],
      excluding: ['10.0.0.0/8', '192.168.0.0/16'],
    };
    expect(
      checkAtomNarrows(source, { ...source, excluding: ['10.0.0.0/8'] }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, {
        ...source,
        excluding: ['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'],
      }),
    ).toEqual([]);
  });
});

// ── ipv4_type / ipv6_type -- must agree with cidr4_type/cidr6_type on the same facet (§5.7) ─────

describe('ipv4_type -- within/excluding narrow exactly as cidr4_type does', () => {
  it('`within` shrinking to nothing widens to every address, and is refused -- not silently accepted', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: [],
    };
    expect(checkAtomNarrows(source, { ...source, within: [] }).length).toBeGreaterThan(0);
  });

  it('`within` shrinking to a subset narrows, and is accepted', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8', '192.168.0.0/16'],
      excluding: [],
    };
    expect(checkAtomNarrows(source, { ...source, within: ['10.0.0.0/8'] })).toEqual([]);
  });

  it('`excluding` may only grow, the same as cidr4_type', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: [],
      excluding: ['10.0.0.0/8'],
    };
    expect(checkAtomNarrows(source, { ...source, excluding: [] }).length).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, { ...source, excluding: ['10.0.0.0/8', '192.168.0.0/16'] }),
    ).toEqual([]);
  });
});

// §5.5's schema-load network obligation: "the pair MUST admit a value," decided exactly rather
// than pairwise. Every case here is a `cidr4_type`/`ipv4_type` body with no facet violation of
// its own (min_prefix <= max_prefix, both in range) — the only question under test is whether
// `within`/`excluding` between them leave anything.
describe('§5.5 network families -- within/excluding MUST admit a value', () => {
  it('a `within`/`excluding` pair that names the identical network admits nothing -- "{ min: 10 max: 3 } in another spelling"', () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/8'],
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('the same contradiction holds for an address family (ipv4_type), which has no prefix bounds of its own', () => {
    const violations = checkAtomCoherence({
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/8'],
    } satisfies Ipv4Type);
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('two `excluding` halves tile a `within` block exactly -- the tiling case a pairwise check misses', () => {
    // 10.0.0.0/9 and 10.128.0.0/9 together cover all of 10.0.0.0/8; neither alone does, so a
    // pairwise comparison against `within` in isolation would wrongly call this coherent.
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/9', '10.128.0.0/9'],
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('one of the two tiling halves missing leaves the other half of `within` free -- coherent', () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/9'],
    });
    expect(violations).toEqual([]);
  });

  it("the prefix bounds participate: max_prefix pinned to `within`'s own prefix leaves only the excluded block", () => {
    // The only network `max_prefix: 24` and `within: ["10.0.0.0/24"]` can produce is
    // 10.0.0.0/24 itself, which overlaps the excluded /32 -- no NETWORK is admitted, though
    // almost every individual ADDRESS in the block still would be.
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/24'],
      excluding: ['10.0.0.5/32'],
      maxPrefix: 24n,
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('an unconstrained pair (no within, no excluding) is trivially coherent', () => {
    expect(
      checkAtomCoherence({ kind: 'cidr4_type', spec: 'x', within: [], excluding: [] }),
    ).toEqual([]);
  });

  it("an `excluding` entry that isn't itself a valid network is reported and stops the admits-a-value question", () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: [],
      excluding: ['not-a-network'],
    });
    expect(violations.some((v) => v.includes("'excluding'") && v.includes('not-a-network'))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('admit no value'))).toBe(false);
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
    const source: EnumBody = { kind: 'enum', members: ['a', 'b', 'c'], type: 'identifier' };
    expect(
      checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b'], type: 'identifier' }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b', 'd'], type: 'identifier' })
        .length,
    ).toBeGreaterThan(0);
  });

  // ── §7.4, §5.4: an enum's type ──────────────────────────────────────────────────────

  it("coherence: an enum's members are not judged as names here -- type resolves in a namespace the body cannot see, so link/enumLabels.ts judges them (§7.4)", () => {
    const notAName: EnumBody = {
      kind: 'enum',
      members: ['sedentary', 'lightly active'],
      type: 'identifier',
    };
    expect(checkAtomCoherence(notAName)).toEqual([]);
    const valueSet: EnumBody = {
      kind: 'enum',
      members: ['sedentary', 'lightly active'],
      type: 'text',
    };
    expect(checkAtomCoherence(valueSet)).toEqual([]);
  });

  it('coherence: a member stated twice is refused -- text_member_set is unique_items: true (§7.4)', () => {
    const violations = checkAtomCoherence({
      kind: 'text_type',
      normalization: 'NONE',
      members: ['SE', 'SE'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('SE');
  });

  it('coherence: members compare as text, NFC -- two spellings of one string are one member stated twice (§7.4)', () => {
    const decomposedE = 'café'; // "café" spelled with a combining acute accent
    const precomposedE = 'café'; // "café" spelled precomposed
    expect(
      checkAtomCoherence({
        kind: 'text_type',
        normalization: 'NONE',
        members: [decomposedE, precomposedE],
      }).length,
    ).toBeGreaterThan(0);
  });

  // ── `pattern` syntax is validated at coherence, not silently skipped (§5.7, RFC 9485) ───────

  it('coherence: a syntactically invalid pattern is itself a coherence violation, not a silently skipped member check', () => {
    const violations = checkAtomCoherence({
      kind: 'text_type',
      normalization: 'NONE',
      pattern: '[',
      members: ['x'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('I-Regexp'))).toBe(true);
  });

  // ── settable-once `members` narrows by NFC-compared set, not written order (§7.5, §7.4) ─────

  it('narrows: members restated in another order is a restatement, not a change -- §7.5 gives set element order no meaning', () => {
    const source: TextType = { kind: 'text_type', normalization: 'NONE', members: ['SE', 'NO'] };
    expect(
      checkAtomNarrows(source, { kind: 'text_type', normalization: 'NONE', members: ['NO', 'SE'] }),
    ).toEqual([]);
  });
});

// ── regex_type: a member's own parsing contract is "a valid I-Regexp pattern" (§7.4) ───────────

describe('regex_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc9485';

  it("coherence: every member must itself parse as I-Regexp -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'regex_type',
      normalization: 'NONE',
      spec,
      members: ['[a-z]+', '['],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('I-Regexp'))).toBe(true);
  });

  it('coherence: a member set of well-formed patterns is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'regex_type',
        normalization: 'NONE',
        spec,
        members: ['[a-z]+', '[0-9]+'],
      }),
    ).toEqual([]);
  });
});

// ── uri_type/email_type: a member must satisfy the family's OWN facets too (§7.4) ──────────
//
// `text_type`'s shared length/pattern member rule is `textMemberCoherence`'s (tested above, and
// reused here through `textCoherence`); this is the family-specific half that rule deliberately
// leaves alone -- `scheme` and RFC 3986's grammar for `uri_type`, RFC 5322's dot-atom grammar for
// `email_type` -- run through each family's own compiled parser, the same one a read uses.

describe('uri_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc3986';

  it("coherence: every member must itself parse as a URI -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec,
      members: ['https://example.com', 'not a uri'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('not a uri'))).toBe(true);
  });

  it('coherence: every member must satisfy `schemes` too, not merely parse as some URI', () => {
    const violations = checkAtomCoherence({
      kind: 'uri_type',
      allowRelative: true,
      allowFragment: true,
      normalization: 'NONE',
      spec,
      schemes: ['https'],
      members: ['https://example.com', 'ftp://example.com'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('ftp://example.com'))).toBe(true);
  });

  it('coherence: a member set of well-formed, scheme-conforming URIs is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'uri_type',
        allowRelative: true,
        allowFragment: true,
        normalization: 'NONE',
        spec,
        schemes: ['https'],
        members: ['https://a.example', 'https://b.example'],
      }),
    ).toEqual([]);
  });
});

describe('uri_type and iri_type narrowing (§5.7)', () => {
  const uri: UriType = {
    kind: 'uri_type',
    spec: 'https://www.rfc-editor.org/rfc/rfc3986',
    allowRelative: true,
    allowFragment: true,
    normalization: 'NONE',
  };

  it('schemes narrows as a set, compared with ASCII case folded', () => {
    const source = { ...uri, schemes: ['http', 'https'] };
    expect(checkAtomNarrows(source, { ...uri, schemes: ['HTTPS'] })).toEqual([]);
    expect(checkAtomNarrows(source, { ...uri, schemes: ['ftp'] }).join(' ')).toContain('schemes');
    // An unset source admits every scheme, so setting one narrows it.
    expect(checkAtomNarrows(uri, { ...uri, schemes: ['https'] })).toEqual([]);
  });

  it('allow_relative and allow_fragment may be withdrawn and never granted back', () => {
    expect(checkAtomNarrows(uri, { ...uri, allowRelative: false })).toEqual([]);
    expect(checkAtomNarrows(uri, { ...uri, allowFragment: false })).toEqual([]);
    expect(checkAtomNarrows({ ...uri, allowRelative: false }, uri).join(' ')).toContain(
      'allow_relative',
    );
    expect(checkAtomNarrows({ ...uri, allowFragment: false }, uri).join(' ')).toContain(
      'allow_fragment',
    );
  });

  it('an iri_type narrows by the same rules, and refines only another iri_type', () => {
    const iri: IriType = {
      ...uri,
      kind: 'iri_type',
      spec: 'https://www.rfc-editor.org/rfc/rfc3987',
    };
    expect(checkAtomNarrows(iri, { ...iri, allowRelative: false })).toEqual([]);
    expect(checkAtomNarrows(iri, { ...iri, schemes: ['https'] })).toEqual([]);
    expect(checkAtomNarrows(iri, uri).join(' ')).toContain('refines an iri');
  });
});

describe('identifier_type (§5.5, §7.7)', () => {
  const identifier: IdentifierType = {
    kind: 'identifier_type',
    spec: 'https://www.unicode.org/reports/tr31/',
    normalization: 'NFC',
    start: 'XID',
    continue: 'XID',
    continueAdd: '-',
  };

  it('narrows by text_type facets: a length bound tightens, a looser one is refused', () => {
    const source = { ...identifier, maxLength: 10n };
    expect(checkAtomNarrows(source, { ...source, maxLength: 5n })).toEqual([]);
    expect(checkAtomNarrows(source, { ...source, maxLength: 20n }).join(' ')).toContain(
      'max_length',
    );
  });

  it('is coherent when its length facets are, and incoherent when min_length exceeds max_length', () => {
    expect(checkAtomCoherence(identifier)).toEqual([]);
    expect(
      checkAtomCoherence({ ...identifier, minLength: 5n, maxLength: 2n }).length,
    ).toBeGreaterThan(0);
  });
});

describe('email_type', () => {
  const spec = 'https://www.rfc-editor.org/rfc/rfc5322';

  it("coherence: every member must itself parse as an email address -- the family's own parsing contract still applies (§7.4)", () => {
    const violations = checkAtomCoherence({
      kind: 'email_type',
      normalization: 'NONE',
      spec,
      members: ['a@example.com', 'not an address'],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('not an address'))).toBe(true);
  });

  it('coherence: a member set of well-formed addresses is coherent', () => {
    expect(
      checkAtomCoherence({
        kind: 'email_type',
        normalization: 'NONE',
        spec,
        members: ['a@example.com', 'b@example.com'],
      }),
    ).toEqual([]);
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
      minPrefix: 40n,
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

  it('`excluding` may only grow under refinement -- dropping an exclusion widens (§5.7)', () => {
    const source: Cidr4Type = {
      kind: 'cidr4_type',
      spec: 'x',
      within: [],
      excluding: ['10.0.0.0/8', '192.168.0.0/16'],
    };
    expect(
      checkAtomNarrows(source, { ...source, excluding: ['10.0.0.0/8'] }).length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, {
        ...source,
        excluding: ['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'],
      }),
    ).toEqual([]);
  });
});

// ── ipv4_type / ipv6_type -- must agree with cidr4_type/cidr6_type on the same facet (§5.7) ─────

describe('ipv4_type -- within/excluding narrow exactly as cidr4_type does', () => {
  it('`within` shrinking to nothing widens to every address, and is refused -- not silently accepted', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: [],
    };
    expect(checkAtomNarrows(source, { ...source, within: [] }).length).toBeGreaterThan(0);
  });

  it('`within` shrinking to a subset narrows, and is accepted', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8', '192.168.0.0/16'],
      excluding: [],
    };
    expect(checkAtomNarrows(source, { ...source, within: ['10.0.0.0/8'] })).toEqual([]);
  });

  it('`excluding` may only grow, the same as cidr4_type', () => {
    const source: Ipv4Type = {
      kind: 'ipv4_type',
      spec: 'x',
      within: [],
      excluding: ['10.0.0.0/8'],
    };
    expect(checkAtomNarrows(source, { ...source, excluding: [] }).length).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, { ...source, excluding: ['10.0.0.0/8', '192.168.0.0/16'] }),
    ).toEqual([]);
  });
});

// §5.5's schema-load network obligation: "the pair MUST admit a value," decided exactly rather
// than pairwise. Every case here is a `cidr4_type`/`ipv4_type` body with no facet violation of
// its own (min_prefix <= max_prefix, both in range) — the only question under test is whether
// `within`/`excluding` between them leave anything.
describe('§5.5 network families -- within/excluding MUST admit a value', () => {
  it('a `within`/`excluding` pair that names the identical network admits nothing -- "{ min: 10 max: 3 } in another spelling"', () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/8'],
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('the same contradiction holds for an address family (ipv4_type), which has no prefix bounds of its own', () => {
    const violations = checkAtomCoherence({
      kind: 'ipv4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/8'],
    } satisfies Ipv4Type);
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('two `excluding` halves tile a `within` block exactly -- the tiling case a pairwise check misses', () => {
    // 10.0.0.0/9 and 10.128.0.0/9 together cover all of 10.0.0.0/8; neither alone does, so a
    // pairwise comparison against `within` in isolation would wrongly call this coherent.
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/9', '10.128.0.0/9'],
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('one of the two tiling halves missing leaves the other half of `within` free -- coherent', () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/8'],
      excluding: ['10.0.0.0/9'],
    });
    expect(violations).toEqual([]);
  });

  it("the prefix bounds participate: max_prefix pinned to `within`'s own prefix leaves only the excluded block", () => {
    // The only network `max_prefix: 24` and `within: ["10.0.0.0/24"]` can produce is
    // 10.0.0.0/24 itself, which overlaps the excluded /32 -- no NETWORK is admitted, though
    // almost every individual ADDRESS in the block still would be.
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: ['10.0.0.0/24'],
      excluding: ['10.0.0.5/32'],
      maxPrefix: 24n,
    });
    expect(violations.some((v) => v.includes('admit no value'))).toBe(true);
  });

  it('an unconstrained pair (no within, no excluding) is trivially coherent', () => {
    expect(
      checkAtomCoherence({ kind: 'cidr4_type', spec: 'x', within: [], excluding: [] }),
    ).toEqual([]);
  });

  it("an `excluding` entry that isn't itself a valid network is reported and stops the admits-a-value question", () => {
    const violations = checkAtomCoherence({
      kind: 'cidr4_type',
      spec: 'x',
      within: [],
      excluding: ['not-a-network'],
    });
    expect(violations.some((v) => v.includes("'excluding'") && v.includes('not-a-network'))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('admit no value'))).toBe(false);
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
    const source: EnumBody = { kind: 'enum', members: ['a', 'b', 'c'], type: 'identifier' };
    expect(
      checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b'], type: 'identifier' }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'enum', members: ['a', 'b', 'd'], type: 'identifier' })
        .length,
    ).toBeGreaterThan(0);
  });

  // ── §7.4, §5.4: an enum's type ──────────────────────────────────────────────────────

  it("coherence: an enum's members are not judged as names here -- type resolves in a namespace the body cannot see, so linking judges them (§7.4)", () => {
    const notAName: EnumBody = {
      kind: 'enum',
      members: ['sedentary', 'lightly active'],
      type: 'identifier',
    };
    expect(checkAtomCoherence(notAName)).toEqual([]);
  });

  it('coherence: where type is text, any text is a member', () => {
    const valueSet: EnumBody = {
      kind: 'enum',
      members: ['sedentary', 'lightly active'],
      type: 'text',
    };
    expect(checkAtomCoherence(valueSet)).toEqual([]);
  });

  it('coherence: a member stated twice is refused, under either type -- enum_set is unique_items: true (§9)', () => {
    const identifierDup: EnumBody = {
      kind: 'enum',
      members: ['OPEN', 'OPEN'],
      type: 'identifier',
    };
    expect(checkAtomCoherence(identifierDup).length).toBeGreaterThan(0);
    const textDup: EnumBody = { kind: 'enum', members: ['x', 'x'], type: 'text' };
    expect(checkAtomCoherence(textDup).length).toBeGreaterThan(0);
  });

  it("narrows: an enum's type is fixed where it is constructed, so a refinement restates it and never changes it, in either direction (§5.7, §7.4)", () => {
    const identifier: EnumBody = { kind: 'enum', members: ['a', 'b'], type: 'identifier' };
    const text: EnumBody = { kind: 'enum', members: ['a', 'b'], type: 'text' };
    // Restating the same type is always vacuously fine.
    expect(checkAtomNarrows(identifier, identifier)).toEqual([]);
    expect(checkAtomNarrows(text, text)).toEqual([]);
    // Neither direction of change is a narrowing.
    expect(checkAtomNarrows(text, identifier).join(' ')).toContain('fixed where it is constructed');
    expect(checkAtomNarrows(identifier, text).join(' ')).toContain('fixed where it is constructed');
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

  it('`format` narrows along its own order -- BINARY64 to BINARY32 tightens, the reverse widens (§5.7, §9)', () => {
    const source: FloatType = {
      kind: 'float_type',
      format: 'BINARY64',
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    };
    const narrower: FloatType = { ...source, format: 'BINARY32' };
    expect(checkAtomNarrows(source, narrower)).toEqual([]);
    expect(checkAtomNarrows(narrower, source).length).toBeGreaterThan(0);
  });

  it('`format` ranks the decimal radix as its own chain -- DECIMAL128 to DECIMAL32 tightens (§5.7, §9)', () => {
    const source: FloatType = {
      kind: 'float_type',
      // `ieee_format` (spec/m/meta.tn) declares six members `FloatFormat` does not -- see that
      // type's own doc on why only BINARY32/BINARY64 are in it.
      format: 'DECIMAL128' as FloatType['format'],
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    };
    const narrower: FloatType = { ...source, format: 'DECIMAL32' as FloatType['format'] };
    expect(checkAtomNarrows(source, narrower)).toEqual([]);
    expect(checkAtomNarrows(narrower, source).length).toBeGreaterThan(0);
  });

  it('`format` never narrows across radices, whichever direction (§5.5, §5.7)', () => {
    const source: FloatType = {
      kind: 'float_type',
      format: 'BINARY64',
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    };
    const decimal: FloatType = { ...source, format: 'DECIMAL32' as FloatType['format'] };
    expect(checkAtomNarrows(source, decimal).length).toBeGreaterThan(0);
    expect(checkAtomNarrows(decimal, source).length).toBeGreaterThan(0);
  });

  it('an unrecognised `format` member fails rather than silently narrowing (§5.7)', () => {
    const source: FloatType = {
      kind: 'float_type',
      format: 'BINARY64',
      allowNan: true,
      allowInfinity: true,
      allowSubnormal: true,
      allowNegativeZero: true,
    };
    const bogus: FloatType = { ...source, format: 'BOGUS' as unknown as FloatType['format'] };
    expect(checkAtomNarrows(source, bogus).length).toBeGreaterThan(0);
  });
});

// ── bytes_type ───────────────────────────────────────────────────────────────────────────────

describe('bytes_type', () => {
  it('`encoding` carries no narrowing relation at all -- restating it is fine, changing it is a resolver error (§5.5, §5.7)', () => {
    const source: BytesType = { kind: 'bytes_type', encoding: 'BASE64' };
    expect(checkAtomNarrows(source, { kind: 'bytes_type', encoding: 'BASE64' })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'bytes_type', encoding: 'HEX' }).length,
    ).toBeGreaterThan(0);
  });
});

// ── complex_type ─────────────────────────────────────────────────────────────────────────────

describe('complex_type', () => {
  it('`component` narrows along its own partial order within a chain (§5.7, §9)', () => {
    const source: ComplexType = { kind: 'complex_type', component: 'NUMBER' };
    // INTEGER ⊂ NUMBER ⊂ RATIONAL: narrower within the exact chain.
    expect(checkAtomNarrows(source, { kind: 'complex_type', component: 'INTEGER' })).toEqual([]);
    // RATIONAL is wider than NUMBER within the same chain.
    expect(
      checkAtomNarrows(source, { kind: 'complex_type', component: 'RATIONAL' }).length,
    ).toBeGreaterThan(0);
  });

  it('the exact and approximate chains are incomparable', () => {
    const source: ComplexType = { kind: 'complex_type', component: 'NUMBER' };
    expect(
      checkAtomNarrows(source, { kind: 'complex_type', component: 'FLOAT64' }).length,
    ).toBeGreaterThan(0);
  });
});

// ── duration_type / period_type ─────────────────────────────────────────────────────────────

describe('duration_type', () => {
  it('bounds narrow inward, and precision narrows to a coarser grid only (§5.5, §5.7)', () => {
    const source: DurationType = { kind: 'duration_type', min: 0n, max: 100n, precision: 3n };
    expect(
      checkAtomNarrows(source, { kind: 'duration_type', min: 10n, max: 50n, precision: 1n }),
    ).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'duration_type', min: -10n, max: 100n, precision: 3n })
        .length,
    ).toBeGreaterThan(0);
    expect(
      checkAtomNarrows(source, { kind: 'duration_type', min: 0n, max: 100n, precision: 9n }).length,
    ).toBeGreaterThan(0);
  });

  it("a refined multiple_of must itself be a multiple of the source's own -- 15 under 5 tightens, 7 under 5 does not (§5.7)", () => {
    const source: DurationType = { kind: 'duration_type', multipleOf: 5n };
    expect(checkAtomNarrows(source, { kind: 'duration_type', multipleOf: 15n })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'duration_type', multipleOf: 7n }).length,
    ).toBeGreaterThan(0);
  });

  it('coherence: min above max is incoherent, and precision may not exceed 9', () => {
    expect(checkAtomCoherence({ kind: 'duration_type', min: 10n, max: 3n }).length).toBeGreaterThan(
      0,
    );
    expect(checkAtomCoherence({ kind: 'duration_type', precision: 10n }).length).toBeGreaterThan(0);
  });
});

describe('period_type', () => {
  it('bounds narrow inward, no precision facet', () => {
    const source: PeriodType = { kind: 'period_type', min: 0n, max: 24n };
    expect(checkAtomNarrows(source, { kind: 'period_type', min: 6n, max: 12n })).toEqual([]);
    expect(
      checkAtomNarrows(source, { kind: 'period_type', min: 0n, max: 36n }).length,
    ).toBeGreaterThan(0);
  });
});

// ── Families with no orderable facet at all ─────────────────────────────────────────────────

describe('families with nothing to narrow or contradict', () => {
  it('value_type/void_type/uuid_type always report clean', () => {
    const cases: Atom[] = [{ kind: 'value_type' }, { kind: 'void_type' }, { kind: 'uuid_type' }];
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
    expect(isAtom({ kind: 'value_type' })).toBe(true);
    expect(isAtom({ kind: 'void_type' })).toBe(true);
    expect(
      isAtom({
        kind: 'identifier_type',
        spec: 's',
        normalization: 'NFC',
        start: 'XID',
        continue: 'XID',
      }),
    ).toBe(true);
    expect(
      isAtom({
        kind: 'iri_type',
        spec: 's',
        allowRelative: false,
        allowFragment: true,
        normalization: 'NONE',
      }),
    ).toBe(true);
    expect(isAtom({ kind: 'record', supertypes: [], fields: [], groups: [] })).toBe(false);
    expect(
      isAtom({ kind: 'reference', target: { name: 'x', arguments: [], annotations: [] } }),
    ).toBe(false);
    // A held template body: no `kind` tag at all (schema/meta's own contract).
    expect(
      isAtom({
        parameters: [{ name: 'T', type: { name: 'type_ref', arguments: [], annotations: [] } }],
        template: '!record { fields: [] }',
      }),
    ).toBe(false);
  });
});

// ── §5.5, §5.7: normalization and the identifier profile are fixed at construction ─────────────

describe('text families -- normalization is fixed where the type is constructed (§5.7)', () => {
  const text = (normalization: 'NONE' | 'NFKC_CASEFOLD' | 'ASCII_CASEFOLD'): Atom => ({
    kind: 'text_type',
    normalization,
  });

  it('a refinement may restate the normalization', () => {
    expect(checkAtomNarrows(text('NFKC_CASEFOLD'), text('NFKC_CASEFOLD'))).toEqual([]);
  });

  it('a refinement may not set or move it: Content-Type would be one value under the source and another under the refinement', () => {
    const violations = checkAtomNarrows(text('NONE'), text('NFKC_CASEFOLD'));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("changes 'normalization' from NONE to NFKC_CASEFOLD");
    expect(checkAtomNarrows(text('ASCII_CASEFOLD'), text('NFKC_CASEFOLD'))).toHaveLength(1);
  });
});

describe('text_type coherence -- members are values in the type’s form (§5.5)', () => {
  it('refuses two members that are one value under the form', () => {
    const atom: Atom = {
      kind: 'text_type',
      normalization: 'NFKC_CASEFOLD',
      members: ['UTF-8', 'utf-8'],
    };
    const violations = checkAtomCoherence(atom);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'UTF-8' and 'utf-8' are one value under NFKC_CASEFOLD");
  });

  it('keeps two members distinct when the form leaves them so', () => {
    expect(
      checkAtomCoherence({ kind: 'text_type', normalization: 'NONE', members: ['UTF-8', 'utf-8'] }),
    ).toEqual([]);
  });

  it('judges a member’s length and pattern as the value it is, in the form', () => {
    const atom: Atom = {
      kind: 'text_type',
      normalization: 'NFKC_CASEFOLD',
      members: ['ﬁ'],
      length: 2n,
      pattern: 'fi',
    };
    expect(checkAtomCoherence(atom)).toEqual([]);
  });
});

describe('identifier_type -- the profile is fixed at construction and must cohere (§5.5, §5.7)', () => {
  const identifier = (facets: Partial<IdentifierType> = {}): IdentifierType => ({
    kind: 'identifier_type',
    spec: 'https://www.unicode.org/reports/tr31/',
    normalization: 'NFC',
    start: 'XID',
    continue: 'XID',
    continueAdd: '-',
    ...facets,
  });

  it('a refinement restates every profile facet, however the set is spelled', () => {
    expect(
      checkAtomNarrows(identifier(), identifier({ pattern: '[a-z-]*', continueAdd: '--' })),
    ).toEqual([]);
  });

  it('a refinement may not move a profile facet, in either direction', () => {
    const widened = checkAtomNarrows(identifier(), identifier({ startAdd: '$' }));
    expect(widened).toHaveLength(1);
    expect(widened[0]).toContain("changes 'start_add'");
    const { continueAdd: _removed, ...withoutAddition } = identifier();
    expect(checkAtomNarrows(identifier(), withoutAddition)).toHaveLength(1);
    expect(checkAtomNarrows(identifier(), identifier({ start: 'ID' }))).toHaveLength(1);
    expect(checkAtomNarrows(identifier(), identifier({ normalization: 'NFKC' }))).toHaveLength(1);
  });

  it('refuses a medial character that is also Continue, which the profile could not place', () => {
    expect(checkAtomCoherence(identifier({ medial: '-' }))).toEqual([
      'U+002D is medial and also Start or Continue',
    ]);
  });

  it('refuses a profile with an empty Start set', () => {
    expect(
      checkAtomCoherence(identifier({ start: 'NONE', continue: 'NONE', continueAdd: 'abc' })),
    ).toEqual(['the Start set is empty, so no text is an identifier']);
  });

  it('refuses a member that is no identifier under the profile, judged as the value it is', () => {
    const violations = checkAtomCoherence(identifier({ members: ['north', '2nd'] }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("member '2nd' is not an identifier");
    expect(
      checkAtomCoherence(
        identifier({ normalization: 'NFKC_CASEFOLD', members: ['North'], continueAdd: '' }),
      ),
    ).toEqual([]);
  });
});
