import { describe, it, expect } from 'vitest';
import { generateDailyAssignments } from '../assignmentEngine.js';
import { buildUnmatchedProviderEntries } from '../pdfParser.js';

const desks = [{ id: 'a', name: 'Desk A' }, { id: 'b', name: 'Desk B' }];

function room(id, deskId, opts = {}) {
  return { id, deskId, code: id, hasWindow: false, videoCapable: false, ...opts };
}

function baseProvider(overrides = {}) {
  return {
    id: 'p1',
    name: 'Dr. Test',
    homeDeskId: 'a',
    preferredNumberOfRooms: 1,
    primaryPreferredRoomId: null,
    secondPreferredRoomId: null,
    windowPreference: 'none',
    alternateDeskIds: [],
    alternateRoomCodes: [],
    hasOfficeOnFloor: false,
    ...overrides
  };
}

describe('never-drop-provider', () => {
  it('keeps a provider in the results with a null room slot when nothing is available', () => {
    const rooms = []; // no rooms at all anywhere
    const providers = [baseProvider()];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];

    const { assignments, warnings } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(assignments).toHaveLength(1);
    expect(assignments[0].providerName).toBe('Dr. Test');
    expect(assignments[0].roomSlots).toEqual([{ roomId: null, deskId: null, isOverflow: false }]);
    expect(warnings.some((w) => w.includes('Dr. Test'))).toBe(true);
  });
});

describe('preferred number of rooms', () => {
  it('assigns two distinct rooms honoring primary/second preferred room', () => {
    const rooms = [room('r1', 'a'), room('r2', 'a'), room('r3', 'a')];
    const providers = [
      baseProvider({ preferredNumberOfRooms: 2, primaryPreferredRoomId: 'r2', secondPreferredRoomId: 'r3' })
    ];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 10, session: 'FULL' }];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    const roomIds = assignments[0].roomSlots.map((s) => s.roomId);
    expect(roomIds).toEqual(['r2', 'r3']);
  });

  it('falls back to whatever is left when the preferred room is taken, still filling both slots', () => {
    const rooms = [room('r1', 'a'), room('r2', 'a')];
    const providers = [
      baseProvider({ id: 'p1', preferredNumberOfRooms: 1, primaryPreferredRoomId: 'r1' }),
      baseProvider({ id: 'p2', preferredNumberOfRooms: 1, primaryPreferredRoomId: 'r1' })
    ];
    const dayEntries = [
      { providerId: 'p1', isWorking: true, patientCount: 5, session: 'FULL' },
      { providerId: 'p2', isWorking: true, patientCount: 5, session: 'FULL' }
    ];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    const allRoomIds = assignments.flatMap((a) => a.roomSlots.map((s) => s.roomId));
    expect(allRoomIds.sort()).toEqual(['r1', 'r2']);
  });
});

describe('room blocks', () => {
  it('excludes a room from assignment during its blocked session', () => {
    const rooms = [room('r1', 'a')];
    const providers = [baseProvider()];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];
    const roomBlocks = [{ id: 'b1', roomId: 'r1', date: '2026-09-08', startMinutes: null, endMinutes: null }];

    const { assignments } = generateDailyAssignments({
      desks, rooms, providers, dayEntries, roomBlocks, date: '2026-09-08'
    });

    expect(assignments[0].roomSlots[0].roomId).toBeNull();
  });

  it('does not block a date it does not apply to', () => {
    const rooms = [room('r1', 'a')];
    const providers = [baseProvider()];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];
    const roomBlocks = [{ id: 'b1', roomId: 'r1', date: '2026-09-09', startMinutes: null, endMinutes: null }];

    const { assignments } = generateDailyAssignments({
      desks, rooms, providers, dayEntries, roomBlocks, date: '2026-09-08'
    });

    expect(assignments[0].roomSlots[0].roomId).toBe('r1');
  });

  it('only blocks the overlapping half-day, leaving the other session free for sharing', () => {
    const rooms = [room('r1', 'a')];
    const providers = [
      baseProvider({ id: 'p1' }),
      baseProvider({ id: 'p2' })
    ];
    // Block covers 10am-12pm -> AM only.
    const roomBlocks = [{ id: 'b1', roomId: 'r1', date: '2026-09-08', startMinutes: 10 * 60, endMinutes: 12 * 60 }];
    const dayEntries = [
      { providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' },
      { providerId: 'p2', isWorking: true, patientCount: 5, session: 'PM' }
    ];

    const { assignments } = generateDailyAssignments({
      desks, rooms, providers, dayEntries, roomBlocks, date: '2026-09-08'
    });

    const amAssignment = assignments.find((a) => a.session === 'AM');
    const pmAssignment = assignments.find((a) => a.session === 'PM');
    expect(amAssignment.roomSlots[0].roomId).toBeNull(); // AM blocked
    expect(pmAssignment.roomSlots[0].roomId).toBe('r1'); // PM still open
  });
});

