/**
 * Room Assignment Engine (v3 — preferences, blocks, video, never-drop)
 * ------------------------------------------------------------------
 * Pure functions — no Firebase/PDF calls in here.
 *
 * Rules implemented (cumulative with earlier versions):
 * 1. Desks have rooms; providers have a home desk.
 * 2. A provider prefers 1 or 2 rooms (provider.preferredNumberOfRooms).
 * 3. Only providers with entries for the given date are scheduled.
 * 4/6a. Window preference, primary/second preferred room, and the
 *    video-capable requirement (see #9) all score a candidate room;
 *    whichever room has more of that provider's preferences wins.
 * 5. Overflow to alternateDeskIds when the home desk can't fit everyone;
 *    target desk chosen by spare capacity + fewest patients.
 * 7. A room has two half-day slots (AM/PM); a provider whose day is
 *    entirely morning or entirely afternoon shares a room with a
 *    complementary provider; a full-day provider takes the whole room.
 * 8. NEW — Room blocks: a room-session (AM/PM, for a given date) that's
 *    covered by a block is treated as already occupied and is never
 *    assigned, checked before any placement is attempted.
 * 9. Video-capable rooms: whether a video-capable room is needed is decided
 *    ENTIRELY by that day's imported schedule (dayEntries[].hasVideoVisit) —
 *    there is no static per-provider "has video visit" flag. If a provider
 *    had a video/virtual visit that day AND does not have an office on the
 *    floor (provider.hasOfficeOnFloor), at least one of their assigned
 *    rooms should be video-capable. This is enforced via scoring priority
 *    during placement; if it still can't be met (e.g. no video-capable
 *    room was available at all), a warning is raised rather than silently
 *    ignoring the requirement.
 * 11. NEW — alternateRoomCodes ("Alt desk rooms"): a provider can name
 *    specific room codes (free text, comma-separated in the UI) belonging
 *    to one or more of their checked `alternateDeskIds` ("Alternate desks
 *    (overflow-eligible)"). A code is only ever matched against the SPECIFIC
 *    alternate desk actually being tried — never the home desk, and never
 *    a different alternate desk that happens to have a room with the same
 *    code — and only once `deskId` is itself one of the provider's checked
 *    alternate desks at all. Gets the exact same ordered/paired treatment
 *    as "Other Set of Rooms" (rule #15), one priority tier lower: tried in
 *    typed order, right after Other Set of Rooms has had its turn — see
 *    fillMissingSlots.
 * 12. NEW — Room `kind`: a room is 'exam' (default, if unset), 'office', or
 *    'utility'. Only 'exam' rooms are ever candidates for assignment — an
 *    'office' room is a specific provider's permanent office (they don't
 *    see patients there) and a 'utility' room is a non-patient space
 *    (hallway, workroom, etc). Both are filtered out before any placement
 *    logic runs, so they behave as if they simply don't exist for the
 *    purposes of this function; they still show up on the static floor-map
 *    PDF export (see pdfGenerator.js), just never in the assignable pool.
 * 10. NEW — Never-drop-provider: every real (matched, non-pseudo) working
 *    provider always appears in `assignments`, one entry per provider,
 *    with a `roomSlots` array of length `preferredNumberOfRooms`. Each
 *    slot is either a real room ({ roomId, deskId, isOverflow }) or
 *    `{ roomId: null }` meaning "Not Found" for that slot — the provider
 *    is never omitted just because a room couldn't be found.
 *    Pseudo ("unmatched name") providers are exempt from this — per an
 *    earlier requirement they silently fill whatever's open and are
 *    simply dropped (no warning, no Not Found entry) if nothing's open.
 * 13. NEW — provider.fixedRoom: when true AND the provider has at least one
 *    patient that day (dayEntries[].patientCount > 0), this provider's
 *    room(s) are reserved up front, before anything else is assigned, from
 *    their primaryPreferredRoomId (slot 0) and secondPreferredRoomId (slot
 *    1, if preferredNumberOfRooms is 2) — no scoring, no substitution. If a
 *    fixed room isn't set or isn't available that session (blocked or
 *    already reserved by another fixed-room provider), that slot shows
 *    "Not Found"; it is NEVER filled by a different room and NEVER sent
 *    through overflow to another desk. This reservation happens before
 *    any non-fixed provider is placed, so a fixed-room provider's room
 *    can't be taken by someone else first. If the provider has NO patients
 *    that day (patientCount is 0 or missing), the room is not reserved at
 *    all — it's released back into the normal pool so another provider can
 *    use it, and this entry is placed through the ordinary tiered flow
 *    like any non-fixed provider.
 * 14. NEW — provider.type ('Doctor' | 'Fellow' | 'Any' | 'Nurse', default
 *    'Any'): assignment happens in priority tiers, in that order — every
 *    Doctor (across all desks, including their overflow) is placed before
 *    any Fellow is placed, then every Fellow before any Any-type provider,
 *    then every Any-type provider before any Nurse. So a Nurse only gets a
 *    room once every Doctor/Fellow/Any-type provider everywhere already
 *    has theirs (or has been overflowed/failed to find one). fixedRoom
 *    providers are reserved before all tiers (see #13) regardless of type.
 * 15. NEW — provider.otherPreferredRoomCodes ("Other Set of Rooms"): a
 *    second, lower-priority list of specific room codes (free text,
 *    comma-separated in the UI, distinct from alternateRoomCodes/#11),
 *    consulted only once the primary/second preferred room couldn't be
 *    used for a given slot. Tried in the exact order the codes were typed,
 *    as an explicit, exhaustive list — NOT a scoring bonus:
 *      - If the provider needs only 1 room (or only one slot is still
 *        missing for a 2-room provider), each room in the list is tried
 *        one at a time, in order; the first one that's open is used.
 *      - If the provider needs 2 rooms and BOTH are still missing, the
 *        list is tried as consecutive PAIRS in order — the first two codes
 *        as a pair, then (if that pair isn't fully open) the next two, and
 *        so on through the whole list — the first pair where both rooms
 *        are open wins. The two rooms in a pair do NOT need to be
 *        adjacent, since both are explicitly named by the user. If the
 *        list has an ODD number of codes, every complete leading pair is
 *        still tried (e.g. 5 codes tries codes 1&2, then 3&4) — only the
 *        single trailing leftover code goes unused here, since it has no
 *        partner; #17's adjacency fallback is what's meant for that case.
 *      - When only slot 1 is still missing (slot 0 already has a room,
 *        whether from a preference or this same list) for a 2-room
 *        provider, a room in the list that's actually ADJACENT (#17) to
 *        slot 0's room is preferred — tried before the rest of the list —
 *        for a tidier pair; any other open room in the list still works if
 *        none are adjacent.
 *    Whatever this list can't resolve falls through to the rest of the
 *    existing logic exactly as before (#17's adjacency fallback, generic
 *    scoring, etc.) — see fillMissingSlots. alternateRoomCodes ("Alt desk
 *    rooms", #11) gets this exact same treatment, one tier lower — see #11.
 * 16. NEW — a provider's rooms are never split across two different desks
 *    during the normal tiered placement/overflow pass. If a provider needs
 *    more than one room and their home desk can't fit all of them, overflow
 *    to an alternateDeskId is only attempted when NONE of their rooms could
 *    be placed at home — and even then, only a SINGLE alternate desk that
 *    can fit every remaining room is used (never partially filled at one
 *    alternate desk and the rest at another). If the home desk placed some
 *    (but not all) of a provider's rooms, the rest are left unfilled here
 *    rather than sent anywhere else during this pass — see #18, which can
 *    still pick them up as a last resort.
 * 17. NEW — provider.preferredNumberOfRooms === 2: when the system has to
 *    pick the second room itself (see fillMissingSlots), the two rooms must
 *    be "beside each other" — same letter suffix and room numbers exactly 2
 *    apart (so always both odd or both even), e.g. 22E/24E, 63E/65E, 30/32
 *    (see parseRoomCode/roomsAdjacent). This is a FALLBACK rule only,
 *    applied in this order for slot 1:
 *      1. provider.secondPreferredRoomId, if it's a room at the desk being
 *         tried and open — used exactly as configured, no adjacency check.
 *      2. provider.otherPreferredRoomCodes, tried per rule #15 above — same,
 *         no adjacency check.
 *      3. Only once neither of those could be used: falls back to any open
 *         room adjacent to whatever room slot 0 ACTUALLY received. If
 *         there's no such room (or slot 0 wasn't placed at all), slot 1 is
 *         left unfilled rather than assigning an unpaired room.
 *    The Providers form (ProviderManager.jsx) does NOT filter the Second
 *    Preferred Room dropdown by adjacency — it only excludes whichever room
 *    is already picked as Primary, same as before this rule existed, since
 *    an explicitly configured Second Preferred Room is always honored as-is
 *    (step 1 above), whether or not it happens to be adjacent.
 * 18. NEW — fallback fill (last resort, runs once after every priority tier
 *    has been placed): no working, non-fixed provider is left with a
 *    missing room while a genuinely usable room exists anywhere. This pass
 *    searches every desk (home desk first, then alternateDeskIds by
 *    patient load, then every other desk by patient load) for each
 *    still-missing slot, respecting the #17 adjacency rule. If nothing is
 *    open, it may evict an already-placed Nurse (never a Doctor, Fellow,
 *    Any-type provider, or a reserved fixed-room provider) from a room that
 *    would fit, then makes a single attempt (no further eviction) to
 *    relocate that nurse elsewhere — if that also fails, the nurse is left
 *    "Not Found" instead, never re-attempted further, so this can never
 *    loop. Runs in priority order (Doctor → Fellow → Any → Nurse, pseudo/
 *    unmatched entries last of all and never allowed to evict anyone),
 *    highest priority first. A provider with 1-2 patients that day is
 *    scored as an especially good candidate for sharing an already
 *    half-filled room (see scoreRoom), rather than opening a fresh one.
 * 19. NEW — cross-check / backtracking: after the #18 fallback sweep runs
 *    once, it's re-run a few more times (bounded, stops as soon as a pass
 *    makes no further change) against the true, current room state. A
 *    placement made late in one pass — a provider shifted to another desk,
 *    a nurse relocated after eviction — can open up a room an
 *    earlier-processed provider in that same pass had already given up on;
 *    this catches that instead of leaving it for manual review.
 * 20. NEW — video-capable backtracking (tryImproveVideoCapableFit): the #18/
 *    #19 passes above only ever revisit a provider with a fully MISSING
 *    slot — a provider who already has a room, just not a video-capable
 *    one when they needed it (#9), was only ever left as a warning. Now,
 *    for each such provider, the system looks for a video-capable room
 *    (anywhere this provider could reach) held by someone who (a) doesn't
 *    need video-capable themselves — swapping them out can't just move the
 *    same problem elsewhere, (b) isn't a same-day fixed-room reservation
 *    (#13 — never touched), and (c) isn't a HIGHER-priority type (#14)
 *    than the provider who needs the swap — a Nurse's video need can never
 *    bump a Doctor/Fellow/Any-type provider. The swap is only ever
 *    COMMITTED if the displaced provider can genuinely be relocated to
 *    another open room in that same attempt; if they can't, the whole
 *    thing is rolled back and the video-capable mismatch is left exactly
 *    as it was — the never-drop-a-provider guarantee (#10) always
 *    outranks a video-capable preference. Interleaved with #19's fallback
 *    sweep (same bounded loop) since either kind of change can open up a
 *    room the other kind of pass would want.
 * 21. NEW — in-person-only desk load / no-room-needed providers: desk-load
 *    ordering (which alternate desk is "lightest", used for overflow — see
 *    patientLoad) counts only IN-PERSON visits, never telephone or video —
 *    a virtual visit doesn't tie up a room at one desk over another, so it
 *    shouldn't weigh into that comparison. Separately, a provider who has
 *    an office on the floor AND has NO in-person visit at all today (every
 *    visit is telephone or video) doesn't need an assigned exam room at
 *    all — they can see those patients from their own office — but ONLY
 *    when their type is Doctor or Fellow; a Nurse or Any-type provider in
 *    the identical situation still gets a room regardless of visit mix.
 *    Such a provider is filtered out before Phase 0 even
 *    starts: no placement attempt, no "Not Found" warning, no entry in the
 *    results at all, since nothing was needed. This is the final check
 *    before the results are considered ready to export.
 * 22. NEW — effective rooms needed (2-rooms-down-to-1 reduction): a
 *    provider's preferredNumberOfRooms is their STANDING configuration, not
 *    necessarily how many rooms they actually need on a given day — see
 *    computeEffectiveRoomsNeeded, run once per entry up front and stored as
 *    entry.effectiveRoomsNeeded (every placement/overflow/fallback/eviction
 *    path below reads THIS, never preferredNumberOfRooms directly):
 *      - `Nurse` type: always exactly 1 room, full stop, regardless of
 *        preferredNumberOfRooms or visit volume — the field is simply
 *        ignored for this type.
 *      - Configured for 2 rooms, any other type: still 2, UNLESS the entry
 *        has at most 1 in-person visit in EACH half-day separately
 *        (inPersonAmCount <= 1 AND inPersonPmCount <= 1 — see pdfParser.js)
 *        — a single in-person visit per half never needs two simultaneous
 *        rooms, whether paired with a video/telephone visit in that same
 *        half, or with a second in-person visit on the OTHER side of noon
 *        (1 AM-in-person + 1 PM-in-person still reduces to 1 room). If
 *        either per-half-day count is missing (an entry that predates this
 *        field), the configured value is used as-is rather than guessing.
 *      - Configured for 1 room: always 1, nothing to reduce.
 *    This applies identically to fixed-room providers (#13) — a fixed-room
 *    provider whose day reduces to 1 room only has their primary room
 *    reserved; the second preferred room is simply never reserved in the
 *    first place, so it's automatically available to anyone else — there's
 *    nothing further to "release".
 * 23. NEW — room contention tie-break: within one priority tier (#14) at one
 *    desk, placement normally happens in whatever order the entries were
 *    given, and whoever is processed first simply claims a contested room
 *    first (occupy() makes it unavailable to the next entry). Now, before
 *    placing a tier's entries at a desk, they're sorted so that whoever
 *    needs a video-capable room and has no office on the floor
 *    (entry.needsVideoCapable, #9) goes first; among the rest, whoever has
 *    more in-person patients today (inPersonPatientCount) goes first. This
 *    doesn't change WHAT each entry is eligible for (preferences, Other Set
 *    of Rooms, Alt desk rooms, adjacency, generic scoring — all unchanged),
 *    only WHO gets first crack when two entries would otherwise collide on
 *    the identical room: the loser simply falls through to their next-best
 *    option at this desk, or to overflow (#16) at whichever alternate desk
 *    has the lowest in-person patient load if nothing else fits here.
 * 24. NEW — "reshuffle any provider" to complete a two-room adjacent pair:
 *    the fallback pass's eviction logic (#18) previously only ever bumped
 *    an already-placed Nurse out of a room. Now, specifically when a
 *    provider still needs their SECOND room of an adjacent pair (slot 1,
 *    #17, slot 0 already filled) and no open room and no evictable Nurse
 *    could be found anywhere, the system also tries evicting any OTHER
 *    already-placed, non-fixed-room occupant — of the same or lower
 *    priority type (#14) than the provider who needs the room, never a
 *    strictly higher one — from an eligible room (findEvictableOccupant).
 *    This is only ever COMMITTED if the evicted occupant can genuinely be
 *    relocated to another open room in the very same attempt
 *    (relocateEvictedOccupant); if they can't, the whole thing is rolled
 *    back and the slot is left exactly as it was — unlike the Nurse-only
 *    eviction (#18), which may leave an unrelocatable Nurse "Not Found",
 *    this path guarantees nobody ends up without a room as a net result.
 *    Pseudo ("unmatched name") entries are never evicted by this path
 *    (they're already exempt from the never-drop guarantee — #10 — so
 *    bumping one isn't the point of this feature).
 * 25. NEW — final two-room adjacency validation/repair (runs LAST, right
 *    before results are export-ready): every provider who needs 2 rooms
 *    (#22) and has both slots filled is double-checked for real adjacency
 *    (#17) — even a pair the provider explicitly named themselves
 *    (secondPreferredRoomId, or a pair from otherPreferredRoomCodes/
 *    alternateRoomCodes, both normally exempt from the adjacency check at
 *    placement time) is checked here and still eligible for repair;
 *    adjacency now wins even over an explicit non-adjacent pairing.
 *    Fixed-room providers (#13) are exempt — never touched. A non-adjacent
 *    pair is repaired (tryFixAdjacency) by trying, from either side of the
 *    pair, every room adjacent to the side being kept, across every desk
 *    this provider can reach: if that room is open, the provider simply
 *    moves there; if it's held by a "loosely placed" occupant — someone
 *    with no hard preference for their current room (no fixedRoom
 *    reservation, and the room isn't their own named preference — see
 *    hasHardPreferenceForRoom) and no strictly higher priority type (#14)
 *    than the provider being fixed — that occupant is evicted, but ONLY if
 *    they can genuinely be relocated to another open room in the same
 *    attempt (relocateEvictedOccupant, shared with #24); otherwise rolled
 *    back and the next candidate is tried. Re-run a few more times
 *    (bounded, same pattern as #19) since fixing one pair can change what's
 *    loosely available for the next. Whatever still can't be made adjacent
 *    after every attempt is left exactly as it was and flagged as a
 *    warning for manual review, rather than looping forever or dropping
 *    anyone's room.
 * ------------------------------------------------------------------
 */

