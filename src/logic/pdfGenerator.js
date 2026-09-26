/**
 * Generates the output PDF.
 *
 * Exports are per-desk (see downloadDeskAssignmentPdf), one PDF per desk:
 *  - Page 1: that desk's provider rows for TODAY — one row per provider
 *    whose home desk is this one, room slot columns, "Not Found" where a
 *    room couldn't be assigned. This is what guarantees no provider
 *    disappears from the report, per the never-drop-provider requirement.
 *    This page changes every day, driven by the day's imported schedule.
 *  - Page 2: the desk's STATIC floor map — room numbers grouped into halls,
 *    each showing either a permanent office's name, a utility space's
 *    label (Hallway, Restroom, etc), or "V" for a video-capable pool room
 *    (blank for a plain pool room). This page is intentionally the SAME
 *    every time, regardless of the day's assignments — it's a floor-plan
 *    reference, not a daily report (confirmed with the real sample export
 *    and the person's own description of how it's used). It's built from
 *    each room's `hall`/`row`/`side`/`kind`/`label` fields (see
 *    src/data/seed.js's Desk A rooms for a fully worked example matching
 *    the real "Mayo 19 - East A Desk" sample). A desk with no `hall` set
 *    on any of its rooms (Desk B / Desk West, until configured) falls back
 *    to a simple one-column room list instead.
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

export function generateDeskAssignmentPdf({ desk, date, rooms, assignments }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const marginX = 48;
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));

  const deskAssignments = assignments.filter((a) => a.homeDeskId === desk.id);

  drawProviderSummaryPage(doc, {
    title: `${desk.name} — Provider Assignment Report`,
    date,
    assignments: deskAssignments,
    roomById,
    marginX,
    showDeskColumn: false
  });

  doc.addPage();
  drawFloorMapPage(doc, { desk, rooms, marginX });

  return doc;
}

export function downloadDeskAssignmentPdf({ desk, date, rooms, assignments }) {
  const doc = generateDeskAssignmentPdf({ desk, date, rooms, assignments });
  const fileName = `${deskNameForFilename(desk.name)}_${formatDateForFilename(date)}.pdf`;
  doc.save(fileName);
}

// ---------- Combined all-desks export (kept for reference; unused by the UI) ----------

export function generateAssignmentPdf({ date, desks, rooms, assignments }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const marginX = 48;
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));

  drawProviderSummaryPage(doc, {
    title: 'Provider Assignment Report',
    date,
    assignments,
    roomById,
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

function drawProviderSummaryPage(doc, { title, date, assignments, roomById, deskById, marginX, showDeskColumn }) {
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
    doc.text(a.providerName, colX.name, cursorY);
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
