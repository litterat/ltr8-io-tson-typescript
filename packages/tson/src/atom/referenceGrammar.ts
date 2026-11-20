/**
 * A reference's text, whatever the token's form ([TSON-DATA] §2.4, §7.4): a qualified name, one or more
 * segments joined by `.`, none empty, the first an identifier (§7.7). A reference in a value is a name, and
 * no production of the data grammar: a token of either form, read by its position. This is where the
 * JSON string at a reference ([TSON-JSON] §5.6) is read, JSON having no unquoted form.
 *
 * ```
 * qualified-name = identifier *("." segment)
 * ```
 *
 * An argument list and a sibling mark are schema grammar: text holding either fails this grammar as
 * any other text that is no name does, the message saying so. This is the grammar alone: what the name
 * resolves to is the position's to judge. No regular expression stands in it -- the first segment is
 * matched by the identifier grammar (§7.7).
 */
import { TsonAtomParseError } from '../core/errors.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { toNfc } from '../unicode/nfc.js';

/** The `expected` fragment every failure of this grammar reports. */
const A_REFERENCE = 'a reference';

/**
 * Whether `text` is a qualified name: one or more identifiers (§7.7) joined by `.`, none empty,
 * each matched in full.
 */
export function isQualifiedName(text: string): boolean {
  if (text.length === 0) return false;
  for (const segment of text.split('.')) {
    if (!isIdentifierText(segment)) return false;
  }
  return true;
}

/**
 * Whether `field` may stand before a dependent type's `!` ([TSON-SCHEMA] §12.1): one identifier, a
 * single segment. A dotted name would be a chained projection, which the grammar does not have.
 */
export function isSiblingField(field: string): boolean {
  return field.length > 0 && !field.includes('.') && isIdentifierText(field);
}

/**
 * `text` as the reference it spells: a qualified name, in NFC as a quoted name is read at every naming
 * position (§7.7), so a decomposed spelling is the name its composed one is.
 *
 * @throws TsonAtomParseError where it spells no qualified name, naming what failed
 */
export function parseReference(text: string): string {
  const name = toNfc(text);
  const detail = malformed(name);
  if (detail !== undefined) {
    throw new TsonAtomParseError(
      'reference',
      `'${text}' is no reference -- ${detail}`,
      A_REFERENCE,
    );
  }
  return name;
}

/** Why `text` is no qualified name, or `undefined` where it is one. */
function malformed(text: string): string | undefined {
  if (text.length === 0) return 'a reference names something, and this is empty';
  const angle = text.indexOf('<');
  if (angle > 0 && isQualifiedName(text.slice(0, angle))) {
    const head = text.slice(0, angle);
    return (
      `an argument list is schema grammar, and a reference is a name ([TSON-SCHEMA] §4.2): name the ` +
      `application by the declaration that gives it one ('my_${head} => ${head}<...>', then ` +
      `'my_${head}'), or at a schema's type slot write it in place`
    );
  }
  if (text.endsWith('!') && isSiblingField(text.slice(0, -1))) {
    return `'${text}' is a dependent type, which is schema grammar and no value: a reference is a name`;
  }
  const segments = text.split('.');
  if (segments.includes('')) {
    return `'${text}' has an empty segment -- each segment between the dots is a name`;
  }
  // Only the first segment is judged here: it names an entry of the root namespace, an identifier
  // (§7.7), and a further segment is a name of the family of what it enters ([TSON-SCHEMA] §5.12),
  // which only the walk that resolves it knows.
  const first = segments[0] ?? '';
  return isIdentifierText(first)
    ? undefined
    : `'${first}' is no name: a name is an identifier (§7.7)`;
}
