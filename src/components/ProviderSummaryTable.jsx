import React from 'react';

/**
 * The "no provider ever disappears" view: one row per real, working
 * provider, room slot cells showing the assigned room code or "Not Found".
 * Unmatched-name (pseudo) providers are intentionally excluded — they
 * silently fill open rooms or get dropped per an earlier requirement, and
 * aren't real staff who need to appear in this report.
 */
export default function ProviderSummaryTable({ assignments, rooms, desks }) {
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));
  const maxSlots = Math.max(1, ...assignments.map((a) => a.roomSlots.length));

  return (
    <section className="provider-summary">
      <h2>Provider assignment report</h2>
      <table className="provider-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Home desk</th>
            <th>Session</th>
            {Array.from({ length: maxSlots }, (_, i) => (
              <th key={i}>Room {i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assignments.map((a) => (
            <tr key={a.providerId}>
              <td>{a.providerName}</td>
              <td>{deskById[a.homeDeskId]?.name || '—'}</td>
              <td>{a.session}</td>
              {Array.from({ length: maxSlots }, (_, i) => {
                const slot = a.roomSlots[i];
                if (!slot) return <td key={i}>—</td>;
                if (!slot.roomId) {
                  return <td key={i} className="not-found">Not Found</td>;
                }
                const room = roomById[slot.roomId];
                const deskName = deskById[slot.deskId]?.name;
                return (
                  <td key={i}>
                    {room?.code || slot.roomId}
                    {slot.isOverflow && <span className="overflow-note"> ({deskName})</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
