// Sample data to develop against before this is wired to Firestore.
// Shapes here match exactly what assignmentEngine.js / pdfParser.js expect.

export const desks = [
  // `title` is only used as the heading on the static floor-map export page
  // (e.g. "Mayo 19 - East A Desk") — it can read differently from the
  // short `name` used everywhere else (tabs, filenames: "DeskA_25Sep2026").
  // Desk A's title is set from the real sample export; Desk B / Desk West
  // don't have a confirmed real title yet, so they fall back to `name`.
  { id: 'desk-a', name: 'Desk A', title: 'East A' },
  { id: 'desk-b', name: 'Desk B' },
  { id: 'desk-west', name: 'Desk West' }
];
// NOTE: desk capacity is NOT stored separately — it's just the count of
// EXAM (kind: 'exam') rooms with that deskId, so it can never drift out of
// sync as rooms are added/edited/deleted on the Rooms page. Office/utility
// rooms don't count toward capacity — see the room `kind` note below.

function makeRooms(deskId, codes) {
  // hasWindow / videoCapable default to false for every seeded room —
  // set the real values via the Rooms management page (or Firestore).
  // kind defaults to 'exam' (the shared daily-assignment pool) when omitted.
  return codes.map((code) => ({ id: `${deskId}-${code}`, deskId, code, hasWindow: false, videoCapable: false, kind: 'exam' }));
}

// ---- Desk A: floor-map layout, transcribed from the real sample export ----
// (Mayo 19 - East A Desk, two halls). Each room/space carries `hall`,
// `row` and `side` ('left' | 'right') so pdfGenerator.js can reproduce the
// exact two-column-per-hall paired layout from the sample. Three kinds:
//  - 'exam'   — shared daily-assignment pool room (shows "V" on the map if
//               videoCapable, otherwise blank); this is the ONLY kind the
//               assignment engine will ever hand out to a provider.
//  - 'office' — a specific provider's permanent office; never entered into
//               the daily assignment pool (they don't see patients there).
//               `label` is the exact text to print (handles shared offices
//               like "Dr. Cramer / Dr. Hanna Office").
//  - 'utility'— a non-patient space (hallway, workroom, restroom, conference
//               room); may or may not have a room number. Also excluded
//               from the assignment pool. `label` is the text to print.
function examRoom(deskId, code, { hall, row, side, videoCapable = false, hasWindow = false }) {
  return { id: `${deskId}-${code}`, deskId, code, hasWindow, videoCapable, kind: 'exam', hall, row, side };
}
function officeRoom(deskId, code, label, { hall, row, side }) {
  return { id: `${deskId}-off-${code}`, deskId, code, label, hasWindow: false, videoCapable: false, kind: 'office', hall, row, side };
}
function utilityRoom(deskId, code, label, { hall, row, side }) {
  const idPart = code || label.toLowerCase().replace(/\s+/g, '-');
  return { id: `${deskId}-util-${idPart}`, deskId, code, label, hasWindow: false, videoCapable: false, kind: 'utility', hall, row, side };
}

const H1 = 'East A Hall 1';
const H2 = 'East A Hall 2';

const deskARooms = [
  // Hall 1
  officeRoom('desk-a', '57', 'Dr. Greene Office', { hall: H1, row: 1, side: 'left' }),
  utilityRoom('desk-a', '', 'Hallway', { hall: H1, row: 1, side: 'right' }),
  officeRoom('desk-a', '55', 'Dr. Williams Office', { hall: H1, row: 2, side: 'left' }),
  examRoom('desk-a', '56', { hall: H1, row: 2, side: 'right' }),
  officeRoom('desk-a', '53', 'Dr. Tran Office', { hall: H1, row: 3, side: 'left' }),
  examRoom('desk-a', '54', { hall: H1, row: 3, side: 'right' }),
  officeRoom('desk-a', '51', 'Dr. Cramer / Dr. Hanna Office', { hall: H1, row: 4, side: 'left' }),
  examRoom('desk-a', '52', { hall: H1, row: 4, side: 'right' }),
  officeRoom('desk-a', '49', 'Dr. Qureshi Office', { hall: H1, row: 5, side: 'left' }),
  examRoom('desk-a', '50', { hall: H1, row: 5, side: 'right' }),
  officeRoom('desk-a', '47', 'Dr. Dines Office', { hall: H1, row: 6, side: 'left' }),
  examRoom('desk-a', '48', { hall: H1, row: 6, side: 'right' }),
  examRoom('desk-a', '45', { hall: H1, row: 7, side: 'left', videoCapable: true }),
  utilityRoom('desk-a', '', 'Staff Workroom', { hall: H1, row: 7, side: 'right' }),
  examRoom('desk-a', '43', { hall: H1, row: 8, side: 'left', videoCapable: true }),
  utilityRoom('desk-a', '', 'Restroom', { hall: H1, row: 8, side: 'right' }),

  // Hall 2
  utilityRoom('desk-a', '36', 'East Conference Room', { hall: H2, row: 1, side: 'left' }),
  officeRoom('desk-a', '35', 'Dr. Craici Office', { hall: H2, row: 1, side: 'right' }),
  examRoom('desk-a', '34', { hall: H2, row: 2, side: 'left' }),
  officeRoom('desk-a', '33', 'Dr. Taler Office', { hall: H2, row: 2, side: 'right' }),
  examRoom('desk-a', '32', { hall: H2, row: 3, side: 'left', videoCapable: true }),
  officeRoom('desk-a', '31', 'Dr. Larson Office', { hall: H2, row: 3, side: 'right' }),
  examRoom('desk-a', '30', { hall: H2, row: 4, side: 'left', videoCapable: true }),
  officeRoom('desk-a', '29', 'Dr. Cheungpasitporn Office', { hall: H2, row: 4, side: 'right' }),
  examRoom('desk-a', '28', { hall: H2, row: 5, side: 'left', videoCapable: true }),
  examRoom('desk-a', '27', { hall: H2, row: 5, side: 'right', videoCapable: true }),
  examRoom('desk-a', '26', { hall: H2, row: 6, side: 'left' }),
  examRoom('desk-a', '25', { hall: H2, row: 6, side: 'right', videoCapable: true }),
  examRoom('desk-a', '24', { hall: H2, row: 7, side: 'left', videoCapable: true }),
  examRoom('desk-a', '23', { hall: H2, row: 7, side: 'right', videoCapable: true }),
  examRoom('desk-a', '22', { hall: H2, row: 8, side: 'left', videoCapable: true }),
  utilityRoom('desk-a', '', 'Transplant Mid-Levels', { hall: H2, row: 8, side: 'right' })
];
// One example window room, same way the old seed flagged one — pick a
// plain exam room since none of the transcribed rooms had a window noted.
deskARooms.find((r) => r.id === 'desk-a-34').hasWindow = true;

