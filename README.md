# Room Assignment

Daily provider-to-room scheduler across three desks, with overflow
handling, window/video-room/preferred-room preferences, and per-day
patient variability driven by uploaded schedule PDFs.

## Project structure

```
src/
├── firebase.js              # Firebase init (reads keys from .env) — NOT wired up yet, see note below
├── App.jsx                  # Top-level app, tabs between Assign / Providers / Rooms
├── components/
│   ├── UploadFlow.jsx          # Upload one PDF per desk, each with its own independent Submit button
│   ├── ProviderSummaryTable.jsx # Never-drop-provider report: one row per provider, "Not Found" cells
│   ├── DeskBoard.jsx           # One desk's physical room grid, AM/PM occupancy, per-desk PDF download
│   ├── ProviderManager.jsx     # Add/edit provider table (preferences, office-on-floor, alt desk rooms)
│   ├── RoomManager.jsx         # Add/edit/delete room table (window, video-capable)
│   ├── RoomBlockManager.jsx    # Add/edit/delete room blocks — DISABLED in the UI, code kept (see below)
│   └── WarningList.jsx         # Surfaces unresolved overflow/video/capacity issues
├── logic/
│   ├── assignmentEngine.js     # Pure rules engine — no Firebase/PDF calls
│   ├── pdfParser.js            # Reads uploaded schedule PDFs into rows
│   │                           # (text-layer based); incl. video-visit
│   │                           # detection and silent handling of
│   │                           # unmatched provider names
│   ├── pdfOcrParser.js         # OCR + icon-classification fallback for
│   │                           # rasterized PDFs (real Epic exports) —
│   │                           # used automatically when pdfParser.js
│   │                           # finds no text layer
│   ├── pdfGenerator.js         # Builds the per-desk output PDF (provider report + desk floor-map page)
│   └── __tests__/
│       └── assignmentEngine.test.js  # Vitest suite — see "Running tests"
└── data/
    └── seed.js                 # Sample desks/rooms/providers/day data
```

The app runs on local React state seeded from `src/data/seed.js` for
desks/rooms/providers, so you can see it working with no Firebase project
connected. **Firebase is not currently wired up** — nothing persists
across a page reload, and nothing syncs between two people using the app
at the same time. See "Connecting Firestore" below for what's needed to
change that.

## Room Blocks — currently disabled, not deleted

Per request, the room-blocking feature is hidden from the UI but the code
is fully intact:

- No **Room blocks** button/tab appears on the home page.
- `App.jsx` always passes `roomBlocks: []` into the assignment engine, so
  no room is ever treated as blocked.
- `RoomBlockManager.jsx` and all of the engine's block-checking logic
  (`computeBlockedSlots`, the `isBlocked`/`canFit` checks) are untouched.

To bring it back: in `App.jsx`, uncomment the `RoomBlockManager` import,
the `'blocks'` tab button, its render branch, and pass a real editable
`roomBlocks` array (instead of `[]`) into `generateDailyAssignments`.

## How the daily flow works

1. Go to **Assign rooms**. There is no date picker — the app uses today's
   date automatically for the assignment run.
2. Each desk has its own file picker and its own **Submit** button — there
   is no shared/global submit step. Upload Desk A's PDF and click its
   Submit button, then do the same for Desk B and Desk West, in any order
   and at any pace. Submitting a desk parses only that desk's file (column
   order doesn't matter — headers are matched by keyword) and merges its
   rows into the report; the report updates as soon as even one desk has
   been submitted, and updates again as each additional desk comes in.
   Re-uploading and re-submitting a single desk (e.g. a corrected PDF)
   only replaces that desk's data — the other desks are untouched.
3. Each submission matches provider names (`LastName, FirstName`) against
   the **Providers** list, works out each provider's AM/PM/full-day session
   from their visit times, detects video/virtual visits from the report
   (see "Video visit detection" below), and re-runs the assignment engine
   — respecting preferred rooms, alternate-desk rooms, and the
   video-capable-room requirement — across whatever desks have been
   submitted so far.
