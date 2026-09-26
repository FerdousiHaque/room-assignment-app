/**
 * OCR-based schedule parser — for real Epic "Print to PDF" desk exports.
 * ------------------------------------------------------------------
 * pdfParser.js's normal parser reads a PDF's embedded TEXT layer, which
 * works for exports from Excel/EHR systems that keep selectable text. The
 * three real Epic desk-schedule PDFs this was built against
 * (demo_desk_A.pdf, demo_desk_B.pdf, demo_desk_west.pdf) turned out to be
 * fully RASTERIZED — Producer: "Microsoft: Print To PDF", zero embedded
 * fonts, zero extractable text — so that parser reads zero rows from them.
 * This module is the fallback for exactly that case: render each page to
 * an image, OCR the text fields, and classify each row's visit-type icon
 * from its actual pixel colors/shape (OCR reads the icon glyphs themselves
 * as garbage text — inconsistent between runs — so icon type is NEVER
 * decided from OCR'd text, only from image analysis of the icon's crop).
 *
 * Row separation follows the user's own description of the layout: each
 * visit is separated by "a bar/straight line" — a thin horizontal gray
 * divider rule that spans most of the page width between visits. This
 * module detects those lines directly from pixel data and treats the
 * space between two consecutive lines as one visit's block.
 *
 * WHERE THE CONSTANTS BELOW COME FROM: rendering demo_desk_A.pdf's real
 * pages at 300-DPI-equivalent (RENDER_SCALE = 300/72) and sampling actual
 * pixel data (via Python + Tesseract during development — the underlying
 * OCR engine is the same one tesseract.js wraps, so results should closely
 * match) confirmed:
 *   - The header row has a combined "V"+"S" icon-column header word; the
 *     icon to classify is the LEFT half of that word's bounding box.
 *   - In-person (two-person) icon: green, tall (~35px), SOLID/filled
 *     silhouette (fill ratio ~0.45-0.65). Sometimes rendered two-tone
 *     (green + slate-blue) for a two-provider visit, which is still
 *     solidly filled, just with a lower average green/red gap — handled
 *     by the fill-ratio check, not color alone.
 *   - Telephone icon: BLUE, clearly more blue than green (avgB - avgG is
 *     large, ~65-100) — this is the most reliable single signal in the
 *     whole classifier.
 *   - Video/virtual icon: a muted, mostly-outline camera glyph — neither
 *     strongly green nor strongly blue, and visibly less "filled" than
 *     the in-person icon (fill ratio ~0.2-0.45, shorter height ~22-31px).
 *     It's the fallback case: not phone, not a solid green figure.
 * A stray adjacent icon (Epic shows a small note/flag glyph right next to
 * the visit icon on some rows) is why the icon crop is kept narrow — a
 * wider crop measurably mis-classified a real bicolor in-person row
 * during testing.
 *
 * HONESTY NOTE: this module was designed and its thresholds tuned against
 * real renders of the three sample PDFs using a Python/Tesseract
 * prototype (this sandbox has no browser, so tesseract.js + canvas
 * couldn't be executed end-to-end here). The algorithm is the same either
 * way — tesseract.js wraps the same OCR engine — but this specific file
 * needs a real run against real uploads (via `npm run dev`) before relying
 * on it. If accuracy is off, the constants below are the place to retune,
 * and passing `{ debug: true }` to parseDeskScheduleFileOcr logs each
 * detected block's classification to the console to help with that.
 */

const RENDER_SCALE = 300 / 72; // ~4.1667 — matches the resolution these thresholds were tuned at

const ICON_LEFT_PAD = -6;         // icon crop starts this many px before the "V/S" header word's left edge
const ICON_WIDTH_FRACTION = 0.5;  // icon crop takes this fraction of the combined "V"+"S" header word's width
const ICON_MIN_WIDTH = 40;        // floor, in case the header word's width comes back oddly small
const ICON_BAND_HEIGHT = 45;      // px tall, measured from the top of each visit block
const PHONE_BLUE_DIFF = 40;       // avgB - avgG above this => phone
const PERSON_GREEN_DIFF = 18;     // avgG - avgR above this (with enough fill) => in-person
const PERSON_MIN_FILL = 0.3;

const DIVIDER_X_MARGIN = 150;     // ignore this many px at each side when scanning for divider lines (skips outer page margins)
const DIVIDER_MIN_GRAY_FRACTION = 0.6;
const MIN_BLOCK_HEIGHT = 80;      // a candidate block shorter than this can't be a real visit row (skips stray thin bands)

