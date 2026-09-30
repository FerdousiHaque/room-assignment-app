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
4. **Per-slot room filling** (`fillMissingSlots`), tried in this order for
   whichever slots are still missing:
   1. Each missing slot's own named preference — `primaryPreferredRoomId`
      for slot 0, `secondPreferredRoomId` for slot 1 — a hard check (must be
      a room at that desk and open), independently per slot, used exactly
      as configured.
   2. **"Other Set of Rooms" (`otherPreferredRoomCodes`)** — an ordered,
      exhaustive list, tried in the exact order the codes were typed, NOT a
      scoring bonus (see `tryOrderedList`):
      - Only one slot still missing: each room in the list is tried one at
        a time, in order — the first one that's open wins. If that's slot 1
        of a 2-room provider (slot 0 already has a room, from a preference
        or this same list), a room in the list that's actually **adjacent**
        to slot 0's room is tried first, for a tidier pair; any other open
        room in the list still works if none are adjacent.
      - Both slots still missing on a 2-room provider: the list is tried as
        consecutive PAIRS in order (the first two codes as a pair, else the
        next two, and so on) — the first pair where both rooms are open
        wins. The two rooms in a pair don't need to be adjacent, since both
        are explicitly named. If the list has an **odd number of codes**
        (can't be evenly paired), it's skipped entirely here — not even a
        leading complete pair is used — falling straight through to the
        adjacency fallback (step 3) instead.
   2b. **"Alt desk rooms" (`alternateRoomCodes`)** — the exact same
      ordered/paired/adjacency-preference/odd-skip treatment as step 2,
      one tier lower, but **only** at a desk that's actually one of this
      provider's checked "Alternate desks (overflow-eligible)" — a code is
      matched only against that specific desk's own rooms, never the home
      desk and never a different alternate desk that happens to have a room
      with the same code, even when several alternate desks are checked at
      once.
   3. Whatever's still missing falls back to preference-scored room
      selection (`scoreRoom`), highest wins: primary/second exact match
      (+10, redundant with step 1 above but kept as a score) → needs
      video-capable & room has it (+5) → `alternateRoomCodes` match (+5) →
      window preference match (+2) → room already half-filled by a
      complementary AM/PM provider (+1, or **+4** when this provider has
      only 1–2 patients that day — a light/likely-half-day case, so it's
      steered toward an already-shared room, leaving whole empty rooms for
      busier providers, and considered at every placement/fallback pass,
      not just after the fact) → an `otherPreferredRoomCodes`/
      `alternateRoomCodes` match left over from steps 2/2b (usually inert
      by this point, since those steps already claimed any match that was
      actually open).
5. **Overflow** — only attempted when the home desk placed **zero** of a
   provider's needed rooms (a partial home-desk placement is never topped
   up elsewhere) during this pass. Tries each `alternateDeskIds` entry,
   lightest patient load first (this ordering is unaffected by `alternateRoomCodes` —
   see step 2b above for how that field itself is matched once a
   particular alternate desk is actually being tried); a desk must fit
   **every** missing room at once or it's rolled back (`release()`) and the
   next desk is tried. A provider's rooms are never split across two desks
   in this pass — but see the fallback-fill pass below, which can still
   fill an unsplit remainder.
6. **Two-room adjacency (fallback only)** — when the system has to pick a
   provider's second room itself, the two rooms must be "beside each
   other": same letter suffix, room numbers exactly 2 apart (`22E`/`24E`,
   `63E`/`65E`, `30`/`32`). This is only step 3 above (`secondPreferredRoomId`,
   `otherPreferredRoomCodes`, and `alternateRoomCodes` — steps 1, 2, 2b —
   are always used exactly as configured, no hard adjacency requirement,
   though step 2/2b do prefer an adjacent candidate when choosing among
   several open ones); it falls back to any open room adjacent to whatever
   the first room actually received. The Providers form does **not** filter
   the Second Preferred Room dropdown by adjacency — it only excludes
   whichever room is already picked as Primary — since an explicitly
   configured Second Preferred Room is always honored as typed, adjacent or
   not.
7. **Fallback fill** (last resort, once after every tier) — no working,
   non-fixed provider is left missing a room while a genuinely open one
   exists anywhere. Searches every desk (home, then `alternateDeskIds` by
   patient load, then every other desk by patient load); if nothing's open,
   may evict an already-placed Nurse (never a Doctor/Fellow/Any-type
   provider or a reserved fixed-room provider), then makes one attempt (no
   further eviction) to relocate that nurse elsewhere.
8. **Cross-check / backtracking** — the fallback-fill pass is re-run a few
   more times (bounded, stops once a round changes nothing), interleaved
   with step 9 below, against the true, current room state — a placement
   made late in one pass can open up a room an earlier-processed provider
   had already given up on.
