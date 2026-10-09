/**
 * `stripSchema` / `stripSchemaKeepingDocs` -- a schema document's reading form. The rules are
 * those of `compiler/strip.ts`'s own contract, over the schema grammar (Part 2 §5) and the
 * adjacency rules of §7.5: `!!id` (§2.2.1) and the documentary annotations (§3.1) go, a header
 * reference's pin goes, and the spec's own library is named by revision and name.
 */
import { describe, expect, it } from 'vitest';
import { CORE_TN, META_KERNEL_TN, META_TN, POLICY_TN } from '../src/stdlib/schemas.generated.js';
import { TsonLexError, TsonParseError } from '../src/core/errors.js';
import { stripSchema, stripSchemaKeepingDocs } from '../src/compiler/strip.js';

const PIN = `?sha256=${'0123456789abcdef'.repeat(4)}`;

describe('stripSchema', () => {
  it('drops the !!id, pins and prose (§2.2.1, §3.1) and shortens the spec library', () => {
    const schema = `!!id:"https://example.test/thing-1.tn${PIN}"
!!meta:"https://tson.io/2026/37/m/meta.tn${PIN}"
!!import:"https://tson.io/2026/37/m/core.tn"
!!import:"https://example.test/shapes-1.tn${PIN}"
@doc:"""
  Things.
  """
{
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
    expect(stripSchema(schema)).toBe(`!!meta:"37/meta"
!!import:"37/core"
!!import:"https://example.test/shapes-1.tn"
{
thing => int32
@deprecated point => { x: float64 y?: float64 ~ 0.0 }
}
`);
  });

  it('keeping docs drops only @comment (§3.1)', () => {
    const schema = `!!meta:"https://tson.io/2026/37/m/meta.tn"
@doc:"Shapes."
{
  @doc:"A point." @title:"Point" @comment:"Kept in step with shapes-1."
  point => { @examples:[1.0 2.5] x: float64 }
}
`;
    expect(stripSchemaKeepingDocs(schema)).toBe(`!!meta:"37/meta"
@doc:"Shapes." {
@doc:"A point." @title:"Point" point => { @examples:[1.0 2.5] x: float64 }
}
`);
  });

  it('keeps adjacency as written, and collapses a run of whitespace to one space (§7.5)', () => {
    const schema = `!!meta:"https://tson.io/2026/37/m/meta.tn"
{   pair    =>   {   a?:text~"x"     b:  array<int32>  }   }
`;
    expect(stripSchema(schema)).toBe(
      '!!meta:"37/meta"\n{\npair => { a?:text~"x" b: array<int32> }\n}\n',
    );
  });

  it('rewrites a surviving multi-line token single-line as the same text (§7.2.2, §7.2.3)', () => {
    const schema = `!!meta:"https://tson.io/2026/37/m/meta.tn"
{
  @title:"""
    Two "quoted"
    lines
    """
  thing => int32
}
`;
    expect(stripSchemaKeepingDocs(schema)).toBe(
      '!!meta:"37/meta"\n{\n@title:"Two \\"quoted\\"\\nlines" thing => int32\n}\n',
    );
  });

  it('shortens only meta-kernel, meta and core under tson.io/<year>/<revision>/m/ (§2.2.1)', () => {
    const schema = `!!meta:"http://tson.io/2026/37/m/meta.tn${PIN}"
!!import:"https://tson.io/2026/37/m/meta-kernel.tn"
!!import:"https://tson.io/2026/37/x/core.tn"
!!import:"https://example.test/2026/37/m/core.tn"
!!import:"https://tson.io/2026/37/m/policy.tn"
{ thing => int32 }
`;
    expect(stripSchema(schema)).toBe(`!!meta:"37/meta"
!!import:"37/meta-kernel"
!!import:"https://tson.io/2026/37/x/core.tn"
!!import:"https://example.test/2026/37/m/core.tn"
!!import:"https://tson.io/2026/37/m/policy.tn"
{
thing => int32
}
`);
  });

  it("keeps a header reference's #fragment while dropping its query", () => {
    const schema = `!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://example.test/a.tn${PIN}#part"
{ thing => int32 }
`;
    expect(stripSchema(schema)).toContain('!!import:"https://example.test/a.tn#part"');
  });

  it.each([
    ['meta-kernel', META_KERNEL_TN],
    ['meta', META_TN],
    ['core', CORE_TN],
    ['policy', POLICY_TN],
  ])('strips the bundled %s schema to valid syntax with no prose', (_name, source) => {
    const stripped = stripSchema(source);
    expect(stripped.length).toBeLessThan(source.length / 2);
    for (const marker of ['@doc', '@comment', '@title', '@examples', 'sha256']) {
      expect(stripped).not.toContain(marker);
    }
    expect(
      stripped.split('\n').every((line) => line === '}' || line.trim() !== '' || line === ''),
    ).toBe(true);
  });

  it('starts each declaration on its own line, at its first annotation or its name', () => {
    const schema = `!!meta:"https://tson.io/2026/37/m/meta.tn"
{ @doc:"Paired." @title:"Pair" pair => <A, B> { first: A second: B } @deprecated old => int32
  @doc:"Last." last => { @examples:{ a => 1 } m?: int32 } }
`;
    expect(stripSchema(schema)).toBe(`!!meta:"37/meta"
{
pair => <A, B> { first: A second: B }
@deprecated old => int32
last => { m?: int32 }
}
`);
  });

  it('refuses a data document (§1.5, §2.2: a schema document requires !!meta)', () => {
    expect(() => stripSchema('{ a: 1 }\n')).toThrow(TsonParseError);
  });

  it('refuses a malformed schema, naming where it breaks', () => {
    const attempt = (): string =>
      stripSchema('!!meta:"https://tson.io/2026/37/m/meta.tn"\n{ thing => }\n');
    expect(attempt).toThrow(TsonParseError);
    try {
      attempt();
    } catch (error) {
      expect((error as TsonParseError).position.line).toBe(2);
    }
  });

  it('refuses a token that does not lex (§7.2.2)', () => {
    expect(() =>
      stripSchema('!!meta:"https://tson.io/2026/37/m/meta.tn"\n{ thing => "unterminated\n}\n'),
    ).toThrow(TsonLexError);
  });
});
