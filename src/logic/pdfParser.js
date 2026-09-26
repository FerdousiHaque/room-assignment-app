/**
 * PDF schedule parser
 * ------------------------------------------------------------------
 * Reads an uploaded desk schedule PDF and returns raw row records,
 * keyed by whatever the PDF's own column headers were (column ORDER
 * doesn't matter — we match headers by keyword, not position).
 *
 * Assumes a text-based PDF (selectable text), laid out as a table with
 * a header row. It clusters text items by their y-position into lines,
 * then buckets each line's items into columns using the header row's
 * x-positions. This works for PDFs exported from Excel/EHR/scheduling
 * systems; it will NOT work on scanned/image PDFs (those need OCR,
 * which isn't wired up here — if parsing comes back empty, that's the
 * most likely reason, and worth confirming with a sample file).
 * ------------------------------------------------------------------
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Keyword groups used to map a PDF's actual header text to our canonical
// field names. Add synonyms here if a real export uses different wording.
const HEADER_SYNONYMS = {
  time: ['time', 'visit time', 'appt time', 'appointment time', 'slot'],
  provider: ['provider', 'provider name', 'doctor', 'physician', 'clinician'],
  patient: ['patient', 'patient name', 'pt name', 'pt'],
  // A dedicated yes/no-style indicator column, if the report has one —
  // checked first since it's the more reliable signal (requirement: "if
  // the imported report format already contains a specific indicator,
  // use it").
  videoFlag: ['video visit', 'virtual visit', 'is video', 'video?', 'telehealth flag', 'televisit'],
  // Otherwise fall back to a descriptive visit-type/modality column and
  // read its value.
  visitType: ['visit type', 'appointment type', 'appt type', 'modality']
};

const VIDEO_VALUE_KEYWORDS = ['video', 'virtual', 'telehealth', 'telemedicine', 'e-visit', 'evisit'];
const TRUTHY_FLAG_VALUES = ['y', 'yes', 'true', '1', 'x'];

function looksLikeVideoVisit(record) {
  if (record.videoFlag !== undefined) {
    const v = record.videoFlag.trim().toLowerCase();
    return TRUTHY_FLAG_VALUES.includes(v) || VIDEO_VALUE_KEYWORDS.some((kw) => v.includes(kw));
  }
  if (record.visitType !== undefined) {
    const v = record.visitType.toLowerCase();
    return VIDEO_VALUE_KEYWORDS.some((kw) => v.includes(kw));
  }
  return false;
}

function classifyHeader(headerText) {
  const norm = headerText.toLowerCase().trim();
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    if (synonyms.some((s) => norm.includes(s))) return field;
  }
  return norm; // unknown column — kept under its own literal name, not discarded
}

async function extractLines(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const byY = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      // Merge items within a few px of each other vertically (handles
      // slight baseline jitter within what's visually the same row).
      const key = [...byY.keys()].find((existingY) => Math.abs(existingY - y) <= 3);
      const bucketKey = key !== undefined ? key : y;
      if (!byY.has(bucketKey)) byY.set(bucketKey, []);
      byY.get(bucketKey).push(item);
    }

    const sortedY = [...byY.keys()].sort((a, b) => b - a); // PDF y grows upward
    for (const y of sortedY) {
      const items = byY.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      lines.push(items);
    }
  }

  return lines;
}

function linesToRecords(lines) {
  if (lines.length === 0) return [];

  const headerLine = lines[0];
  const columns = headerLine.map((item) => ({
    field: classifyHeader(item.str),
    x: item.transform[4]
  }));

  const nearestColumn = (x) => {
    let best = columns[0];
    let bestDist = Infinity;
    for (const col of columns) {
      const dist = Math.abs(col.x - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = col;
      }
    }
    return best;
  };

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const record = {};
    for (const item of lines[i]) {
      const col = nearestColumn(item.transform[4]);
      record[col.field] = record[col.field] ? `${record[col.field]} ${item.str.trim()}` : item.str.trim();
    }
    if (Object.keys(record).length > 0) records.push(record);
  }
  return records;
}

/**
 * @param {File} file
 * @param {string} deskId  which desk this file's rows belong to
 * @returns {Promise<Array>} rows like { deskId, time, provider, patient, ...anyOtherColumns }
 */
export async function parseDeskScheduleFile(file, deskId) {
  const lines = await extractLines(file);
  const records = linesToRecords(lines);
  return records.map((r) => ({ deskId, ...r }));
}

/**
 * Tries the fast text-layer parser first; if that comes back with zero
 * rows (the signature of a rasterized/image PDF — e.g. real Epic "Print to
 * PDF" desk exports, which have no embedded text at all), automatically
 * falls back to the OCR + icon-classification parser in pdfOcrParser.js.
 * This is what UploadFlow.jsx actually calls — callers don't need to know
 * or care which underlying method actually read a given file.
 *
 * The OCR path is lazy-loaded (see pdfOcrParser.js's loadDeps) so its
 * dependencies (tesseract.js, pdfjs-dist) are only pulled in when a file
 * actually needs them.
 */
