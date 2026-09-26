import React from 'react';

// Flattens assignments (which are provider-centric, with a roomSlots array)
// into per-room occupancy for this desk, ignoring "Not Found" (null) slots —
// those are surfaced separately in ProviderSummaryTable, not on the room grid.
function buildOccupancy(desk, assignments) {
  const byRoom = {}; // roomId -> { am: slotInfo|null, pm: slotInfo|null }
  for (const a of assignments) {
    for (const slot of a.roomSlots) {
      if (!slot.roomId || slot.deskId !== desk.id) continue;
      if (!byRoom[slot.roomId]) byRoom[slot.roomId] = { am: null, pm: null };
      const info = { providerName: a.providerName, isOverflow: slot.isOverflow, session: a.session };
      if (a.session === 'FULL') {
        byRoom[slot.roomId].am = info;
        byRoom[slot.roomId].pm = info;
      } else if (a.session === 'AM') {
        byRoom[slot.roomId].am = info;
      } else {
        byRoom[slot.roomId].pm = info;
      }
    }
  }
  return byRoom;
}

export default function DeskBoard({ desk, rooms, assignments, blockedRoomIds = {}, onDownload }) {
  const occupancy = buildOccupancy(desk, assignments);
  const usedCount = Object.keys(occupancy).length;
  const sortedRooms = [...rooms].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return (
    <section className="desk-board">
      <div className="desk-board-head">
        <h2>{desk.name}</h2>
        <span className="desk-capacity">{usedCount} / {rooms.length} rooms</span>
      </div>

      <ul className="room-list">
        {sortedRooms.map((room) => {
          const occ = occupancy[room.id] || { am: null, pm: null };
          const blocked = blockedRoomIds[room.id];
          const isFullDay = occ.am && occ.pm && occ.am.session === 'FULL';

          return (
            <li key={room.id} className={`room ${room.hasWindow ? 'window' : ''} ${occ.am || occ.pm ? 'filled' : 'empty'}`}>
              <span className="room-number">{room.code}</span>
              {room.hasWindow && <span className="window-tag">Window</span>}
              {room.videoCapable && <span className="video-tag">Video</span>}

              {blocked?.am || blocked?.pm ? (
                <span className="room-provider blocked-label">
                  Blocked{blocked.reason ? ` — ${blocked.reason}` : ''}
                </span>
              ) : isFullDay ? (
                <span className={`room-provider ${occ.am.isOverflow ? 'overflow' : ''}`}>
                  {occ.am.providerName}
                  {occ.am.isOverflow && <em> (overflow)</em>}
                  <small> · all day</small>
                </span>
              ) : (
                <span className="room-halves">
                  <span className={`half ${occ.am ? (occ.am.isOverflow ? 'overflow' : 'filled') : 'empty-label'}`}>
                    AM: {occ.am ? occ.am.providerName : 'Open'}
                  </span>
                  <span className={`half ${occ.pm ? (occ.pm.isOverflow ? 'overflow' : 'filled') : 'empty-label'}`}>
                    PM: {occ.pm ? occ.pm.providerName : 'Open'}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {onDownload && (
        <button type="button" className="download-button desk-download-button" onClick={onDownload}>
          Download {desk.name} PDF
        </button>
      )}
    </section>
  );
}
