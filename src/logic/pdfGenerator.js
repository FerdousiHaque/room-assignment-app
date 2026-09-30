/**
 * Generates the output PDF.
 *
 * Exports are per-desk (see downloadDeskAssignmentPdf), one PDF per desk.
 * The page is the desk's full room grid — every room the desk has, grouped
 * into halls exactly like the printed floor plan, whether or not anyone is
 * assigned there today. A room with a provider in it today shows that
 * provider's name in place of its usual blank/video-capable marker; every
 * other room still prints (blank, "V" for video-capable, or its permanent
 * office/utility label) so the page never collapses to a single "no one
 * scheduled" line just because the day's import didn't match anyone. Any
 * provider who has NO room today (e.g. nothing was open for them) still
 * gets a short "not assigned a room" note below the grid — the never-drop-
 * a-provider guarantee from the old provider-list page, now attached to the
 * grid instead of replacing it.
 *
 * A desk with no hall/row/side configured on its rooms falls back to a
 * plain one-column room list (drawSimpleRoomList) — same idea, just without
 * the two-column floor-plan layout.
 *
 * generateAssignmentPdf / downloadAssignmentPdf (the original combined,
 * all-desks-in-one-file version) are kept below for reference/reuse — nothing
 * currently calls them, since the app now downloads per desk.
 */
import { jsPDF } from 'jspdf';

const NAVY = [20, 34, 110];
const BORDER = [150, 180, 210];
const TEXT = [25, 35, 60];
const PAGE_RIGHT = 564; // right edge of content, matching the existing marginX=48 convention

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '25Sep2026' (day, 3-letter month, year — no separators). */
export function formatDateForFilename(dateStr) {
  const [y, m, d] = dateStr.split('-').map((s) => parseInt(s, 10));
  const dd = String(d).padStart(2, '0');
  return `${dd}${MONTH_ABBR[m - 1]}${y}`;
}

/** 'Desk West' -> 'DeskWest' (spaces stripped, matches the requested filename shape). */
export function deskNameForFilename(deskName) {
  return deskName.replace(/\s+/g, '');
}

// ---------- Per-desk export (current default) ----------

export function generateDeskAssignmentPdf({ desk, date, rooms, assignments, providers = [] }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const marginX = 48;
  const providerById = Object.fromEntries(providers.map((p) => [p.id, p]));

  // Occupancy is looked up against the FULL assignments list (not just this
  // desk's own providers) — when "Submit All" ran, a room here may be filled
  // by a provider whose home desk is elsewhere but overflowed in, and that
  // should still show up as occupied on this desk's own grid.
  const deskRooms = rooms.filter((r) => r.deskId === desk.id);
  const occupancy = buildRoomOccupancy(deskRooms, assignments, providerById);

  // Only this desk's own providers count for the "not assigned a room"
  // note below the grid — a provider who belongs to a different desk isn't
  // this desk's report's problem to flag.
  const deskAssignments = assignments.filter((a) => a.homeDeskId === desk.id);

  drawRoomGridPage(doc, { desk, date, deskRooms, occupancy, deskAssignments, providerById, marginX });

  return doc;
}

// A Doctor-type provider always prints as "Dr. <LastName>" in exports
// (never the full name); every other type keeps printing their full name,
// exactly as before. `fallbackName` (the assignment's own providerName) is
// used only if the provider record itself couldn't be found (shouldn't
// normally happen, since pseudo/unmatched entries are filtered out of
// exports before they ever reach here).
function exportDisplayName(provider, fallbackName) {
  if (!provider) return fallbackName;
  const lastName = (provider.lastName || '').trim();
  if (provider.type === 'Doctor' && lastName) return `Dr. ${lastName}`;
  const firstName = (provider.firstName || '').trim();
  return [firstName, lastName].filter(Boolean).join(' ') || fallbackName;
}

// Last-name-only, used specifically for the compact "Issa (AM)/Riad (PM)"
// shared-room format — kept separate from exportDisplayName so a shared
// cell never has to fit two full "Dr. First Last" names side by side.
function exportLastName(provider, fallbackName) {
  if (!provider) return fallbackName;
  return (provider.lastName || '').trim() || fallbackName;
}

function occupantCellLabel(occ) {
  const label = exportDisplayName(occ.provider, occ.providerName);
  return occ.isOverflow ? `${label} *` : label;
}

function sharedOccupantLabel(occ) {
  const label = exportLastName(occ.provider, occ.providerName);
  return occ.isOverflow ? `${label}*` : label;
}

