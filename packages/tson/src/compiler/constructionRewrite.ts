/**
 * Construction sugar on the written form (§5.3, §5.10): `!meta.apply { head: C  arguments: [a₁ … aₙ] }` over a
 * constructor `C` is rewritten to the binding record `!C { f₁: a₁ … fₙ: aₙ }` before anything reads it, its
 * argument slots (`constructionSugar.ts`) filled in order, innermost first; over an incomplete entry it is the
 * completion (§5.5). Every application left is then kernel data: a parametric record's, its arguments names or
 * parameters, the kernel's `meta.apply` typing them `[meta.type_ref; 1..]`. So a payload is read once, under the
 * kernel's own types.
 *
 * **Who wrote an application decides how much is rewritten.** One desugaring wrote from `head<args>` is the
 * author's sugar, nested applications and all: a constructor's is constructed, and an argument of any other that
 * is no name is refused (§5.3). One the author wrote out, `{ of: !meta.apply { … } }`, means what the sugar means
 * where its arguments are names (§5.10), and is rewritten then; one whose arguments hold a type in place is left as
 * written, for the kernel's reader to refuse.
 *
 * **A parametric record's application orders nothing** (a name at a type position, §3.4.1): whether a head is one
 * is asked without making it ready (`opens`), so `chain => <T> { next?: chain<T> }` and mutual recursion wait on
 * nothing. Any other head is made ready before it is asked whether it constructs, as reading a construction
 * against it would make it.
 *
 * A value comes back as the same object where nothing in it changed, so what is keyed on a value desugaring wrote
 * still finds it.
 */
import { TsonInternalError, TsonSchemaValidationError } from '../core/errors.js';
import type { ApplicationRef } from '../ast/schema/typeref.js';
import type { CoreValue, DataValue, RecordField, RecordValue } from '../ast/value.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import type { IncompleteEntry } from '../schema/meta/typedef.js';
import { terminal } from '../link/aliasChain.js';
import { applicationValue } from './desugar.js';
import * as IncompleteEntries from './incompleteEntries.js';
import {
  constructs,
  refuseNamespaceInPlace,
  requireArity,
  slots,
  slotsInPlace,
} from './constructionSugar.js';
import { APPLY, ARGUMENTS, HEAD, OF, member } from './wireForm.js';
import type { DefinitionGetter } from './resolverTypes.js';

/** Rewrites constructions spelled as applications, over the heads `types` finds. */
export interface ConstructionRewrite {
  /** `written` with each constructor's application in it written as its construction in place. */
  inPlace(written: DataValue, desugared: boolean): DataValue;
  /**
   * `generic`, written at a declaration's body (`x => meta.array<text>`), as the construction it spells, tagged
   * by its head as written; `undefined` where its head is no constructor.
   */
  body(generic: ApplicationRef): DataValue | undefined;
  /**
   * `generic`, written at a type slot (`f: meta.array<text>`), as the construction it spells, tagged by its
   * constructor past its alias hops; `undefined` where its head is no constructor, every argument then a name.
   */
  atSlot(generic: ApplicationRef): DataValue | undefined;
  /** The constructor or incomplete entry `head` applies past its alias hops, or `undefined` where it applies none. */
  constructorOf(head: string): string | undefined;
}

/**
 * A rewrite over `types`, where a head and a constructor's slots are found (asking for a declaration not yet ready
 * makes it ready), and `opens`, whether a head past its alias hops is a parametric record, asked without waiting.
 */
