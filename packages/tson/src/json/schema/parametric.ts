/**
 * The reader of an entry that declares type parameters: a parametric record ([TSON-SCHEMA] §5.10).
 *
 * No position names a parametric record bare -- it is named only as the head of an application, and
 * an application is closed by a declaration, whose name is what a document writes ([TSON-JSON]
 * §1.6 item 23). So a `$type` naming one ([TSON-JSON] §3.3), a root type supplied out of band that
 * names one (§3.4), and a declared position's `$type` reaching one (§8.5) each arrive here, and the
 * answer is the same everywhere: a validation error, reported at the value, with the value skipped
 * so the stream is left where a reader that understood the position would have left it.
 *
 * Built before the body is looked at, so a parametric record's unsubstituted body never reaches a
 * reader factory.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import type { ExactReader } from './route.js';
import type { JsonTypeReader } from './types.js';

/** The reader of the parametric record `name`, taking `parameters`: it reads nothing and refuses what it is handed. */
export function parametricRecordReader(
  name: string,
  parameters: readonly string[],
  schemaLocation: SchemaLocation,
): JsonTypeReader & ExactReader {
  const arity = `${String(parameters.length)} type argument${parameters.length === 1 ? '' : 's'}`;
  const reader: JsonTypeReader & ExactReader = {
    *read(ctx: JsonReadContext): Task<undefined> {
      ctx
        .underDeclaration(schemaLocation)
        .report(
          'TYPE_MISMATCH',
          `'${name}' is a parametric record taking ${arity} (${parameters.join(', ')}), and no ` +
            'position names a parametric record bare (§5.10) -- name the application in the ' +
            `schema ('my_type => ${name}<...>') and bind this document to 'my_type'`,
          'a type, not a parametric record',
          name,
        );
      yield* skipNextValue(ctx);
      return undefined;
    },
    // A tag naming it leads an object that is the whole of the refused value, inline form or not.
    readExact: (ctx: JsonReadContext) => reader.read(ctx),
  };
  return reader;
}