/**
 * roomId -> { AM: occ|null, PM: occ|null, FULL: occ|null } for every room in
 * `deskRooms` that has someone in it today (occ = { provider, providerName,
 * isOverflow }), scanning every assignment's room slots (not just ones whose
 * home desk is this one — see the comment above). Tracking AM and PM
 * separately (instead of one name per room) is what makes a shared room
 * show BOTH occupants instead of one silently overwriting the other.
 */
function buildRoomOccupancy(deskRooms, assignments, providerById) {
  const deskRoomIds = new Set(deskRooms.map((r) => r.id));
  const occupancy = new Map();
  for (const a of assignments) {
    const provider = providerById[a.providerId];
    for (const slot of a.roomSlots || []) {
      if (slot.roomId && deskRoomIds.has(slot.roomId)) {
        if (!occupancy.has(slot.roomId)) occupancy.set(slot.roomId, {});
        occupancy.get(slot.roomId)[a.session] = { provider, providerName: a.providerName, isOverflow: slot.isOverflow };
      }
    }
  }
  return occupancy;
}

export function downloadDeskAssignmentPdf({ desk, date, rooms, assignments, providers = [] }) {
  const doc = generateDeskAssignmentPdf({ desk, date, rooms, assignments, providers });
  const fileName = `${deskNameForFilename(desk.name)}_${formatDateForFilename(date)}.pdf`;
  doc.save(fileName);
}

// ---------- Combined all-desks export (kept for reference; unused by the UI) ----------

export function generateAssignmentPdf({ date, desks, rooms, assignments, providers = [] }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const marginX = 48;
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));
  const providerById = Object.fromEntries(providers.map((p) => [p.id, p]));

  drawProviderSummaryPage(doc, {
    title: 'Provider Assignment Report',
    date,
    assignments,
    roomById,
    providerById,
    marginX,
    showDeskColumn: true,
    deskById
  });

  desks.forEach((desk) => {
    doc.addPage();
    drawFloorMapPage(doc, { desk, rooms, marginX });
  });

  return doc;
}

export function downloadAssignmentPdf(args) {
  const doc = generateAssignmentPdf(args);
  doc.save(`room-assignments-${args.date}.pdf`);
}

// ---------- Shared drawing helpers ----------