describe('video-capable requirement', () => {
  // Note: whether a video-capable room is needed is decided ENTIRELY by
  // that day's imported schedule (dayEntries[].hasVideoVisit) crossed with
  // the provider's fixed hasOfficeOnFloor fact — there is no provider-level
  // "has video visit" field anymore, so these tests only set it on the
  // day entry.
  it('prioritizes a video-capable room when the day entry has a video visit and no office on the floor', () => {
    const rooms = [room('r1', 'a'), room('r2', 'a', { videoCapable: true })];
    const providers = [baseProvider({ hasOfficeOnFloor: false })];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM', hasVideoVisit: true }];

    const { assignments, warnings } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(assignments[0].roomSlots[0].roomId).toBe('r2');
    expect(warnings).toHaveLength(0);
  });

  it('warns when a video visit cannot get a video-capable room', () => {
    const rooms = [room('r1', 'a')]; // no video-capable room exists
    const providers = [baseProvider({ hasOfficeOnFloor: false })];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM', hasVideoVisit: true }];

    const { warnings } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(warnings.some((w) => w.toLowerCase().includes('video-capable'))).toBe(true);
  });

  it('does not require a video-capable room when the provider has an office on the floor', () => {
    const rooms = [room('r1', 'a')];
    const providers = [baseProvider({ hasOfficeOnFloor: true })];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM', hasVideoVisit: true }];

    const { warnings } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(warnings).toHaveLength(0);
  });

  it('does not require a video-capable room on a day with no video visit, even if one was needed before', () => {
    const rooms = [room('r1', 'a')]; // no video-capable room exists
    const providers = [baseProvider({ hasOfficeOnFloor: false })];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }]; // no hasVideoVisit today

    const { warnings } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(warnings).toHaveLength(0);
  });
});

describe('room kind (office / utility exclusion)', () => {
  it('never assigns a provider to an office or utility room, even when it is the only room at the desk', () => {
    const rooms = [
      room('office-1', 'a', { kind: 'office', label: 'Dr. Greene Office' }),
      room('util-1', 'a', { kind: 'utility', label: 'Hallway' })
    ];
    const providers = [baseProvider()];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    // No exam rooms exist at all, so the provider must show "Not Found" —
    // never silently placed into someone's permanent office or a hallway.
    expect(assignments[0].roomSlots[0].roomId).toBeNull();
  });

  it('skips office/utility rooms but still uses a plain exam room in the same pool', () => {
    const rooms = [
      room('office-1', 'a', { kind: 'office', label: 'Dr. Greene Office' }),
      room('exam-1', 'a', { kind: 'exam' })
    ];
    const providers = [baseProvider()];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(assignments[0].roomSlots[0].roomId).toBe('exam-1');
  });
});

describe('alternate desk rooms (free-text room codes)', () => {
  it('prefers a room whose code is in the provider\'s alternateRoomCodes list when overflowing', () => {
    // Provider's home desk has no rooms at all, forcing overflow onto desk b.
    const rooms = [room('r1', 'b'), room('r2', 'b')];
    const providers = [
      baseProvider({ homeDeskId: 'a', alternateDeskIds: ['b'], alternateRoomCodes: ['r2'] })
    ];
    const dayEntries = [{ providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' }];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(assignments[0].roomSlots[0].roomId).toBe('r2');
  });
});

describe('unmatched provider names (pseudo-providers)', () => {
  it('silently fills an open room with no warning', () => {
    const rooms = [room('r1', 'a')];
    const providers = [];
    const unmatchedRows = [{ deskId: 'a', provider: 'Smith, John', patient: 'Doe, Jane', time: '9:00 am' }];
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatchedRows, desks);

    const { assignments, warnings } = generateDailyAssignments({
      desks, rooms, providers: [...providers, ...pseudoProviders], dayEntries: pseudoDayEntries, date: '2026-09-08'
    });

    expect(assignments[0].roomSlots[0].roomId).toBe('r1');
    expect(warnings).toHaveLength(0);
  });

  it('is silently dropped (no warning) when nothing is open', () => {
    const rooms = [];
    const unmatchedRows = [{ deskId: 'a', provider: 'Smith, John', patient: 'Doe, Jane', time: '9:00 am' }];
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatchedRows, desks);

    const { warnings } = generateDailyAssignments({
      desks, rooms, providers: pseudoProviders, dayEntries: pseudoDayEntries, date: '2026-09-08'
    });

    expect(warnings).toHaveLength(0);
  });
});

describe('AM/PM half-day sharing (regression)', () => {
  it('lets an AM-only and a PM-only provider share the same room', () => {
    const rooms = [room('r1', 'a')];
    const providers = [baseProvider({ id: 'p1' }), baseProvider({ id: 'p2' })];
    const dayEntries = [
      { providerId: 'p1', isWorking: true, patientCount: 5, session: 'AM' },
      { providerId: 'p2', isWorking: true, patientCount: 5, session: 'PM' }
    ];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    expect(assignments[0].roomSlots[0].roomId).toBe('r1');
    expect(assignments[1].roomSlots[0].roomId).toBe('r1');
  });

  it('does not let two full-day providers share one room', () => {
    const rooms = [room('r1', 'a')];
    const providers = [baseProvider({ id: 'p1' }), baseProvider({ id: 'p2' })];
    const dayEntries = [
      { providerId: 'p1', isWorking: true, patientCount: 5, session: 'FULL' },
      { providerId: 'p2', isWorking: true, patientCount: 5, session: 'FULL' }
    ];

    const { assignments } = generateDailyAssignments({ desks, rooms, providers, dayEntries, date: '2026-09-08' });

    const filled = assignments.filter((a) => a.roomSlots[0].roomId !== null);
    const notFound = assignments.filter((a) => a.roomSlots[0].roomId === null);
    expect(filled).toHaveLength(1);
    expect(notFound).toHaveLength(1);
  });
});
