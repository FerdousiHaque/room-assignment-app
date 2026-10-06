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

0. **No-room-needed exclusion** — before anything else, a provider is
   dropped from the working set entirely (no assignment attempt, no
   warning, doesn't occupy a room, doesn't count toward any desk's load)
   when **all** of: `hasOfficeOnFloor` is true, they have **zero in-person
   patients** that day (`inPersonPatientCount` — video and telephone visits
   don't count as in-person), and their `type` **is** `Doctor` or `Fellow`
   — this exemption is Doctor/Fellow-only; a `Nurse` or `Any`-type provider
   in the identical situation (office on the floor, an all-video/telephone
   day) still gets a room regardless of visit mix. `inPersonPatientCount` is
   computed by the PDF parser: it starts from `patientCount` and subtracts
   video visits; telephone-visit rows are dropped entirely upstream (never
   counted in `patientCount` either, never left in `unmatched`) — this
   matches the existing OCR parser's telephone handling.
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
        are explicitly named. If the list has an **odd number of codes**,
        every complete leading pair is still tried (5 codes tries 1&2, then
        3&4) — only the single trailing leftover code goes unused, falling
        through to the adjacency fallback (step 3) for whichever slot it
        would have filled.
   2b. **"Alt desk rooms" (`alternateRoomCodes`)** — the exact same
      ordered/paired/adjacency-preference treatment as step 2, one tier
      lower, but **only** at a desk that's actually one of this
      provider's checked "Alternate desks (overflow-eligible)" — a code is
      matched only against that specific desk's own rooms, never the home
      desk and never a different alternate desk that happens to have a room
      with the same code, even when several alternate desks are checked at
      once.
   3. Whatever's still missing falls back to preference-scored room
      selection (`scoreRoom`), highest wins: primary/second exact match
      (+10, redundant with step 1 above but kept as a score) → needs
      video-capable & room has it (+5) → `alternateRoomCodes` match (+5,
      **desk-scoped**: only awarded when the candidate room's own desk is
      actually one of this provider's checked alternate desks — room
      numbering commonly repeats across desks/wings, so without this check
      a code typed for one alternate desk could wrongly boost a
      same-numbered room at an entirely different desk, including the home
      desk or one never checked as an alternate at all) → window
      preference match (+2) → room already half-filled by a
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
   lightest **in-person** patient load first — `patientLoad` sums each
   desk's already-placed providers' `inPersonPatientCount`, so a desk full
   of video-only visits doesn't look "busy" and a desk with real in-person
   volume does, even if the video-heavy desk's raw `patientCount` is higher
   (this ordering is unaffected by `alternateRoomCodes` —
   see step 2b above for how that field itself is matched once a
   particular alternate desk is actually being tried); a desk must fit
   **every** missing room at once or it's rolled back (`release()`) and the
   next desk is tried. A provider's rooms are never split across two desks
   in this pass — but see the fallback-fill pass below, which can still
   fill an unsplit remainder.
6. **Two-room adjacency (fallback only, preferred — never a reason to leave
   a provider without a room)** — when the system has to pick a provider's
   second room itself (step 3 above; `secondPreferredRoomId`,
   `otherPreferredRoomCodes`, and `alternateRoomCodes` — steps 1, 2, 2b —
   are always used exactly as configured, no hard adjacency requirement,
   though step 2/2b do prefer an adjacent candidate when choosing among
   several open ones), it first tries any open room "beside" the first
   room: same letter suffix, room numbers exactly 2 apart (`22E`/`24E`,
   `63E`/`65E`, `30`/`32`). If **no** adjacent room is open, it falls back
   to **any** open room at that desk, adjacent or not — adjacency is a
   nice-to-have for a tidier pair, never a reason to leave this provider
   without a second room while some other, non-adjacent room sits empty
   (that would break the never-drop-a-provider guarantee in step 7 below
   for no real benefit). The Providers form does **not** filter the Second
   Preferred Room dropdown by adjacency — it only excludes whichever room
   is already picked as Primary — since an explicitly configured Second
   Preferred Room is always honored as typed, adjacent or not.
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
11. **Effective rooms needed (2-rooms-down-to-1 reduction)** — a provider's
    `preferredNumberOfRooms` is their standing configuration, not
    necessarily how many rooms they actually need on a given day. Before
    placement, every entry gets a computed `effectiveRoomsNeeded`
    (`computeEffectiveRoomsNeeded`) that every placement/overflow/fallback/
    eviction step reads instead of `preferredNumberOfRooms` directly:
    - **Nurse** type: always exactly 1 room, full stop, regardless of
      `preferredNumberOfRooms` or how busy the day is — the field is
      ignored entirely for this type.
    - Configured for 2 rooms, any other type: still 2, **unless** the
      entry has at most 1 in-person visit in *each* half-day separately
      (`inPersonAmCount <= 1` and `inPersonPmCount <= 1`, tracked by
      `pdfParser.js`'s `deriveDayEntries`) — one in-person visit per half
      never needs two simultaneous rooms, whether it's paired with a
      video/telephone visit in that same half or with a second in-person
      visit on the other side of noon (1 AM + 1 PM still reduces to 1
      room). If either per-half-day count is missing (an entry predating
      this field), the configured value is used as-is.
    - Configured for 1 room: always 1, nothing to reduce.

    This applies identically to fixed-room providers (step 2) — a
    fixed-room provider whose day reduces to 1 room only has their primary
    room reserved; the second preferred room is simply never reserved in
    the first place, so it's automatically available to anyone else.
12. **Room contention tie-break** — placement within one priority tier (#3)
    at one desk is first-come, first-served: whoever is processed first
    simply claims a contested room first. Entries are sorted before
    placement so ties resolve sensibly instead of by arbitrary input order:
    whoever needs a video-capable room and has no office on the floor goes
    first; among the rest, whoever has more in-person patients today goes
    first. This only decides who gets first crack at a desk — it doesn't
    change what either provider is eligible for. The provider who loses a
    contested room still gets their normal fallback attempt (next
    preference, Other Set of Rooms, Alt desk rooms, adjacency, generic
    scoring) or, failing that, overflow (#5) to whichever alternate desk
    has the lowest in-person patient load.
13. **Reshuffle any provider to complete a two-room adjacent pair** — the
    fallback pass's eviction logic previously only ever bumped an
    already-placed Nurse out of a room (see step 6's cross-check). Now,
    specifically when a provider still needs the SECOND room of an
    adjacent pair (step 6) and neither an open room nor an evictable Nurse
    could be found anywhere, the system also tries evicting any OTHER
    already-placed, non-fixed-room occupant of the SAME OR LOWER priority
    type (#3) than the provider who needs the room — never a strictly
    higher one (a Nurse or Any-type still can't bump a Doctor/Fellow this
    way). This is only ever kept if the evicted occupant can genuinely be
    relocated to another open room (anywhere they're eligible to work, not
    just the same desk) in that same attempt; if they can't, the whole
    thing is rolled back and the slot is left exactly as it was — so
    nobody ends up without a room as a net result of this reshuffle.
    Pseudo (unmatched-name) entries are never evicted this way.
14. **Final two-room adjacency validation/repair** — runs LAST, right
    before results are considered export-ready. Every provider who needs 2
    rooms and has both slots filled is double-checked for real adjacency
    (step 6), with exactly ONE exemption: a pair that is EXACTLY the
    provider's own configured Primary Preferred Room + Second Preferred
    Room (in either slot order) is always honored as-is, non-adjacent or
    not, with no warning — that's a direct, explicit 1:1 configuration. A
    pair from Other Set of Rooms/Alt desk rooms (a code picked from a
    longer list, not a direct 1:1 setting) or one the system picked itself
    via fallback is NOT exempt — still checked and repaired here, even
    though it was allowed to be non-adjacent at placement time. Fixed-room
    providers are exempt — never touched. A non-adjacent pair is repaired
    by trying, from either side of the pair, every room adjacent to the
    side being kept, across every desk that provider can reach: if that
    room is open, they simply move there; if it's held by a **loosely
    placed** occupant — someone with no hard preference for their current
    room (no fixed-room reservation, and the room isn't their own named
    preference) and no strictly higher priority type than the provider
    being fixed — that occupant is evicted, but ONLY if they can genuinely
    be relocated to another open room in the same attempt; otherwise the
    whole thing is rolled back and the next candidate is tried. Repeated a
    few more times since fixing one pair can free up what's available for
    the next. Whatever still can't be made adjacent after every attempt is
    left exactly as it was and flagged with a warning for manual review,
    rather than looping forever or dropping anyone's room.
15. **Two in-person visits 2+ hours apart → one room** — a provider
    configured for 2 rooms with exactly two in-person visits all day
    (video/telephone ignored) whose start times are at least 2 hours apart
    gets one room, even if both visits are in the same half-day.
16. **West desk** — in a desk named/identified "west", rooms whose code
    starts with `6` can't be used by a Doctor or Fellow (any other type may).
17. **Same hallway** — "adjacent" also requires the same `hall`; the second
    room is picked adjacent+same hall, else same hall, else any open room,
    and the final adjacency pass (step 14) repairs cross-hall pairs. An
    explicit Primary + Second Preferred pair is still honored as set.
18. **Unmatched-name placeholders go last** — they're placed after Nurses,
    and a real provider still without a room takes a placeholder's room, so
    nobody real is "Not Found" while rooms are held by hidden placeholders.
19. **Home desk first** — a desk's own Doctors/Fellows always get that desk's rooms before visitors from other desks: if a foreign provider holds a room while the home Doctor/Fellow has none, the visitor is moved elsewhere (Nurses are the ones relocated to other desks).
20. **Never split across desks** — a provider who needs 2 rooms gets both on ONE desk. If only one room can be found, they keep it at their default desk (the other shows "Not Found") and any stray room on another desk is freed for a provider who has none.

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
  only, not a form constraint). Changing a provider's **Default desk** away
  from a desk that's currently checked as one of their "Alternate desks"
  automatically drops it from that list too (a desk can't be its own
  alternate) — previously this stale entry was left behind, which could
  make the "Alt desks"/"Alt desk rooms" columns show a value tied to a desk
  that's no longer actually an alternate once the default desk changed to
  it. Editing the table's **last row** scrolls its inline edit form
  smoothly into view — since the "Add" section is hidden while any row is
  being edited, the edit form for the last row renders in the exact screen
  space the "Add" section occupied a moment before, which without a scroll
  nudge could read as the two overlapping.

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
using today. When a desk's rooms are grouped into exactly **two halls**,
both hall tables print one after another (full page width each), not side
by side — side-by-side squeezed each table into half the page, which
cramped longer labels (a shared office, or a name plus an AM/PM or Time
note); stacked, each table gets the full content width and a slightly
larger font (10pt cell text / 14pt hall title / 28pt row height, vs. 8pt /
12pt / 26pt elsewhere) to actually use the extra room. Desks with 0, 1, or
3+ halls are unaffected. (The older combined, all-desks, two-page
report+floor-map export — `generateAssignmentPdf`/`drawFloorMapPage` — is
kept in `pdfGenerator.js` for reference but isn't called by the UI, and
still prints two halls side by side there since nothing calls it.)

Name formatting in every exported page (`pdfGenerator.js`):
- A room shared AM/PM by two different providers prints **both**, as
  `LastName (AM)/LastName (PM)` (e.g. `Issa (AM)/Riad (PM)`) — occupancy is
  tracked per AM/PM slot rather than one name per room, so the second
  provider in a shared room no longer silently overwrites the first.
- A **solo** occupant (not sharing) also gets a note next to their name now
  (`occupantCellLabel`): if they only have patients for **half a day**
  (session is AM-only or PM-only, not a full day), the same `(AM)`/`(PM)`
  note a shared room already shows — even though they're alone in the
  room. If instead they have exactly **one patient for the whole day**
  (session is FULL and `patientCount === 1`), their raw imported **Time**
  value prints next to their name instead (e.g. `Onepatient (11:30 am)`) —
  never the "Arrive By" field. The two notes never combine (a same-day
  single patient is always the FULL case, never AM/PM-only). Both `session`
  and `patientCount`/`soloTime` are carried on the occupancy entry built by
  `buildRoomOccupancy` specifically so `occupantCellLabel` can see them.
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
