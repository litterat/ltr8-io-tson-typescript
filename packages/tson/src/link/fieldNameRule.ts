/**
 * What a schema-governed record's field names are judged by as a reader meets them ([TSON-SCHEMA]
 * §5.2, §7.2, §7.7): the record's name type, the kernel's `field_name` where it states none. Shared
 * by every reader of both encodings -- the text tree and bind readers and the JSON record reader
 * ([TSON-JSON] §6.1.1, §9.4) -- so a document's verdict does not depend on which one read it, nor on
 * which encoding carried it. It lives beside the linker's own judgement of the declared names
 * (`fieldNames.ts`) because it is that judgement turned round to face a document: it reads only the
 * name type linking recorded (`LinkedSchema.nameTypes`), and no reader's machinery.
 *
 * **A name is matched in the type's form.** A declared field and a document's name are compared in
 * the name type's `normalization` -- the equality linking judged the declared names distinct under
 * -- so under a case-folding type `NAME` is the field `name`, and two spellings of one name in one
 * record are a duplicate field. Under the default, NFC, every name's form already (the stream
 * normalises a field name's decoded text, [TSON-DATA] §2.5), the key is the name itself.
 *
 * **The name type judges a name before closure does.** A name that is a value of the type is a
 * name, and meets [TSON-DATA] §8.2's per-name rules under the type's profile -- so a look-alike of
 * a declared name is refused, and never also reported as an unknown field. A name that is no value
 * of the type can be no declared field, since every declared name is one, and is unrecognised
 * without reaching the policy: no name rule reaches what is no name. A record nested in a relaxed
 * one is read by its own reader and so judges its own names.
 */
import { createIdentifierParser } from '../atom/text/identifier.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import {
  identifierProfileOf,
  isIdentifierText,
  NAME_PROFILE,
  type IdentifierProfile,
} from '../unicode/identifier-profile.js';
import { applyNormalization } from '../unicode/normalization.js';
import type { FieldNameType } from './fieldNames.js';

/** One record's field-name rule: its name type, read once when the reader is built. */
export interface FieldNameRule {
  /** The name type the record states, for a message -- `undefined` for the kernel's `field_name`. */
  readonly typeName?: string;
  /** The form a name is matched in. */
  readonly form: Normalization;
  readonly profile: IdentifierProfile;
  /** Why `name` is no value of the type, or `undefined` when it is one. */
  refusal(name: string): string | undefined;
}

/** The kernel's `field_name`: [TSON-DATA] §7.7's grammar, asked of every name of an ordinary document. */
export const FIELD_NAME_RULE: FieldNameRule = {
  form: 'NFC',
  profile: NAME_PROFILE,
  refusal: (name) => (isIdentifierText(name) ? undefined : 'it is not an identifier'),
};

/** The rule a record whose name type linking recorded (`LinkedSchema.nameTypes`) is read by. */
export function fieldNameRule(nameType: FieldNameType | undefined): FieldNameRule {
  if (nameType === undefined) return FIELD_NAME_RULE;
  const parser = createIdentifierParser(nameType.typeName, nameType.definition);
  return {
    typeName: nameType.typeName,
    form: nameType.definition.normalization,
    profile: identifierProfileOf(nameType.definition),
    refusal(name) {
      try {
        parser.read({ text: name, form: 'single-line' });
        return undefined;
      } catch (error) {
        if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
          return error.message;
        }
        throw error;
      }
    },
  };
}

/** `name` in `rule`'s form: the key a declared field and a document's name are matched by. */
export function matchKey(rule: FieldNameRule, name: string): string {
  return rule.form === 'NFC' ? name : applyNormalization(rule.form, name);
}
