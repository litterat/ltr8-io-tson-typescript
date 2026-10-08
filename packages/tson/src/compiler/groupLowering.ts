/**
 * A written field group lowered to the kernel's `field_group` (§5.11, §8.1): the options in source
 * order, the members marked `?` within their option, and whether the group is optional.
 *
 * `+` is sugar (§5.11): `( a: A | b: B )+` lowers to the group of one option holding every member,
 * each marked optional, on a group that is not optional — so at least one is present. Every other
 * group lowers option for option, with a member optional exactly where its name carries `?`, and
 * the group optional exactly where it ends in `?`.
 */
import type { GroupDef, GroupMember } from '../ast/schema/fields.js';
import type { FieldGroup } from '../schema/meta/bodies.js';

/** Every member of every option of `group`, in source order. */
export function groupMembers(group: GroupDef): readonly GroupMember[] {
  return group.options.flat();
}

/** The kernel's `field_group` for `group`. */
export function lowerGroup(group: GroupDef): FieldGroup {
  const members = groupMembers(group);
  if (group.quantifier === 'AT_LEAST_ONE') {
    const names = members.map((member) => member.name);
    return { members: [names], optionalMembers: names, optional: false };
  }
  const optionalMembers = members.filter((member) => member.omittable).map((member) => member.name);
  return {
    members: group.options.map((option) => option.map((member) => member.name)),
    ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
    optional: group.quantifier === 'AT_MOST_ONE',
  };
}