/**
 * Loads tesseract.js and pdfjs-dist lazily — both are only needed when the
 * normal text-layer parser comes back empty, so keeping them out of the
 * main import graph avoids shipping the (fairly large) OCR/WASM bundle to
 * everyone who only ever imports text-based PDFs.
 */
async function loadDeps() {
  const [pdfjsLib, { createWorker }] = await Promise.all([
    import('pdfjs-dist'),
    import('tesseract.js')
  ]);
  const pdfWorkerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return { pdfjsLib, createWorker };
}

async function renderPageToCanvas(pdfjsLib, page) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx };
}

/** Finds the header's combined "V"/"S" icon-column word — tesseract usually reads it as a single "VS"-ish token near the top of the page. */
function findIconHeaderBox(words, pageHeight) {
  const headerCutoff = pageHeight * 0.15;
  const candidate = words.find(
    (w) => w.bbox.y0 < headerCutoff && /^v\s*s$/i.test(w.text.replace(/[^a-zA-Z]/g, ''))
  );
  if (candidate) return candidate.bbox;
  // Fallback: sometimes OCR splits "V" and "S" into separate single-letter
  // words instead of merging them — look for a lone "V" near the top.
  const loneV = words.find((w) => w.bbox.y0 < headerCutoff && w.text.trim().toUpperCase() === 'V');
  if (loneV) return { ...loneV.bbox, x1: loneV.bbox.x1 + (loneV.bbox.x1 - loneV.bbox.x0) };
  return null;
}

/** Locates the x-position of each named column header (case-insensitive substring match), for mapping the summary line's OCR words to fields. */
function findColumnHeaders(words, pageHeight, names) {
  const headerCutoff = pageHeight * 0.15;
  const headerWords = words.filter((w) => w.bbox.y0 < headerCutoff);
  const found = {};
  for (const name of names) {
    const match = headerWords.find((w) => w.text.toLowerCase().includes(name.toLowerCase()));
    if (match) found[name] = match.bbox.x0;
  }
  return found;
}

/** Scans the canvas for thin, near-full-width horizontal gray divider lines — the "bar/straight line" that separates each visit. Returns [[startY,endY], ...]. */
function detectDividerLines(ctx, width, height) {
  const x0 = DIVIDER_X_MARGIN;
  const x1 = Math.max(x0 + 1, width - DIVIDER_X_MARGIN);
  const span = x1 - x0;
  const { data } = ctx.getImageData(x0, 0, span, height);

  const grayFractionPerRow = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let grayCount = 0;
    const rowOffset = y * span * 4;
    for (let x = 0; x < span; x++) {
      const i = rowOffset + x * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 12 && max < 235 && max > 150) grayCount++;
    }
    grayFractionPerRow[y] = grayCount / span;
  }

  const lines = [];
  let start = null;
  for (let y = 0; y < height; y++) {
    const isLine = grayFractionPerRow[y] > DIVIDER_MIN_GRAY_FRACTION;
    if (isLine && start === null) {
      start = y;
    } else if (!isLine && start !== null) {
      lines.push([start, y - 1]);
      start = null;
    }
  }
  if (start !== null) lines.push([start, height - 1]);
  return lines;
}

/** Classifies one block's visit-type icon by cropping its known column position and analyzing pixel color/shape — never by reading it as text. */
function classifyIcon(ctx, blockTop, iconX0, iconWidth, canvasWidth, canvasHeight) {
  const x0 = Math.max(0, Math.round(iconX0 + ICON_LEFT_PAD));
  const w = Math.min(Math.max(iconWidth, ICON_MIN_WIDTH), canvasWidth - x0);
  const y0 = Math.max(0, blockTop);
  const h = Math.min(ICON_BAND_HEIGHT, canvasHeight - y0);
  if (w <= 0 || h <= 0) return null;

  const { data } = ctx.getImageData(x0, y0, w, h);
  let count = 0, sumR = 0, sumG = 0, sumB = 0;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 235 && g > 235 && b > 235) continue; // white background
      count++;
      sumR += r; sumG += g; sumB += b;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count < 10) return null; // nothing here — not a real visit block

  const avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
  const glyphW = maxX - minX + 1;
  const glyphH = maxY - minY + 1;
  const fill = count / (glyphW * glyphH);

  if (avgB - avgG > PHONE_BLUE_DIFF) return 'phone';
  if (avgG - avgR > PERSON_GREEN_DIFF && fill > PERSON_MIN_FILL) return 'in-person';
  return 'video';
}

