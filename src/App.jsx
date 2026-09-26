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
  saveDayRows
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

// No date picker is shown (see request to remove it) — exports are named
// from today's date automatically. If a future version derives the date
// from the imported schedule itself, this is the place to swap it in.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

  useEffect(() => {
    const unsubProviders = subscribeProviders(seedProviders, (list) => {
      setProvidersLocal(list);
      setFirestoreStatus('ok');
    });
    const unsubRooms = subscribeRooms(seedRooms, (list) => setRoomsLocal(list));
    const unsubDay = subscribeDayRows(date, (rows) => setRowsByDeskLocal(rows));
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
  const { dayEntries, effectiveProviders } = useMemo(() => {
    if (combinedRows.length === 0) return { dayEntries: null, effectiveProviders: providers };
    const { dayEntries: matchedEntries, unmatched } = deriveDayEntries(combinedRows, providers);
    const { pseudoProviders, pseudoDayEntries } = buildUnmatchedProviderEntries(unmatched, desks);
    return {
      dayEntries: [...matchedEntries, ...pseudoDayEntries],
      effectiveProviders: [...providers, ...pseudoProviders]
    };
  }, [combinedRows, providers, desks]);

  const { assignments, warnings } = useMemo(() => {
    if (!dayEntries) return { assignments: [], warnings: [] };
    // roomBlocks is hardcoded to [] while the room-blocking feature is
    // disabled (see the commented-out import above) — the engine still
    // accepts and checks a roomBlocks array, it's just never populated.
    return generateDailyAssignments({ desks, rooms, providers: effectiveProviders, dayEntries, roomBlocks: [], date });
  }, [dayEntries, effectiveProviders, rooms, date]);

  // Real (non-pseudo) provider assignments only — this is what the
  // never-drop-provider report shows. Pseudo/unmatched-name entries are
  // excluded per the earlier "silent drop" requirement.
  const realAssignments = useMemo(
    () => assignments.filter((a) => !a.providerId.startsWith('unmatched-')),
    [assignments]
  );

  const handleDeskSubmit = (deskId, rows) => {
    const next = { ...rowsByDesk, [deskId]: rows };
    setRowsByDeskLocal(next);
    saveDayRows(date, next).catch((err) => {
      console.error('Failed to save uploaded rows to Firestore:', err);
      setFirestoreStatus('error');
    });
  };

  const handleDownloadDesk = (desk) => {
    downloadDeskAssignmentPdf({ desk, date, rooms, assignments: realAssignments });
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
          <UploadFlow desks={desks} onDeskSubmit={handleDeskSubmit} />

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
