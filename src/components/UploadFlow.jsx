import React, { useEffect, useRef, useState } from 'react';
import { parseDeskScheduleFileAuto } from '../logic/pdfParser.js';

/**
 * Each desk gets its own independent file input + Submit button — there is
 * no shared/global submit step. Submitting a desk parses only that desk's
 * file and reports just that desk's rows AND the date printed on the
 * schedule itself up to the parent via onDeskSubmit(deskId, rows,
 * scheduleDate); the parent merges it into whatever the other desks have
 * already submitted. Every desk's button stays usable at all times, so a
 * desk can be re-uploaded and re-submitted on its own (e.g. a corrected
 * PDF) without touching the other two desks' data.
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
  // Progress bar shown above "Submit All": null until the first Submit
  // (desk or Submit All) is clicked. Once shown, it does NOT auto-hide when
  // processing finishes — it settles into a done/error state and stays on
  // screen as a record that a submit happened, until the page is reloaded
  // (there's nothing to persist across a refresh; it's plain component state).
  const [progress, setProgress] = useState(null); // { status: 'processing'|'done'|'error', label: string, pct: number } | null
  const rampRef = useRef(null);

  // Used only by a single desk's own Submit (handleSubmitDesk) — that flow
  // has just one real event to report (the parse finishing), so there's
  // nothing to stage it against. It climbs toward 90% in slowing steps
  // while the parse is actually running, then jumps straight to 100% the
  // moment it really finishes — never claiming "done" early. "Submit All"
  // (handleSubmitAll below) no longer uses this at all: it has real,
  // individually-awaited steps to report (each desk's import, then each
  // step the parent finishes), so every percentage there comes from an
  // actual completed unit of work instead.
  const startProgress = (label) => {
    if (rampRef.current) clearInterval(rampRef.current);
    setProgress({ status: 'processing', label, pct: 0 });
    rampRef.current = setInterval(() => {
      setProgress((prev) => {
        if (!prev || prev.status !== 'processing') return prev;
        const remaining = 90 - prev.pct;
        const next = Math.min(90, prev.pct + Math.max(1, Math.round(remaining * 0.18)));
        return { ...prev, pct: next };
      });
    }, 140);
  };

  const finishProgress = (status, label) => {
    if (rampRef.current) {
      clearInterval(rampRef.current);
      rampRef.current = null;
    }
    setProgress((prev) => ({ status, label, pct: status === 'error' ? (prev ? prev.pct : 0) : 100 }));
  };

  useEffect(() => () => {
    if (rampRef.current) clearInterval(rampRef.current);
  }, []);

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
    // scheduleDate is the date actually printed on the schedule itself
    // (e.g. "19 Desk A - 10/28/2026"), not today's date — the export uses
    // it instead of assuming the upload happened on the day it's for.
    const { rows, scheduleDate } = await parseDeskScheduleFileAuto(file, desk.id);
    if (rows.length === 0) {
      throw new Error('No rows were extracted from that PDF, even after trying OCR. Its layout may not match what this parser expects — check the header/column names and icon column line up with pdfParser.js / pdfOcrParser.js.');
    }
    return { rows, scheduleDate };
  };

  const handleSubmitDesk = async (desk) => {
    const file = pendingFiles[desk.id];
    if (!file) return;
    setErrorsByDesk((prev) => ({ ...prev, [desk.id]: null }));
    setSubmittingDeskId(desk.id);
    startProgress(`Processing ${desk.name}…`);
    try {
      const { rows, scheduleDate } = await parseDeskFile(desk, file);
      setSubmittedByDesk((prev) => ({ ...prev, [desk.id]: { fileName: file.name, rowCount: rows.length, scheduleDate } }));
      onDeskSubmit(desk.id, rows, scheduleDate);
      finishProgress('done', `${desk.name} submitted`);
    } catch (err) {
      setErrorsByDesk((prev) => ({ ...prev, [desk.id]: `Couldn't read that PDF: ${err.message}` }));
      finishProgress('error', `${desk.name} failed to submit`);
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
    // No simulated ramp for this flow at all — every percentage below comes
    // from an actual finished step, so the bar never claims progress it
    // hasn't made:
    //   0-90%, in real 20%-per-desk jumps, as each desk's file is actually
    //   imported (Stage 1, below) — then real jumps reported back by the
    //   parent (Stage 2) as it actually finishes assigning rooms and then
    //   generating each desk's PDF, capped at 90% until truly done — then a
    //   final jump straight to 100% only once everything has genuinely
    //   completed.
    if (rampRef.current) {
      clearInterval(rampRef.current);
      rampRef.current = null;
    }
    setProgress({ status: 'processing', label: 'Importing desk files…', pct: 0 });
    try {
      // Stage 1 — parse every desk's file before reporting anything up (a
      // combined, cross-desk report only makes sense once every desk's data
      // is available together, so one bad file aborts the whole batch
      // rather than submitting a partial set), but each desk's own parse
      // still earns its own real, individually-awaited 20% jump the moment
      // IT resolves, even though they're all running concurrently.
      let completedDesks = 0;
      const rowsByDeskEntries = await Promise.all(
        desks.map(async (desk) => {
          const result = await parseDeskFile(desk, pendingFiles[desk.id]);
          completedDesks += 1;
          const pct = Math.min(90, completedDesks * 20);
          setProgress((prev) =>
            prev && prev.status === 'processing'
              ? { ...prev, pct: Math.max(prev.pct, pct), label: `Imported ${completedDesks} of ${desks.length} desk files…` }
              : prev
          );
          return [desk, result];
        })
      );
      const rowsByDeskForAll = {};
      const scheduleDatesByDesk = {};
      const nextSubmitted = {};
      for (const [desk, { rows, scheduleDate }] of rowsByDeskEntries) {
        rowsByDeskForAll[desk.id] = rows;
        scheduleDatesByDesk[desk.id] = scheduleDate;
        nextSubmitted[desk.id] = { fileName: pendingFiles[desk.id].name, rowCount: rows.length, scheduleDate };
      }
      setSubmittedByDesk((prev) => ({ ...prev, ...nextSubmitted }));

      // Stage 2 — room assignment + per-desk PDF generation, reported back
      // by the parent as each real step of that work actually completes.
      await onSubmitAll(rowsByDeskForAll, scheduleDatesByDesk, (pct, label) => {
        setProgress((prev) =>
          prev && prev.status === 'processing' ? { ...prev, pct: Math.max(prev.pct, Math.min(90, pct)), label } : prev
        );
      });
      finishProgress('done', 'All desks submitted');
    } catch (err) {
      setAllError(`Couldn't process all three files: ${err.message}`);
      finishProgress('error', 'Submit All failed');
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
                  {submitted.scheduleDate
                    ? ` — schedule date: ${submitted.scheduleDate}`
                    : ' — no date found on the schedule itself; the export will fall back to today’s date'}
                </span>
              )}
              {errorsByDesk[desk.id] && <p className="upload-error">{errorsByDesk[desk.id]}</p>}
            </div>
          );
        })}
      </div>

      {progress && (
        <div className={`upload-progress upload-progress-${progress.status}`} role="status">
          <span className="upload-progress-text">{progress.label}</span>
          <div className="upload-progress-row">
            <div className="upload-progress-track">
              <div className="upload-progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
            <span className="upload-progress-pct">
              {progress.status === 'error' ? 'Failed' : `${progress.pct}%`}
            </span>
          </div>
        </div>
      )}

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
