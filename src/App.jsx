import React, { useEffect, useMemo, useState } from 'react';
import { desks as seedDesks, rooms as seedRooms, providers as seedProviders } from './data/seed.js';
import { generateDailyAssignments } from './logic/assignmentEngine.js';
import { deriveDayEntries, buildUnmatchedProviderEntries } from './logic/pdfParser.js';
import { downloadDeskAssignmentPdf } from './logic/pdfGenerator.js';
import DeskBoard from './components/DeskBoard.jsx';
import WarningList from './components/WarningList.jsx';
import UploadFlow from './components/UploadFlow.jsx';
import ProviderManager from './components/ProviderManager.jsx';
import RoomManager from './components/RoomManager.jsx';
import ProviderSummaryTable from './components/ProviderSummaryTable.jsx';
import {
  subscribeProviders,
  subscribeRooms,
  subscribeDayRows,
  saveProviders,
  saveRooms,
  saveDayRows,
  deleteDayRows
} from './data/firestoreSync.js';

// Room blocking is disabled for now (per request), but NOT deleted — the
// component, the engine's block-checking logic, and RoomBlockManager.jsx
// all still exist. To bring it back: uncomment this import, the 'blocks'
// tab button below, the tab's render branch, and pass a real editable
// roomBlocks array (instead of the hardcoded []) into generateDailyAssignments.
// import RoomBlockManager from './components/RoomBlockManager.jsx';

// Providers, rooms, and each day's uploaded schedule rows are backed by
// Firestore (src/data/firestoreSync.js) — every browser looking at this
// app sees the same live data. On first load ever, Firestore is seeded
// from src/data/seed.js; after that, seed.js is only a fallback shown
// instantly while the first Firestore snapshot is still loading.
// Desks stay static from seed.js — there's no UI for editing them.