function drawProviderSummaryPage(doc, { title, date, assignments, roomById, deskById, providerById = {}, marginX, showDeskColumn }) {
  let cursorY = 56;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(title, marginX, cursorY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(date, marginX, cursorY + 16);
  cursorY += 40;

  const colX = showDeskColumn
    ? { name: marginX, desk: marginX + 150, session: marginX + 250, room1: marginX + 310, room2: marginX + 420 }
    : { name: marginX, session: marginX + 220, room1: marginX + 300, room2: marginX + 420 };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Provider', colX.name, cursorY);
  if (showDeskColumn) doc.text('Desk', colX.desk, cursorY);
  doc.text('Session', colX.session, cursorY);
  doc.text('Room 1', colX.room1, cursorY);
  doc.text('Room 2', colX.room2, cursorY);
  cursorY += 8;
  doc.line(marginX, cursorY, 564, cursorY);
  cursorY += 16;
  doc.setFont('helvetica', 'normal');

  for (const a of assignments) {
    if (cursorY > 740) {
      doc.addPage();
      cursorY = 56;
    }
    doc.text(exportDisplayName(providerById[a.providerId], a.providerName), colX.name, cursorY);
    if (showDeskColumn) doc.text(deskById[a.homeDeskId]?.name || '—', colX.desk, cursorY);
    doc.text(a.session, colX.session, cursorY);

    const slot1 = a.roomSlots[0];
    const slot2 = a.roomSlots[1];
    doc.text(formatSlot(slot1, roomById), colX.room1, cursorY);
    if (slot2) doc.text(formatSlot(slot2, roomById), colX.room2, cursorY);

    cursorY += 18;
  }

  if (assignments.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.text('No providers scheduled at this desk yet.', marginX, cursorY);
    doc.setFont('helvetica', 'normal');
  }
}

function formatSlot(slot, roomById) {
  if (!slot) return '—';
  if (!slot.roomId) return 'Not Found';
  const code = roomById[slot.roomId]?.code || slot.roomId;
  return slot.isOverflow ? `${code}*` : code;
}

// ---------- Per-desk room grid (current default export page) ----------
// Same hall/row/side floor-plan layout as drawFloorMapPage below, but each
// exam room's cell shows today's assigned provider (if any) instead of just
// a blank/video-capable marker, so the page is always the full room list —
// never a bare "no providers scheduled" line.

/** A room -> what to print in its two cells (room number, label/marker), given who (if anyone) is in it today. A room shared AM/PM by two different providers prints BOTH, as "LastName (AM)/LastName (PM)" — see buildRoomOccupancy/sharedOccupantLabel. */
function resolveOccupiedCell(room, occupancy) {
  if (!room) return { code: '', label: '' };
  if (room.kind === 'office' || room.kind === 'utility') {
    // Permanent spaces aren't part of the daily assignment pool — always
    // their fixed label, same as the static floor map.
    return { code: room.code || '', label: room.label || '' };
  }
  const occ = occupancy.get(room.id);
  if (occ) {
    if (occ.AM && occ.PM) {
      return { code: room.code || '', label: `${sharedOccupantLabel(occ.AM)} (AM)/${sharedOccupantLabel(occ.PM)} (PM)` };
    }
    const solo = occ.FULL || occ.AM || occ.PM;
    if (solo) return { code: room.code || '', label: occupantCellLabel(solo) };
  }
  // Nobody in it today: fall back to the same static marker the floor map
  // uses ("V" for video-capable, blank otherwise) rather than leaving it
  // ambiguous whether the room was skipped or genuinely empty.
  return { code: room.code || '', label: room.videoCapable ? 'V' : '' };
}

/** Same drawing as drawHallTable, but cells come from resolveOccupiedCell so today's assignments show through. */
function drawOccupiedHallTable(doc, { hall, hallRooms, occupancy, x, y, width }) {
  const byRow = new Map();
  let maxRow = 0;
  for (const r of hallRooms) {
    const rowNum = r.row || 0;
    maxRow = Math.max(maxRow, rowNum);
    if (!byRow.has(rowNum)) byRow.set(rowNum, {});
    byRow.get(rowNum)[r.side === 'right' ? 'right' : 'left'] = r;
  }

  const numW = width * 0.12;
  const labelW = width * 0.38;
  const colX = [x, x + numW, x + numW + labelW, x + numW + labelW + numW];
  const rowH = 26;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...NAVY);
  doc.text(hall, x + width / 2, y, { align: 'center' });

  let cursorY = y + 14;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.75);

  for (let rowNum = 1; rowNum <= maxRow; rowNum++) {
    const pair = byRow.get(rowNum) || {};
    const left = resolveOccupiedCell(pair.left, occupancy);
    const right = resolveOccupiedCell(pair.right, occupancy);

    doc.rect(colX[0], cursorY, numW, rowH);
    doc.rect(colX[1], cursorY, labelW, rowH);
    doc.rect(colX[2], cursorY, numW, rowH);
    doc.rect(colX[3], cursorY, labelW, rowH);

    doc.setTextColor(...TEXT);
    const textY = cursorY + rowH / 2 + 3;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(left.code, colX[0] + 4, textY);
    doc.text(right.code, colX[2] + 4, textY);

    const labelMaxWidth = labelW - 8;
    if (left.label) {
      fitLabelFont(doc, left.label, labelMaxWidth, 8);
      doc.text(left.label, colX[1] + 4, textY);
    }
    if (right.label) {
      fitLabelFont(doc, right.label, labelMaxWidth, 8);
      doc.text(right.label, colX[3] + 4, textY);
    }

    cursorY += rowH;
  }

  return cursorY;
}

/** Plain one-column fallback for a desk with no hall/row/side configured — every room still prints, occupied or not. */
function drawSimpleOccupiedRoomList(doc, { deskRooms, occupancy, marginX, cursorY }) {
  let y = cursorY;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  doc.text('Room', marginX, y);
  doc.text('Assigned to', marginX + 100, y);
  y += 8;
  doc.setDrawColor(0, 0, 0);
  doc.line(marginX, y, PAGE_RIGHT, y);
  y += 16;
  doc.setFont('helvetica', 'normal');

  const sorted = [...deskRooms].sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
  for (const room of sorted) {
    if (y > 740) {
      doc.addPage();
      y = 56;
    }
    const occ = occupancy.get(room.id);
    let value;
    if (occ && occ.AM && occ.PM) {
      value = `${sharedOccupantLabel(occ.AM)} (AM)/${sharedOccupantLabel(occ.PM)} (PM)`;
    } else if (occ && (occ.FULL || occ.AM || occ.PM)) {
      value = occupantCellLabel(occ.FULL || occ.AM || occ.PM);
    } else if (room.kind === 'office' || room.kind === 'utility') {
      value = room.label || '—';
    } else {
      const tags = [room.hasWindow ? 'window' : null, room.videoCapable ? 'video-capable' : null].filter(Boolean);
      value = tags.join(', ') || 'Empty';
    }
    doc.text(room.code || '—', marginX, y);
    doc.text(value, marginX + 100, y);
    y += 18;
  }
  return y;
}

