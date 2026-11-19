/**
 * `stripSchema` / `stripSchemaKeepingDocs` -- a schema document's reading form. The rules are
 * those of `compiler/strip.ts`'s own contract, over the schema grammar (Part 2 §5) and the
 * adjacency rules of §7.5: `!!id` (§2.2.1) and the documentary annotations (§3.1) go, a header
 * reference's pin goes, and the spec's own library is named by revision and name.
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_TN,
  NUMERIC_TN,
  TEMPORAL_TN,
  META_TN,
  NET_TN,
  POLICY_TN,
} from '../src/stdlib/schemas.generated.js';
import { TsonLexError, TsonParseError } from '../src/core/errors.js';
import { stripSchema, stripSchemaKeepingDocs } from '../src/compiler/strip.js';

const PIN = `?sha256=${'0123456789abcdef'.repeat(4)}`;

describe('stripSchema', () => {
  it('drops the !!id, pins and @doc (§2.2.1, §3.1), keeps every other annotation, and shortens the spec library', () => {
    const schema = `!!id:"https://example.test/thing-1.tn${PIN}"
!!import:"https://tson.io/2026/39/m/core.tn"
!!import:"https://example.test/shapes-1.tn${PIN}"
@doc:"""
  Things.
  """
!schema {
  @doc:"An identifier."
  thing => int32

  @title:"Point"
  @comment:"Kept in step with shapes-1."
  @deprecated
  point => {
    @doc:"""
      Across.
      """
    @examples:[1.0 2.5]
    x: float64
    y?: float64 ~ 0.0
  }
}
`;
    expect(stripSchema(schema)).toBe(`!!import:"39/core"
!!import:"https://example.test/shapes-1.tn"
!schema {
thing => int32
@title:"Point" @comment:"Kept in step with shapes-1." @deprecated point => { @examples:[1.0 2.5] x: float64 y?: float64 ~ 0.0 }
}
`);
  });

  it('keeping docs keeps every annotation (§3.1)', () => {
    const schema = `@doc:"Shapes."
!schema {
  @doc:"A point." @title:"Point" @comment:"Kept in step with shapes-1."
  point => { @examples:[1.0 2.5] x: float64 }
}
`;
    expect(stripSchemaKeepingDocs(schema)).toBe(`@doc:"Shapes." !schema {
@doc:"A point." @title:"Point" @comment:"Kept in step with shapes-1." point => { @examples:[1.0 2.5] x: float64 }
}
`);
  });

  it('keeps adjacency as written, and collapses a run of whitespace to one space (§7.5)', () => {
    const schema = `!schema {   pair    =>   {   a?:text~"x"     b:  array<int32>  }   }
`;
    expect(stripSchema(schema)).toBe('!schema {\npair => { a?:text~"x" b: array<int32> }\n}\n');
  });

  it('rewrites a surviving multi-line token single-line as the same text (§7.2.2, §7.2.3)', () => {
    const schema = `!schema {
  @title:"""
    Two "quoted"
    lines
    """
  thing => int32
}
`;
    expect(stripSchemaKeepingDocs(schema)).toBe(
      '!schema {\n@title:"Two \\"quoted\\"\\nlines" thing => int32\n}\n',
    );
  });

  it('shortens only the five libraries a schema builds on under tson.io/<year>/<revision>/m/ (§2.2.1)', () => {
    const schema = `!!import:"https://tson.io/2026/39/m/meta.tn"
!!import:"https://tson.io/2026/39/m/meta-kernel.tn"
!!import:"https://tson.io/2026/39/x/core.tn"
!!import:"https://example.test/2026/39/m/core.tn"
!!import:"https://tson.io/2026/39/m/net.tn"
!!import:"https://tson.io/2026/39/m/policy.tn"
!schema { thing => int32 }
`;
    expect(stripSchema(schema)).toBe(`!!import:"39/meta"
!!import:"https://tson.io/2026/39/m/meta-kernel.tn"
!!import:"https://tson.io/2026/39/x/core.tn"
!!import:"https://example.test/2026/39/m/core.tn"
!!import:"39/net"
!!import:"https://tson.io/2026/39/m/policy.tn"
!schema {
thing => int32
}
`);
  });

  it("keeps a header reference's #fragment while dropping its query", () => {
    const schema = `!!import:"https://example.test/a.tn${PIN}#part"
!schema { thing => int32 }
`;
    expect(stripSchema(schema)).toContain('!!import:"https://example.test/a.tn#part"');
  });

  it.each([
    ['meta', META_TN],
    ['numeric', NUMERIC_TN],
    ['temporal', TEMPORAL_TN],
    ['net', NET_TN],
    ['core', CORE_TN],
    ['policy', POLICY_TN],
  ])('strips the bundled %s schema to valid syntax with no @doc', (_name, source) => {
    const stripped = stripSchema(source);
    expect(stripped.length).toBeLessThan(source.length / 2);
    for (const marker of ['@doc', 'sha256']) {
      expect(stripped).not.toContain(marker);
    }
    expect(
      stripped.split('\n').every((line) => line === '}' || line.trim() !== '' || line === ''),
    ).toBe(true);
  });

  it('starts each declaration on its own line, at its first annotation or its name', () => {
    const schema = `!schema { @doc:"Paired." @title:"Pair" pair => <A, B> { first: A second: B } @deprecated old => int32
  @doc:"Last." last => { @examples:{ a => 1 } m?: int32 } }
`;
    expect(stripSchema(schema)).toBe(`!schema {
@title:"Pair" pair => <A, B> { first: A second: B }
@deprecated old => int32
last => { @examples:{ a => 1 } m?: int32 }
}
`);
  });

  it("refuses a data document (§2.2: a schema document's root is tagged '!schema')", () => {
    expect(() => stripSchema('{ a: 1 }\n')).toThrow(TsonParseError);
  });

  it('refuses a malformed schema, naming where it breaks', () => {
    const attempt = (): string =>
      stripSchema('!!import:"https://tson.io/2026/39/m/core.tn"\n!schema { thing => }\n');
    expect(attempt).toThrow(TsonParseError);
    try {
      attempt();
    } catch (error) {
      expect((error as TsonParseError).position.line).toBe(2);
    }
  });

  it('refuses a token that does not lex (§7.2.2)', () => {
    expect(() =>
      stripSchema(
        '!!import:"https://tson.io/2026/39/m/core.tn"\n!schema { thing => "unterminated\n}\n',
      ),
    ).toThrow(TsonLexError);
  });
});