9. **Video-capable backtracking** (`tryImproveVideoCapableFit`) — unlike
   step 8, which only ever fills a fully-missing slot, this revisits a
   provider who already has a room but not a video-capable one when they
   needed it, and tries to **swap** them into a video-capable room held by
   someone who (a) doesn't need video-capable themselves, (b) isn't a
   same-day fixed-room reservation, and (c) isn't a higher-priority type —
   a Nurse's video need can never bump a Doctor/Fellow/Any-type provider.
   The swap only ever commits if the displaced provider can genuinely be
   relocated to another open room in the same attempt; otherwise everything
   is rolled back and the mismatch is left as a warning — the never-drop-a-
   provider guarantee always wins. This is the last step before results are
   considered ready to export.
10. **Video-capable validation** — one final pass: if `dayEntries[].hasVideoVisit`
    is true and the provider has no `hasOfficeOnFloor`, at least one
    assigned room should be video-capable; still unmet after step 9's
    backtracking → warning.

Other rules: only `kind: 'exam'` rooms are ever assignable (`office`/
`utility` are floor-map-only, and never offered in the Providers form's
room dropdowns either — see below); a room has two half-day slots (AM/PM),
shared by complementary half-day providers, and a provider with only 1–2
patients that day is treated as an especially good candidate for that kind
of sharing throughout placement — not just patched in afterward (see step 4
above); every real matched provider always appears in the results
(`roomSlots[i].roomId: null` = "Not Found"), unmatched PDF names silently
fill open rooms or are dropped; a blank/whitespace provider name falls back
to "Unknown provider"; `type` and `suppressWarnings` are per-provider
fields (see field list below); a fixed-room provider with zero patients
that day has their room released back into the normal pool instead of
reserved, so it's free for anyone.
Every run also returns a `logs` array — plain narration of what actually
happened ("Working on Desk A providers…", "Shifting Dr. X to Desk B",
"Cross-checking all assignments…", "Finalizing all the providers…"); the UI
doesn't currently surface it anywhere (an earlier Logs box was removed per
feedback that it wasn't working as expected).

## UI

- **Assign rooms** — no date picker, uses today's date. Each desk submits
  its PDF independently (own Submit button); **Submit All** processes all
  three together (required for correct cross-desk overflow) and shows a
  progress bar above the button — it appears on any Submit click and
  settles into a done/error state that stays until the page is reloaded.
  For **Submit All**, every percentage is tied to a real, actually-completed
  step rather than simulated: each desk's file import earns its own real
  20% jump the moment that desk's parse resolves (so all three imported =
  60%), then the parent reports back as it actually finishes assigning
  rooms and generating each desk's PDF, climbing in real steps to 90%, and
  only jumps to 100% once everything has genuinely finished — never a fake
  "done" before the work is actually over. A single desk's own Submit has
  just one real event to report (the parse finishing), so that one still
  uses a simulated climb-to-90%-then-jump animation while it waits. Each
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
("Other Set of Rooms" — comma-separated codes, tried in typed order after
primary/second: one at a time for a single missing room, or as consecutive
pairs when both of a 2-room provider's rooms are still missing — see the
assignment engine section above), `windowPreference`, `alternateDeskIds`
("Alternate desks (overflow-eligible)" — a checkbox list, one or more),
`alternateRoomCodes` ("Alt desk rooms", comma-separated — the same
ordered/paired treatment as `otherPreferredRoomCodes`, one tier lower, but
only at whichever of `alternateDeskIds` is actually being tried; a code is
never matched against a different desk's room even if it shares the same
code), `fixedRoom`, `type` (`Doctor`/`Fellow`/`Any`/`Nurse`),
`hasOfficeOnFloor`, `suppressWarnings`. No static "has video visit" field —
that's decided per day from the imported schedule.

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

**Duplicate-visit filtering**: `deriveDayEntries` (and the unmatched-name
path, `buildUnmatchedProviderEntries`) dedupe by the row's MRN-ish column
(`rowMrn` — checks a short list of likely header spellings, since an
unrecognized PDF column keeps its own literal header text as the field
name) — if the same provider has the same MRN more than once, every visit
after the first is ignored entirely, before patient counts, session
(AM/PM/FULL) detection, or the video-visit flag are ever computed, so a
duplicate can never affect room assignment. A row with no readable MRN at
all is never treated as a duplicate of anything.

## PDF export

One PDF per desk, `<DeskName>_<DDMonYYYY>.pdf` (date = that desk's
detected schedule date): the desk's full room grid (Hall/Row/Side layout
from the Rooms tab, or a plain one-column list if that's not configured),
every room shown whether or not anyone's assigned there today, plus a
"Not assigned a room today" list for anyone from that desk who still has a
missing slot. An unoccupied exam room prints **blank** — no "window" /
"video-capable" descriptor and no "Empty" placeholder text — so an unfilled
room reads as genuinely empty rather than advertising capabilities nobody's
using today. (The older combined, all-desks, two-page report+floor-map
export — `generateAssignmentPdf`/`drawFloorMapPage` — is kept in
`pdfGenerator.js` for reference but isn't called by the UI.)

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
