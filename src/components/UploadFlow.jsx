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
 */
export default function UploadFlow({ desks, onDeskSubmit }) {
  const [pendingFiles, setPendingFiles] = useState({}); // deskId -> File
  const [submittedByDesk, setSubmittedByDesk] = useState({}); // deskId -> { fileName, rowCount }
  const [errorsByDesk, setErrorsByDesk] = useState({}); // deskId -> string
  const [submittingDeskId, setSubmittingDeskId] = useState(null);

  const handleFileChange = (deskId, file) => {
    setPendingFiles((prev) => ({ ...prev, [deskId]: file }));
    setErrorsByDesk((prev) => ({ ...prev, [deskId]: null }));
  };

  const handleSubmitDesk = async (desk) => {
    const file = pendingFiles[desk.id];
    if (!file) return;
    setErrorsByDesk((prev) => ({ ...prev, [desk.id]: null }));
    setSubmittingDeskId(desk.id);
    try {
      // Tries the fast text-layer read first, and automatically falls back
      // to OCR + icon classification if the PDF has no text layer at all
      // (real Epic "Print to PDF" exports are like this) \u2014 see
      // pdfParser.js's parseDeskScheduleFileAuto. The OCR path is slower
      // (rendering + OCR-ing every page), so this can take a while longer
      // for those files; the button already shows "Processing\u2026" either way.
      const rows = await parseDeskScheduleFileAuto(file, desk.id);
      if (rows.length === 0) {
        setErrorsByDesk((prev) => ({
          ...prev,
          [desk.id]: 'No rows were extracted from that PDF, even after trying OCR. Its layout may not match what this parser expects \u2014 check the header/column names and icon column line up with pdfParser.js / pdfOcrParser.js.'
        }));
        return;
      }
      setSubmittedByDesk((prev) => ({ ...prev, [desk.id]: { fileName: file.name, rowCount: rows.length } }));
      onDeskSubmit(desk.id, rows);
    } catch (err) {
      setErrorsByDesk((prev) => ({ ...prev, [desk.id]: `Couldn't read that PDF: ${err.message}` }));
    } finally {
      setSubmittingDeskId(null);
    }
  };

  return (
    <section className="upload-flow">
      <h2>Upload desk schedules</h2>
      <p className="upload-hint">
        Each desk submits independently — column order doesn't matter, and re-submitting a desk
        (e.g. a corrected file) only updates that desk's data.
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
                  disabled={!pendingFiles[desk.id] || isProcessing}
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
    </section>
  );
}
