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
 * 11. NEW — alternateRoomCodes: a provider can name specific room codes
 *    (free text, comma-separated in the UI) that should be favored whenever
 *    they're a candidate — most useful for overflow, since a provider's
 *    home-desk rooms aren't usually also listed here. Same scoring weight
 *    as the primary/second preferred room.
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
 * 13. NEW — provider.fixedRoom: when true, this provider's room(s) are
 *    reserved up front, before anything else is assigned, from their
 *    primaryPreferredRoomId (slot 0) and secondPreferredRoomId (slot 1,
 *    if preferredNumberOfRooms is 2) — no scoring, no substitution. If a
 *    fixed room isn't set or isn't available that session (blocked or
 *    already reserved by another fixed-room provider), that slot shows
 *    "Not Found"; it is NEVER filled by a different room and NEVER sent
 *    through overflow to another desk. This reservation happens before
 *    any non-fixed provider is placed, so a fixed-room provider's room
 *    can't be taken by someone else first.
 * 14. NEW — provider.type ('Doctor' | 'Fellow' | 'Any' | 'Nurse', default
 *    'Any'): assignment happens in priority tiers, in that order — every
 *    Doctor (across all desks, including their overflow) is placed before
 *    any Fellow is placed, then every Fellow before any Any-type provider,
 *    then every Any-type provider before any Nurse. So a Nurse only gets a
 *    room once every Doctor/Fellow/Any-type provider everywhere already
 *    has theirs (or has been overflowed/failed to find one). fixedRoom
 *    providers are reserved before all tiers (see #13) regardless of type.
 * ------------------------------------------------------------------
 */

const NOON = 12 * 60;

function timeRangeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
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
 *                                alternateRoomCodes, hasOfficeOnFloor, suppressWarnings,
 *                                fixedRoom, type }]
 * @param {Array} dayEntries  [{ providerId, isWorking, patientCount, session, hasVideoVisit? }]
 *                             hasVideoVisit is the ONLY source of whether a video-capable
 *                             room is needed — it comes from that day's import, never from
 *                             a static provider field.
 * @param {Array} roomBlocks  [{ id, roomId, date, startMinutes, endMinutes, reason }]
 * @param {string} date       'YYYY-MM-DD', used to resolve which blocks apply today
 * @returns {{ assignments: Array, warnings: Array }}
 */
export function generateDailyAssignments({ desks, rooms, providers, dayEntries, roomBlocks = [], date }) {
  const warnings = [];
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
  // room code (not just id) so it lines up with whatever the user typed on
  // the Providers page, and applies at any desk — it's naturally scoped to
  // overflow desks in practice, since a home-desk room wouldn't usually
  // also be listed as an "alternate" room.
  const scoreRoom = (roomId, entry, preferredRoomId, alreadyPicked) => {
    if (alreadyPicked.includes(roomId)) return -Infinity; // never double-book the same room to the same provider
    const s = roomState[roomId];
    let score = 0;
    if (preferredRoomId && preferredRoomId === roomId) score += 4;
    if (entry.needsVideoCapable && s.room.videoCapable) score += 3;
    if ((entry.provider.alternateRoomCodes || []).includes(s.room.code)) score += 3;
    if (entry.provider.windowPreference === 'prefers' && s.room.hasWindow) score += 2;
    if (s.amOccupant !== null || s.pmOccupant !== null) score += 1; // reuse half-filled rooms
    return score;
  };

  const pickRoom = (deskId, entry, preferredRoomId, alreadyPicked) => {
    const candidates = (roomsByDesk[deskId] || []).filter((id) => canFit(id, entry.session));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => scoreRoom(b, entry, preferredRoomId, alreadyPicked) - scoreRoom(a, entry, preferredRoomId, alreadyPicked));
    const best = candidates[0];
    return scoreRoom(best, entry, preferredRoomId, alreadyPicked) === -Infinity ? null : best;
  };

  /**
   * Attempts to fill `count` room slots for `entry` at `deskId`, starting
   * at `slotOffset` (so slot preferences line up correctly when this is
   * called again during overflow for just the still-missing slots).
   * Returns an array of { roomId: string|null, deskId, isOverflow }.
   */
  const placeSlots = (deskId, entry, count, slotOffset, isOverflow) => {
    const results = [];
    const pickedSoFar = [];
    for (let i = 0; i < count; i++) {
      const slotIndex = slotOffset + i;
      const preferredRoomId = slotIndex === 0
        ? entry.provider.primaryPreferredRoomId
        : slotIndex === 1
        ? entry.provider.secondPreferredRoomId
        : null;
      const roomId = pickRoom(deskId, entry, preferredRoomId, pickedSoFar);
      if (roomId) {
        occupy(roomId, entry.session, entry.providerId);
        pickedSoFar.push(roomId);
        results.push({ roomId, deskId, isOverflow });
      } else {
        results.push({ roomId: null, deskId: null, isOverflow: false });
      }
    }
    return results;
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
      if (entry.provider.fixedRoom) fixedEntries.push(entry);
      else normalEntries.push(entry);
    }
  }

  for (const entry of fixedEntries) {
    const need = entry.provider.preferredNumberOfRooms || 1;
    const homeDesk = deskById[entry.provider.homeDeskId];
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

  // Video-capable validation for fixed-room providers too — a fixed room
  // is still expected to satisfy the day's video-visit need if it applies.
  checkVideoCapable(assignments);

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
      const eligible = (entry.provider.alternateDeskIds || [])
        .map((id) => deskById[id])
        .filter(Boolean)
        .sort((a, b) => patientLoad(a.id) - patientLoad(b.id));

      let remaining = missingCount;
      const filledSoFar = assignment.roomSlots.length - missingCount;

      for (const desk of eligible) {
        if (remaining === 0) break;
        const newSlots = placeSlots(desk.id, entry, remaining, filledSoFar, true);
        // Splice the newly-filled slots into the first remaining null positions.
        let cursor = 0;
        for (let i = 0; i < assignment.roomSlots.length && cursor < newSlots.length; i++) {
          if (assignment.roomSlots[i].roomId === null) {
            assignment.roomSlots[i] = newSlots[cursor];
            if (newSlots[cursor].roomId !== null) remaining -= 1;
            cursor += 1;
          }
        }
      }

      if (remaining > 0 && !entry.provider.suppressWarnings) {
        warnings.push(
          `${entry.provider.name}: ${remaining} of ${assignment.roomSlots.length} preferred room(s) could not be assigned (shown as "Not Found") — needs manual review.`
        );
      }
    }

    // Video-capable validation for every assignment in this tier, whether
    // it went through overflow or was fully placed at the home desk.
    checkVideoCapable(tierAssignments);
  };

  for (let tier = 0; tier < TYPE_PRIORITY.length; tier++) {
    const tierEntries = normalEntries.filter((e) => typeRank(e.provider.type) === tier);
    if (tierEntries.length === 0) continue;

    const tierEntriesByDesk = {};
    for (const d of desks) tierEntriesByDesk[d.id] = [];
    for (const e of tierEntries) tierEntriesByDesk[e.provider.homeDeskId].push(e);

    const tierAssignments = [];
    for (const desk of desks) {
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

  return { assignments, warnings };
}

function makeAssignment(entry, homeDesk, roomSlots) {
  return {
    providerId: entry.providerId,
    providerName: entry.provider.name,
    homeDeskId: homeDesk.id,
    homeDeskName: homeDesk.name,
    session: entry.session,
    patientCount: entry.patientCount,
    roomSlots // [{ roomId: string|null, deskId: string|null, isOverflow: bool }, ...]
  };
}
