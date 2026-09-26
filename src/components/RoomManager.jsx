import React, { useState } from 'react';

const emptyDraft = {
  code: '',
  deskId: '',
  hasWindow: false,
  videoCapable: false,
  kind: 'exam',       // 'exam' | 'office' | 'utility' — see assignmentEngine.js rule #12
  label: '',          // shown on the floor-map PDF for 'office'/'utility' kinds only
  hall: '',           // free-text hall/section name, e.g. "East A Hall 1" — groups rooms on the floor-map PDF
  row: '',            // row number within the hall (rooms with the same hall+row print on the same line)
  side: 'left'        // 'left' | 'right' — which of the two paired columns within that row
};

/**
 * In-app add/edit table for rooms. A desk's capacity is the count of
 * 'exam' rooms with that deskId — office/utility rooms don't count, since
 * they're never part of the daily assignment pool (see assignmentEngine.js).
 * Currently backed by local state passed in as `rooms` + `onChange`; wire
 * to Firestore the same way as ProviderManager.
 */
export default function RoomManager({ rooms, desks, onChange }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);

  const resetDraft = () => {
    setDraft(emptyDraft);
    setEditingId(null);
  };

  const startEdit = (room) => {
    setDraft({
      code: room.code || '',
      deskId: room.deskId,
      hasWindow: Boolean(room.hasWindow),
      videoCapable: Boolean(room.videoCapable),
      kind: room.kind || 'exam',
      label: room.label || '',
      hall: room.hall || '',
      row: room.row ?? '',
      side: room.side || 'left'
    });
    setEditingId(room.id);
  };

  const buildRecord = (idForNew) => {
    const code = draft.code.trim();
    const base = {
      id: editingId || idForNew,
      code,
      deskId: draft.deskId,
      hasWindow: draft.hasWindow,
      videoCapable: draft.videoCapable,
      kind: draft.kind
    };
    // hall/row/side only matter once a room has a place on the floor-map
    // layout — leave them off entirely if hall wasn't set, so a desk with
    // no configured floor map still falls back to the simple list view.
    if (draft.hall.trim()) {
      base.hall = draft.hall.trim();
      base.row = draft.row === '' ? null : Number(draft.row);
      base.side = draft.side;
    }
    if (draft.kind !== 'exam') {
      base.label = draft.label.trim();
    }
    return base;
  };

  const handleSave = () => {
    const code = draft.code.trim();
    // A code is required for 'exam'/'office' rooms (it's the room number),
    // but a 'utility' space (e.g. "Hallway") may legitimately have none.
    if (!draft.deskId) return;
    if (draft.kind !== 'utility' && !code) return;
    if (draft.kind !== 'exam' && !draft.label.trim()) {
      alert('Enter the label to print for this office/utility space (e.g. "Dr. Smith Office" or "Hallway").');
      return;
    }

    if (editingId) {
      onChange(rooms.map((r) => (r.id === editingId ? buildRecord(editingId) : r)));
    } else {
      const fallbackId = code || `util-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newId = `${draft.deskId}-${fallbackId}`;
      if (rooms.some((r) => r.id === newId)) {
        alert(`A room with code "${code}" already exists on this desk.`);
        return;
      }
      onChange([...rooms, buildRecord(newId)]);
    }
    resetDraft();
  };

  const handleDelete = (id) => {
    onChange(rooms.filter((r) => r.id !== id));
    if (editingId === id) resetDraft();
  };

  const countForDesk = (deskId) => rooms.filter((r) => r.deskId === deskId && (!r.kind || r.kind === 'exam')).length;

  const kindLabel = { exam: 'Exam (pool)', office: 'Office', utility: 'Utility' };
  const resolvedLabel = (r) => {
    if (r.kind === 'office' || r.kind === 'utility') return r.label || '—';
    return r.videoCapable ? 'Video capable' : '—';
  };

  return (
    <section className="provider-manager">
      <h2>Rooms</h2>
      <p className="upload-hint">
        {desks.map((d) => `${d.name}: ${countForDesk(d.id)} exam rooms`).join('  ·  ')}
      </p>

      <table className="provider-table">
        <thead>
          <tr>
            <th>Room code</th>
            <th>Desk</th>
            <th>Kind</th>
            <th>Hall</th>
            <th>Window</th>
            <th>Label / Video</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {[...rooms]
            .sort((a, b) => a.deskId.localeCompare(b.deskId) || (a.hall || '').localeCompare(b.hall || '') || (a.row || 0) - (b.row || 0))
            .map((r) => (
              <tr key={r.id}>
                <td>{r.code || '—'}</td>
                <td>{desks.find((d) => d.id === r.deskId)?.name || '—'}</td>
                <td>{kindLabel[r.kind || 'exam']}</td>
                <td>{r.hall || '—'}</td>
                <td>{r.hasWindow ? 'Window' : '—'}</td>
                <td>{resolvedLabel(r)}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => startEdit(r)}>Edit</button>
                  <button type="button" onClick={() => handleDelete(r.id)}>Delete</button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="provider-form">
        <h3>{editingId ? 'Edit room' : 'Add room'}</h3>
        <div className="provider-form-grid">
          <label>
            <span>Room code {draft.kind === 'utility' ? '(optional)' : ''}</span>
            <input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} placeholder="e.g. 22" />
          </label>
          <label>
            <span>Desk</span>
            <select value={draft.deskId} onChange={(e) => setDraft((d) => ({ ...d, deskId: e.target.value }))}>
              <option value="">Select…</option>
              {desks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Kind</span>
            <select value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}>
              <option value="exam">Exam room (daily pool)</option>
              <option value="office">Permanent office</option>
              <option value="utility">Utility / non-patient space</option>
            </select>
          </label>
          {draft.kind !== 'exam' && (
            <label>
              <span>Label to print</span>
              <input
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder={draft.kind === 'office' ? 'e.g. Dr. Smith Office' : 'e.g. Hallway'}
              />
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.hasWindow}
              onChange={(e) => setDraft((d) => ({ ...d, hasWindow: e.target.checked }))}
            />
            Has window
          </label>
          {draft.kind === 'exam' && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.videoCapable}
                onChange={(e) => setDraft((d) => ({ ...d, videoCapable: e.target.checked }))}
              />
              Video capable
            </label>
          )}
          <label>
            <span>Hall (floor-map grouping, optional)</span>
            <input
              value={draft.hall}
              onChange={(e) => setDraft((d) => ({ ...d, hall: e.target.value }))}
              placeholder="e.g. East A Hall 1"
            />
          </label>
          {draft.hall.trim() && (
            <>
              <label>
                <span>Row (same row = same printed line)</span>
                <input
                  type="number"
                  value={draft.row}
                  onChange={(e) => setDraft((d) => ({ ...d, row: e.target.value }))}
                />
              </label>
              <label>
                <span>Side</span>
                <select value={draft.side} onChange={(e) => setDraft((d) => ({ ...d, side: e.target.value }))}>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </>
          )}
        </div>
        <p className="upload-hint">
          Leave Hall blank for a simple desk (its floor-map PDF page falls back to a plain list). Set Hall + Row + Side
          on every room at a desk to reproduce a real two-column floor-plan layout like Desk A's.
        </p>
        <div className="provider-form-actions">
          <button type="button" onClick={handleSave}>{editingId ? 'Save changes' : 'Add room'}</button>
          {editingId && <button type="button" onClick={resetDraft}>Cancel</button>}
        </div>
      </div>
    </section>
  );
}