4. **Provider assignment report** (top of the page) lists every real,
   scheduled provider — this never shrinks; a provider who couldn't get a
   room shows **Not Found** in that room-slot cell instead of disappearing.
5. The desk boards below show the physical room-by-room view (shared
   AM/PM rooms show both occupants).
6. Each desk board has its own **Download `<Desk Name>` PDF** button —
   there's no combined all-desk export. See "Export PDF" below for the
   filename convention and layout status.

Rows whose provider name doesn't match anyone in **Providers** are
handled separately: they silently fill whatever room is open (their own
desk first, then any other desk) at the lowest priority, and are simply
dropped with no warning if nothing's open. They never appear in the
Provider assignment report, since they aren't real staff — that report's
"never disappears" guarantee is about your actual providers.

## PDF import for real (rasterized) Epic exports — OCR pipeline

The three real sample exports (`demo_desk_A.pdf`, `demo_desk_B.pdf`,
`demo_desk_west.pdf`) were checked with `pdffonts`/`pdftotext`/`pdfinfo`
and confirmed to be **fully rasterized/image PDFs with zero embedded
text** (`Producer: Microsoft: Print To PDF`, `Title: EpicPDFSpooler_...`,
no fonts, no extractable text at all) — different from what was assumed
earlier in this project (that exports would be text-based/selectable).

**`src/logic/pdfOcrParser.js` is the fallback for exactly this case.**
`UploadFlow.jsx` now calls `parseDeskScheduleFileAuto` (in `pdfParser.js`)
instead of the plain text-based parser directly: it tries the fast
text-layer read first, and automatically falls back to OCR when that
comes back with zero rows. Nothing in the UI changes — a real Epic PDF
just takes longer to process (rendering + OCR-ing every page) and the
button shows "Processing…" while that happens.