export async function parseDeskScheduleFileAuto(file, deskId) {
  const textRows = await parseDeskScheduleFile(file, deskId);
  if (textRows.length > 0) return textRows;

  const { parseDeskScheduleFileOcr } = await import('./pdfOcrParser.js');
  return parseDeskScheduleFileOcr(file, deskId);
}

// ---- Time / session helpers -------------------------------------------

/** "8:30 am" / "4:00 pm" / "16:00" -> minutes since midnight, or null if unparseable. */
export function parseClockTime(text) {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let [, h, min, ampm] = m;
  h = parseInt(h, 10);
  min = parseInt(min, 10);
  if (ampm) {
    ampm = ampm.toLowerCase();
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  }
  return h * 60 + min;
}

const NOON = 12 * 60;

/** Given all of a provider's visit times for one day, decide AM / PM / FULL. */
export function deriveSession(timeStrings) {
  const minutes = timeStrings.map(parseClockTime).filter((m) => m !== null);
  if (minutes.length === 0) return 'FULL'; // unknown times — safest is to assume worst case
  const hasAM = minutes.some((m) => m < NOON);
  const hasPM = minutes.some((m) => m >= NOON);
  if (hasAM && hasPM) return 'FULL';
  return hasAM ? 'AM' : 'PM';
}

/**
 * "LastName, FirstName" (or "FirstName LastName") -> normalized key for
 * matching against provider records, which store firstName/lastName
 * separately.
 */
export function normalizeName(raw) {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.includes(',')) {
    const [last, first] = cleaned.split(',').map((s) => s.trim());
    return `${first} ${last}`.toLowerCase();
  }
  return cleaned.toLowerCase();
}

/**
 * Aggregates raw parsed rows (across all three uploaded desk files) into
 * one dayEntries array, matching each row's provider name against the
 * providers list. Rows with no matching provider are returned separately
 * as `unmatched` so the UI can surface them for a manual fix rather than
 * silently dropping patients.
 */
export function deriveDayEntries(rows, providers) {
  const byName = new Map(
    providers.map((p) => [normalizeName(`${p.lastName}, ${p.firstName}`), p])
  );

  const grouped = new Map(); // providerId -> { patientCount, times: [], hasVideoVisit }
  const unmatched = [];

  for (const row of rows) {
    const key = normalizeName(row.provider);
    const provider = byName.get(key);
    if (!provider) {
      unmatched.push(row);
      continue;
    }
    if (!grouped.has(provider.id)) grouped.set(provider.id, { patientCount: 0, times: [], hasVideoVisit: false });
    const g = grouped.get(provider.id);
    g.patientCount += 1;
    if (row.time) g.times.push(row.time);
    if (looksLikeVideoVisit(row)) g.hasVideoVisit = true;
  }

  const dayEntries = [...grouped.entries()].map(([providerId, g]) => ({
    providerId,
    isWorking: true,
    patientCount: g.patientCount,
    session: deriveSession(g.times),
    hasVideoVisit: g.hasVideoVisit
  }));

  return { dayEntries, unmatched };
}

/**
 * Builds throwaway "pseudo provider" + day-entry records for rows whose
 * provider name didn't match anyone in the Providers list, so they can
 * still be run through the same assignment engine and silently fill
 * whatever room is open — no manual-review warning, no entry added to
 * the Providers list. If nothing is open for them, they're just dropped.
 *
 * They're eligible to overflow to ANY other desk (not just a configured
 * list) since there's no real provider record to read a preference from —
 * "any empty room" is the point.
 */
export function buildUnmatchedProviderEntries(unmatchedRows, desks) {
  const grouped = new Map(); // "deskId||name" -> { deskId, name, patientCount, times }

  for (const row of unmatchedRows) {
    const name = (row.provider || 'Unknown provider').trim();
    const key = `${row.deskId}||${normalizeName(name)}`;
    if (!grouped.has(key)) grouped.set(key, { deskId: row.deskId, name, patientCount: 0, times: [] });
    const g = grouped.get(key);
    g.patientCount += 1;
    if (row.time) g.times.push(row.time);
  }

  const pseudoProviders = [];
  const pseudoDayEntries = [];

  let i = 0;
  for (const g of grouped.values()) {
    const id = `unmatched-${i++}`;
    pseudoProviders.push({
      id,
      name: g.name,
      homeDeskId: g.deskId,
      preferredNumberOfRooms: 1,
      primaryPreferredRoomId: null,
      secondPreferredRoomId: null,
      windowPreference: 'none',
      alternateDeskIds: desks.map((d) => d.id).filter((id2) => id2 !== g.deskId),
      alternateRoomCodes: [],
      hasOfficeOnFloor: false,
      suppressWarnings: true
    });
    pseudoDayEntries.push({
      providerId: id,
      isWorking: true,
      patientCount: g.patientCount,
      session: deriveSession(g.times)
    });
  }

  return { pseudoProviders, pseudoDayEntries };
}
