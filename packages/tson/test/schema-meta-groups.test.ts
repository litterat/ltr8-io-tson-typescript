import { describe, expect, it } from 'vitest';

import {
  atLeastOne,
  describeGroup,
  groupMemberNames,
  groupViolations,
  groupRefusals,
  isGroupMember,
  type FieldGroup,
} from '../src/schema/meta/bodies.js';

/** `present` as the predicate `groupViolations` asks. */
function over(...present: string[]): (member: string) => boolean {
  return (member) => present.includes(member);
}

const ONE_OF: FieldGroup = { members: [['a'], ['b']], optional: false };
const AT_MOST_ONE: FieldGroup = { members: [['a'], ['b']], optional: true };
const OPTIONS: FieldGroup = {
  members: [['host', 'port'], ['socket']],
  optionalMembers: ['port'],
  optional: false,
};
const AT_LEAST_ONE: FieldGroup = {
  members: [['email', 'phone']],
  optionalMembers: ['email', 'phone'],
  optional: false,
};

describe('FieldGroup (§5.11, §8.1): options, optional members, optional', () => {
  it('lists every member of every option in source order', () => {
    expect(groupMemberNames(OPTIONS)).toEqual(['host', 'port', 'socket']);
  });

  it('isGroupMember finds a member in any option', () => {
    expect(isGroupMember([OPTIONS], 'port')).toBe(true);
    expect(isGroupMember([OPTIONS], 'socket')).toBe(true);
    expect(isGroupMember([OPTIONS], 'other')).toBe(false);
  });

  it('is the at-least-one group exactly when it is one option the group may not leave out', () => {
    expect(atLeastOne(AT_LEAST_ONE)).toBe(true);
    expect(atLeastOne(ONE_OF)).toBe(false);
    expect(atLeastOne({ ...AT_LEAST_ONE, optional: true })).toBe(false);
  });

  it('describes a group as its spelling reads', () => {
    expect(describeGroup(ONE_OF)).toBe('a | b');
    expect(describeGroup(OPTIONS)).toBe('host port? | socket');
    expect(describeGroup(AT_LEAST_ONE)).toBe('email | phone');
  });
});

describe('groupViolations (§5.11, §7.6)', () => {
  it('a group that is not optional admits exactly one chosen option', () => {
    expect(groupViolations(ONE_OF, over('a'))).toEqual([]);
    expect(groupViolations(ONE_OF, over())).toEqual([{ kind: 'NONE_CHOSEN' }]);
    expect(groupViolations(ONE_OF, over('a', 'b'))).toEqual([
      { kind: 'SEVERAL_CHOSEN', options: [0, 1] },
    ]);
  });

  it('an optional group admits at most one', () => {
    expect(groupViolations(AT_MOST_ONE, over())).toEqual([]);
    expect(groupViolations(AT_MOST_ONE, over('b'))).toEqual([]);
    expect(groupViolations(AT_MOST_ONE, over('a', 'b')).map((v) => v.kind)).toEqual([
      'SEVERAL_CHOSEN',
    ]);
  });

  it('an option is chosen by any one of its members, and must then hold every unmarked member', () => {
    expect(groupViolations(OPTIONS, over('host'))).toEqual([]);
    expect(groupViolations(OPTIONS, over('host', 'port'))).toEqual([]);
    expect(groupViolations(OPTIONS, over('port'))).toEqual([
      { kind: 'MEMBER_MISSING', option: 0, missing: ['host'] },
    ]);
    expect(groupViolations(OPTIONS, over('socket'))).toEqual([]);
    expect(groupViolations(OPTIONS, over('host', 'socket')).map((v) => v.kind)).toEqual([
      'SEVERAL_CHOSEN',
    ]);
  });

  it("reports each chosen option's missing members before the count of chosen options (§5.11 Validation)", () => {
    expect(groupViolations(OPTIONS, over('port', 'socket'))).toEqual([
      { kind: 'MEMBER_MISSING', option: 0, missing: ['host'] },
      { kind: 'SEVERAL_CHOSEN', options: [0, 1] },
    ]);
  });

  it('the at-least-one group admits any non-empty subset', () => {
    expect(groupViolations(AT_LEAST_ONE, over('email'))).toEqual([]);
    expect(groupViolations(AT_LEAST_ONE, over('phone'))).toEqual([]);
    expect(groupViolations(AT_LEAST_ONE, over('email', 'phone'))).toEqual([]);
    expect(groupViolations(AT_LEAST_ONE, over())).toEqual([{ kind: 'NONE_CHOSEN' }]);
  });
});

describe('groupRefusals -- FIELD_GROUP, in the reference messages and order (§5.11 Validation)', () => {
  const say = (group: FieldGroup, ...present: string[]): string[] =>
    groupRefusals(group, over(...present), 'r').map((r) => `${r.code}: ${r.message}`);

  it('a bare group says exactly one, both when none and when several are chosen', () => {
    expect(say(ONE_OF)).toEqual([
      "FIELD_GROUP: exactly one option of (a | b) must be chosen for 'r', found none",
    ]);
    expect(say(ONE_OF, 'a', 'b')).toEqual([
      "FIELD_GROUP: exactly one option of (a | b) must be chosen for 'r', found 2",
    ]);
  });

  it('an optional group says at most one', () => {
    expect(say(AT_MOST_ONE, 'a', 'b')).toEqual([
      "FIELD_GROUP: at most one option of (a | b) may be chosen for 'r', found 2",
    ]);
  });

  it('an at-least-one group says at least one', () => {
    expect(say(AT_LEAST_ONE)).toEqual([
      "FIELD_GROUP: at least one of (email | phone) must be present for 'r'",
    ]);
  });

  it('a chosen option names the member that chose it and what it needs', () => {
    expect(say(OPTIONS, 'port')).toEqual([
      "FIELD_GROUP: 'port' chose (host port) on 'r', which needs 'host'",
    ]);
  });

  it("reports each chosen option's missing members before the count", () => {
    const refusals = say(OPTIONS, 'port', 'socket');
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('which needs');
    expect(refusals[1]).toContain('found 2');
  });
});
