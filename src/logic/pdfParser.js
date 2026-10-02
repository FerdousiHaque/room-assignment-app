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
  // Same idea for a dedicated telephone-visit indicator column.
  phoneFlag: ['phone visit', 'telephone visit', 'is phone', 'phone?', 'tel visit'],
  // Otherwise fall back to a descriptive visit-type/modality column and
  // read its value.
  visitType: ['visit type', 'appointment type', 'appt type', 'modality']
};

const VIDEO_VALUE_KEYWORDS = ['video', 'virtual', 'telehealth', 'telemedicine', 'e-visit', 'evisit'];
const TELEPHONE_VALUE_KEYWORDS = ['phone', 'telephone', 'tel visit', 'call'];
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

// Telephone visits are ignored entirely — same rule pdfOcrParser.js already
// applies via its blue-icon classification ("telephone visits are skipped
// entirely, never even added to `rows`"). This is the text-layer parser's
// equivalent for a PDF that has a phone-visit indicator or visit-type
// column instead of an icon: such a row is dropped before it's ever
// matched to a provider, counted, or aggregated in any way.
function looksLikePhoneVisit(record) {
  if (record.phoneFlag !== undefined) {
    const v = record.phoneFlag.trim().toLowerCase();
    return TRUTHY_FLAG_VALUES.includes(v) || TELEPHONE_VALUE_KEYWORDS.some((kw) => v.includes(kw));
  }
  if (record.visitType !== undefined) {
    const v = record.visitType.toLowerCase();
    return TELEPHONE_VALUE_KEYWORDS.some((kw) => v.includes(kw));
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

/**
 * "10/28/2026" or "10/28/26" -> "2026-10-28" (ISO), or null if `text` isn't
 * shaped like a US-format date. Shared by both parsers (this file's own
 * text-layer reader, and pdfOcrParser.js's OCR reader) to pull the actual
 * schedule date — e.g. "19 Desk A - 10/28/2026" — off the page itself,
 * rather than assuming the file is always for today.
 */
export function parseUsDateToIso(text) {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  let [, mo, da, yr] = m.map((s, i) => (i === 0 ? s : parseInt(s, 10)));
  if (yr < 100) yr += 2000;
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

async function extractLines(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  let scheduleDate = null;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const byY = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      // The page's own header ("19 Desk A - 10/28/2026") carries the
      // schedule's real date — only checked on page 1, and only until
      // found, so a date-shaped patient MRN or similar further down the
      // page can't ever override it.
      if (pageNum === 1 && !scheduleDate) {
        const iso = parseUsDateToIso(item.str.trim());
        if (iso) scheduleDate = iso;
      }
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

  return { lines, scheduleDate };
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
 * @returns {Promise<{ rows: Array, scheduleDate: string|null }>} rows like { deskId, time, provider, patient, ...anyOtherColumns }, plus the date printed on the schedule itself (ISO, or null if none was found on page 1)
 */
export async function parseDeskScheduleFile(file, deskId) {
  const { lines, scheduleDate } = await extractLines(file);
  const records = linesToRecords(lines);
  return { rows: records.map((r) => ({ deskId, ...r })), scheduleDate };
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
 *
 * @returns {Promise<{ rows: Array, scheduleDate: string|null }>}
 */
export async function parseDeskScheduleFileAuto(file, deskId) {
  const textResult = await parseDeskScheduleFile(file, deskId);
  if (textResult.rows.length > 0) return textResult;

  let ocrModule;
  try {
    ocrModule = await import('./pdfOcrParser.js');
  } catch (err) {
    // Every deploy replaces the whole build, including every hashed chunk
    // filename. A tab that was already open from before the latest deploy
    // still has the OLD filename baked into its in-memory bundle, and that
    // file no longer exists on the server — Firebase Hosting's catch-all
    // rewrite then serves index.html instead of a 404, which shows up here
    // as "Failed to fetch dynamically imported module" / a MIME-type error,
    // not as anything about the PDF itself. A one-time reload picks up the
    // current build and its correct filenames; guard with sessionStorage so
    // a genuinely broken deploy can't reload-loop forever.
    if (!window.sessionStorage.getItem('reloaded-for-stale-build')) {
      window.sessionStorage.setItem('reloaded-for-stale-build', '1');
      window.location.reload();
      return new Promise(() => {}); // navigating away; never resolve
    }
    throw new Error('This page is running an out-of-date version of the site. Please refresh your browser and try again.');
  }

  // A successful dynamic import means the current build is fine — clear the
  // guard so a *future* deploy's stale-chunk error can still auto-heal once
  // rather than jumping straight to the manual-refresh message.
  window.sessionStorage.removeItem('reloaded-for-stale-build');

  const { parseDeskScheduleFileOcr } = ocrModule;
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
 *
 * Real Epic exports commonly go further than plain "Last, First" —
 * e.g. "Mueller, Theodore L, R.N." or "Titan, Silvia M, M.D., Ph.D." — with
 * a middle initial tacked onto the first-name part and one or more
 * credentials (R.N., APRN, M.D., Ph.D., M.B.B.S., ...) as further
 * comma-separated segments after that. Providers are entered here by
 * first/last name only (see ProviderManager.jsx), so both the middle
 * initial and every credential segment are dropped for matching purposes:
 * only the first two comma segments (last name, first name) are used, and
 * a trailing single-letter "word" on the first-name segment (the middle
 * initial) is stripped.
 */
export function normalizeName(raw) {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[0] || '';
    // parts[1] is "First[, Middle initial]"; parts[2+] (if any) are
    // credentials and are ignored entirely — never part of the match key.
    const first = (parts[1] || '').replace(/\s+[A-Za-z]\.?$/, '');
    return `${first} ${last}`.toLowerCase().trim();
  }
  return cleaned.toLowerCase();
}

// A row's patient identifier, whatever the PDF's own MRN-ish column was
// actually named — classifyHeader keeps an unrecognized header's own
// literal text as the field name (e.g. a column literally titled "MRN"
// lands on row.mrn), and real exports use a few different spellings for
// the same thing, so check a short list of likely field names rather than
// assuming exactly "mrn". Returns '' (never dedup-worthy) if none matched
// or the row genuinely lacks one — a missing MRN must never be treated as
// equal to another missing MRN.
const MRN_FIELD_CANDIDATES = ['mrn', 'patientmrn', 'patientid', 'mrnnumber', 'mrn#'];
function rowMrn(row) {
  for (const field of MRN_FIELD_CANDIDATES) {
    const v = row[field];
    if (v && String(v).trim()) return String(v).trim().toLowerCase();
  }
  return '';
}

/**
 * Aggregates raw parsed rows (across all three uploaded desk files) into
 * one dayEntries array, matching each row's provider name against the
 * providers list. Rows with no matching provider are returned separately
 * as `unmatched` so the UI can surface them for a manual fix rather than
 * silently dropping patients.
 *
 * Duplicate-visit filtering: a same-provider row whose MRN was already
 * seen for that provider is a duplicate of an earlier visit (e.g. the
 * schedule accidentally lists the same appointment twice) and is skipped
 * entirely here — before patientCount, session, or the video-visit flag
 * are ever computed — so a duplicate can never inflate a patient count,
 * shift AM/PM/FULL session detection, or otherwise affect room assignment.
 * A row with no readable MRN at all is never treated as a duplicate of
 * anything (there's nothing to compare), so it's always counted.
 *
 * Telephone visits are dropped entirely (see looksLikePhoneVisit) — never
 * matched, counted, or aggregated at all, same as pdfOcrParser.js's
 * icon-based handling of phone visits.
 *
 * `inPersonPatientCount` (in-person only, excluding video — telephone
 * never even reaches here) is tracked alongside the overall `patientCount`
 * (which still includes video visits) — the engine uses the in-person-only
 * count for desk-selection "load" ordering, and for deciding whether a
 * provider with an office on the floor needs a room at all today.
 * `soloTime` carries the one raw imported Time value for a provider with
 * exactly one patient that day, for display next to their name on a
 * full-day solo assignment (see pdfGenerator.js).
 */
export function deriveDayEntries(rows, providers) {
  const byName = new Map(
    providers.map((p) => [normalizeName(`${p.lastName}, ${p.firstName}`), p])
  );

  const grouped = new Map(); // providerId -> { patientCount, inPersonPatientCount, inPersonAmCount, inPersonPmCount, times: [], hasVideoVisit, seenMrns: Set }
  const unmatched = [];

  for (const row of rows) {
    if (looksLikePhoneVisit(row)) continue; // ignored entirely, matching pdfOcrParser.js
    const key = normalizeName(row.provider);
    const provider = byName.get(key);
    if (!provider) {
      unmatched.push(row);
      continue;
    }
    if (!grouped.has(provider.id)) {
      grouped.set(provider.id, {
        patientCount: 0,
        inPersonPatientCount: 0,
        // Per-half-day in-person counts — used by assignmentEngine.js's
        // 2-rooms-down-to-1 reduction (a provider with at most 1 in-person
        // visit in EACH half separately doesn't need a second room that
        // day, even if they're also seeing a video/telephone patient in
        // the other half, or have a second in-person visit on the OTHER
        // side of noon). A row with no readable time can't be bucketed, so
        // it's simply not counted in either half (counted only in the
        // overall inPersonPatientCount above).
        inPersonAmCount: 0,
        inPersonPmCount: 0,
        times: [],
        hasVideoVisit: false,
        seenMrns: new Set()
      });
    }
    const g = grouped.get(provider.id);
    const mrn = rowMrn(row);
    if (mrn) {
      if (g.seenMrns.has(mrn)) continue; // duplicate visit for this provider — ignore entirely
      g.seenMrns.add(mrn);
    }
    const isVideo = looksLikeVideoVisit(row);
    g.patientCount += 1;
    if (!isVideo) {
      g.inPersonPatientCount += 1;
      const minutes = row.time ? parseClockTime(row.time) : null;
      if (minutes !== null) {
        if (minutes < NOON) g.inPersonAmCount += 1;
        else g.inPersonPmCount += 1;
      }
    }
    if (row.time) g.times.push(row.time);
    if (isVideo) g.hasVideoVisit = true;
  }

  const dayEntries = [...grouped.entries()].map(([providerId, g]) => ({
    providerId,
    isWorking: true,
    patientCount: g.patientCount,
    inPersonPatientCount: g.inPersonPatientCount,
    inPersonAmCount: g.inPersonAmCount,
    inPersonPmCount: g.inPersonPmCount,
    soloTime: g.patientCount === 1 ? g.times[0] || null : null,
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
  const grouped = new Map(); // "deskId||name" -> { deskId, name, patientCount, inPersonPatientCount, times, seenMrns }

  for (const row of unmatchedRows) {
    // Trim FIRST, then fall back — a whitespace-only provider field (e.g.
    // OCR read something unusable) is truthy, so `row.provider || '...'`
    // alone would keep the blank string and the room would show no name at
    // all instead of falling back. See rule: an unmatched name must still
    // be shown, never blank, even though it isn't in the Providers list.
    // (Phone-visit rows never reach here at all — deriveDayEntries drops
    // them before a row is ever added to `unmatched`.)
    const name = (row.provider || '').trim() || 'Unknown provider';
    const key = `${row.deskId}||${normalizeName(name)}`;
    if (!grouped.has(key)) {
      grouped.set(key, { deskId: row.deskId, name, patientCount: 0, inPersonPatientCount: 0, times: [], seenMrns: new Set() });
    }
    const g = grouped.get(key);
    // Same duplicate-visit filtering as deriveDayEntries above — an
    // unmatched name's duplicate MRN visit shouldn't inflate its patient
    // count either.
    const mrn = rowMrn(row);
    if (mrn) {
      if (g.seenMrns.has(mrn)) continue;
      g.seenMrns.add(mrn);
    }
    g.patientCount += 1;
    if (!looksLikeVideoVisit(row)) g.inPersonPatientCount += 1;
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
      inPersonPatientCount: g.inPersonPatientCount,
      soloTime: g.patientCount === 1 ? g.times[0] || null : null,
      session: deriveSession(g.times)
    });
  }

  return { pseudoProviders, pseudoDayEntries };
}
