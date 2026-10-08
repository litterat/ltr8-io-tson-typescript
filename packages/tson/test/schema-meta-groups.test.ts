import { describe, expect, it } from 'vitest';

import {
  atLeastOne,
  describeGroup,
  groupMemberNames,
  groupViolations,
  describeViolation,
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

describe("describeViolation -- the message fits the group's quantifier (§5.11 Validation)", () => {
  const say = (group: FieldGroup, ...present: string[]): string[] =>
    groupViolations(group, over(...present)).map((v) =>
      describeViolation(group, v, over(...present)),
    );

  it('a bare group says exactly one, both when none and when several are chosen', () => {
    expect(say(ONE_OF)).toEqual(['none of (a | b) is present; exactly one is required']);
    expect(say(ONE_OF, 'a', 'b')).toEqual(['(a) and (b) choose 2 options; exactly one is allowed']);
  });

  it('an optional group says at most one', () => {
    expect(say(AT_MOST_ONE, 'a', 'b')).toEqual([
      '(a) and (b) choose 2 options; at most one is allowed',
    ]);
  });

  it('an at-least-one group says at least one', () => {
    expect(say(AT_LEAST_ONE)).toEqual([
      'none of (email | phone) is present; at least one is required',
    ]);
  });

  it('a chosen option names what it needs', () => {
    expect(say(OPTIONS, 'port')).toEqual(['(port) chose its option, which needs host']);
  });
});
