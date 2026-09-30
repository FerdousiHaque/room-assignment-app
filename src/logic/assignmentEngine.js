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
 *        list has an ODD number of codes, it can't be evenly paired, so
 *        it's skipped ENTIRELY in this two-missing-slots case (not even a
 *        leading complete pair is used) — falls straight through to #17's
 *        adjacency fallback instead.
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
 *    room the other kind of pass would want. This is the final check
 *    before the results are considered ready to export.
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
 * @param {Array} dayEntries  [{ providerId, isWorking, patientCount, session, hasVideoVisit? }]
 *                             hasVideoVisit is the ONLY source of whether a video-capable
 *                             room is needed — it comes from that day's import, never from
 *                             a static provider field.
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
      return { ...e, provider, needsVideoCapable };
    })
    .filter((e) => {
      if (!e.provider) {
        warnings.push(`Schedule entry for unknown provider id "${e.providerId}" was skipped.`);
        return false;
      }
      return true;
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
  // Providers page, and applies at any desk — naturally scoped to overflow
  // desks in practice, since a home-desk room wouldn't usually also be
  // listed there. The otherPreferredRoomCodes bonus below is now mostly a
  // residual tie-break: rule #15's explicit, ordered try (fillMissingSlots)
  // already claims a matching room whenever one was actually open, so by
  // the time generic scoring runs here that list has usually already been
  // exhausted — this only still matters for an odd-one-out code left over
  // from an unpaired 2-room list, or a slot filled through a different path.
  const scoreRoom = (roomId, entry, preferredRoomId, alreadyPicked) => {
    if (alreadyPicked.includes(roomId)) return -Infinity; // never double-book the same room to the same provider
    const s = roomState[roomId];
    let score = 0;
    if (preferredRoomId && preferredRoomId === roomId) score += 10;
    if ((entry.provider.otherPreferredRoomCodes || []).includes(s.room.code)) score += 7;
    if (entry.needsVideoCapable && s.room.videoCapable) score += 5;
    if ((entry.provider.alternateRoomCodes || []).includes(s.room.code)) score += 5;
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
   *     order. An ODD-length list can't be evenly paired, so it's skipped
   *     ENTIRELY here (not even a leading complete pair is used) — rule
   *     #15's odd-list carve-out; #17's adjacency fallback is what's meant
   *     for that case instead.
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
      if (ids.length % 2 !== 0) return false; // odd count — skip entirely, rule #15
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
    const need2 = (entry.provider.preferredNumberOfRooms || 1) === 2;
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

    // Step 3: existing fallback logic, unchanged — generic preference
    // scoring for slot 0, the anchor-adjacency rule (#17) for slot 1.
    for (const slotIndex of stillMissing) {
      let roomId;
      if (slotIndex === 1 && (entry.provider.preferredNumberOfRooms || 1) === 2) {
        const anchorCode = filled[0] !== undefined ? roomState[filled[0]]?.room.code || null : anchorCodeForSlot1;
        roomId = anchorCode ? pickRoom(deskId, entry, null, pickedSoFar, anchorCode) : null;
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
    const need = entry.provider.preferredNumberOfRooms || 1;
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

  const patientLoad = (deskId) =>
    assignments
      .filter((a) => a.homeDeskId === deskId || a.roomSlots.some((s) => s.deskId === deskId))
      .reduce((sum, a) => sum + (a.patientCount || 0), 0);

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
      for (const entry of tierEntriesByDesk[desk.id]) {
        const need = entry.provider.preferredNumberOfRooms || 1;
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
    const need2 = (entry.provider.preferredNumberOfRooms || 1) === 2;
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
    const need2 = (nurseEntry.provider.preferredNumberOfRooms || 1) === 2;
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
      const need2 = (entry.provider.preferredNumberOfRooms || 1) === 2;

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
            break outer;
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
    roomSlots // [{ roomId: string|null, deskId: string|null, isOverflow: bool }, ...]
  };
}
