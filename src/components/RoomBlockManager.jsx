import React, { useState } from 'react';
import { parseClockTime } from '../logic/pdfParser.js';

const emptyDraft = { roomId: '', date: '', startTime: '', endTime: '', reason: '' };

/**
 * In-app add/edit table for room blocks. `date` blank means the block is
 * standing/recurring (applies every day) rather than one-off. `startTime`/
 * `endTime` blank means the block covers the entire day. Times are parsed
 * with the same parseClockTime used for PDF import ("8:30 am", "16:00",
 * etc.) so blocks can be entered in whichever format is convenient.
 */
export default function RoomBlockManager({ roomBlocks, rooms, desks, onChange }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  const resetDraft = () => {
    setDraft(emptyDraft);
    setEditingId(null);
    setError(null);
  };

  const startEdit = (block) => {
    setDraft({
      roomId: block.roomId,
      date: block.date || '',
      startTime: block.startTimeText || '',
      endTime: block.endTimeText || '',
      reason: block.reason || ''
    });
    setEditingId(block.id);
  };

  const handleSave = () => {
    setError(null);
    if (!draft.roomId) {
      setError('Choose a room.');
      return;
    }
    const startMinutes = draft.startTime ? parseClockTime(draft.startTime) : null;
    const endMinutes = draft.endTime ? parseClockTime(draft.endTime) : null;
    if (draft.startTime && startMinutes === null) {
      setError('Start time not recognized — try a format like "8:30 am".');
      return;
    }
    if (draft.endTime && endMinutes === null) {
      setError('End time not recognized — try a format like "5:00 pm".');
      return;
    }
    if (startMinutes !== null && endMinutes !== null && startMinutes >= endMinutes) {
      setError('Start time must be before end time.');
      return;
    }

    const record = {
      roomId: draft.roomId,
      date: draft.date || null,
      startMinutes,
      endMinutes,
      startTimeText: draft.startTime,
      endTimeText: draft.endTime,
      reason: draft.reason || ''
    };

    if (editingId) {
      onChange(roomBlocks.map((b) => (b.id === editingId ? { ...b, ...record } : b)));
    } else {
      onChange([...roomBlocks, { id: `block-${Date.now()}`, ...record }]);
    }
    resetDraft();
  };

  const handleDelete = (id) => {
    onChange(roomBlocks.filter((b) => b.id !== id));
    if (editingId === id) resetDraft();
  };

  const describe = (b) => {
    const when = b.date ? b.date : 'Every day';
    const time = b.startTimeText || b.endTimeText ? `${b.startTimeText || 'start'}–${b.endTimeText || 'end of day'}` : 'All day';
    return `${when} · ${time}`;
  };

  return (
    <section className="provider-manager">
      <h2>Room blocks</h2>
      <p className="upload-hint">
        Blocks with no date apply every day. Blocks with no start/end time block the whole day.
      </p>

      <table className="provider-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>When</th>
            <th>Reason</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {roomBlocks.map((b) => (
            <tr key={b.id}>
              <td>{rooms.find((r) => r.id === b.roomId)?.code || b.roomId}</td>
              <td>{describe(b)}</td>
              <td>{b.reason || '—'}</td>
              <td className="row-actions">
                <button type="button" onClick={() => startEdit(b)}>Edit</button>
                <button type="button" onClick={() => handleDelete(b.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="provider-form">
        <h3>{editingId ? 'Edit block' : 'Add block'}</h3>
        <div className="provider-form-grid">
          <label>
            <span>Room</span>
            <select value={draft.roomId} onChange={(e) => setDraft((d) => ({ ...d, roomId: e.target.value }))}>
              <option value="">Select…</option>
              {desks.map((desk) => (
                <optgroup key={desk.id} label={desk.name}>
                  {rooms.filter((r) => r.deskId === desk.id).map((r) => (
                    <option key={r.id} value={r.id}>{r.code}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            <span>Date (blank = every day)</span>
            <input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
          </label>
          <label>
            <span>Start time (blank = start of day)</span>
            <input placeholder="8:30 am" value={draft.startTime} onChange={(e) => setDraft((d) => ({ ...d, startTime: e.target.value }))} />
          </label>
          <label>
            <span>End time (blank = end of day)</span>
            <input placeholder="5:00 pm" value={draft.endTime} onChange={(e) => setDraft((d) => ({ ...d, endTime: e.target.value }))} />
          </label>
          <label>
            <span>Reason (optional)</span>
            <input value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))} />
          </label>
        </div>
        {error && <p className="upload-error">{error}</p>}
        <div className="provider-form-actions">
          <button type="button" onClick={handleSave}>{editingId ? 'Save changes' : 'Add block'}</button>
          {editingId && <button type="button" onClick={resetDraft}>Cancel</button>}
        </div>
      </div>
    </section>
  );
}