const NOON = 12 * 60;

function timeRangeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// "22E" -> { num: 22, suffix: "E" }; null if unparseable.
function parseRoomCode(code) {
  const m = /^(\d+)([A-Za-z]*)$/.exec((code || '').trim());
  if (!m) return null;
  return { num: Number(m[1]), suffix: m[2] };
}

// Two rooms count as "beside each other" (rule #17) only when both codes
// parse, share the same letter suffix, and are exactly 2 apart — e.g.
// 22E/24E, 63E/65E, 30/32 (a difference of 2 also guarantees both odd or
// both even).
function roomsAdjacent(codeA, codeB) {
  const a = parseRoomCode(codeA);
  const b = parseRoomCode(codeB);
  if (!a || !b) return false;
  return a.suffix === b.suffix && Math.abs(a.num - b.num) === 2;
}

/**
 * How many rooms this entry actually needs TODAY — not necessarily the
 * same as provider.preferredNumberOfRooms (rule #22, see the top-of-file
 * docstring). Computed once per entry and stored as entry.effectiveRoomsNeeded
 * so every placement/overflow/fallback/eviction path downstream reads that
 * instead of re-deriving it (and instead of reading
 * provider.preferredNumberOfRooms directly, which would miss the
 * reduction):
 *   - `Nurse` type: always exactly 1, full stop — preferredNumberOfRooms
 *     is ignored entirely for this type, even if someone sets it to 2.
 *   - Configured for 1 room: always 1 (nothing to reduce).
 *   - Configured for 2 rooms, any other type: still 2, UNLESS the entry
 *     has at most 1 in-person visit in EACH half-day separately
 *     (inPersonAmCount <= 1 AND inPersonPmCount <= 1) — one in-person
 *     visit per half never needs two simultaneous rooms, whether it's
 *     paired with a video/telephone visit in that same half, or with a
 *     second in-person visit on the OTHER side of noon (1 AM + 1 PM still
 *     reduces to 1 room). If either per-half-day count is missing
 *     (dayEntries that predate this field), the configured value is used
 *     as-is rather than guessing.
 * The room this frees up is simply never reserved/occupied in the first
 * place — there's nothing further to "release", it's automatically
 * available to any other provider.
 */
function computeEffectiveRoomsNeeded(provider, entry) {
  const configured = (provider && provider.preferredNumberOfRooms) || 1;
  const type = (provider && provider.type) || 'Any';
  if (type === 'Nurse') return 1;
  if (configured !== 2) return configured;
  const amCount = entry.inPersonAmCount;
  const pmCount = entry.inPersonPmCount;
  if (amCount === undefined || pmCount === undefined) return configured;
  return amCount <= 1 && pmCount <= 1 ? 1 : 2;
}