export const rooms = [
  ...deskARooms,
  // Desk B / Desk West don't have a confirmed real floor map yet — these
  // stay as plain exam-pool rooms (no hall/office/utility layout) until a
  // real sample like Desk A's is available. pdfGenerator.js falls back to
  // a simple single-column list for a desk with no `hall` set on its rooms.
  ...makeRooms('desk-b', ['64E', '68E', '70E', '72E', '74E', '80E', '84E', '86E', '90E', '92E']),
  ...makeRooms('desk-west', ['64W', '68W', '70W', '72W', '74W', '78W'])
];
rooms.find((r) => r.id === 'desk-b-64E').hasWindow = true;
rooms.find((r) => r.id === 'desk-b-68E').videoCapable = true;

// firstName/lastName are kept separate (not just a combined `name`) because
// uploaded PDFs give "LastName, FirstName" and matching is done on that pair.
export const providers = [
  {
    id: 'p1',
    firstName: 'Maria',
    lastName: 'Alvarez',
    name: 'Maria Alvarez',
    homeDeskId: 'desk-a',
    preferredNumberOfRooms: 1,
    primaryPreferredRoomId: 'desk-a-34', // the one Desk A exam room flagged hasWindow: true
    secondPreferredRoomId: null,
    windowPreference: 'prefers',
    alternateDeskIds: ['desk-b'],
    alternateRoomCodes: ['64E'],
    hasOfficeOnFloor: false
  },
  {
    id: 'p2',
    firstName: 'David',
    lastName: 'Chen',
    name: 'David Chen',
    homeDeskId: 'desk-a',
    preferredNumberOfRooms: 2,
    primaryPreferredRoomId: 'desk-a-23',
    secondPreferredRoomId: 'desk-a-24', // both video-capable exam rooms in the real Hall 2 layout
    windowPreference: 'none',
    alternateDeskIds: [],
    alternateRoomCodes: [],
    hasOfficeOnFloor: false
  },
  {
    id: 'p3',
    firstName: 'Ijeoma',
    lastName: 'Okafor',
    name: 'Ijeoma Okafor',
    homeDeskId: 'desk-b',
    preferredNumberOfRooms: 1,
    primaryPreferredRoomId: null,
    secondPreferredRoomId: null,
    windowPreference: 'none',
    alternateDeskIds: ['desk-west'],
    alternateRoomCodes: ['68W', '70W'],
    hasOfficeOnFloor: true
  },
  {
    id: 'p4',
    firstName: 'Raj',
    lastName: 'Patel',
    name: 'Raj Patel',
    homeDeskId: 'desk-west',
    preferredNumberOfRooms: 1,
    primaryPreferredRoomId: null,
    secondPreferredRoomId: null,
    windowPreference: 'prefers',
    alternateDeskIds: [],
    alternateRoomCodes: [],
    hasOfficeOnFloor: false
  }
];

// One day's worth of who's working, how many patients, which half of the
// day (AM/PM/FULL), and whether that day includes a video visit — this is
// ALWAYS per-day, never a static provider field (see ProviderManager.jsx's
// comment on why "has video visit" isn't there). Normally this comes from
// the uploaded PDFs via pdfParser.deriveDayEntries; this is just for local
// dev/testing.
export const sampleDayEntries = [
  { providerId: 'p1', isWorking: true, patientCount: 8, session: 'AM' },
  { providerId: 'p2', isWorking: true, patientCount: 20, session: 'FULL', hasVideoVisit: true },
  { providerId: 'p3', isWorking: true, patientCount: 6, session: 'PM' },
  { providerId: 'p4', isWorking: false, patientCount: 0, session: 'FULL' }
];

// Example room blocks — for the (currently disabled) room-blocking feature.
// Not loaded into the app; kept for when that feature is re-enabled.
export const sampleRoomBlocks = [
  { id: 'block-1', roomId: '22E', date: null, startMinutes: 10 * 60, endMinutes: 12 * 60, reason: 'Maintenance' },
  { id: 'block-2', roomId: '64E', date: '2026-09-10', startMinutes: null, endMinutes: null, reason: 'Deep clean' }
];
