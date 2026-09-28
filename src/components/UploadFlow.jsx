import React, { useState } from 'react';
import { parseDeskScheduleFileAuto } from '../logic/pdfParser.js';

/**
 * Each desk gets its own independent file input + Submit button — there is
 * no shared/global submit step. Submitting a desk parses only that desk's
 * file and reports just that desk's rows up to the parent via
 * onDeskSubmit(deskId, rows); the parent merges it into whatever the other
 * desks have already submitted. Every desk's button stays usable at all
 * times, so a desk can be re-uploaded and re-submitted on its own (e.g. a
 * corrected PDF) without touching the other two desks' data.
 *
 * A single desk's own Submit/Download never considers another desk's rooms
 * (see App.jsx's buildDeskOnlyReport) — only "Submit All" below does, since
 * it's the only path with every desk's file in hand at once, so it's the
 * only one that can work out real cross-desk overflow correctly.
 */
export default function UploadFlow({ desks, onDeskSubmit, onSubmitAll }) {
  const [pendingFiles, setPendingFiles] = useState({}); // deskId -> File
  const [submittedByDesk, setSubmittedByDesk] = useState({}); // deskId -> { fileName, rowCount }
  const [errorsByDesk, setErrorsByDesk] = useState({}); // deskId -> string
  const [submittingDeskId, setSubmittingDeskId] = useState(null); // a single desk id, or 'all'
  const [allError, setAllError] = useState(null);

  const handleFileChange = (deskId, file) => {
    setPendingFiles((prev) => ({ ...prev, [deskId]: file }));
    setErrorsByDesk((prev) => ({ ...prev, [deskId]: null }));
    setAllError(null);
  };

  const parseDeskFile = async (desk, file) => {
    // Tries the fast text-layer read first, and automatically falls back
    // to OCR + icon classification if the PDF has no text layer at all
    // (real Epic "Print to PDF" exports are like this) — see
    // pdfParser.js's parseDeskScheduleFileAuto. The OCR path is slower
    // (rendering + OCR-ing every page), so this can take a while longer
    // for those files; the button already shows "Processing…" either way.
    const rows = await parseDeskScheduleFileAuto(file, desk.id);
    if (rows.length === 0) {
      throw new Error('No rows were extracted from that PDF, even after trying OCR. Its layout may not match what this parser expects — check the header/column names and icon column line up with pdfParser.js / pdfOcrParser.js.');
    }
    return rows;
  };

  const handleSubmitDesk = async (desk) => {
    const file = pendingFiles[desk.id];
    if (!file) return;
    setErrorsByDesk((prev) => ({ ...prev, [desk.id]: null }));
    setSubmittingDeskId(desk.id);
    try {
      const rows = await parseDeskFile(desk, file);
      setSubmittedByDesk((prev) => ({ ...prev, [desk.id]: { fileName: file.name, rowCount: rows.length } }));
      onDeskSubmit(desk.id, rows);
    } catch (err) {
      setErrorsByDesk((prev) => ({ ...prev, [desk.id]: `Couldn't read that PDF: ${err.message}` }));
    } finally {
      setSubmittingDeskId(null);
    }
  };

  const allFilesReady = desks.every((d) => pendingFiles[d.id]);

  const handleSubmitAll = async () => {
    if (!allFilesReady) return;
    setAllError(null);
    setErrorsByDesk({});
    setSubmittingDeskId('all');
    try {
      // Parse every desk's file before reporting anything up — a combined,
      // cross-desk report (the whole point of "Submit All") only makes
      // sense if every desk's data is actually available together, so one
      // bad file aborts the whole batch rather than submitting a partial set.
      const rowsByDeskEntries = await Promise.all(
        desks.map(async (desk) => [desk, await parseDeskFile(desk, pendingFiles[desk.id])])
      );
      const rowsByDeskForAll = {};
      const nextSubmitted = {};
      for (const [desk, rows] of rowsByDeskEntries) {
        rowsByDeskForAll[desk.id] = rows;
        nextSubmitted[desk.id] = { fileName: pendingFiles[desk.id].name, rowCount: rows.length };
      }
      setSubmittedByDesk((prev) => ({ ...prev, ...nextSubmitted }));
      onSubmitAll(rowsByDeskForAll);
    } catch (err) {
      setAllError(`Couldn't process all three files: ${err.message}`);
    } finally {
      setSubmittingDeskId(null);
    }
  };

  const isProcessingAll = submittingDeskId === 'all';

  return (
    <section className="upload-flow">
      <h2>Upload desk schedules</h2>
      <p className="upload-hint">
        Each desk submits independently — column order doesn't matter, and re-submitting a desk
        (e.g. a corrected file) only updates that desk's data. A desk's own Submit/Download only
        ever uses that desk's own rooms and file — it never sends anyone to another desk.
      </p>

      <div className="upload-desk-rows">
        {desks.map((desk) => {
          const submitted = submittedByDesk[desk.id];
          const isProcessing = submittingDeskId === desk.id;
          return (
            <div key={desk.id} className={`upload-desk-row ${submitted ? 'done' : ''}`}>
              <div className="upload-desk-row-main">
                <span className="upload-desk-name">{desk.name}</span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => handleFileChange(desk.id, e.target.files?.[0] || null)}
                />
                <button
                  type="button"
                  className="submit-button"
                  onClick={() => handleSubmitDesk(desk)}
                  disabled={!pendingFiles[desk.id] || isProcessing || isProcessingAll}
                >
                  {isProcessing ? 'Processing…' : submitted ? 'Re-submit' : 'Submit'}
                </button>
              </div>
              {submitted && (
                <span className="upload-file">
                  Loaded {submitted.fileName} ({submitted.rowCount} rows)
                </span>
              )}
              {errorsByDesk[desk.id] && <p className="upload-error">{errorsByDesk[desk.id]}</p>}
            </div>
          );
        })}
      </div>

      <div className="upload-submit-all-row">
        <button
          type="button"
          className="submit-button submit-all-button"
          onClick={handleSubmitAll}
          disabled={!allFilesReady || isProcessingAll || submittingDeskId !== null}
        >
          {isProcessingAll ? 'Processing all…' : 'Submit All'}
        </button>
        <span className="upload-hint">
          Choose a file for all three desks first, then Submit All processes them together and
          downloads all three desks' PDFs at once — the only way overflow to an alternate desk
          gets calculated correctly, since it needs every desk's data at the same time.
        </span>
        {allError && <p className="upload-error">{allError}</p>}
      </div>
    </section>
  );
}