function drawRoomGridPage(doc, { desk, date, deskRooms, occupancy, deskAssignments, providerById, marginX }) {
  const { order: halls, byHall } = groupRoomsByHall(deskRooms);

  let cursorY = 56;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...NAVY);
  doc.text(`Mayo 19 - ${desk.title || desk.name} Desk`, (marginX + PAGE_RIGHT) / 2, cursorY, { align: 'center' });
  cursorY += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...TEXT);
  doc.text(date, (marginX + PAGE_RIGHT) / 2, cursorY, { align: 'center' });
  cursorY += 26;

  if (halls.length === 0) {
    cursorY = drawSimpleOccupiedRoomList(doc, { deskRooms, occupancy, marginX, cursorY });
  } else {
    const contentWidth = PAGE_RIGHT - marginX;
    const gap = 24;

    if (halls.length === 2) {
      const hallWidth = (contentWidth - gap) / 2;
      const bottom1 = drawOccupiedHallTable(doc, { hall: halls[0], hallRooms: byHall.get(halls[0]), occupancy, x: marginX, y: cursorY, width: hallWidth });
      const bottom2 = drawOccupiedHallTable(doc, { hall: halls[1], hallRooms: byHall.get(halls[1]), occupancy, x: marginX + hallWidth + gap, y: cursorY, width: hallWidth });
      cursorY = Math.max(bottom1, bottom2);
    } else {
      for (const hallName of halls) {
        if (cursorY > 700) {
          doc.addPage();
          cursorY = 56;
        }
        cursorY = drawOccupiedHallTable(doc, { hall: hallName, hallRooms: byHall.get(hallName), occupancy, x: marginX, y: cursorY, width: contentWidth }) + 24;
      }
    }
  }

  // Never-drop-a-provider guarantee: anyone from this desk who didn't get
  // every room slot they needed today still shows up here, even though the
  // grid above only has room for who's actually IN a room.
  const notPlaced = deskAssignments.filter((a) => (a.roomSlots || []).some((slot) => !slot.roomId));
  if (notPlaced.length > 0) {
    cursorY += 12;
    if (cursorY > 700) {
      doc.addPage();
      cursorY = 56;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...TEXT);
    doc.text('Not assigned a room today:', marginX, cursorY);
    cursorY += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    for (const a of notPlaced) {
      if (cursorY > 740) {
        doc.addPage();
        cursorY = 56;
      }
      const name = exportDisplayName(providerById?.[a.providerId], a.providerName);
      doc.text(`• ${name} (${a.session})`, marginX, cursorY);
      cursorY += 14;
    }
  }
}

// ---------- Static floor-map page (page 2 of each desk's export) ----------
// Matches the real "Mayo 19 - East A Desk" sample: a title, then each hall
// as its own bordered 4-column table (room#, label, room#, label) — two
// halls print side by side, three or more stack vertically. See the big
// comment at the top of this file for what does/doesn't change daily.

/** Groups a desk's rooms by `hall`, preserving first-appearance order. Rooms with no `hall` are skipped (caller falls back to the plain list). */
function groupRoomsByHall(deskRooms) {
  const order = [];
  const byHall = new Map();
  for (const r of deskRooms) {
    if (!r.hall) continue;
    if (!byHall.has(r.hall)) {
      byHall.set(r.hall, []);
      order.push(r.hall);
    }
    byHall.get(r.hall).push(r);
  }
  return { order, byHall };
}

/** A room -> what to print in its two cells (room number, label/marker). */
function resolveCell(room) {
  if (!room) return { code: '', label: '' };
  if (room.kind === 'office' || room.kind === 'utility') {
    return { code: room.code || '', label: room.label || '' };
  }
  // Plain exam/pool room: "V" for video-capable, blank otherwise — this is
  // the meaning confirmed against the real sample, not "vacant".
  return { code: room.code || '', label: room.videoCapable ? 'V' : '' };
}

/** Sets the largest font size (down to a floor) at which `text` fits on one line within `maxWidth`, so long labels (e.g. a shared office) shrink instead of overlapping the next cell. */
function fitLabelFont(doc, text, maxWidth, baseSize) {
  const MIN_SIZE = 5.5;
  let size = baseSize;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  while (size > MIN_SIZE && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    doc.setFontSize(size);
  }
}

