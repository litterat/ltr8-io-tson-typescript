/**
 * The declarations a read has not made ready that may be the member of a family ([TSON-SCHEMA] §5.2) a value's pins
 * select, judged from what each writes, never by resolving one (§3.4.1): its written operands (a composition's, a
 * refinement's source, an alias's target, an application's head) reach the family's base, an entry IS-A it, or a
 * declaration that may be a member; a subtraction joins nothing (§5.9). Its pin for a selector is the nearest one
 * written on that walk, its own first, since a restatement never changes a pin (§5.8), and a declaration whose pin
 * differs from the value's is none.
 *
 * What this answers is the wait §3.4.1's first rule states: a value placed by its pins waits on each declaration not
 * yet ready that may be its member, so a member declared after the value that selects it is ready when the value is
 * placed, as it is once every entry is ready.
 *
 * @module
 */
import type { Declaration } from '../ast/schema/document.js';
import type { RecordDef, StructuralDef, TypeDef } from '../ast/schema/typedef.js';
import type { TypeExpr as AstTypeExpr } from '../ast/schema/typeref.js';
import type { Top } from '../schema/meta/typedef.js';
import { supertypesOf } from '../schema/meta/typedef.js';
import { typeParamsOf } from './desugar.js';

/** Whether a value's written `pin` for `selector` is one value with the pin a declaration states. */
export type SamePin = (selector: string, pin: string) => boolean;

/**
 * Each declaration `notHeld` admits that may be the member of `base` the value's pins select: one whose written
 * operands may reach `base`, and whose nearest pin for every selector, where it states one, is the value's.
 */
export function familyJoiners(
  base: string,
  selectors: Iterable<string>,
  samePin: SamePin,
  declarations: ReadonlyMap<string, Declaration>,
  entries: (name: string) => Top | undefined,
  notHeld: (name: string) => boolean,
): string[] {
  const walk = new Walk(base, declarations, entries);
  const wanted = [...selectors];
  const joiners: string[] = [];
  for (const [name, declaration] of declarations) {
    // A parametric record is no member (§5.10); it is an operand of the applications that close it.
    if (!notHeld(name) || typeParamsOf(declaration.typeDef).length > 0) continue;
    if (!walk.mayJoin(name, new Set())) continue;
    const pinned = wanted.every((selector) => {
      const pin = walk.pin(name, selector, new Set());
      return pin === undefined || samePin(selector, pin);
    });
    if (pinned) joiners.push(name);
  }
  return joiners;
}

class Walk {
  constructor(
    private readonly base: string,
    private readonly declarations: ReadonlyMap<string, Declaration>,
    private readonly entries: (name: string) => Top | undefined,
  ) {}

  /** Whether `name`, a declaration, may be IS-A the base by what it writes. */
  mayJoin(name: string, visiting: Set<string>): boolean {
    if (visiting.has(name)) return false;
    visiting.add(name);
    return operands(this.declarations.get(name)?.typeDef).some((operand) =>
      this.isA(operand, visiting),
    );
  }

  private isA(name: string, visiting: Set<string>): boolean {
    if (name === this.base) return true;
    const ready = this.entries(name);
    if (ready !== undefined) {
      return ready.kind === 'alias'
        ? this.isA(ready.target.name, visiting)
        : supertypesOf(ready).includes(this.base);
    }
    return this.declarations.has(name) && this.mayJoin(name, visiting);
  }

  /** The nearest pin written for `selector` on `name`'s walk, `undefined` where none is. */
  pin(name: string, selector: string, visiting: Set<string>): string | undefined {
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    const ready = this.entries(name);
    if (ready !== undefined) {
      if (ready.kind === 'alias') return this.pin(ready.target.name, selector, visiting);
      if (ready.kind !== 'record') return undefined;
      const field = ready.fields.entries.get(selector);
      return field?.role === 'FIXED' ? field.value?.text : undefined;
    }
    const declaration = this.declarations.get(name);
    if (declaration === undefined) return undefined;
    const own = writtenPin(bodyOf(declaration.typeDef), selector);
    if (own !== undefined) return own;
    for (const operand of operands(declaration.typeDef)) {
      const inherited = this.pin(operand, selector, visiting);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  }
}

function writtenPin(body: RecordDef | undefined, selector: string): string | undefined {
  for (const entry of body?.entries ?? []) {
    if (entry.kind === 'fieldDef' && entry.name === selector && entry.modifier?.kind === 'fixed') {
      return entry.modifier.token.text;
    }
  }
  return undefined;
}

function bodyOf(typeDef: TypeDef): RecordDef | undefined {
  if (typeDef.kind !== 'structuralTypeDef') return undefined;
  const body: StructuralDef = typeDef.body;
  return body.kind === 'constructionDef' ? body.body : body;
}

/** The names a declaration writes as its parents, an application by its head. */
function operands(typeDef: TypeDef | undefined): string[] {
  if (typeDef === undefined) return [];
  switch (typeDef.kind) {
    case 'structuralTypeDef': {
      const body = typeDef.body;
      if (body.kind === 'recordDef' || body.removal !== undefined) return [];
      return body.supertypes.flatMap((type) => named(type));
    }
    case 'typeExprDef':
      return named(typeDef.ref);
    case 'atomRefinement':
      return [typeDef.target];
    default:
      return [];
  }
}

function named(type: AstTypeExpr): string[] {
  return type.kind === 'nameRef' || type.kind === 'applicationRef' ? [type.name] : [];
}
