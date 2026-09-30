# Room Assignment

Daily provider-to-room scheduler across three desks (React + Vite), with
scoring-based room assignment, overflow, and PDF import/export. Deployed to
Firebase Hosting with Cloud Firestore as the shared database.

## Project structure

```
src/
├── firebase.js                  # Firebase init (Firestore + Hosting)
├── App.jsx                      # Top-level app, tabs: Assign / Providers / Rooms
├── components/
│   ├── UploadFlow.jsx           # Per-desk PDF upload + Submit / Submit All, progress bar
│   ├── ProviderSummaryTable.jsx # Never-drop-provider report ("Not Found" cells)
│   ├── DeskBoard.jsx            # Per-desk room grid (AM/PM), per-desk PDF download
│   ├── ProviderManager.jsx      # Provider CRUD table, inline edit, sort, delete confirm
│   ├── RoomManager.jsx          # Room CRUD table, inline edit, sort, delete confirm
│   ├── RoomBlockManager.jsx     # Room blocks — disabled in UI, code intact (see below)
│   ├── ConfirmDialog.jsx        # Shared yes/no confirm popup (used by delete actions)
│   ├── LogsPanel.jsx            # Real per-run engine narration, clears on refresh
│   └── WarningList.jsx          # Surfaces unresolved overflow/video/capacity warnings
├── logic/
│   ├── assignmentEngine.js      # Pure rules engine (no Firebase/PDF calls) — see below
│   ├── pdfParser.js             # Text-layer PDF parser; extracts schedule date from header
│   ├── pdfOcrParser.js          # OCR + icon-classification fallback for rasterized PDFs
│   ├── pdfGenerator.js          # Per-desk output PDF (report page + floor-map page)
│   └── __tests__/assignmentEngine.test.js
└── data/seed.js                 # Sample desks/rooms/providers/day data
```

## Assignment engine (`assignmentEngine.js`)

Runs in this order for a given date:

1. **Blocked slots** — `computeBlockedSlots` marks any room-session (AM/PM)
   covered by a room block as unavailable before anything else runs.
2. **Fixed-room reservation** — a provider with `fixedRoom: true` and at
   least one patient that day gets their primary/second preferred room
   reserved up front, no scoring, no substitution, no overflow. Unavailable
   → "Not Found" for that slot; never moved elsewhere.
3. **Priority tiers** — `Doctor → Fellow → Any → Nurse`. Each tier is fully
   placed (home desk, then its own overflow) before the next tier starts.
4. **Per-slot room scoring** (`scoreRoom`), highest wins:
   `primary/second preferred room` (+10) → `otherPreferredRoomCodes` match
   (+7) → needs video-capable & room has it (+5) → `alternateRoomCodes`
   match (+5) → window preference match (+2) → room already half-filled by
   a complementary AM/PM provider (+1, or **+4** when this provider has
   only 1–2 patients that day — a light/likely-half-day case, so it's
   steered toward an already-shared room, leaving whole empty rooms for
   busier providers).
5. **Overflow** — only attempted when the home desk placed **zero** of a
   provider's needed rooms (a partial home-desk placement is never topped
   up elsewhere) during this pass. Tries each `alternateDeskIds` entry,
   lightest patient load first; a desk must fit **every** missing room at
   once or it's rolled back (`release()`) and the next desk is tried. A
   provider's rooms are never split across two desks in this pass — but see
   the fallback-fill pass below, which can still fill an unsplit remainder.
6. **Two-room adjacency (fallback only)** — when the system has to pick a
   provider's second room itself, the two rooms must be "beside each
   other": same letter suffix, room numbers exactly 2 apart (`22E`/`24E`,
   `63E`/`65E`, `30`/`32`). This is tried in order: (1) `secondPreferredRoomId`,
   if it's a room at that desk and open — used exactly as configured, **no**
   adjacency check; (2) `otherPreferredRoomCodes`, same — matched and used
   as-is, no adjacency check; (3) only once neither of those could be used,
   falls back to any open room adjacent to whatever the first room actually
   received. The Providers form does **not** filter the Second Preferred
   Room dropdown by adjacency — it only excludes whichever room is already
   picked as Primary — since an explicitly configured Second Preferred Room
   is always honored as typed, adjacent or not.
7. **Fallback fill** (last resort, once after every tier) — no working,
   non-fixed provider is left missing a room while a genuinely open one
   exists anywhere. Searches every desk (home, then `alternateDeskIds` by
   patient load, then every other desk by patient load); if nothing's open,
   may evict an already-placed Nurse (never a Doctor/Fellow/Any-type
   provider or a reserved fixed-room provider), then makes one attempt (no
   further eviction) to relocate that nurse elsewhere.
8. **Cross-check / backtracking** — the fallback-fill pass is re-run a few
   more times (bounded, stops once a pass changes nothing) against the true
   final room state, since a late placement in one pass can open up a room
   an earlier-processed provider had already given up on. This is the last
   step before results are considered ready to export.
9. **Video-capable validation** — one final pass: if `dayEntries[].hasVideoVisit`
   is true and the provider has no `hasOfficeOnFloor`, at least one assigned
   room should be video-capable (scored, not hard-enforced); unmet → warning.