/** Draws one hall's paired room table at (x, y) within the given width; returns the Y position just below it. */
function drawHallTable(doc, { hall, hallRooms, x, y, width }) {
  const byRow = new Map();
  let maxRow = 0;
  for (const r of hallRooms) {
    const rowNum = r.row || 0;
    maxRow = Math.max(maxRow, rowNum);
    if (!byRow.has(rowNum)) byRow.set(rowNum, {});
    byRow.get(rowNum)[r.side === 'right' ? 'right' : 'left'] = r;
  }

  const numW = width * 0.12;
  const labelW = width * 0.38;
  const colX = [x, x + numW, x + numW + labelW, x + numW + labelW + numW];
  const rowH = 26;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...NAVY);
  doc.text(hall, x + width / 2, y, { align: 'center' });

  let cursorY = y + 14;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.75);

  for (let rowNum = 1; rowNum <= maxRow; rowNum++) {
    const pair = byRow.get(rowNum) || {};
    const left = resolveCell(pair.left);
    const right = resolveCell(pair.right);

    doc.rect(colX[0], cursorY, numW, rowH);
    doc.rect(colX[1], cursorY, labelW, rowH);
    doc.rect(colX[2], cursorY, numW, rowH);
    doc.rect(colX[3], cursorY, labelW, rowH);

    doc.setTextColor(...TEXT);
    const textY = cursorY + rowH / 2 + 3;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(left.code, colX[0] + 4, textY);
    doc.text(right.code, colX[2] + 4, textY);

    // Labels shrink to fit on one line rather than wrapping — a wrapped
    // 2nd line risks overlapping the row below at this row height, and a
    // shared office ("Dr. Cramer / Dr. Hanna Office") is the main case
    // long enough to need it.
    const labelMaxWidth = labelW - 8;
    if (left.label) {
      fitLabelFont(doc, left.label, labelMaxWidth, 8);
      doc.text(left.label, colX[1] + 4, textY);
    }
    if (right.label) {
      fitLabelFont(doc, right.label, labelMaxWidth, 8);
      doc.text(right.label, colX[3] + 4, textY);
    }

    cursorY += rowH;
  }

  return cursorY;
}

/** Plain one-column fallback for a desk with no hall/row/side configured on any of its rooms yet. */
function drawSimpleRoomList(doc, { deskRooms, marginX, cursorY }) {
  let y = cursorY;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  doc.text('Room', marginX, y);
  doc.text('Notes', marginX + 100, y);
  y += 8;
  doc.setDrawColor(0, 0, 0);
  doc.line(marginX, y, PAGE_RIGHT, y);
  y += 16;
  doc.setFont('helvetica', 'normal');

  const sorted = [...deskRooms].sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
  for (const room of sorted) {
    if (y > 740) {
      doc.addPage();
      y = 56;
    }
    const tags = [room.hasWindow ? 'window' : null, room.videoCapable ? 'video-capable' : null].filter(Boolean);
    doc.text(room.code || '—', marginX, y);
    doc.text(tags.join(', ') || '—', marginX + 100, y);
    y += 18;
  }
}

function drawFloorMapPage(doc, { desk, rooms, marginX }) {
  const deskRooms = rooms.filter((r) => r.deskId === desk.id);
  const { order: halls, byHall } = groupRoomsByHall(deskRooms);

  let cursorY = 60;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...NAVY);
  doc.text(`Mayo 19 - ${desk.title || desk.name} Desk`, (marginX + PAGE_RIGHT) / 2, cursorY, { align: 'center' });
  cursorY += 34;

  if (halls.length === 0) {
    drawSimpleRoomList(doc, { deskRooms, marginX, cursorY });
    return;
  }

  const contentWidth = PAGE_RIGHT - marginX;
  const gap = 24;

  if (halls.length === 2) {
    const hallWidth = (contentWidth - gap) / 2;
    drawHallTable(doc, { hall: halls[0], hallRooms: byHall.get(halls[0]), x: marginX, y: cursorY, width: hallWidth });
    drawHallTable(doc, { hall: halls[1], hallRooms: byHall.get(halls[1]), x: marginX + hallWidth + gap, y: cursorY, width: hallWidth });
  } else {
    for (const hallName of halls) {
      if (cursorY > 700) {
        doc.addPage();
        cursorY = 56;
      }
      cursorY = drawHallTable(doc, { hall: hallName, hallRooms: byHall.get(hallName), x: marginX, y: cursorY, width: contentWidth }) + 24;
    }
  }
}