**How it works:** each page is rendered to an image (via `pdfjs-dist`,
same library the text parser already uses, just rendering instead of
reading text), OCR'd with `tesseract.js` for the text fields (time,
patient, provider, MRN), and each visit's row boundary is found by
detecting the thin horizontal gray divider line between visits — exactly
the "bar/straight line to separate each visit" described in the original
request. The three visit-type icons are **never** identified from OCR'd
text (OCR reads them as inconsistent garbage characters between runs —
confirmed during testing) — instead, each icon's own crop is analyzed by
actual pixel color and shape:
- **Blue** and clearly bluer than green → **telephone** (skipped — the
  row is never emitted, per "you do not have to consider anything, just
  ignore that row")
- **Green and solidly filled** (a dense two-person silhouette, sometimes
  rendered two-tone for a two-provider visit) → **in-person**
- Anything else (a muted, mostly-outline camera glyph) → **video visit**
  (sets `hasVideoVisit` for that day, same as the old keyword-based
  detection did when it found a match)

**How this was validated:** this sandbox has no browser, so the actual
`tesseract.js` + `<canvas>` code path in `pdfOcrParser.js` couldn't be
executed end-to-end here. Instead, the exact same algorithm (row
segmentation via divider-line detection, icon classification via pixel
color/fill-ratio thresholds, field extraction via OCR word positions) was
prototyped and tested in Python against the real `demo_desk_A.pdf` pages
— using the system Tesseract binary, the same underlying OCR engine
`tesseract.js` wraps — and every visit row on the tested pages, including
tricky edge cases (a two-tone in-person icon, a stray "note" icon right
next to the visit icon, the page-header's own timestamp nearly being
mistaken for the first visit's time), came back correctly classified with
clean provider names and times. The constants in `pdfOcrParser.js`
(icon-classification thresholds, crop geometry, row-anchoring logic) are
exactly what that validated prototype used. **What's still needed:** a
real run in an actual browser (`npm run dev`, upload a real desk PDF) to
confirm `tesseract.js`'s output shape matches what `pdfOcrParser.js`
expects and to check timing/accuracy on the full set of pages across all
three files — the algorithm is proven, but this specific file hasn't been
exercised in the real runtime it ships in. If something's off,
`parseDeskScheduleFileOcr(file, deskId, { debug: true })` logs each
detected block's classification to the console.

**New dependency:** `tesseract.js` was added to `package.json`. It's
lazy-loaded (dynamic `import()`) only when a PDF's text layer comes back
empty, so text-based PDFs never pay for it.

If a text-based export becomes available from Epic instead (many Epic
reports offer a "text"/"selectable" print option, or a CSV/Excel export),
that's still the simpler and faster path — the existing keyword-based
column parser in `pdfParser.js` would need only minor adjustments.

## Export PDF

- **Filename:** `<DeskName>_<DDMonYYYY>.pdf`, e.g. `DeskA_25Sep2026`,
  `DeskWest_25Sep2026` (spaces stripped from the desk name; day is
  zero-padded; month is a 3-letter abbreviation).
- **One PDF per desk**, generated from that desk's own Download button, two pages:
  - **Page 1 — Provider Assignment Report.** Changes every day: one row
    per provider scheduled at that desk today, their room slot(s), "Not
    Found" where nothing could be assigned.
  - **Page 2 — floor map.** A **static** reference page matching the real
    "Mayo 19 - `<Desk>` Desk" sample export: room numbers grouped into
    halls, each showing a permanent office's name, a utility space's
    label (Hallway, Restroom, Staff Workroom, Conference Room, etc.), or
    **"V"** for a video-capable pool room (blank for a plain pool room).
    This page is intentionally the same every time — it's a floor-plan
    reference, not a daily report, confirmed against the real sample and
    how it's actually used.
- **Setting up a desk's floor map:** on the **Rooms** tab, give each room
  a `Hall` name, a `Row` number, and a `Side` (left/right) — rooms sharing
  the same Hall + Row print on the same line, left and right of the
  corridor. Set `Kind` to **Office** (with a label like "Dr. Smith
  Office") for a provider's permanent room, or **Utility** (with a label
  like "Hallway") for a non-patient space — both are automatically
  excluded from the daily assignment pool (see "Room kinds" below). A
  desk with no Hall set on any of its rooms falls back to a plain
  one-column room list on page 2 instead. **Desk A is fully configured**
  as a worked example, transcribed field-by-field from the real sample
  export — see `src/data/seed.js`. **Desk B and Desk West aren't
  configured yet** (no confirmed real floor plan for them) — set up their
  Hall/Row/Side/Kind values on the Rooms tab the same way once you have
  their real layout, or send it over and it can be seeded the same way
  Desk A was.

## Room kinds

Every room now has a `kind`, set on the **Rooms** tab:

- **Exam (pool)** — the default. The only kind ever handed to a provider
  by the assignment engine. Shows "V" on the floor-map export if
  Video Capable is checked, otherwise blank.
- **Office** — a specific provider's permanent room. Never enters the
  daily assignment pool (they don't see patients there — this is what
  ties together with a provider's **Office on floor** checkbox: if they
  have a permanent office, they don't need a video-capable pool room for
  a video visit either, per the existing video-capable rule). Shows its
  label (e.g. "Dr. Greene Office") on the floor map.
- **Utility** — a non-patient space (hallway, restroom, workroom,
  conference room). Also excluded from the pool. May or may not have a
  room number. Shows its label on the floor map.

## Provider preferences, in priority order

When picking a room for a provider, the engine scores each candidate and
picks the highest score:

1. Matches their **Primary Preferred Room** (for room slot 1) or **Second
   Preferred Room** (for slot 2 — only used if Preferred Number of Rooms is 2)
2. Is **Video Capable**, if the provider needs one that day (see below)
3. Matches one of the provider's **Alt desk rooms** (free-text, comma-
   separated room codes) — same scoring weight as the window preference,
   most useful when overflowing to another desk
4. Has a **window**, if the provider prefers one
5. Is already half-filled by a complementary AM/PM provider (conserves rooms)

If a preferred room is taken, the provider still gets *a* room (whatever
scores next-best) — preferences are best-effort, not hard requirements,
except where noted below.

## Video-capable room requirement

- A provider needs a video-capable room only if **(a)** that day's
  imported schedule shows a video/virtual visit for them **and (b)** they
  don't have an office on the floor (`hasOfficeOnFloor`, set once on the
  Providers page).