/**
 * Computes, for the given date, which rooms have their AM and/or PM slot
 * blocked. Blocks with no `date` are treated as standing/recurring
 * (apply every day). Blocks with no start/end time block the whole day.
 *
 * @param {Array} roomBlocks [{ id, roomId, date: string|null, startMinutes: number|null, endMinutes: number|null }]
 *                            (startMinutes/endMinutes already parsed to minutes-since-midnight upstream)
 */
export function computeBlockedSlots(roomBlocks, date) {
  const blocked = {}; // roomId -> { am: bool, pm: bool }
  for (const block of roomBlocks || []) {
    if (block.date && block.date !== date) continue;
    if (!blocked[block.roomId]) blocked[block.roomId] = { am: false, pm: false, reason: null };
    if (block.reason && !blocked[block.roomId].reason) blocked[block.roomId].reason = block.reason;

    const hasStart = block.startMinutes !== null && block.startMinutes !== undefined;
    const hasEnd = block.endMinutes !== null && block.endMinutes !== undefined;
    if (!hasStart && !hasEnd) {
      blocked[block.roomId].am = true;
      blocked[block.roomId].pm = true;
      continue;
    }
    const start = hasStart ? block.startMinutes : 0;
    const end = hasEnd ? block.endMinutes : 24 * 60;
    if (timeRangeOverlaps(start, end, 0, NOON)) blocked[block.roomId].am = true;
    if (timeRangeOverlaps(start, end, NOON, 24 * 60)) blocked[block.roomId].pm = true;
  }
  return blocked;
}

/**
 * @param {Array} desks       [{ id, name }]
 * @param {Array} rooms       [{ id, deskId, code, hasWindow, videoCapable }]
 * @param {Array} providers   [{ id, name, homeDeskId, preferredNumberOfRooms,
 *                                windowPreference, primaryPreferredRoomId,
 *                                secondPreferredRoomId, alternateDeskIds,
 *                                alternateRoomCodes, otherPreferredRoomCodes,
 *                                hasOfficeOnFloor, suppressWarnings,
 *                                fixedRoom, type }]
 * @param {Array} dayEntries  [{ providerId, isWorking, patientCount, inPersonPatientCount?,
 *                                inPersonAmCount?, inPersonPmCount?, soloTime?, session,
 *                                hasVideoVisit? }]
 *                             hasVideoVisit is the ONLY source of whether a video-capable
 *                             room is needed — it comes from that day's import, never from
 *                             a static provider field. inPersonPatientCount excludes video
 *                             visits (telephone visits are dropped entirely upstream, in
 *                             pdfParser.js, and never reach here at all) — used for desk-load
 *                             ordering (rule #21) and falls back to patientCount if omitted.
 *                             inPersonAmCount/inPersonPmCount split that same in-person count
 *                             by half-day — used by the 2-rooms-down-to-1 reduction (rule #22);
 *                             omitting either disables that reduction for the entry (falls
 *                             back to provider.preferredNumberOfRooms as-is).
 *                             soloTime is the one raw imported Time value for a provider with
 *                             exactly one patient that day, or null/omitted otherwise.
 * @param {Array} roomBlocks  [{ id, roomId, date, startMinutes, endMinutes, reason }]
 * @param {string} date       'YYYY-MM-DD', used to resolve which blocks apply today
 * @returns {{ assignments: Array, warnings: Array, logs: Array }}
 */