export function createConstructionRewrite(
  types: DefinitionGetter,
  opens: (head: string) => boolean,
): ConstructionRewrite {
  function constructorOf(head: string): string | undefined {
    if (opens(head)) return undefined;
    const name = terminal(head, types);
    const definition = types(name);
    return constructs(name, definition) || definition?.kind === 'incomplete' ? name : undefined;
  }

  function inPlace(written: DataValue, desugared: boolean): DataValue {
    if (isApplication(written)) return applied(written, desugared, true);
    const core = written.coreValue;
    let rewritten: CoreValue = core;
    switch (core.kind) {
      case 'record': {
        const fields = core.fields.map((field): RecordField => {
          const value =
            field.name === OF ? ofInPlace(field.value, desugared) : inPlace(field.value, desugared);
          return value === field.value ? field : { name: field.name, value };
        });
        if (fields.some((field, index) => field !== core.fields[index])) {
          rewritten = { kind: 'record', fields };
        }
        break;
      }
      case 'array': {
        const elements = core.elements.map((element) => inPlace(element, desugared));
        if (elements.some((element, index) => element !== core.elements[index])) {
          rewritten = { kind: 'array', elements };
        }
        break;
      }
      case 'map': {
        const entries = core.entries.map((entry) => {
          const value = inPlace(entry.value, desugared);
          return value === entry.value ? entry : { key: entry.key, value };
        });
        if (entries.some((entry, index) => entry !== core.entries[index])) {
          rewritten = { kind: 'map', entries };
        }
        break;
      }
      default:
        break;
    }
    return rewritten === core ? written : { ...written, coreValue: rewritten };
  }

  /**
   * One application: a constructor's as its construction, any other as written. A declaration's body is the one
   * construction not `inPlace`: it is tagged by the head as written, which its entry records as its constructor,
   * and no namespace type is refused there.
   */
  function applied(written: DataValue, desugared: boolean, atSlot: boolean): DataValue {
    const apply = written.coreValue as RecordValue;
    const headValue = member(apply, HEAD)?.coreValue;
    const listed = member(apply, ARGUMENTS)?.coreValue;
    if (headValue?.kind !== 'token' || listed?.kind !== 'array') return written;
    const head = headValue.text;
    const argumentsWritten = listed.elements;
    if (!desugared && !argumentsWritten.every(isName)) return written;
    const constructor = constructorOf(head);
    if (constructor === undefined && !atSlot) return written;
    const constructed = argumentsWritten.map((argument) =>
      isName(argument) ? argument : inPlace(argument, desugared),
    );
    if (constructor === undefined) {
      for (const argument of argumentsWritten) {
        if (!isName(argument)) {
          throw argumentNotAName(text(argument), suggestedName(argument), text(written));
        }
      }
      return written;
    }
    const definition = types(constructor);
    if (definition?.kind === 'incomplete') {
      const base = types(definition.head);
      if (base?.kind !== 'record') return written;
      return completedApplication(
        written,
        head,
        definition,
        base,
        argumentsWritten,
        constructed,
        atSlot,
      );
    }
    const record = definition as RecordBody;
    const slotNames = slots(record, types);
    if (atSlot) {
      refuseNamespaceInPlace(
        text(written),
        head,
        argumentsWritten.map(text),
        slotNames,
        constructor,
        record,
      );
    }
    requireArity(head, slotNames, constructed.length);
    const inPlaceSlots = slotsInPlace(record, types);
    const fields: RecordField[] = slotNames.map((slot, index) =>
      slotField(slot, argumentsWritten[index], constructed[index], inPlaceSlots[index] === true),
    );
    return {
      annotations: written.annotations,
      typeRef: atSlot ? constructor : head,
      coreValue: { kind: 'record', fields },
    };
  }

  /**
   * An application of an incomplete entry, its arguments filling the type slots the entry leaves absent, in its
   * constructor's declared order. A declaration's body is tagged by the head as written, for the declaration to
   * complete; in place it is the completion itself, its constructor's construction over the merged body.
   */
  function completedApplication(
    written: DataValue,
    head: string,
    incomplete: IncompleteEntry,
    constructor: RecordBody,
    argumentsWritten: readonly DataValue[],
    constructed: readonly DataValue[],
    atSlot: boolean,
  ): DataValue {
    const allSlots = slots(constructor, types);
    const allInPlace = slotsInPlace(constructor, types);
    const slotNames: string[] = [];
    const inPlaceSlots: boolean[] = [];
    allSlots.forEach((slot, index) => {
      if (incomplete.absent.includes(slot)) {
        slotNames.push(slot);
        inPlaceSlots.push(allInPlace[index] === true);
      }
    });
    if (slotNames.length !== constructed.length) {
      throw new TsonSchemaValidationError(
        slotNames.length === 0
          ? `'${head}' is an incomplete '${incomplete.head}' leaving [${incomplete.absent.join(', ')}] absent, ` +
              `none of them a type slot, so '${head}<...>' has nothing to fill; complete it in braces, ` +
              `'!${head} { ... }', as a declaration (§5.5)`
          : `'${head}' is an incomplete '${incomplete.head}' whose absent type slots are ` +
              `[${slotNames.join(', ')}], so '${head}<...>' takes ${String(slotNames.length)} argument` +
              `${slotNames.length === 1 ? '' : 's'}, one for each in that order, but ${String(constructed.length)} ` +
              `${constructed.length === 1 ? 'was' : 'were'} applied (§5.5)`,
      );
    }
    const fields: RecordField[] = slotNames.map((slot, index) =>
      slotField(slot, argumentsWritten[index], constructed[index], inPlaceSlots[index] === true),
    );
    const application: DataValue = {
      annotations: written.annotations,
      typeRef: head,
      coreValue: { kind: 'record', fields },
    };
    if (!atSlot) return application;
    refuseNamespaceInPlace(
      text(written),
      head,
      argumentsWritten.map(text),
      slotNames,
      incomplete.head,
      constructor,
    );
    return IncompleteEntries.completed(text(written), head, incomplete, constructor, application);
  }

  /**
   * The `of` of a type written in place: where it is tagged by an incomplete entry, `{ of: !X { … } }`, the
   * completion in place, its constructor's construction. Only a type in place is asked, its tag being read against
   * anyway.
   */
  function ofInPlace(written: DataValue, desugared: boolean): DataValue {
    const tag = written.typeRef;
    if (tag === undefined || opens(tag) || types(tag) === undefined) {
      return inPlace(written, desugared);
    }
    const incomplete = types(terminal(tag, types));
    if (incomplete?.kind !== 'incomplete') return inPlace(written, desugared);
    const base = types(incomplete.head);
    if (base?.kind !== 'record') return inPlace(written, desugared);
    const payload = inPlace(
      { annotations: written.annotations, coreValue: written.coreValue },
      desugared,
    );
    return IncompleteEntries.completed(`!${tag}`, tag, incomplete, base, payload);
  }

  return {
    inPlace,
    body(generic: ApplicationRef): DataValue | undefined {
      const written = applicationValue(generic);
      const constructed = applied(written, true, false);
      return constructed === written ? undefined : constructed;
    },
    atSlot(generic: ApplicationRef): DataValue | undefined {
      const written = applicationValue(generic);
      const constructed = applied(written, true, true);
      return constructed === written ? undefined : constructed;
    },
    constructorOf,
  };
}