/** Finds the "Provider:" label within a block's y-range and returns the text that follows it on the same line. */
function extractProviderName(words, blockTop, blockBottom) {
  const labelWord = words.find(
    (w) => w.bbox.y0 >= blockTop && w.bbox.y0 <= blockBottom && /^provider:?$/i.test(w.text)
  );
  if (!labelWord) return null;
  const lineY = labelWord.bbox.y0;
  const lineTolerance = 15;
  const lineWords = words
    .filter((w) => Math.abs(w.bbox.y0 - lineY) <= lineTolerance && w.bbox.x0 > labelWord.bbox.x1)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return lineWords.map((w) => w.text).join(' ').trim() || null;
}

/**
 * Locates the block's actual summary/status line by finding the TOPMOST
 * clock-time-shaped word anywhere in the block, and returns its y0.
 *
 * This can't just be "blockTop" — a block's boundaries come from divider
 * lines (or the page edge for the very first block on a page), and the
 * FIRST block on every page also contains the page header (desk name,
 * date, column titles) above the actual first visit, which can be 250+px
 * taller than the ~10-20px gap seen on every other block. Anchoring on
 * "blockTop + a small fixed offset" broke on exactly that block during
 * testing — the summary-line window landed on header text instead of the
 * visit's own row. A time-pattern anchor is unambiguous and appears on
 * every real visit row, so it's a more reliable anchor than raw position.
 * Returns null if no time pattern is found anywhere in the block, which
 * means it isn't a real visit row (header/footer content) — callers use
 * that to skip the block entirely.
 *
 * `minY` additionally floors the search below the page header band (the
 * desk name/date/"Last refresh: H:MM PM" line) — without it, the first
 * block on a page (which spans from the page's very top down to the first
 * divider, so it contains the header too) can anchor on "2:51 PM" from
 * "Last refresh: 2:51 PM" instead of the first real visit's own time,
 * since that text matches the same time-shaped pattern.
 */
function findSummaryLineTop(words, blockTop, blockBottom, minY = 0) {
  const searchTop = Math.max(blockTop, minY);
  const inBlock = words.filter((w) => w.bbox.y0 >= searchTop && w.bbox.y0 <= blockBottom);
  const timeWord = inBlock.find((w) => /^\d{1,2}:\d{2}(am|pm)?$/i.test(w.text));
  return timeWord ? timeWord.bbox.y0 : null;
}

/**
 * Finds the actual appointment clock time on the summary line, as its own
 * step rather than through the generic nearest-column bucketing below.
 * The report has TWO time-like columns ("Arrive By" and "Time"), and OCR
 * sometimes splits "9:00 AM" into two word tokens ("9:00", "AM") — generic
 * column bucketing pulled in unrelated text (the "Scheduled" status word,
 * icon glyph OCR garbage) often enough during testing that it broke
 * downstream AM/PM session detection, which needs a clean "H:MM am/pm"
 * string. This picks whichever time-pattern match sits closest to the
 * real "Time" header's x-position (falling back to the first match found
 * if that header wasn't detected), and re-attaches a trailing AM/PM token
 * if OCR split it off as a separate word.
 */
function extractApptTime(words, summaryTop, timeHeaderX) {
  const summaryWords = words
    .filter((w) => w.bbox.y0 >= summaryTop - 15 && w.bbox.y0 <= summaryTop + 25)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);

  const timeMatches = [];
  for (let i = 0; i < summaryWords.length; i++) {
    const w = summaryWords[i];
    const m = w.text.match(/^(\d{1,2}):(\d{2})(am|pm)?$/i);
    if (!m) continue;
    let text = w.text;
    if (!m[3]) {
      const next = summaryWords[i + 1];
      if (next && /^(am|pm)$/i.test(next.text)) text += next.text;
    }
    timeMatches.push({ text, x0: w.bbox.x0 });
  }
  if (timeMatches.length === 0) return '';
  if (timeHeaderX == null) return timeMatches[0].text;

  timeMatches.sort((a, b) => Math.abs(a.x0 - timeHeaderX) - Math.abs(b.x0 - timeHeaderX));
  return timeMatches[0].text;
}

/** Maps the summary line's OCR words (patient, MRN, visit type — whatever headers were found) into a row object using nearest-column matching, same idea as the text-based parser's column matching but driven by OCR word x-positions instead of PDF text-item x-positions. Time is handled separately by extractApptTime, above, since it needs cleaner isolation. */
function extractSummaryFields(words, summaryTop, columnHeaders) {
  const summaryWords = words
    .filter((w) => w.bbox.y0 >= summaryTop - 15 && w.bbox.y0 <= summaryTop + 25)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);

  const columnEntries = Object.entries(columnHeaders);
  if (columnEntries.length === 0 || summaryWords.length === 0) return {};

  const record = {};
  for (const w of summaryWords) {
    let best = columnEntries[0][0];
    let bestDist = Infinity;
    for (const [field, x] of columnEntries) {
      const dist = Math.abs(x - w.bbox.x0);
      if (dist < bestDist) {
        bestDist = dist;
        best = field;
      }
    }
    record[best] = record[best] ? `${record[best]} ${w.text}` : w.text;
  }
  return record;
}