export function generateDailyAssignments({ desks, rooms, providers, dayEntries, roomBlocks = [], date }) {
  const warnings = [];
  // Real, human-readable narration of what the engine actually did, in the
  // order it happened — see rule #18's doc comment and the UI's Logs box
  // (App.jsx). Ephemeral by nature: this is just a plain array returned
  // fresh on every run, nothing is persisted.
  const logs = [];
  // Tracks which desks have already gotten a "Working on <desk> providers…"
  // log line, so each desk only logs once no matter how many phases/tiers
  // touch it.
  const loggedDesks = new Set();
  const logDeskStart = (desk) => {
    if (!desk || loggedDesks.has(desk.id)) return;
    loggedDesks.add(desk.id);
    logs.push(`Working on ${desk.name} providers…`);
  };
  const providerById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const blockedSlots = computeBlockedSlots(roomBlocks, date);

  // Only 'exam' rooms (or rooms with no `kind` set, for backward
  // compatibility with older seed/Firestore data) ever enter the
  // assignable pool — see rule #12 above.
  const assignableRooms = rooms.filter((r) => !r.kind || r.kind === 'exam');

  const roomState = {}; // roomId -> { room, amOccupant, pmOccupant }
  const roomsByDesk = {};
  for (const r of assignableRooms) {
    roomState[r.id] = { room: r, amOccupant: null, pmOccupant: null };
    (roomsByDesk[r.deskId] ||= []).push(r.id);
  }

  const isBlocked = (roomId, session) => {
    const b = blockedSlots[roomId];
    if (!b) return false;
    if (session === 'FULL') return b.am || b.pm;
    return session === 'AM' ? b.am : b.pm;
  };

  const canFit = (roomId, session) => {
    if (isBlocked(roomId, session)) return false;
    const s = roomState[roomId];
    if (session === 'FULL') return s.amOccupant === null && s.pmOccupant === null;
    return session === 'AM' ? s.amOccupant === null : s.pmOccupant === null;
  };

  const occupy = (roomId, session, providerId) => {
    const s = roomState[roomId];
    if (session === 'FULL') {
      s.amOccupant = providerId;
      s.pmOccupant = providerId;
    } else if (session === 'AM') {
      s.amOccupant = providerId;
    } else {
      s.pmOccupant = providerId;
    }
  };

  // Undoes occupy() — used only to roll back a trial placement at an
  // alternate desk that turned out not to fit ALL of a provider's still-
  // missing rooms (see rule #16: a partial fit at one desk is never kept if
  // it would mean the rest go to yet another desk).
  const release = (roomId, session) => {
    const s = roomState[roomId];
    if (session === 'FULL') {
      s.amOccupant = null;
      s.pmOccupant = null;
    } else if (session === 'AM') {
      s.amOccupant = null;
    } else {
      s.pmOccupant = null;
    }
  };

  const workingEntries = dayEntries
    .filter((e) => e.isWorking)
    .map((e) => {
      const provider = providerById[e.providerId];
      // Video-capable-room need is decided purely by today's import
      // (e.hasVideoVisit) plus the provider's fixed office-on-floor fact —
      // there is no provider-level "has video visit" fallback.
      const needsVideoCapable = Boolean(provider && e.hasVideoVisit && !provider.hasOfficeOnFloor);
      const effectiveRoomsNeeded = computeEffectiveRoomsNeeded(provider, e);
      return { ...e, provider, needsVideoCapable, effectiveRoomsNeeded };
    })
    .filter((e) => {
      if (!e.provider) {
        warnings.push(`Schedule entry for unknown provider id "${e.providerId}" was skipped.`);
        return false;
      }
      return true;
    })
    // A Doctor or Fellow with an office on the floor whose day is ENTIRELY
    // telephone/video visits (no in-person visit at all) can see those
    // patients from their own office and doesn't need an exam room today.
    // Any other type (Nurse/Any) always still gets a room regardless of
    // visit mix — this exemption is Doctor/Fellow-only. Excluded here means
    // excluded entirely: no placement attempt, no "Not Found" warning, no
    // entry in `assignments` — there's nothing to report because nothing
    // was needed.
    .filter((e) => {
      const type = e.provider.type || 'Any';
      const noInPersonVisits = (e.inPersonPatientCount ?? e.patientCount ?? 0) === 0;
      const needsNoRoomToday = e.provider.hasOfficeOnFloor && noInPersonVisits && (type === 'Doctor' || type === 'Fellow');
      return !needsNoRoomToday;
    });

  const entriesByHomeDesk = {};
  for (const d of desks) entriesByHomeDesk[d.id] = [];
  for (const e of workingEntries) {
    if (!entriesByHomeDesk[e.provider.homeDeskId]) {
      warnings.push(`${e.provider.name} has an unknown home desk (${e.provider.homeDeskId}); skipped.`);
      continue;
    }
    entriesByHomeDesk[e.provider.homeDeskId].push(e);
  }

  // Score a candidate room for a specific slot of an entry. `preferredRoomId`
  // is the primary preferred room for slot 0, the second preferred room for
  // slot 1 — passed in by the caller per-slot. alternateRoomCodes matches by
  // room code (not id) so it lines up with whatever the user typed on the
  // Providers page, but — unlike otherPreferredRoomCodes just below — it is
  // explicitly scoped to the room's own desk actually being one of this
  // provider's checked alternate desks (same rule altDeskRoomIdsInOrder
  // uses). Room numbering commonly repeats across desks/wings (a "10" at
  // Desk B and an unrelated "10" at Desk C, or even at the home desk), so
  // without this check a code typed for one alternate desk could boost a
  // same-numbered room at a totally different desk — including one never
  // even checked as an alternate. The otherPreferredRoomCodes bonus below
  // is now mostly a residual tie-break: rule #15's explicit, ordered try
  // (fillMissingSlots) already claims a matching room whenever one was
  // actually open, so by the time generic scoring runs here that list has
  // usually already been exhausted — this only still matters for an
  // odd-one-out code left over from an unpaired 2-room list, or a slot
  // filled through a different path.
  const scoreRoom = (roomId, entry, preferredRoomId, alreadyPicked) => {
    if (alreadyPicked.includes(roomId)) return -Infinity; // never double-book the same room to the same provider
    const s = roomState[roomId];
    let score = 0;
    if (preferredRoomId && preferredRoomId === roomId) score += 10;
    if ((entry.provider.otherPreferredRoomCodes || []).includes(s.room.code)) score += 7;
    if (entry.needsVideoCapable && s.room.videoCapable) score += 5;
    if (
      (entry.provider.alternateDeskIds || []).includes(s.room.deskId) &&
      (entry.provider.alternateRoomCodes || []).includes(s.room.code)
    ) {
      score += 5;
    }
    if (entry.provider.windowPreference === 'prefers' && s.room.hasWindow) score += 2;
    // Reuse a half-filled room (AM/PM room-sharing) rather than opening a
    // fresh one. A provider with only 1-2 patients that day is a light,
    // likely-half-day case and a good sharing candidate — weighted higher
    // so they gravitate to an already-half-filled room and leave whole,
    // empty rooms open for busier providers.
    if (s.amOccupant !== null || s.pmOccupant !== null) {
      score += entry.patientCount != null && entry.patientCount <= 2 ? 4 : 1;
    }
    return score;
  };

  // `requireAdjacentToCode`, when set, hard-filters candidates to only
  // rooms adjacent (rule #17) to that room code, before any scoring runs.
  // `restrictToRoomIds`, when set, further narrows candidates to exactly
  // that set (e.g. the rooms matching a provider's otherPreferredRoomCodes
  // at this desk) before scoring picks the best of them.
  const pickRoom = (deskId, entry, preferredRoomId, alreadyPicked, requireAdjacentToCode = null, restrictToRoomIds = null) => {
    let candidates = (roomsByDesk[deskId] || []).filter((id) => canFit(id, entry.session));
    if (restrictToRoomIds) {
      const allowed = new Set(restrictToRoomIds);
      candidates = candidates.filter((id) => allowed.has(id));
    }
    if (requireAdjacentToCode) {
      candidates = candidates.filter((id) => roomsAdjacent(roomState[id].room.code, requireAdjacentToCode));
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => scoreRoom(b, entry, preferredRoomId, alreadyPicked) - scoreRoom(a, entry, preferredRoomId, alreadyPicked));
    const best = candidates[0];
    return scoreRoom(best, entry, preferredRoomId, alreadyPicked) === -Infinity ? null : best;
  };

  // Slot 0 = primary preferred room, slot 1 = second preferred room.
  const slotPreferredRoomId = (entry, slotIndex) =>
    slotIndex === 0 ? entry.provider.primaryPreferredRoomId : slotIndex === 1 ? entry.provider.secondPreferredRoomId : null;

  // Room ids matching provider.otherPreferredRoomCodes at `deskId`, in the
  // SAME order the codes were typed (a code with no matching room at this
  // desk is simply skipped) — rule #15 uses this as an explicit, ordered
  // list to try, not just a scoring nudge, so the order the user typed the
  // codes in actually matters (first pair, then next pair, etc.).
  const otherSetRoomIdsInOrder = (deskId, entry) => {
    const codes = entry.provider.otherPreferredRoomCodes || [];
    if (codes.length === 0) return [];
    const codeToRoomId = new Map();
    for (const id of roomsByDesk[deskId] || []) {
      const code = roomState[id].room.code;
      if (!codeToRoomId.has(code)) codeToRoomId.set(code, id);
    }
    const ids = [];
    for (const code of codes) {
      const id = codeToRoomId.get(code);
      if (id) ids.push(id);
    }
    return ids;
  };

  // Same idea as otherSetRoomIdsInOrder, for provider.alternateRoomCodes
  // ("Alt desk rooms") — rule #11. This field is only meaningful at one of
  // the provider's checked alternate desks, so it resolves to nothing at
  // all unless `deskId` is actually one of them — a code is only ever
  // matched against THAT desk's own rooms, never the home desk, and never
  // a different alternate desk's room that happens to share the same code.
  const altDeskRoomIdsInOrder = (deskId, entry) => {
    if (!(entry.provider.alternateDeskIds || []).includes(deskId)) return [];
    const codes = entry.provider.alternateRoomCodes || [];
    if (codes.length === 0) return [];
    const codeToRoomId = new Map();
    for (const id of roomsByDesk[deskId] || []) {
      const code = roomState[id].room.code;
      if (!codeToRoomId.has(code)) codeToRoomId.set(code, id);
    }
    const ids = [];
    for (const code of codes) {
      const id = codeToRoomId.get(code);
      if (id) ids.push(id);
    }
    return ids;
  };

  /**
   * Shared by fillMissingSlots' steps 2 and 2b below: tries `ids` (already
   * in the field's typed order) against whichever of `stillMissing`'s slots
   * are left, mutating `filled`/`pickedSoFar` and occupying rooms on
   * success. Returns whether anything was filled.
   *   - Both slots still missing: tried as consecutive PAIRS in typed
   *     order — the first two codes as a pair, else the next two, and so
   *     on. An ODD-length list still tries every complete leading pair it
   *     has (e.g. 5 codes tries codes 1&2, then 3&4) — only the single
   *     trailing leftover code (the 5th, in that example) goes unused here
   *     since it has no partner; #17's adjacency fallback is what's meant
   *     for that leftover case.
   *   - Only slot 1 still missing (slot 0 already has a room): a room in
   *     the list ADJACENT (#17) to slot 0's room is preferred — tried
   *     before the rest of the list, for a tidier pair — but any other
   *     open room in the list still works if none are adjacent.
   *   - Only slot 0 still missing (a 1-room provider, or slot 1 already
   *     filled): plain first-open-in-order, no adjacency concept applies.
   */
  const tryOrderedList = (ids, stillMissing, pickedSoFar, filled, entry, anchorCodeForSlot1) => {
    if (ids.length === 0) return false;

    if (stillMissing.length === 2) {
      for (let i = 0; i + 1 < ids.length; i += 2) {
        const a = ids[i];
        const b = ids[i + 1];
        if (a !== b && canFit(a, entry.session) && canFit(b, entry.session)) {
          filled[stillMissing[0]] = a;
          filled[stillMissing[1]] = b;
          occupy(a, entry.session, entry.providerId);
          occupy(b, entry.session, entry.providerId);
          pickedSoFar.push(a, b);
          return true;
        }
      }
      return false;
    }

    const slotIndex = stillMissing[0];
    const need2 = entry.effectiveRoomsNeeded === 2;
    let candidateIds = ids;
    if (need2 && slotIndex === 1) {
      const anchorCode = filled[0] !== undefined ? roomState[filled[0]]?.room.code || null : anchorCodeForSlot1;
      if (anchorCode) {
        const adjacent = ids.filter((id) => roomsAdjacent(roomState[id].room.code, anchorCode));
        if (adjacent.length > 0) {
          candidateIds = [...adjacent, ...ids.filter((id) => !adjacent.includes(id))];
        }
      }
    }
    for (const id of candidateIds) {
      if (!pickedSoFar.includes(id) && canFit(id, entry.session)) {
        filled[slotIndex] = id;
        occupy(id, entry.session, entry.providerId);
        pickedSoFar.push(id);
        return true;
      }
    }
    return false;
  };

  /**
   * Fills as many of `entry`'s still-missing slots as possible at `deskId`
   * in one shot. `missingSlotIndexes` says which slots still need a room
   * (e.g. [0, 1] or just [1]). Tries, in this order:
   *   1. Each missing slot's own named preference — primaryPreferredRoomId
   *      for slot 0, secondPreferredRoomId for slot 1 — a hard check (must
   *      be a room at THIS desk and open), independently per slot, used
   *      exactly as configured.
   *   2. Rule #15 — provider.otherPreferredRoomCodes ("Other Set of
   *      Rooms"), as an ordered, exhaustive list (the order the user typed
   *      them in) — see tryOrderedList for the pairs/singles/adjacency-
   *      preference/odd-list-skip details.
   *   2b. Rule #11 — provider.alternateRoomCodes ("Alt desk rooms"), same
   *      ordered/paired treatment as step 2, one tier lower — but ONLY
   *      when `deskId` is actually one of this provider's checked
   *      alternate desks (a code names a room at a SPECIFIC alternate
   *      desk, never matched against any other desk's rooms).
   *   3. Whatever's still missing falls back to the existing logic exactly
   *      as before: a plain preference-scored pick for slot 0, or the
   *      anchor-adjacency rule (#17) for slot 1.
   * `anchorCodeForSlot1` carries slot 0's room code when slot 0 was already
   * placed BEFORE this call (not among `missingSlotIndexes` here — it was
   * filled earlier, maybe even at a different desk); when slot 0 gets
   * filled DURING this same call, its own room's code is used instead.
   * Returns { [slotIndex]: roomId } for whichever slots got filled here —
   * every occupy() needed for a fill already happened by the time this
   * returns.
   */
  const fillMissingSlots = (deskId, entry, missingSlotIndexes, anchorCodeForSlot1) => {
    const filled = {};
    const pickedSoFar = [];

    // Step 1: named preference, per slot, independently, hard match.
    for (const slotIndex of missingSlotIndexes) {
      const preferredRoomId = slotPreferredRoomId(entry, slotIndex);
      if (
        preferredRoomId &&
        !pickedSoFar.includes(preferredRoomId) &&
        roomState[preferredRoomId]?.room.deskId === deskId &&
        canFit(preferredRoomId, entry.session)
      ) {
        filled[slotIndex] = preferredRoomId;
        occupy(preferredRoomId, entry.session, entry.providerId);
        pickedSoFar.push(preferredRoomId);
      }
    }

    let stillMissing = missingSlotIndexes.filter((i) => filled[i] === undefined);

    // Step 2: "Other Set of Rooms" (otherPreferredRoomCodes) — ordered,
    // exhaustive; see tryOrderedList.
    if (stillMissing.length > 0) {
      tryOrderedList(otherSetRoomIdsInOrder(deskId, entry), stillMissing, pickedSoFar, filled, entry, anchorCodeForSlot1);
    }

    stillMissing = missingSlotIndexes.filter((i) => filled[i] === undefined);

    // Step 2b: "Alt desk rooms" (alternateRoomCodes) — same ordered/paired
    // treatment, only when `deskId` is one of this provider's checked
    // alternate desks (altDeskRoomIdsInOrder resolves to [] otherwise).
    if (stillMissing.length > 0) {
      tryOrderedList(altDeskRoomIdsInOrder(deskId, entry), stillMissing, pickedSoFar, filled, entry, anchorCodeForSlot1);
    }

    stillMissing = missingSlotIndexes.filter((i) => filled[i] === undefined);

    // Step 3: existing fallback logic — generic preference scoring for
    // slot 0, the anchor-adjacency rule (#17) for slot 1, PLUS a final
    // non-adjacent fallback for slot 1 (see below): adjacency is a
    // nice-to-have for a tidier pair, never a reason to leave this
    // provider without a second room while some other, non-adjacent room
    // at this desk is genuinely open — that would violate the
    // never-drop-a-provider guarantee (rule #18) for no real benefit.
    for (const slotIndex of stillMissing) {
      let roomId;
      if (slotIndex === 1 && entry.effectiveRoomsNeeded === 2) {
        const anchorCode = filled[0] !== undefined ? roomState[filled[0]]?.room.code || null : anchorCodeForSlot1;
        roomId = anchorCode ? pickRoom(deskId, entry, null, pickedSoFar, anchorCode) : null;
        // No adjacent room open (or no anchor at all, e.g. slot 0 itself
        // is still missing too) — rather than leave this slot "Not Found"
        // while a different, non-adjacent room at this desk sits empty,
        // fall back to any open room here, same as slot 0's rule.
        if (!roomId) {
          roomId = pickRoom(deskId, entry, null, pickedSoFar);
        }
      } else {
        roomId = pickRoom(deskId, entry, null, pickedSoFar);
      }
      if (roomId) {
        filled[slotIndex] = roomId;
        occupy(roomId, entry.session, entry.providerId);
        pickedSoFar.push(roomId);
      }
    }

    return filled;
  };

  /**
   * Attempts to fill `count` room slots for `entry` at `deskId`, starting
   * at `slotOffset` (so slot preferences line up correctly when this is
   * called again during overflow for just the still-missing slots).
   * `anchorCode`, when `slotOffset` starts past slot 0 (i.e. slot 0 was
   * already placed by an earlier call, possibly at a different desk),
   * carries that room's code so slot 1's adjacency fallback (see
   * pickSlotRoom) still has something to check against.
   * Returns an array of { roomId: string|null, deskId, isOverflow }.
   */
  const placeSlots = (deskId, entry, count, slotOffset, isOverflow, anchorCode = null) => {
    const missingSlotIndexes = [];
    for (let i = 0; i < count; i++) missingSlotIndexes.push(slotOffset + i);
    const filled = fillMissingSlots(deskId, entry, missingSlotIndexes, anchorCode);
    return missingSlotIndexes.map((slotIndex) => {
      const roomId = filled[slotIndex];
      return roomId ? { roomId, deskId, isOverflow } : { roomId: null, deskId: null, isOverflow: false };
    });
  };

  const assignments = [];
  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));

  // ---- Phase 0 — fixed-room reservation (rule #13) -----------------------
  // Runs before anything else, so a fixed-room provider's room can never be
  // taken by another provider placed earlier in the normal flow. No scoring,
  // no substitution, no overflow: either the named room is free, or the
  // slot is "Not Found".
  const fixedEntries = [];
  const normalEntries = [];
  for (const desk of desks) {
    for (const entry of entriesByHomeDesk[desk.id]) {
      // A fixed-room provider only has their room reserved on a day they
      // actually have patients — with none scheduled, the room is free for
      // anyone else and this entry is placed through the normal flow.
      if (entry.provider.fixedRoom && entry.patientCount > 0) fixedEntries.push(entry);
      else normalEntries.push(entry);
    }
  }

  if (fixedEntries.length > 0) logs.push('Reserving fixed rooms…');
  for (const entry of fixedEntries) {
    const need = entry.effectiveRoomsNeeded;
    const homeDesk = deskById[entry.provider.homeDeskId];
    logDeskStart(homeDesk);
    const slots = [];
    for (let i = 0; i < need; i++) {
      const preferredRoomId = i === 0
        ? entry.provider.primaryPreferredRoomId
        : i === 1
        ? entry.provider.secondPreferredRoomId
        : null;
      if (preferredRoomId && canFit(preferredRoomId, entry.session)) {
        occupy(preferredRoomId, entry.session, entry.providerId);
        const roomDeskId = roomState[preferredRoomId]?.room.deskId ?? homeDesk.id;
        slots.push({ roomId: preferredRoomId, deskId: roomDeskId, isOverflow: false });
      } else {
        slots.push({ roomId: null, deskId: null, isOverflow: false });
        if (!entry.provider.suppressWarnings) {
          const which = i === 0 ? 'primary' : 'second';
          warnings.push(
            preferredRoomId
              ? `${entry.provider.name} has a fixed room, but their ${which} room isn't available today — shown as "Not Found" (fixed-room providers are never moved to a different room).`
              : `${entry.provider.name} is marked "Fixed room" but has no ${which} preferred room set — shown as "Not Found".`
          );
        }
      }
    }
    assignments.push(makeAssignment(entry, homeDesk, slots));
  }

  // Desk-selection ordering (which alternate desk is "lightest") counts
  // only IN-PERSON visits — a video visit doesn't need a room at this
  // specific desk any more than at another, so it shouldn't weigh a desk
  // down when deciding where to send someone else's overflow. Falls back
  // to the overall patientCount for an assignment that predates this field.
  const patientLoad = (deskId) =>
    assignments
      .filter((a) => a.homeDeskId === deskId || a.roomSlots.some((s) => s.deskId === deskId))
      .reduce((sum, a) => sum + (a.inPersonPatientCount ?? a.patientCount ?? 0), 0);

  const checkVideoCapable = (tierAssignments) => {
    for (const assignment of tierAssignments) {
      const entry = workingEntries.find((e) => e.providerId === assignment.providerId);
      if (!entry.needsVideoCapable) continue;
      const gotVideoRoom = assignment.roomSlots.some(
        (s) => s.roomId && roomState[s.roomId].room.videoCapable
      );
      if (!gotVideoRoom && !entry.provider.suppressWarnings) {
        warnings.push(
          `${entry.provider.name} has a video/virtual visit today and no office on the floor, but wasn't assigned a video-capable room — needs manual review.`
        );
      }
    }
  };

  // Video-capable validation is deferred to a single final pass over every
  // assignment (fixed, tiered, and fallback-filled) at the very end, rather
  // than being checked once here and again per tier — see the bottom of
  // this function.

  // ---- Phases 1+2 — priority tiers (rule #14) -----------------------------
  // Doctor, then Fellow, then Any (default/unset), then Nurse. Each tier is
  // fully placed (home desk, then its own overflow) before the next tier
  // starts, so a later tier only ever sees rooms the earlier tiers left.
  const TYPE_PRIORITY = ['Doctor', 'Fellow', 'Any', 'Nurse'];
  const typeRank = (type) => {
    const idx = TYPE_PRIORITY.indexOf(type || 'Any');
    return idx === -1 ? TYPE_PRIORITY.indexOf('Any') : idx;
  };

  const runOverflowAndValidate = (tierAssignments) => {
    for (const assignment of tierAssignments) {
      const missingCount = assignment.roomSlots.filter((s) => s.roomId === null).length;
      if (missingCount === 0) continue;

      const entry = workingEntries.find((e) => e.providerId === assignment.providerId);

      // Rule #16: never split a provider's rooms across desks during this
      // automatic pass. If the home desk placed SOME but not all of their
      // needed rooms, the rest stay unfilled here rather than overflowing
      // elsewhere — overflow is only attempted when the home desk placed
      // NONE of them. (Rule #18's fallback pass, after every tier, can
      // still pick this up as a last resort.)
      if (missingCount < assignment.roomSlots.length) continue;

      const eligible = (entry.provider.alternateDeskIds || [])
        .map((id) => deskById[id])
        .filter(Boolean)
        .sort((a, b) => patientLoad(a.id) - patientLoad(b.id));

      let placed = false;
      for (const desk of eligible) {
        // Try this ONE desk for every missing room at once — a desk that
        // can only fit some of them is rejected outright (rolled back)
        // rather than accepted partially, since accepting it would still
        // mean the remainder gets sent to yet another desk.
        const trialSlots = placeSlots(desk.id, entry, missingCount, assignment.roomSlots.length - missingCount, true);
        const allFilled = trialSlots.every((s) => s.roomId !== null);
        if (allFilled) {
          let cursor = 0;
          for (let i = 0; i < assignment.roomSlots.length && cursor < trialSlots.length; i++) {
            if (assignment.roomSlots[i].roomId === null) {
              assignment.roomSlots[i] = trialSlots[cursor];
              cursor += 1;
            }
          }
          logs.push(`Shifting ${entry.provider.name} to ${desk.name}`);
          placed = true;
          break;
        }
        // This desk couldn't fit everyone — undo whatever it did manage to
        // occupy before trying the next eligible desk.
        for (const s of trialSlots) {
          if (s.roomId) release(s.roomId, entry.session);
        }
      }
      // Not placed here is not necessarily final — rule #18's fallback pass
      // gets one more, broader attempt after every tier has run; warnings
      // and video-capable validation are both deferred to the very end.
    }
  };

  for (let tier = 0; tier < TYPE_PRIORITY.length; tier++) {
    const tierEntries = normalEntries.filter((e) => typeRank(e.provider.type) === tier);
    if (tierEntries.length === 0) continue;

    const tierEntriesByDesk = {};
    for (const d of desks) tierEntriesByDesk[d.id] = [];
    for (const e of tierEntries) tierEntriesByDesk[e.provider.homeDeskId].push(e);

    const tierAssignments = [];
    for (const desk of desks) {
      if (tierEntriesByDesk[desk.id].length === 0) continue;
      logDeskStart(desk);
      // Rule #23 — room contention tie-break: placement is first-come
      // first-served (occupy() makes a room unavailable to whoever's
      // processed next), so ordering entries here decides who wins when
      // two of them would otherwise collide on the identical room. Whoever
      // needs a video-capable room and has no office on the floor goes
      // first; among the rest, whoever has more in-person patients today
      // goes first. Doesn't change what either entry is eligible for —
      // only who gets first crack at this desk.
      const orderedDeskEntries = [...tierEntriesByDesk[desk.id]].sort((a, b) => {
        const videoA = a.needsVideoCapable ? 1 : 0;
        const videoB = b.needsVideoCapable ? 1 : 0;
        if (videoA !== videoB) return videoB - videoA;
        const countA = a.inPersonPatientCount ?? a.patientCount ?? 0;
        const countB = b.inPersonPatientCount ?? b.patientCount ?? 0;
        return countB - countA;
      });
      for (const entry of orderedDeskEntries) {
        const need = entry.effectiveRoomsNeeded;
        const slots = placeSlots(desk.id, entry, need, 0, false);
        const assignment = makeAssignment(entry, desk, slots);
        assignments.push(assignment);
        tierAssignments.push(assignment);
      }
    }

    runOverflowAndValidate(tierAssignments);
  }

  // ---- Phase 3 — fallback fill (rule #18) --------------------------------
  // One more sweep, after every tier has been placed, so no working,
  // non-fixed provider is left with a missing room while a genuinely usable
  // room exists anywhere. Runs in priority order; pseudo/unmatched entries
  // go last and can never evict anyone.
  const patientLoadForFallback = (deskId) => patientLoad(deskId);

  const deskSearchOrder = (entry) => {
    const seen = new Set();
    const ordered = [];
    const home = deskById[entry.provider.homeDeskId];
    if (home) {
      ordered.push(home);
      seen.add(home.id);
    }
    const byLoad = (a, b) => patientLoadForFallback(a.id) - patientLoadForFallback(b.id);
    (entry.provider.alternateDeskIds || [])
      .map((id) => deskById[id])
      .filter(Boolean)
      .sort(byLoad)
      .forEach((d) => {
        if (!seen.has(d.id)) {
          ordered.push(d);
          seen.add(d.id);
        }
      });
    desks
      .filter((d) => !seen.has(d.id))
      .sort(byLoad)
      .forEach((d) => {
        ordered.push(d);
        seen.add(d.id);
      });
    return ordered;
  };

  // Same priority order as fillMissingSlots' slot-1 rule, but returns every
  // eligible room id (not just an open one) so the eviction pass below can
  // also consider bumping someone out of a named preference before it ever
  // considers an adjacency-only candidate: secondPreferredRoomId, then
  // Other Set of Rooms / Alt desk rooms matches at this desk (if any exist
  // at all), then — only when none exist — rooms adjacent to `anchorCode`.
  const slotEligibleRoomIds = (deskId, entry, slotIndex, anchorCode) => {
    const allIds = roomsByDesk[deskId] || [];
    const need2 = entry.effectiveRoomsNeeded === 2;
    if (!need2 || slotIndex !== 1) return allIds;

    const named = [];
    const secondId = entry.provider.secondPreferredRoomId;
    if (secondId && roomState[secondId]?.room.deskId === deskId) named.push(secondId);
    for (const id of [...otherSetRoomIdsInOrder(deskId, entry), ...altDeskRoomIdsInOrder(deskId, entry)]) {
      if (!named.includes(id)) named.push(id);
    }
    if (named.length > 0) return named;
    if (!anchorCode) return [];
    return allIds.filter((id) => roomsAdjacent(roomState[id].room.code, anchorCode));
  };

  // Returns the evictable Nurse (if any) occupying `roomId` during
  // `neededSession` — never a Doctor/Fellow/Any-type provider, and never a
  // fixed-room reservation with patients that day.
  const findEvictableNurse = (roomId, neededSession) => {
    const s = roomState[roomId];
    const occupantId =
      neededSession === 'FULL' ? s.amOccupant || s.pmOccupant : neededSession === 'AM' ? s.amOccupant : s.pmOccupant;
    if (!occupantId) return null;
    const occAssignment = assignments.find((a) => a.providerId === occupantId);
    if (!occAssignment) return null;
    const occEntry = workingEntries.find((e) => e.providerId === occupantId);
    if (!occEntry) return null;
    if ((occEntry.provider.type || 'Any') !== 'Nurse') return null;
    if (occEntry.provider.fixedRoom && occEntry.patientCount > 0) return null;
    const slotIndex = occAssignment.roomSlots.findIndex((sl) => sl.roomId === roomId);
    if (slotIndex === -1) return null;
    return { providerId: occupantId, assignment: occAssignment, entry: occEntry, slotIndex };
  };

  // A single, non-recursive attempt to give an evicted nurse a new room for
  // just the one slot that was freed — no further eviction rights, so this
  // can never cascade or loop. If it fails, the nurse is simply left "Not
  // Found" for that slot (picked up by the final warnings sweep below).
  const relocateEvictedNurse = (hit) => {
    const nurseEntry = hit.entry;
    const nurseAssignment = hit.assignment;
    const need2 = nurseEntry.effectiveRoomsNeeded === 2;
    let anchorCode = null;
    if (need2 && hit.slotIndex === 1) {
      const slot0RoomId = nurseAssignment.roomSlots[0]?.roomId;
      anchorCode = slot0RoomId ? roomState[slot0RoomId]?.room.code || null : null;
    }
    for (const desk of deskSearchOrder(nurseEntry)) {
      const result = fillMissingSlots(desk.id, nurseEntry, [hit.slotIndex], anchorCode);
      const roomId = result[hit.slotIndex];
      if (roomId) {
        nurseAssignment.roomSlots[hit.slotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== nurseEntry.provider.homeDeskId };
        if (desk.id !== nurseEntry.provider.homeDeskId) logs.push(`Shifting ${nurseEntry.provider.name} to ${desk.name}`);
        return;
      }
    }
  };

  // Rule #24 — "reshuffle any provider": generalized version of
  // findEvictableNurse, used only to help a provider complete a two-room
  // adjacent pair (#17) when neither an open room nor an evictable Nurse
  // could be found. Returns an evictable occupant of `roomId` during
  // `neededSession` — never the requesting provider itself, never a
  // fixed-room reservation with patients that day, never a pseudo
  // ("unmatched name") entry (already exempt from the never-drop guarantee,
  // #10 — bumping one isn't the point of this feature), and never a
  // STRICTLY HIGHER-priority type (#14) than `requestingEntry` — a Nurse or
  // Any-type still can't bump a Doctor/Fellow this way, but same-or-lower
  // priority (including same-tier) occupants are eligible.
  const findEvictableOccupant = (roomId, neededSession, requestingEntry) => {
    const s = roomState[roomId];
    const occupantId =
      neededSession === 'FULL' ? s.amOccupant || s.pmOccupant : neededSession === 'AM' ? s.amOccupant : s.pmOccupant;
    if (!occupantId || occupantId === requestingEntry.providerId) return null;
    if (occupantId.startsWith('unmatched-')) return null;
    const occAssignment = assignments.find((a) => a.providerId === occupantId);
    if (!occAssignment) return null;
    const occEntry = workingEntries.find((e) => e.providerId === occupantId);
    if (!occEntry) return null;
    if (occEntry.provider.fixedRoom && occEntry.patientCount > 0) return null;
    if (typeRank(occEntry.provider.type) < typeRank(requestingEntry.provider.type)) return null;
    const slotIndex = occAssignment.roomSlots.findIndex((sl) => sl.roomId === roomId);
    if (slotIndex === -1) return null;
    return { providerId: occupantId, assignment: occAssignment, entry: occEntry, slotIndex };
  };

  // Rule #24 cont'd — unlike relocateEvictedNurse (which may leave a Nurse
  // "Not Found" if nothing opens up elsewhere — an already-accepted
  // outcome for that narrower feature), this MUST succeed for the eviction
  // to be kept: it returns the new slot object on success, or null on
  // failure, so the caller can roll the whole eviction back and guarantee
  // nobody ends up without a room as a net result of this reshuffle.
  const relocateEvictedOccupant = (hit) => {
    const occEntry = hit.entry;
    const need2 = occEntry.effectiveRoomsNeeded === 2;
    let anchorCode = null;
    if (need2 && hit.slotIndex === 1) {
      const slot0RoomId = hit.assignment.roomSlots[0]?.roomId;
      anchorCode = slot0RoomId ? roomState[slot0RoomId]?.room.code || null : null;
    }
    for (const desk of deskSearchOrder(occEntry)) {
      const result = fillMissingSlots(desk.id, occEntry, [hit.slotIndex], anchorCode);
      const roomId = result[hit.slotIndex];
      if (roomId) {
        return { roomId, deskId: desk.id, isOverflow: desk.id !== occEntry.provider.homeDeskId };
      }
    }
    return null;
  };

  // Rule #25 — final adjacency validation/repair. A "hard preference" for
  // `roomId` means the occupant named it themselves (primaryPreferredRoomId,
  // secondPreferredRoomId, or a code in otherPreferredRoomCodes/
  // alternateRoomCodes resolving to this room's code), or it's a same-day
  // fixed-room reservation (#13, never touched by anything). An occupant
  // with none of those for their CURRENT room is "loosely placed" and is
  // eligible to be moved by the adjacency repair below — one with a hard
  // preference for their current room is left alone.
  const hasHardPreferenceForRoom = (occEntry, roomId) => {
    const p = occEntry.provider;
    if (p.fixedRoom && occEntry.patientCount > 0) return true;
    if (p.primaryPreferredRoomId === roomId || p.secondPreferredRoomId === roomId) return true;
    const code = roomState[roomId]?.room.code;
    if (!code) return false;
    if ((p.otherPreferredRoomCodes || []).includes(code)) return true;
    if ((p.alternateRoomCodes || []).includes(code)) return true;
    return false;
  };

  // Returns an evictable, loosely-placed occupant of `roomId` during
  // `neededSession` — never the requesting provider itself, never a pseudo
  // entry, never someone with a hard preference for this specific room
  // (see hasHardPreferenceForRoom), and never a strictly higher-priority
  // type (#14) than `requestingEntry`.
  const findLooselyPlacedOccupant = (roomId, neededSession, requestingEntry) => {
    const s = roomState[roomId];
    const occupantId =
      neededSession === 'FULL' ? s.amOccupant || s.pmOccupant : neededSession === 'AM' ? s.amOccupant : s.pmOccupant;
    if (!occupantId || occupantId === requestingEntry.providerId) return null;
    if (occupantId.startsWith('unmatched-')) return null;
    const occAssignment = assignments.find((a) => a.providerId === occupantId);
    if (!occAssignment) return null;
    const occEntry = workingEntries.find((e) => e.providerId === occupantId);
    if (!occEntry) return null;
    if (hasHardPreferenceForRoom(occEntry, roomId)) return null;
    if (typeRank(occEntry.provider.type) < typeRank(requestingEntry.provider.type)) return null;
    const slotIndex = occAssignment.roomSlots.findIndex((sl) => sl.roomId === roomId);
    if (slotIndex === -1) return null;
    return { providerId: occupantId, assignment: occAssignment, entry: occEntry, slotIndex };
  };

  // Rule #25 cont'd — one attempt to fix a single non-adjacent two-room
  // pair. Tries, from EITHER side of the current pair (keep slot 0 fixed
  // and replace slot 1, then keep slot 1 fixed and replace slot 0), every
  // desk this provider can reach, every room there adjacent to the side
  // being kept: if that adjacent room is already open, just moves there;
  // if it's held by a loosely-placed occupant, evicts them — but only
  // keeps the eviction if that occupant can genuinely be relocated
  // elsewhere in the same attempt (relocateEvictedOccupant), otherwise
  // rolls back and tries the next candidate. This applies even when the
  // non-adjacent pair came from the provider's OWN explicit preference
  // (secondPreferredRoomId or an Other Set of Rooms/Alt desk rooms pair) —
  // confirmed to take priority over an explicit non-adjacent pairing.
  // Returns whether anything changed.
  const tryFixAdjacency = (assignment, entry) => {
    const slot0 = assignment.roomSlots[0];
    const slot1 = assignment.roomSlots[1];
    if (!slot0?.roomId || !slot1?.roomId) return false; // only a fully-filled pair can be "non-adjacent"
    const code0 = roomState[slot0.roomId]?.room.code;
    const code1 = roomState[slot1.roomId]?.room.code;
    if (roomsAdjacent(code0, code1)) return false; // already fine

    for (const anchorSlotIndex of [0, 1]) {
      const otherSlotIndex = anchorSlotIndex === 0 ? 1 : 0;
      const anchorRoomId = assignment.roomSlots[anchorSlotIndex].roomId;
      const anchorCode = roomState[anchorRoomId]?.room.code;
      if (!anchorCode) continue;
      const oldOtherRoomId = assignment.roomSlots[otherSlotIndex].roomId;

      for (const desk of deskSearchOrder(entry)) {
        for (const roomId of roomsByDesk[desk.id] || []) {
          if (roomId === anchorRoomId || roomId === oldOtherRoomId) continue;
          if (!roomsAdjacent(roomState[roomId].room.code, anchorCode)) continue;

          if (canFit(roomId, entry.session)) {
            release(oldOtherRoomId, entry.session);
            occupy(roomId, entry.session, entry.providerId);
            assignment.roomSlots[otherSlotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };
            logs.push(`Adjusting ${entry.provider.name}'s room pair to keep it adjacent`);
            return true;
          }

          const hit = findLooselyPlacedOccupant(roomId, entry.session, entry);
          if (!hit) continue;
          const occOldSlot = { ...hit.assignment.roomSlots[hit.slotIndex] };
          release(roomId, hit.assignment.session);
          if (!canFit(roomId, entry.session)) {
            occupy(roomId, hit.assignment.session, hit.providerId);
            continue;
          }
          release(oldOtherRoomId, entry.session);
          occupy(roomId, entry.session, entry.providerId);
          hit.assignment.roomSlots[hit.slotIndex] = { roomId: null, deskId: null, isOverflow: false };
          const relocated = relocateEvictedOccupant(hit);
          if (!relocated) {
            // Couldn't relocate the evicted provider — roll everything
            // back (assignment.roomSlots[otherSlotIndex] was never
            // mutated above, so only the room-state occupy/release calls
            // and the evicted provider's slot need undoing here).
            release(roomId, entry.session);
            occupy(oldOtherRoomId, entry.session, entry.providerId);
            hit.assignment.roomSlots[hit.slotIndex] = occOldSlot;
            occupy(roomId, hit.assignment.session, hit.providerId);
            continue;
          }
          assignment.roomSlots[otherSlotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };
          hit.assignment.roomSlots[hit.slotIndex] = relocated;
          logs.push(
            `Adjusting ${entry.provider.name}'s room pair to keep it adjacent (relocated ${hit.entry.provider.name})`
          );
          return true;
        }
      }
    }
    return false;
  };

  // Runs one full fallback sweep over whatever is missing a room RIGHT NOW
  // (recomputed fresh each call, not a fixed snapshot) and returns whether
  // it changed anything. Called in a loop below (rule #19 — cross-check /
  // backtracking) so a placement made late in one pass (e.g. a provider
  // shifted off their home desk, freeing it up) can still be picked up by
  // an earlier-processed provider on a repeat pass, instead of only ever
  // getting one shot in priority order.
  const runFallbackPass = () => {
    const needsFallback = normalEntries
      .filter((e) => assignments.find((a) => a.providerId === e.providerId)?.roomSlots.some((s) => s.roomId === null))
      .sort((a, b) => {
        const aKey = (a.providerId.startsWith('unmatched-') ? 100 : 0) + typeRank(a.provider.type);
        const bKey = (b.providerId.startsWith('unmatched-') ? 100 : 0) + typeRank(b.provider.type);
        return aKey - bKey;
      });

    let changed = false;

    for (const entry of needsFallback) {
      const assignment = assignments.find((a) => a.providerId === entry.providerId);
      if (!assignment) continue;
      const isPseudo = entry.providerId.startsWith('unmatched-');
      const allowEvict = !isPseudo && (entry.provider.type || 'Any') !== 'Nurse';
      const need2 = entry.effectiveRoomsNeeded === 2;

      // First pass: any already-open room, no eviction. Tries each desk in
      // order, filling as many of the entry's still-missing slots as
      // possible in one shot at that desk — see fillMissingSlots for how
      // otherPreferredRoomCodes (rule #15b, pairs when both slots are still
      // missing, an ordered single-room list when only one is) and the
      // anchor-adjacency fallback (#17) apply.
      for (const desk of deskSearchOrder(entry)) {
        logDeskStart(desk);
        const missingSlotIndexes = assignment.roomSlots
          .map((s, i) => (s.roomId === null ? i : -1))
          .filter((i) => i !== -1);
        if (missingSlotIndexes.length === 0) break;
        const anchorCodeForSlot1 = assignment.roomSlots[0]?.roomId
          ? roomState[assignment.roomSlots[0].roomId]?.room.code || null
          : null;
        const result = fillMissingSlots(desk.id, entry, missingSlotIndexes, anchorCodeForSlot1);
        for (const slotIndex of missingSlotIndexes) {
          const roomId = result[slotIndex];
          if (roomId) {
            assignment.roomSlots[slotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };
            if (desk.id !== entry.provider.homeDeskId) logs.push(`Shifting ${entry.provider.name} to ${desk.name}`);
            changed = true;
          }
        }
      }

      // Second pass: whatever's still missing after every desk above —
      // nothing open anywhere for it — try bumping a Nurse (never for a
      // Nurse or pseudo entry itself) out of a room that would fit. Same
      // priority order as the first pass: a named preference / other-set
      // room is tried for eviction before an adjacency-only candidate.
      if (!allowEvict) continue;
      for (let slotIndex = 0; slotIndex < assignment.roomSlots.length; slotIndex++) {
        if (assignment.roomSlots[slotIndex].roomId !== null) continue;

        let anchorCode = null;
        if (need2 && slotIndex === 1) {
          const slot0RoomId = assignment.roomSlots[0]?.roomId;
          anchorCode = slot0RoomId ? roomState[slot0RoomId]?.room.code || null : null;
        }

        let filledByEviction = false;
        outer: for (const desk of deskSearchOrder(entry)) {
          const roomIds = slotEligibleRoomIds(desk.id, entry, slotIndex, anchorCode);
          for (const roomId of roomIds) {
            const nurseHit = findEvictableNurse(roomId, entry.session);
            if (!nurseHit) continue;
            release(roomId, nurseHit.assignment.session);
            if (!canFit(roomId, entry.session)) {
              // Evicting this nurse alone wasn't enough (e.g. the
              // complementary half-day slot is held by someone else) —
              // restore them and move on.
              occupy(roomId, nurseHit.assignment.session, nurseHit.providerId);
              continue;
            }
            occupy(roomId, entry.session, entry.providerId);
            assignment.roomSlots[slotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };
            logs.push(`Shifting ${entry.provider.name} to ${desk.name}`);
            nurseHit.assignment.roomSlots[nurseHit.slotIndex] = { roomId: null, deskId: null, isOverflow: false };
            relocateEvictedNurse(nurseHit);
            changed = true;
            filledByEviction = true;
            break outer;
          }
        }
        if (filledByEviction) continue;

        // Rule #24 — "reshuffle any provider": only for completing a
        // two-room ADJACENT pair (need2, slot 1, slot 0 already filled) —
        // a fully-missing provider is already covered above and by the
        // broader fallback passes. No evictable Nurse was found anywhere
        // for this slot, so now try evicting any OTHER already-placed,
        // same-or-lower-priority, non-fixed-room occupant
        // (findEvictableOccupant) — but ONLY keep it if the evicted
        // occupant can genuinely be relocated to another open room in
        // this same attempt (relocateEvictedOccupant); otherwise the whole
        // thing is rolled back and this slot is left exactly as it was.
        if (need2 && slotIndex === 1 && anchorCode) {
          outer2: for (const desk of deskSearchOrder(entry)) {
            const roomIds = slotEligibleRoomIds(desk.id, entry, slotIndex, anchorCode);
            for (const roomId of roomIds) {
              const occHit = findEvictableOccupant(roomId, entry.session, entry);
              if (!occHit) continue;
              const occOldSlot = { ...occHit.assignment.roomSlots[occHit.slotIndex] };
              release(roomId, occHit.assignment.session);
              if (!canFit(roomId, entry.session)) {
                occupy(roomId, occHit.assignment.session, occHit.providerId);
                continue;
              }
              occupy(roomId, entry.session, entry.providerId);
              occHit.assignment.roomSlots[occHit.slotIndex] = { roomId: null, deskId: null, isOverflow: false };
              const relocated = relocateEvictedOccupant(occHit);
              if (!relocated) {
                // Couldn't relocate the evicted provider anywhere — roll
                // back everything so nobody ends up without a room.
                release(roomId, entry.session);
                occHit.assignment.roomSlots[occHit.slotIndex] = occOldSlot;
                occupy(roomId, occHit.assignment.session, occHit.providerId);
                continue;
              }
              assignment.roomSlots[slotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };
              logs.push(`Shifting ${entry.provider.name} to ${desk.name}`);
              occHit.assignment.roomSlots[occHit.slotIndex] = relocated;
              if (relocated.deskId !== occHit.entry.provider.homeDeskId) {
                logs.push(
                  `Shifting ${occHit.entry.provider.name} to ${deskById[relocated.deskId]?.name || 'another desk'} to complete ${entry.provider.name}'s room pair`
                );
              }
              changed = true;
              break outer2;
            }
          }
        }
      }
    }

    return changed;
  };

  // ---- Phase 5 helper — video-capable backtracking (rule #20) -------------
  // The fallback/cross-check pass above only ever revisits a provider with
  // a fully MISSING slot. A provider who already has a room, just not a
  // video-capable one when they needed it (#9), was only ever flagged as a
  // warning. This makes one further, conservative attempt per call to fix
  // that by swapping them into a video-capable room currently held by
  // someone the swap can't hurt — see rule #20's doc comment at the top of
  // this file for the exact guards. The swap is only ever committed if the
  // displaced provider can genuinely be relocated in the same attempt;
  // otherwise everything is rolled back and the mismatch is left exactly as
  // it was. Returns whether anything changed, same shape as runFallbackPass,
  // so the two can be interleaved in one bounded loop below.
  const tryImproveVideoCapableFit = () => {
    let changed = false;
    for (const assignment of assignments) {
      const entry = workingEntries.find((e) => e.providerId === assignment.providerId);
      if (!entry || !entry.needsVideoCapable) continue;
      const alreadyHasVideoRoom = assignment.roomSlots.some((s) => s.roomId && roomState[s.roomId]?.room.videoCapable);
      if (alreadyHasVideoRoom) continue;
      const filledSlotIndexes = assignment.roomSlots.map((s, i) => (s.roomId ? i : -1)).filter((i) => i !== -1);
      if (filledSlotIndexes.length === 0) continue; // fully missing — #18/#19's job, not this one

      const myRank = typeRank(entry.provider.type);

      swapSearch: for (const desk of deskSearchOrder(entry)) {
        for (const roomId of roomsByDesk[desk.id] || []) {
          const room = roomState[roomId].room;
          if (!room.videoCapable) continue;
          if (assignment.roomSlots.some((s) => s.roomId === roomId)) continue; // already theirs

          const s = roomState[roomId];
          const occupantId =
            entry.session === 'FULL' ? s.amOccupant || s.pmOccupant : entry.session === 'AM' ? s.amOccupant : s.pmOccupant;
          if (!occupantId) continue; // a genuinely open video-capable room would already have been taken earlier
          const occAssignment = assignments.find((a) => a.providerId === occupantId);
          const occEntry = workingEntries.find((e) => e.providerId === occupantId);
          if (!occAssignment || !occEntry) continue;
          if (occEntry.needsVideoCapable) continue; // would just move the same problem elsewhere
          if (occEntry.provider.fixedRoom && occEntry.patientCount > 0) continue; // #13 — never touched
          if (typeRank(occEntry.provider.type) < myRank) continue; // never bump a higher-priority type
          const occSlotIndex = occAssignment.roomSlots.findIndex((sl) => sl.roomId === roomId);
          if (occSlotIndex === -1) continue;

          for (const mySlotIndex of filledSlotIndexes) {
            const myOldSlot = { ...assignment.roomSlots[mySlotIndex] };
            const occOldSlot = { ...occAssignment.roomSlots[occSlotIndex] };

            release(roomId, occAssignment.session);
            release(myOldSlot.roomId, entry.session);
            if (!canFit(roomId, entry.session)) {
              // Freeing the occupant's side of this room still isn't
              // enough for this provider's session — restore and move on.
              occupy(myOldSlot.roomId, entry.session, entry.providerId);
              occupy(roomId, occAssignment.session, occupantId);
              continue;
            }

            occupy(roomId, entry.session, entry.providerId);
            assignment.roomSlots[mySlotIndex] = { roomId, deskId: desk.id, isOverflow: desk.id !== entry.provider.homeDeskId };

            let newOccSlot = null;
            for (const relocDesk of deskSearchOrder(occEntry)) {
              const result = fillMissingSlots(relocDesk.id, occEntry, [occSlotIndex], null);
              if (result[occSlotIndex]) {
                newOccSlot = { roomId: result[occSlotIndex], deskId: relocDesk.id, isOverflow: relocDesk.id !== occEntry.provider.homeDeskId };
                break;
              }
            }

            if (!newOccSlot) {
              // Can't relocate the displaced provider without dropping
              // them — undo the whole swap, leave the video mismatch as a
              // warning instead (rule #10 always wins).
              release(roomId, entry.session);
              assignment.roomSlots[mySlotIndex] = myOldSlot;
              occupy(myOldSlot.roomId, entry.session, entry.providerId);
              occupy(roomId, occAssignment.session, occupantId);
              occAssignment.roomSlots[occSlotIndex] = occOldSlot;
              continue;
            }

            occAssignment.roomSlots[occSlotIndex] = newOccSlot;
            logs.push(
              `Shifting ${occEntry.provider.name} to ${deskById[newOccSlot.deskId]?.name || 'another desk'} to free a video-capable room for ${entry.provider.name}`
            );
            changed = true;
            break swapSearch;
          }
        }
      }
    }
    return changed;
  };

  runFallbackPass();

  // ---- Phase 4 — cross-check / backtracking (rule #19) --------------------
  // Re-runs the fallback sweep against the FINAL, current room state a few
  // more times: a placement made late in the first pass (a provider shifted
  // to another desk, a nurse relocated after eviction) can open up a room
  // that an earlier-processed provider in that same pass had already given
  // up on. Interleaved with the #20 video-capable-backtracking pass, since
  // either kind of change can open up a room the other kind would want —
  // bounded to a handful of extra rounds, stops as soon as a round makes no
  // further change at all, rather than looping forever.
  logs.push('Cross-checking all assignments…');
  let crossCheckPasses = 0;
  let somethingChanged = true;
  while (crossCheckPasses < 4 && somethingChanged) {
    const fallbackChanged = runFallbackPass();
    const videoChanged = tryImproveVideoCapableFit();
    somethingChanged = fallbackChanged || videoChanged;
    crossCheckPasses += 1;
  }

  // ---- Phase 5 — final two-room adjacency validation/repair (rule #25) ---
  // Runs last, right before results are considered export-ready: for every
  // provider who needs 2 rooms and has both slots filled, double-checks the
  // two rooms are actually adjacent (#17) — even a pair the provider named
  // themselves (secondPreferredRoomId, or an Other Set of Rooms/Alt desk
  // rooms pair) is checked and, if non-adjacent, still eligible for repair.
  // Fixed-room providers (#13) are exempt — their rooms are never moved by
  // anything. Re-run a few more times (bounded, same pattern as #19) since
  // fixing one provider's pair can change what's loosely available for the
  // next. Whatever can't be fixed (no loosely-placed occupant anywhere
  // could be evicted-and-relocated to make it adjacent) is left exactly as
  // it was and flagged in the final warnings sweep below.
  logs.push('Verifying two-room adjacency…');
  const fixedProviderIdsForAdjacency = new Set(fixedEntries.map((e) => e.providerId));
  let adjacencyPasses = 0;
  let adjacencyChanged = true;
  while (adjacencyPasses < 4 && adjacencyChanged) {
    adjacencyChanged = false;
    for (const assignment of assignments) {
      if (fixedProviderIdsForAdjacency.has(assignment.providerId)) continue;
      const entry = workingEntries.find((e) => e.providerId === assignment.providerId);
      if (!entry || entry.effectiveRoomsNeeded !== 2) continue;
      if (tryFixAdjacency(assignment, entry)) adjacencyChanged = true;
    }
    adjacencyPasses += 1;
  }

  logs.push('Finalizing all the providers…');

  // ---- Final sweep — warnings + video-capable validation ------------------
  // Deferred to one pass over every assignment (fixed, tiered, and
  // fallback-filled) now that the fallback pass has had its say, instead of
  // being checked repeatedly across earlier phases.
  const fixedProviderIds = new Set(fixedEntries.map((e) => e.providerId));
  for (const assignment of assignments) {
    if (fixedProviderIds.has(assignment.providerId)) continue; // already warned in Phase 0, if needed
    const entry = workingEntries.find((e) => e.providerId === assignment.providerId);
    if (!entry || entry.provider.suppressWarnings) continue;
    const missing = assignment.roomSlots.filter((s) => s.roomId === null).length;
    if (missing > 0) {
      warnings.push(
        `${assignment.providerName}: ${missing} of ${assignment.roomSlots.length} preferred room(s) could not be assigned today (shown as "Not Found") — needs manual review.`
      );
    } else if (entry.effectiveRoomsNeeded === 2) {
      const c0 = roomState[assignment.roomSlots[0].roomId]?.room.code;
      const c1 = roomState[assignment.roomSlots[1].roomId]?.room.code;
      if (!roomsAdjacent(c0, c1)) {
        warnings.push(
          `${assignment.providerName}: assigned two rooms (${c0}, ${c1}) that aren't adjacent — needs manual review.`
        );
      }
    }
  }
  checkVideoCapable(assignments);

  return { assignments, warnings, logs };
}

function makeAssignment(entry, homeDesk, roomSlots) {
  return {
    providerId: entry.providerId,
    // A blank/whitespace-only name would otherwise show up as a filled-but-
    // nameless room on the live board and in the export — a provider whose
    // name didn't match anyone on the Providers list still needs to be
    // shown as SOMEONE, not nothing.
    providerName: (entry.provider.name || '').trim() || 'Unknown provider',
    homeDeskId: homeDesk.id,
    homeDeskName: homeDesk.name,
    session: entry.session,
    patientCount: entry.patientCount,
    // In-person-only patient count (falls back to patientCount for an entry
    // that predates this field) — used for desk-load ordering; see
    // patientLoad above.
    inPersonPatientCount: entry.inPersonPatientCount ?? entry.patientCount,
    // The one raw imported Time value for a provider with exactly one
    // patient that day (null otherwise) — see pdfGenerator.js's use of it
    // next to a solo, full-day provider's name.
    soloTime: entry.soloTime || null,
    roomSlots // [{ roomId: string|null, deskId: string|null, isOverflow: bool }, ...]
  };
}
