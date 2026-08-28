/**
 * Renders a {@link Diagnostic} as a `tree/nodes.ts` {@link Value} record -- the one place `--format
 * tson` output for `validate`/`compile` goes through `@ltr8/tson`'s own writer rather than string
 * concatenation, per this work package's own brief. Field names follow `snake_case` to match this
 * project's own wire vocabulary (`schema_id`, `data_position`, ...), the same convention the
 * reference implementation's `diagnostics.tn` sidecar schema uses for the same shape.
 */
import { atomNode, recordNode, type Diagnostic, type Position, type Value } from '@ltr8/tson';

function positionNode(position: Position): Value {
  return recordNode(
    new Map<string, Value>([
      ['line', atomNode(BigInt(position.line))],
      ['column', atomNode(BigInt(position.column))],
      ['offset', atomNode(BigInt(position.offset))],
    ]),
  );
}

/** One {@link Diagnostic} as a record node -- every field it actually carries, nothing invented. */
export function diagnosticNode(diagnostic: Diagnostic): Value {
  const fields = new Map<string, Value>();
  fields.set('code', atomNode(diagnostic.code));
  fields.set('message', atomNode(diagnostic.message));
  if (diagnostic.path !== undefined) fields.set('path', atomNode(diagnostic.path));
  if (diagnostic.schemaId !== undefined) fields.set('schema_id', atomNode(diagnostic.schemaId));
  if (diagnostic.schemaPointer !== undefined) {
    fields.set('schema_pointer', atomNode(diagnostic.schemaPointer));
  }
  if (diagnostic.expected !== undefined) fields.set('expected', atomNode(diagnostic.expected));
  if (diagnostic.actual !== undefined) fields.set('actual', atomNode(diagnostic.actual));
  if (diagnostic.dataPosition !== undefined) {
    fields.set('data_position', positionNode(diagnostic.dataPosition));
  }
  if (diagnostic.schemaPosition !== undefined) {
    fields.set('schema_position', positionNode(diagnostic.schemaPosition));
  }
  return recordNode(fields);
}

/** {@link Diagnostic} rendered for `--format json` -- a plain object, positions included verbatim. */
export function diagnosticJson(diagnostic: Diagnostic): Record<string, unknown> {
  const out: Record<string, unknown> = { code: diagnostic.code, message: diagnostic.message };
  if (diagnostic.path !== undefined) out.path = diagnostic.path;
  if (diagnostic.schemaId !== undefined) out.schema_id = diagnostic.schemaId;
  if (diagnostic.schemaPointer !== undefined) out.schema_pointer = diagnostic.schemaPointer;
  if (diagnostic.expected !== undefined) out.expected = diagnostic.expected;
  if (diagnostic.actual !== undefined) out.actual = diagnostic.actual;
  if (diagnostic.dataPosition !== undefined) out.data_position = diagnostic.dataPosition;
  if (diagnostic.schemaPosition !== undefined) out.schema_position = diagnostic.schemaPosition;
  return out;
}

/** {@link Diagnostic} rendered for `--format text` -- one line, position appended when known. */
export function diagnosticText(diagnostic: Diagnostic): string {
  const where = diagnostic.path === undefined ? '' : ` at ${diagnostic.path}`;
  const at =
    diagnostic.dataPosition === undefined
      ? ''
      : ` (${String(diagnostic.dataPosition.line)}:${String(diagnostic.dataPosition.column)})`;
  return `${diagnostic.code}${where}${at}: ${diagnostic.message}`;
}
