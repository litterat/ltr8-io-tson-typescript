/**
 * §5.11's declaration rules over every resolved record, whatever spelling wrote its groups. A
 * group is refused wherever it restates what plain fields or another group already state, and
 * "the declaration rules are an invariant of resolved output as well as of source: no resolved
 * record carries a group they refuse". The schema parser refuses the `( … | … )` sugar early with a
 * message in the author's own spelling; a group written as a `!record { groups: [ … ] }` literal
 * reaches the resolver without passing that check, so the rules are applied here to the group as
 * bound, where both spellings meet.
 *
 * What is judged, per record and group:
 *
 * - every option holds a member, and every member is a field of the record, contributed to
 *   exactly one option of one group (a label sits in one option of one group);
 * - every flattened member field is `optional: true` (Resolution: the grouping, not the field,
 *   states presence);
 * - `optional_members` is absent rather than empty, and names members of the group, each in an
 *   option that holds more than that member (the only member of an option takes no `?`);
 * - a group of one option is the `+` shape (not optional, at least two members, every one marked)
 *   or an optional group with at least two members and one unmarked. Every other single-option
 *   group restates plain fields or another group.
 *
 * The reader (`reader/tree/record.ts`) and the JSON record reader count chosen options against
 * these facts, so an inconsistent group handed to either would report nonsense.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import type { FieldGroup, RecordBody } from '../schema/meta/bodies.js';
import type { TypeDefinition } from '../schema/meta/typedef.js';

/** Dependencies {@link checkFieldGroups} needs beyond the merged namespace. */
export interface CheckFieldGroupsOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /** Where a refused group is reported. Omitted means fail-fast. */
  readonly receiver?: DiagnosticsReceiver;
}

/** Why `group` of a record with `fieldNames` and `optionalFields` is refused, or `undefined` when it stands (§5.11). */
export function refuseGroup(
  group: FieldGroup,
  fields: ReadonlyMap<string, boolean>,
  claimed: Set<string>,
): string | undefined {
  const marked = new Set(group.optionalMembers ?? []);
  if (group.optionalMembers?.length === 0) {
    return "'optional_members' is absent rather than empty where no member is marked (§5.11)";
  }
  const members = group.members.flat();
  for (const option of group.members) {
    if (option.length === 0) return 'an option holds no field (§5.11)';
  }
  for (const member of members) {
    if (!fields.has(member)) return `the member '${member}' names no field of the record (§5.11)`;
    if (claimed.has(member)) {
      return `the field '${member}' sits under two presence rules; it belongs to one option of one group (§5.11)`;
    }
    claimed.add(member);
    if (fields.get(member) !== true) {
      return `the member '${member}' is not \`optional: true\` as a flattened group member is -- the group, not the field, states its presence (§5.11)`;
    }
  }
  for (const name of marked) {
    if (!members.includes(name)) {
      return `'optional_members' names '${name}', which is no member of the group (§5.11)`;
    }
  }
  for (const option of group.members) {
    const only = option[0];
    if (option.length === 1 && only !== undefined && marked.has(only)) {
      return (
        `'${only}' is the only member of its option, so the '?' on its name changes nothing -- ` +
        'it is present exactly when its option is chosen; write it without the mark (§5.11)'
      );
    }
  }
  if (group.members.length > 1) return undefined;
  const unmarked = members.filter((member) => !marked.has(member));
  const names = members.join(', ');
  if (group.optional) {
    if (members.length < 2 || unmarked.length === 0) {
      return (
        `an optional group of one option ${members.length < 2 ? 'and one member' : 'whose members are all marked'} ` +
        `admits each member independently -- declare (${names}) as optional fields (§5.11)`
      );
    }
    return undefined;
  }
  if (unmarked.length > 0) {
    return `a group of one option with an unmarked member states plain fields -- declare (${names}) as fields (§5.11)`;
  }
  if (members.length < 2) {
    return `at least one of a single field is that field, required -- declare '${names}' as a field (§5.11)`;
  }
  return undefined;
}

/**
 * Applies {@link refuseGroup} to every group of every record `localNames` declares. Imported
 * entries were judged when their own schema linked.
 */
export function checkFieldGroups(
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
  options: CheckFieldGroupsOptions,
): void {
  for (const name of localNames) {
    const definition = merged.get(name);
    const body = definition?.body;
    if (body === undefined || !('kind' in body) || body.kind !== 'record') continue;
    const record = body as RecordBody;
    if (record.groups.length === 0) continue;
    const fields = new Map(record.fields.map((field) => [field.name, field.optional]));
    const claimed = new Set<string>();
    for (const group of record.groups) {
      const reason = refuseGroup(group, fields, claimed);
      if (reason === undefined) continue;
      const message = `'${name}': a field group is refused: ${reason}`;
      const { schemaId, receiver } = options;
      if (receiver === undefined) throw new TsonSchemaValidationError(message);
      receiver.report({
        code: 'SCHEMA_ERROR',
        message,
        schemaId,
        schemaPointer: `/${name}`,
        ...(definition?.position === undefined ? {} : { schemaPosition: definition.position }),
      });
    }
  }
}
