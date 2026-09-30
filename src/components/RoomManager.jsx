import React, { useEffect, useMemo, useRef, useState } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';

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
 *
 * Editing happens INLINE, same pattern as ProviderManager: clicking "Edit"
 * on a row opens the same form fields in a row right below it instead of
 * scrolling down to a shared form at the bottom. The bottom form is
 * reserved for adding a new room and stays put; it's hidden while an
 * existing row is being edited.
 */
export default function RoomManager({ rooms, desks, onChange }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  // Id of the room awaiting delete confirmation, or null when the confirm
  // popup is closed — Delete never removes anything by itself.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  // Same auto-scroll as ProviderManager.jsx — for the LAST row, the inline
  // edit form renders right where the (now-hidden) "Add room" section used
  // to be, which reads as an overlap without a scroll nudge into view.
  const editRowRef = useRef(null);
  useEffect(() => {
    if (editingId !== null && editRowRef.current) {
      editRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [editingId]);
  // Column sort, toggled by clicking a sortable header: column is null (the
  // table's default order — see sortedRooms below, room code ascending) or
  // 'code' / 'desk'; clicking the active column flips 'asc' -> 'desc' ->
  // back to the default.
  const [sort, setSort] = useState({ column: null, direction: 'asc' });
  const toggleSort = (column) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: 'asc' };
      if (prev.direction === 'asc') return { column, direction: 'desc' };
      return { column: null, direction: 'asc' };
    });
  };
  const sortIcon = (column) => (sort.column !== column ? '⇅' : sort.direction === 'asc' ? '▲' : '▼');

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

  const requestDelete = (id) => setPendingDeleteId(id);

  const confirmDelete = () => {
    const id = pendingDeleteId;
    onChange(rooms.filter((r) => r.id !== id));
    if (editingId === id) resetDraft();
    setPendingDeleteId(null);
  };

  const cancelDelete = () => setPendingDeleteId(null);

  const pendingDeleteRoom = rooms.find((r) => r.id === pendingDeleteId);

  const countForDesk = (deskId) => rooms.filter((r) => r.deskId === deskId && (!r.kind || r.kind === 'exam')).length;

  const kindLabel = { exam: 'Exam (pool)', office: 'Office', utility: 'Utility' };
  const resolvedLabel = (r) => {
    if (r.kind === 'office' || r.kind === 'utility') return r.label || '—';
    return r.videoCapable ? 'Video capable' : '—';
  };

  const deskName = (deskId) => desks.find((d) => d.id === deskId)?.name || '';

  // numeric:true so "9E" sorts before "10E" instead of after it.
  const byCodeAsc = (a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' });

  const sortedRooms = useMemo(() => {
    const list = [...rooms];
    if (sort.column === 'code') {
      list.sort((a, b) => (sort.direction === 'asc' ? 1 : -1) * byCodeAsc(a, b));
    } else if (sort.column === 'desk') {
      list.sort((a, b) => {
        const cmp = deskName(a.deskId).localeCompare(deskName(b.deskId), undefined, { numeric: true, sensitivity: 'base' });
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    } else {
      // Default: room code ascending.
      list.sort(byCodeAsc);
    }
    return list;
  }, [rooms, sort, desks]);

  // Shared between the "Add room" form (bottom of the page) and the inline
  // "Edit room" row — both just show/edit the same `draft` state, only one
  // is ever open at a time.
  const renderFormFields = () => (
    <>
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
      </div>
      <p className="upload-hint">
        Leave Hall blank for a simple desk (its floor-map PDF page falls back to a plain list). Set Hall + Row + Side
        on every room at a desk to reproduce a real two-column floor-plan layout like Desk A's.
      </p>
    </>
  );

  const columnCount = 7;

  return (
    <section className="provider-manager">
      <h2>Rooms</h2>
      <p className="upload-hint">
        {desks.map((d) => `${d.name}: ${countForDesk(d.id)} exam rooms`).join('  ·  ')}
      </p>

      <table className="provider-table">
        <thead>
          <tr>
            <th
              className="sortable-th"
              onClick={() => toggleSort('code')}
              title="Sort by room code"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('code'); } }}
            >
              Room code
              <span className={`sort-icon ${sort.column === 'code' ? 'active' : ''}`}>{sortIcon('code')}</span>
            </th>
            <th
              className="sortable-th"
              onClick={() => toggleSort('desk')}
              title="Sort by desk"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('desk'); } }}
            >
              Desk
              <span className={`sort-icon ${sort.column === 'desk' ? 'active' : ''}`}>{sortIcon('desk')}</span>
            </th>
            <th>Kind</th>
            <th>Hall</th>
            <th>Window</th>
            <th>Label / Video</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedRooms.map((r) => (
            <React.Fragment key={r.id}>
              <tr>
                <td>{r.code || '—'}</td>
                <td>{desks.find((d) => d.id === r.deskId)?.name || '—'}</td>
                <td>{kindLabel[r.kind || 'exam']}</td>
                <td>{r.hall || '—'}</td>
                <td>{r.hasWindow ? 'Window' : '—'}</td>
                <td>{resolvedLabel(r)}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => (editingId === r.id ? resetDraft() : startEdit(r))}>
                    {editingId === r.id ? 'Close' : 'Edit'}
                  </button>
                  <button type="button" onClick={() => requestDelete(r.id)}>Delete</button>
                </td>
              </tr>
              {editingId === r.id && (
                <tr className="inline-edit-row" ref={editRowRef}>
                  <td colSpan={columnCount}>
                    <div className="provider-form inline">
                      <h3>Edit room</h3>
                      {renderFormFields()}
                      <div className="provider-form-actions">
                        <button type="button" onClick={handleSave}>Save changes</button>
                        <button type="button" onClick={resetDraft}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {editingId === null && (
        <div className="provider-form">
          <h3>Add room</h3>
          {renderFormFields()}
          <div className="provider-form-actions">
            <button type="button" onClick={handleSave}>Add room</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete this room?"
        message={pendingDeleteRoom ? `Are you sure you want to delete room "${pendingDeleteRoom.code || pendingDeleteRoom.label || pendingDeleteRoom.id}"? This can't be undone.` : ''}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </section>
  );
}