/**
 * One argument slot filled: `constructed`, the argument `written` as the construction reads it. A slot holding a
 * name alone takes a name, and a type written in place there is refused, declared and named instead (§4.2).
 */
function slotField(
  slot: string,
  written: DataValue | undefined,
  constructed: DataValue | undefined,
  inPlace: boolean,
): RecordField {
  if (written === undefined || constructed === undefined) {
    throw new TsonInternalError(`the argument for slot '${slot}' is missing after the arity check`);
  }
  if (!isName(written) && !inPlace) throw nameRequired(text(written), suggestedName(written));
  return { name: slot, value: constructed };
}

function isApplication(value: DataValue): boolean {
  return value.typeRef === APPLY && value.coreValue.kind === 'record';
}

function isName(argument: DataValue): boolean {
  return argument.typeRef === undefined && argument.coreValue.kind === 'token';
}

/**
 * A type as the author wrote it at an application, for a message: a name, an application as `head<argument
 * argument>`, a type in place by its constructor.
 */
export function text(written: DataValue): string {
  const core = written.coreValue;
  if (core.kind === 'token') return core.text;
  if (core.kind !== 'record') return core.kind;
  if (!isApplication(written)) {
    const of = member(core, OF);
    return of === undefined ? `!${written.typeRef ?? ''} { ... }` : text(of);
  }
  const head = member(core, HEAD);
  const listed = member(core, ARGUMENTS)?.coreValue;
  const argumentsWritten = listed?.kind === 'array' ? listed.elements : [];
  return `${head === undefined ? '' : text(head)}<${argumentsWritten.map(text).join(' ')}>`;
}

/**
 * A name for a declaration of `written`, for a message: the head's last segment, then each argument's, `my` for
 * one that is no name.
 */
export function suggestedName(written: DataValue): string {
  const core = written.coreValue;
  const application =
    core.kind === 'record' && !isApplication(written) ? (member(core, OF) ?? written) : written;
  if (!isApplication(application)) return 'my_type';
  const record = application.coreValue as RecordValue;
  const head = member(record, HEAD);
  let name = lastSegment(head === undefined ? '' : text(head));
  const listed = member(record, ARGUMENTS)?.coreValue;
  if (listed?.kind === 'array') {
    for (const argument of listed.elements) {
      name += `_${isName(argument) ? lastSegment(text(argument)) : 'my'}`;
    }
  }
  return name;
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** An application written where only a name may stand (§4.2), naming the declaration to write instead. */
export function nameRequired(written: string, suggested: string): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${written}' is an application, and it stands where only a name may stand -- a map's key, a ` +
      "reference's 'of', a parameter's bound or an alias's target -- where an application closes nowhere " +
      `(§4.2): declare it ('${suggested} => ${written}') and write that name`,
  );
}

/** An application or construction passed as an argument of a parametric record's application (§5.3, §5.10). */
export function argumentNotAName(
  argument: string,
  suggested: string,
  application: string,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${argument}' is passed as an argument of '${application}', and an argument of a parametric record's ` +
      `application is a name or a parameter (§5.3): declare it ('${suggested} => ${argument}') and pass that name`,
  );
}