- There is **no static "Has video visit" field on a provider anymore** —
  whether a video-capable room is needed is decided entirely fresh each
  day from that day's import. A provider who needed one last week but
  has no video visit today won't be held to that requirement today, and
  vice versa.
- **Video visit detection** depends on which parser actually read the
  file (this is automatic — see "PDF import for real (rasterized) Epic
  exports" above): for a real rasterized Epic PDF (read via
  `pdfOcrParser.js`), it comes from classifying each row's visit-type
  icon by its pixel color/shape — video-camera icon = video visit,
  two-person icon = in-person, phone icon = telephone (that row is
  dropped entirely). For a text-based PDF (read via the original
  `pdfParser.js`), it falls back to a dedicated yes/no-style column
  (header containing "video visit", "virtual visit", "is video", etc.,
  read as a boolean) or, failing that, a descriptive visit-type/modality
  column checked for "video", "virtual", "telehealth", etc.
- This is enforced as a **strong preference during placement**, not a hard
  guarantee — if no video-capable room is available at all (or the
  provider's other preferences conflict), a warning is raised rather than
  silently ignoring the requirement or reshuffling other providers'
  assignments to force it.

## Rooms

Rooms are identified by their real codes (e.g. `22E`, `64W`) — set up
under the **Rooms** tab, along with **Window** and **Video Capable**
flags. A desk's capacity is just the count of rooms assigned to it there;
there's no separate stored number to keep in sync.

## Providers

Each provider record has:

- Name, home desk
- Preferred Number of Rooms (1 or 2), Primary/Second Preferred Room
- Window preference
- Alternate Desks (which other desks they can overflow to)
- **Alt desk rooms** — free-text, comma-separated specific room codes to
  favor when overflowing (e.g. `64W, 68W`) — separate from, and can be
  used alongside, the Alternate Desks list
- Office on floor (used only for the video-capable-room exception above)

There is no "Has video visit" checkbox on this page — see the
video-capable section above for why that's now entirely day-driven.

## Connecting Firestore

Replace the local `useState` seeded from `src/data/seed.js` in `App.jsx`
with `onSnapshot` listeners against Firestore collections, and have each
manager component's `onChange` write to its collection instead of calling
`setProviders`/`setRooms`:

- `desks` — `{ name }`
- `rooms` — `{ deskId, code, hasWindow, videoCapable }`
- `providers` — `{ name, firstName, lastName, homeDeskId,
  preferredNumberOfRooms, primaryPreferredRoomId, secondPreferredRoomId,
  windowPreference, alternateDeskIds, alternateRoomCodes, hasOfficeOnFloor }`
- `roomBlocks` — `{ roomId, date, startMinutes, endMinutes, reason }`
  (only needed again once the Room Blocks feature is re-enabled)
- `dailySchedules/{date}` — computed dayEntries, if you want to persist a
  day's parsed schedule rather than re-parsing PDFs each time

`assignmentEngine.js`, `pdfParser.js`, and `pdfGenerator.js` don't need to
change — they're pure functions of whatever data you pass in.

## Firebase project setup (one-time)

1. Create a project at https://console.firebase.google.com
2. Enable **Firestore Database** and **Hosting** (and **Authentication** if
   you want to restrict who can edit schedules).
3. In Project Settings → General, register a Web App and copy the config
   values into your `.env`.
4. Update `.firebaserc` with your real project ID.
5. Install the Firebase CLI: `npm install -g firebase-tools`, then `firebase login`.

## Deploying

**Manual:**
```bash
npm run build
firebase deploy
```

**Automatic on push to `main` (GitHub Actions):**

The workflow at `.github/workflows/firebase-hosting-merge.yml` builds and
deploys on every push to `main`. Add these repo secrets (Settings →
Secrets and variables → Actions):

- `FIREBASE_SERVICE_ACCOUNT` — JSON key with Hosting deploy permission
  (generate via `firebase init hosting:github`, recommended over doing it
  by hand)
- The six `VITE_FIREBASE_*` values from your `.env`

Then replace `YOUR_FIREBASE_PROJECT_ID` in the workflow file with your
actual project ID.

## Running tests

```bash
npm install
npm test
```

`src/logic/__tests__/assignmentEngine.test.js` covers: never-drop-provider
("Not Found" instead of disappearing), 2-room preference with primary/
second preferred rooms, room blocks (full-day, date-scoped, and
partial/half-day blocking — still tested even though the UI is currently
disabled, since the engine code is unchanged), the video-capable
requirement (including the office-on-floor exception, and confirming it's
decided fresh per day with no static provider field), alternate-room-code
scoring during overflow, unmatched-provider silent-fill/silent-drop
behavior, and the AM/PM half-day sharing rule.

**Note:** these tests were traced by hand against the engine logic with a
plain `node` script (no `npm install`/`npm test` available in the
environment this was built in — outbound access to the npm registry was
blocked there) — run `npm test` after `npm install` on your own machine
to confirm with the real Vitest runner; flag anything that doesn't match.

## Rules implemented so far

1. Desks contain rooms; each provider has a home desk.
2. A provider's **Preferred Number of Rooms** (1 or 2) is attempted via
   their **Primary**/**Second Preferred Room**, then any available room.
3. Assignments are computed per date (today) from that day's schedule —
   nothing repeats automatically.
4. Window preference, video-capable requirement, preferred rooms, and
   alt-desk room codes are all scored together when picking a room (see
   priority order above).
5. Overflow to a provider's **Alternate Desk** list when their home desk
   can't fit them, ranked by spare capacity and fewest patients; alt desk
   room codes are favored within that overflow.
6. Room codes, window/video-capable flags, and daily volume/schedules are
   all data-driven.
7. A room has two half-day slots (AM/PM); complementary half-day providers
   can share a room; a full-day provider takes the whole room.
8. Room blocks (engine logic retained, UI currently disabled) exclude a
   room's AM and/or PM slot for a date (or every date, if recurring)
   before any assignment is attempted.
9. Video-capable room requirement, decided entirely from that day's
   import plus the office-on-floor exception — no static provider flag.
10. **Every real, scheduled provider always appears in the report** — a
    room slot that couldn't be filled shows "Not Found" rather than the
    provider being dropped. (Unmatched-name PDF rows are the one
    exception — they silently fill open rooms or are dropped, per an
    earlier requirement, since they aren't real staff.)

## Open items worth a decision

- **PDF import for real Epic exports** — the OCR + icon-classification
  pipeline is built (`pdfOcrParser.js`, wired in automatically) and its
  logic was validated against real sample pages via a Python/Tesseract
  prototype (see "PDF import for real (rasterized) Epic exports" above for
  what that did and didn't cover). It still needs a real run in an actual
  browser against all three sample files to confirm accuracy end-to-end
  with `npm run dev` — the algorithm is proven, this specific file hasn't
  been executed in its real runtime yet.
- **Desk B / Desk West floor maps** — not configured yet (see "Setting up
  a desk's floor map" above); their export page 2 currently falls back to
  a plain room list until real Hall/Row/Side/Kind data is entered.
- Whether "video-capable required" should ever *force* a reshuffle of
  other providers' rooms rather than just raising a warning when nothing's
  available — current behavior is best-effort + warning.