// No date picker is shown (see request to remove it). `date` below still
// drives where uploads are stored in Firestore (today's date) and is the
// fallback used on export when a schedule's own date couldn't be read —
// but each desk's actual EXPORT uses the date printed on that desk's own
// uploaded PDF instead, via scheduleDatesByDesk (see handleDeskSubmit /
// handleSubmitAll / handleDownloadDesk below), so a schedule uploaded a day
// late (or early) still exports under the day it's actually for.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> the previous calendar day, same format. */
function previousDayIso(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const [tab, setTab] = useState('assign'); // 'assign' | 'providers' | 'rooms'
  const [providers, setProvidersLocal] = useState(seedProviders);
  const [rooms, setRoomsLocal] = useState(seedRooms);
  const date = useMemo(() => todayIso(), []);

  // Each desk submits independently (see UploadFlow) — this holds whatever
  // rows that desk's most recent submission produced. A desk with no
  // submission yet simply isn't a key here. Re-submitting a desk replaces
  // only its own entry, and every other desk's data is untouched.
  // Synced through Firestore under today's date, so all three desks (and
  // anyone else with this app open) see the same combined upload state
  // live, without each browser needing its own re-upload.
  const [rowsByDesk, setRowsByDeskLocal] = useState({});
  const [firestoreStatus, setFirestoreStatus] = useState('connecting'); // 'connecting' | 'ok' | 'error'
  // deskId -> the date actually printed on that desk's most recently
  // submitted schedule PDF (ISO 'YYYY-MM-DD'), read off the page itself by
  // pdfParser.js/pdfOcrParser.js — e.g. "19 Desk A - 10/28/2026". This is
  // NOT the same as `date` below (which only drives where uploads are
  // stored in Firestore and stays "today"): this is what gets printed on,
  // and used to name, that desk's exported PDF, so the export reflects the
  // day the schedule is actually for rather than the day it was uploaded.
  // A desk with no successfully-detected date (or not submitted yet) has no
  // entry here, and its export falls back to `date`.
  const [scheduleDatesByDesk, setScheduleDatesByDesk] = useState({});

  useEffect(() => {
    const unsubProviders = subscribeProviders(seedProviders, (list) => {
      setProvidersLocal(list);
      setFirestoreStatus('ok');
    });
    const unsubRooms = subscribeRooms(seedRooms, (list) => setRoomsLocal(list));
    const unsubDay = subscribeDayRows(date, (rows) => setRowsByDeskLocal(rows));

    // An imported schedule is only ever for the day it was uploaded — once
    // a new day starts, yesterday's uploaded rows are wiped outright rather
    // than just left unread, so nothing from a prior day can ever be saved
    // over into, or re-surface on, today. Best-effort: this doc is already
    // scoped to its own date, so a failure here just leaves an old, unused
    // doc sitting in the database rather than causing any visible problem.
    deleteDayRows(previousDayIso(date)).catch((err) => {
      console.warn(`Could not clear yesterday's uploaded rows (non-fatal):`, err);
    });

    return () => {
      unsubProviders();
      unsubRooms();
      unsubDay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Wrappers so every existing call site (ProviderManager/RoomManager's
  // onChange, handleDeskSubmit below) keeps its original "just call this
  // with the next array" signature — the Firestore write happens here,
  // and the onSnapshot listener above feeds the confirmed value back in.
  const setProviders = (next) => {
    setProvidersLocal(next);
    saveProviders(next).catch((err) => {
      console.error('Failed to save providers to Firestore:', err);
      setFirestoreStatus('error');
    });
  };
  const setRooms = (next) => {
    setRoomsLocal(next);
    saveRooms(next).catch((err) => {
      console.error('Failed to save rooms to Firestore:', err);
      setFirestoreStatus('error');
    });
  };

  const desks = seedDesks;
  const hasAnySubmission = Object.keys(rowsByDesk).length > 0;

  const combinedRows = useMemo(() => Object.values(rowsByDesk).flat(), [rowsByDesk]);

  // Recomputed live from whatever has been submitted so far — submitting
  // just one desk is enough to see that desk's assignments; submitting a
  // second desk adds to the same report rather than starting over.
  const { dayEntries, effectiveProviders, unmatchedNames } = useMemo(() => {
    if (combinedRows.length === 0) return { dayEntries: null, effectiveProviders: providers, unmatchedNames: [] };
    const { dayEntries: matchedEntries, unmatched } = deriveDayEntries(combinedRows, providers);
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatched, desks);
    return {
      dayEntries: [...matchedEntries, ...pseudoDayEntries],
      effectiveProviders: [...providers, ...pseudoProviders],
      // Distinct raw names from the uploaded file that didn't match anyone
      // on the Providers tab — surfaced as a warning below so an empty-
      // looking report is traceable to a name mismatch instead of looking
      // like a silent bug. These rows still get placed on-screen (as
      // unlabeled fill-ins), just never in the Provider assignment report
      // or the exported PDF.
      unmatchedNames: [...new Set(unmatched.map((r) => (r.provider || '').trim()).filter(Boolean))]
    };
  }, [combinedRows, providers, desks]);

  // generateDailyAssignments also returns a `logs` narration array, but the
  // UI no longer surfaces it (the Logs box was removed per feedback) — it's
  // simply left unused here rather than pulled into a variable.
  const { assignments, warnings: engineWarnings } = useMemo(() => {
    if (!dayEntries) return { assignments: [], warnings: [], logs: [] };
    // roomBlocks is hardcoded to [] while the room-blocking feature is
    // disabled (see the commented-out import above) — the engine still
    // accepts and checks a roomBlocks array, it's just never populated.
    return generateDailyAssignments({ desks, rooms, providers: effectiveProviders, dayEntries, roomBlocks: [], date });
  }, [dayEntries, effectiveProviders, rooms, date]);

  const warnings = useMemo(() => {
    if (unmatchedNames.length === 0) return engineWarnings;
    return [
      `${unmatchedNames.length} name(s) from the uploaded schedule didn't match anyone on the Providers tab, so they're filling rooms on screen but are left OUT of the Provider assignment report and the exported PDF: ${unmatchedNames.join(', ')}. Add them as providers (spelled exactly as in the PDF) if they should be included.`,
      ...engineWarnings
    ];
  }, [unmatchedNames, engineWarnings]);

  // Real (non-pseudo) provider assignments only — this is what the
  // never-drop-provider report shows. Pseudo/unmatched-name entries are
  // excluded per the earlier "silent drop" requirement.
  const realAssignments = useMemo(
    () => assignments.filter((a) => !a.providerId.startsWith('unmatched-')),
    [assignments]
  );

  const handleDeskSubmit = (deskId, rows, scheduleDate) => {
    const next = { ...rowsByDesk, [deskId]: rows };
    setRowsByDeskLocal(next);
    if (scheduleDate) {
      setScheduleDatesByDesk((prev) => ({ ...prev, [deskId]: scheduleDate }));
    }
    saveDayRows(date, next).catch((err) => {
      console.error('Failed to save uploaded rows to Firestore:', err);
      setFirestoreStatus('error');
    });
  };

  // Runs the assignment engine scoped to ONE desk only — just that desk's
  // own rooms, and only the rows from that desk's own submitted file
  // (never another desk's rows). Passing a single-desk `desks` array to the
  // engine means a provider's alternateDeskIds can never resolve to a real
  // desk, so overflow is naturally impossible here — an unfilled slot comes
  // back "Not Found" instead of being sent to another desk. This is what
  // the per-desk Submit/Download flow uses; "Submit All" (below) is the
  // only path that considers alternate desks, since it's the only one with
  // every desk's data in hand at once.
  const buildDeskOnlyReport = (desk, deskRows) => {
    const deskOnlyRooms = rooms.filter((r) => r.deskId === desk.id);
    const { dayEntries: matchedEntries, unmatched } = deriveDayEntries(deskRows, providers);
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatched, [desk]);
    const { assignments: deskAssignments } = generateDailyAssignments({
      desks: [desk],
      rooms: deskOnlyRooms,
      providers: [...providers, ...pseudoProviders],
      dayEntries: [...matchedEntries, ...pseudoDayEntries],
      roomBlocks: [],
      date
    });
    return {
      rooms: deskOnlyRooms,
      assignments: deskAssignments.filter((a) => !a.providerId.startsWith('unmatched-'))
    };
  };

  const handleDownloadDesk = (desk) => {
    const { rooms: deskOnlyRooms, assignments: deskOnlyAssignments } = buildDeskOnlyReport(desk, rowsByDesk[desk.id] || []);
    // Prefer the date actually printed on this desk's uploaded schedule over
    // today's date, so the export (both its filename and the date printed
    // inside it) reflects the day the schedule is for, not the day it
    // happened to be uploaded. Falls back to today only if no date could be
    // read off the PDF at all (or nothing's been submitted for this desk).
    const exportDate = scheduleDatesByDesk[desk.id] || date;
    downloadDeskAssignmentPdf({ desk, date: exportDate, rooms: deskOnlyRooms, assignments: deskOnlyAssignments, providers });
  };

  // "Submit All": parses and saves all three desks' files in one shot, then
  // immediately generates and downloads all three desks' PDFs from that
  // SAME combined data — computed directly here rather than waiting for the
  // next render's useMemo, so the files reflect exactly what was just
  // submitted. Because every desk's rows are known at once, this is the one
  // path where a provider's alternateDeskIds are actually honored, so
  // overflow across desks comes out right (see handleDownloadDesk above for
  // why the plain per-desk Submit/Download never does this).
  const handleSubmitAll = (rowsByDeskForAll, scheduleDatesForAll) => {
    const next = { ...rowsByDesk, ...rowsByDeskForAll };
    setRowsByDeskLocal(next);
    if (scheduleDatesForAll) {
      setScheduleDatesByDesk((prev) => ({ ...prev, ...scheduleDatesForAll }));
    }
    saveDayRows(date, next).catch((err) => {
      console.error('Failed to save uploaded rows to Firestore:', err);
      setFirestoreStatus('error');
    });

    const combined = Object.values(next).flat();
    const { dayEntries: matchedEntries, unmatched } = deriveDayEntries(combined, providers);
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatched, desks);
    const { assignments: allAssignments } = generateDailyAssignments({
      desks,
      rooms,
      providers: [...providers, ...pseudoProviders],
      dayEntries: [...matchedEntries, ...pseudoDayEntries],
      roomBlocks: [],
      date
    });
    const realAll = allAssignments.filter((a) => !a.providerId.startsWith('unmatched-'));

    for (const desk of desks) {
      // Each desk's own export uses the date read off ITS OWN uploaded
      // schedule (just submitted, via scheduleDatesForAll — not yet reduced
      // into state at this point in the function, so read from the param
      // directly) rather than today's date. Falls back to whatever was
      // previously known for this desk, then today, if this file had no
      // readable date at all.
      const exportDate = (scheduleDatesForAll && scheduleDatesForAll[desk.id]) || scheduleDatesByDesk[desk.id] || date;
      downloadDeskAssignmentPdf({ desk, date: exportDate, rooms, assignments: realAll, providers });
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Room Assignments</h1>
        {firestoreStatus === 'error' && (
          <p className="firestore-status firestore-status-error">
            Couldn't save the last change to the shared database — it's only on this screen right now. Check your connection and try again.
          </p>
        )}
        <nav className="tabs">
          <button className={tab === 'assign' ? 'active' : ''} onClick={() => setTab('assign')}>Assign rooms</button>
          <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>Providers</button>
          <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>Rooms</button>
          {/* Room blocks tab intentionally removed — see the commented-out import above. */}
        </nav>
      </header>

      {tab === 'providers' && (
        <ProviderManager providers={providers} desks={desks} rooms={rooms} onChange={setProviders} />
      )}

      {tab === 'rooms' && (
        <RoomManager rooms={rooms} desks={desks} onChange={setRooms} />
      )}

      {/* {tab === 'blocks' && (
        <RoomBlockManager roomBlocks={roomBlocks} rooms={rooms} desks={desks} onChange={setRoomBlocks} />
      )} */}

      {tab === 'assign' && (
        <>
          <UploadFlow desks={desks} onDeskSubmit={handleDeskSubmit} onSubmitAll={handleSubmitAll} />

          {warnings.length > 0 && <WarningList warnings={warnings} />}

          {hasAnySubmission && (
            <>
              <ProviderSummaryTable assignments={realAssignments} rooms={rooms} desks={desks} />

              <div className="desk-grid">
                {desks.map((desk) => (
                  <DeskBoard
                    key={desk.id}
                    desk={desk}
                    // Live in-app board only shows the assignable exam-room
                    // pool — office/utility rooms are never part of daily
                    // occupancy, they only appear on the static floor-map
                    // PDF export (see pdfGenerator.js).
                    rooms={rooms.filter((r) => r.deskId === desk.id && (!r.kind || r.kind === 'exam'))}
                    assignments={assignments}
                    onDownload={() => handleDownloadDesk(desk)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