/**
 * Parses one desk's rasterized schedule PDF via OCR + icon-image
 * classification. Telephone-visit rows are skipped entirely (never
 * returned), per the request this was built against.
 *
 * @param {File} file
 * @param {string} deskId
 * @param {{ debug?: boolean }} [opts] debug: true logs each detected block's classification to the console — useful when tuning against a new real export.
 * @returns {Promise<Array>} rows shaped like { deskId, time, provider, patient, mrn, videoFlag }, compatible with pdfParser.js's deriveDayEntries.
 */
export async function parseDeskScheduleFileOcr(file, deskId, opts = {}) {
  const { pdfjsLib, createWorker } = await loadDeps();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const worker = await createWorker('eng');
  const rows = [];

  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const { canvas, ctx } = await renderPageToCanvas(pdfjsLib, page);

      const { data: ocrData } = await worker.recognize(canvas);
      const words = (ocrData.words || []).filter((w) => w.text && w.text.trim());

      const iconHeaderBox = findIconHeaderBox(words, canvas.height);
      const columnHeaders = findColumnHeaders(words, canvas.height, ['Time', 'Patient', 'MRN', 'Visit Type']);

      if (!iconHeaderBox) {
        // Couldn't find the icon column header on this page at all — skip
        // it rather than guess at a pixel position that might be wrong for
        // a differently-laid-out export.
        continue;
      }
      const iconX0 = iconHeaderBox.x0;
      const iconWidth = (iconHeaderBox.x1 - iconHeaderBox.x0) * ICON_WIDTH_FRACTION;
      // The page's own title/date/"Last refresh: H:MM PM" line sits ABOVE
      // the column-header row (which is where the "V"/"S" icon header
      // lives) — everything real starts below it. "Last refresh: 2:51 PM"
      // matches the same time-shaped pattern findSummaryLineTop looks for,
      // so without this floor it can get mistaken for the first visit's
      // own time on the very first block of a page (that block spans from
      // the page's top edge down to the first divider, so it contains
      // both the page header AND the first real visit).
      const contentFloorY = iconHeaderBox.y1;

      const dividerLines = detectDividerLines(ctx, canvas.width, canvas.height);
      // Blocks are the gaps between consecutive divider lines (and from
      // the page top to the first line, and the last line to the bottom).
      const blocks = [];
      for (let i = 0; i < dividerLines.length + 1; i++) {
        const top = i === 0 ? 0 : dividerLines[i - 1][1] + 1;
        const bottom = i === dividerLines.length ? canvas.height : dividerLines[i][0] - 1;
        if (bottom - top >= MIN_BLOCK_HEIGHT) blocks.push([top, bottom]);
      }

      for (const [top, bottom] of blocks) {
        // Anchor everything on the block's own summary line (found via its
        // clock time), not the raw block boundary — see findSummaryLineTop
        // for why (the first block on a page also contains the page
        // header, which is not a fixed height).
        const summaryTop = findSummaryLineTop(words, top, bottom, contentFloorY);
        if (summaryTop == null) continue; // no time found => not a real visit row (header/footer)

        const icon = classifyIcon(ctx, summaryTop - 8, iconX0, iconWidth, canvas.width, canvas.height);
        if (!icon) continue; // no visit-type icon here after all — skip rather than guess
        if (opts.debug) {
          // eslint-disable-next-line no-console
          console.log(`[pdfOcrParser] page ${pageNum} block [${top},${bottom}] summaryTop=${summaryTop} -> ${icon}`);
        }
        if (icon === 'phone') continue; // telephone visits are ignored entirely, per request

        const provider = extractProviderName(words, top, bottom);
        const summary = extractSummaryFields(words, summaryTop, columnHeaders);
        const time = extractApptTime(words, summaryTop, columnHeaders.Time);

        rows.push({
          deskId,
          time,
          patient: summary.Patient || '',
          mrn: summary.MRN || '',
          provider: provider || '',
          videoFlag: icon === 'video' ? 'yes' : undefined
        });
      }
    }
  } finally {
    await worker.terminate();
  }

  return rows.filter((r) => r.provider); // a row with no readable provider name isn't usable
}