Other rules: only `kind: 'exam'` rooms are ever assignable (`office`/
`utility` are floor-map-only, and never offered in the Providers form's
room dropdowns either — see below); a room has two half-day slots (AM/PM),
shared by complementary half-day providers; every real matched provider
always appears in the results (`roomSlots[i].roomId: null` = "Not Found"),
unmatched PDF names silently fill open rooms or are dropped; a blank/
whitespace provider name falls back to "Unknown provider"; `type` and
`suppressWarnings` are per-provider fields (see field list below); a
fixed-room provider with zero patients that day has their room released
back into the normal pool instead of reserved, so it's free for anyone.
Every run also returns a `logs` array — plain narration of what actually
happened ("Working on Desk A providers…", "Shifting Dr. X to Desk B",
"Cross-checking all assignments…", "Finalizing all the providers…"),
shown in the UI's Logs box (see below).

## UI

- **Assign rooms** — no date picker, uses today's date. Each desk submits
  its PDF independently (own Submit button); **Submit All** processes all
  three together (required for correct cross-desk overflow) and shows a
  progress bar above the button — it appears on any Submit click, animates
  while processing, and settles into a done/error state that stays until
  the page is reloaded. A **Logs** box sits between the upload section and
  the "Needs review" warnings, showing that run's real engine narration
  (`logs`, see above) — it clears on refresh, nothing is persisted. Each
  desk board has its own PDF download button.
- **Providers / Rooms tabs** — table with sortable columns (click a header
  to toggle asc/desc/default, including Type), inline edit (opens the edit
  form in a row under the one being edited, add form stays at the bottom),
  delete with a yes/no confirm popup. Providers default-sort by last name
  ascending, shown as `Last, First`; Rooms default-sort by room code
  ascending. Primary/Second preferred room dropdowns only ever list
  exam-kind rooms at the provider's selected default desk, always in
  ascending room-code order, and are mutually exclusive (picking a room in
  one clears it from the other if duplicated) — no adjacency filtering here
  (see the two-room adjacency rule above: it's an assignment-time fallback
  only, not a form constraint).

## Provider fields

`firstName`, `lastName`, `homeDeskId`, `preferredNumberOfRooms` (1–2),
`primaryPreferredRoomId`, `secondPreferredRoomId`, `otherPreferredRoomCodes`
(comma-separated codes, tried after primary/second), `windowPreference`,
`alternateDeskIds`, `alternateRoomCodes` (comma-separated), `fixedRoom`,
`type` (`Doctor`/`Fellow`/`Any`/`Nurse`), `hasOfficeOnFloor`,
`suppressWarnings`. No static "has video visit" field — that's decided
per day from the imported schedule.

## Room fields

`code`, `deskId`, `kind` (`exam`/`office`/`utility`), `hasWindow`,
`videoCapable`, `label` (office/utility floor-map text), `hall`, `row`,
`side` (floor-map layout — omit `hall` to fall back to a plain list).

## PDF import

`parseDeskScheduleFileAuto` tries the text-layer parser
(`pdfParser.js`) first; if it returns zero rows (rasterized/image-only
Epic export), it falls back to OCR (`pdfOcrParser.js`, lazy-loads
`tesseract.js`). Visit-type icons are classified by pixel color/shape
(blue → telephone, dropped; green filled → in-person; camera glyph →
video visit) rather than OCR text, since OCR misreads the icons. The
**schedule date** is read from the PDF's own header (both parsers) and
used for the exported PDF's content and filename — not the upload date.

## PDF export

One PDF per desk, `<DeskName>_<DDMonYYYY>.pdf` (date = that desk's
detected schedule date). Page 1: provider assignment report for that day.
Page 2: static floor-map reference (Hall/Row/Side layout from the Rooms
tab), room codes grouped into halls with office/utility labels or "V" for
video-capable pool rooms.

Name formatting in every exported page (`pdfGenerator.js`):
- A room shared AM/PM by two different providers prints **both**, as
  `LastName (AM)/LastName (PM)` (e.g. `Issa (AM)/Riad (PM)`) — occupancy is
  tracked per AM/PM slot rather than one name per room, so the second
  provider in a shared room no longer silently overwrites the first.
- A `Doctor`-type provider always prints as `Dr. LastName` (never the full
  name) everywhere a name appears in an export — a solo room, the "Not
  assigned a room today" list, all of it. Every other type keeps printing
  its full name, unchanged.

## Room Blocks — disabled, not deleted

No UI tab; `App.jsx` always passes `roomBlocks: []`. Engine logic
(`computeBlockedSlots`, `isBlocked`/`canFit`) and `RoomBlockManager.jsx`
are intact. To re-enable: uncomment the import/tab/render branch in
`App.jsx` and pass a real `roomBlocks` array.

## Firestore

`App.jsx` currently uses local `useState` seeded from `src/data/seed.js`.
To wire up persistence, replace with `onSnapshot` listeners and have each
manager's `onChange` write to Firestore instead:

- `desks` — `{ name }`
- `rooms` — see Room fields above
- `providers` — see Provider fields above
- `roomBlocks` — `{ roomId, date, startMinutes, endMinutes, reason }`
  (only needed once Room Blocks is re-enabled)

`assignmentEngine.js`, `pdfParser.js`, `pdfGenerator.js` are pure
functions of whatever data is passed in — no change needed there.

## Setup & deploy

```bash
npm install
npm test              # vitest — src/logic/__tests__/assignmentEngine.test.js
npm run build
firebase deploy
```

GitHub Actions (`.github/workflows/firebase-hosting-merge.yml`) builds and
deploys automatically on push to `main`. Repo secrets required:
`FIREBASE_SERVICE_ACCOUNT` (Hosting deploy key) and the six
`VITE_FIREBASE_*` values from `.env`.
