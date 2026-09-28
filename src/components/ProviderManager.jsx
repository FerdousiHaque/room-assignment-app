import React, { useMemo, useState } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';

const emptyDraft = {
  firstName: '',
  lastName: '',
  homeDeskId: '',
  preferredNumberOfRooms: 1,
  primaryPreferredRoomId: '',
  secondPreferredRoomId: '',
  windowPreference: 'none',
  alternateDeskIds: [],
  alternateRoomCodesText: '', // raw comma-separated text as typed; parsed to alternateRoomCodes on save
  hasOfficeOnFloor: false,
  // Fixed room: when true, this provider must always get their primary (and
  // second, if they take 2) preferred room — if it's unavailable that day
  // they show as "Not Found" rather than being placed in, or overflowed to,
  // any other room. See assignmentEngine.js's fixed-room reservation pass.
  fixedRoom: false,
  // Type: 'Any' (default), 'Doctor', 'Fellow', or 'Nurse'. Only affects
  // assignment order — Nurses are placed last, after every Doctor, Fellow,
  // and Any-type provider everywhere has already been placed (including
  // their overflow). See assignmentEngine.js's priority tiers.
  type: 'Any'
};

// "23E, 68W,  70E" -> ["23E", "68W", "70E"]
function parseRoomCodes(text) {
  return (text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * In-app add/edit table for provider config. Currently backed by local
 * state passed in as `providers` + `onChange`. To wire to Firestore:
 * replace `onChange(next)` calls with writes to the `providers`
 * collection and drive `providers` from an onSnapshot listener instead.
 *
 * Video-visit is intentionally NOT a field here — whether a provider has a
 * video visit varies day to day and comes entirely from the imported
 * schedule (see pdfParser.deriveDayEntries), never from a static per-provider
 * flag. "Has office on this floor" stays here because it's a fixed fact
 * about the provider, and combined with the day's video-visit signal it
 * decides whether a video-capable room is required that day.
 */
export default function ProviderManager({ providers, desks, rooms, onChange }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  // Id of the provider awaiting delete confirmation, or null when the
  // confirm popup is closed — Delete never removes anything by itself.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  // Column sort, toggled by clicking a sortable header: column is null (the
  // table's natural/insertion order) or 'name' / 'desk'; clicking the active
  // column flips 'asc' -> 'desc' -> back to the natural order.
  const [sort, setSort] = useState({ column: null, direction: 'asc' });
  const toggleSort = (column) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: 'asc' };
      if (prev.direction === 'asc') return { column, direction: 'desc' };
      return { column: null, direction: 'asc' };
    });
  };
  const sortIcon = (column) => (sort.column !== column ? '⇅' : sort.direction === 'asc' ? '▲' : '▼');

  const roomsForDesk = (deskId) => rooms.filter((r) => r.deskId === deskId);

  const resetDraft = () => {
    setDraft(emptyDraft);
    setEditingId(null);
    setError(null);
  };

  const startEdit = (provider) => {
    setDraft({
      firstName: provider.firstName,
      lastName: provider.lastName,
      homeDeskId: provider.homeDeskId,
      preferredNumberOfRooms: provider.preferredNumberOfRooms || 1,
      primaryPreferredRoomId: provider.primaryPreferredRoomId || '',
      secondPreferredRoomId: provider.secondPreferredRoomId || '',
      windowPreference: provider.windowPreference,
      alternateDeskIds: provider.alternateDeskIds || [],
      alternateRoomCodesText: (provider.alternateRoomCodes || []).join(', '),
      hasOfficeOnFloor: Boolean(provider.hasOfficeOnFloor),
      fixedRoom: Boolean(provider.fixedRoom),
      type: provider.type || 'Any'
    });
    setEditingId(provider.id);
  };

  const toggleAlternateDesk = (deskId) => {
    setDraft((d) => ({
      ...d,
      alternateDeskIds: d.alternateDeskIds.includes(deskId)
        ? d.alternateDeskIds.filter((id) => id !== deskId)
        : [...d.alternateDeskIds, deskId]
    }));
  };

  const handleSave = () => {
    setError(null);
    if (!draft.firstName || !draft.lastName || !draft.homeDeskId) {
      setError('First name, last name, and default desk are required.');
      return;
    }
    if (![1, 2].includes(Number(draft.preferredNumberOfRooms))) {
      setError('Preferred number of rooms must be 1 or 2.');
      return;
    }
    if (
      draft.primaryPreferredRoomId &&
      draft.secondPreferredRoomId &&
      draft.primaryPreferredRoomId === draft.secondPreferredRoomId
    ) {
      setError('Primary and second preferred room must be different.');
      return;
    }

    const name = `${draft.firstName} ${draft.lastName}`;
    const { alternateRoomCodesText, ...rest } = draft;
    const record = {
      ...rest,
      preferredNumberOfRooms: Number(draft.preferredNumberOfRooms),
      alternateRoomCodes: parseRoomCodes(alternateRoomCodesText),
      name
    };

    if (editingId) {
      onChange(providers.map((p) => (p.id === editingId ? { ...p, ...record } : p)));
    } else {
      onChange([...providers, { id: `p-${Date.now()}`, ...record }]);
    }
    resetDraft();
  };

  const requestDelete = (id) => setPendingDeleteId(id);

  const confirmDelete = () => {
    const id = pendingDeleteId;
    onChange(providers.filter((p) => p.id !== id));
    if (editingId === id) resetDraft();
    setPendingDeleteId(null);
  };

  const cancelDelete = () => setPendingDeleteId(null);

  const roomCode = (roomId) => rooms.find((r) => r.id === roomId)?.code;
  const pendingDeleteProvider = providers.find((p) => p.id === pendingDeleteId);
  const deskName = (deskId) => desks.find((d) => d.id === deskId)?.name || '';

  const sortedProviders = useMemo(() => {
    const list = [...providers];
    if (sort.column === 'name') {
      list.sort((a, b) => {
        const cmp = (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    } else if (sort.column === 'desk') {
      list.sort((a, b) => {
        const cmp = deskName(a.homeDeskId).localeCompare(deskName(b.homeDeskId), undefined, { numeric: true, sensitivity: 'base' });
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [providers, sort, desks]);

  return (
    <section className="provider-manager">
      <h2>Providers</h2>

      <table className="provider-table">
        <thead>
          <tr>
            <th
              className="sortable-th"
              onClick={() => toggleSort('name')}
              title="Sort by name"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('name'); } }}
            >
              Name
              <span className={`sort-icon ${sort.column === 'name' ? 'active' : ''}`}>{sortIcon('name')}</span>
            </th>
            <th
              className="sortable-th"
              onClick={() => toggleSort('desk')}
              title="Sort by default desk"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('desk'); } }}
            >
              Default desk
              <span className={`sort-icon ${sort.column === 'desk' ? 'active' : ''}`}>{sortIcon('desk')}</span>
            </th>
            <th># rooms</th>
            <th>Primary room</th>
            <th>2nd room</th>
            <th>Window</th>
            <th>Alt desks</th>
            <th>Alt desk rooms</th>
            <th>Office on floor</th>
            <th>Fixed room</th>
            <th>Type</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedProviders.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{desks.find((d) => d.id === p.homeDeskId)?.name || '—'}</td>
              <td>{p.preferredNumberOfRooms || 1}</td>
              <td>{p.primaryPreferredRoomId ? roomCode(p.primaryPreferredRoomId) || '—' : '—'}</td>
              <td>{p.secondPreferredRoomId ? roomCode(p.secondPreferredRoomId) || '—' : '—'}</td>
              <td>{p.windowPreference === 'prefers' ? 'Prefers' : '—'}</td>
              <td>
                {(p.alternateDeskIds || [])
                  .map((id) => desks.find((d) => d.id === id)?.name)
                  .filter(Boolean)
                  .join(', ') || '—'}
              </td>
              <td>{(p.alternateRoomCodes || []).join(', ') || '—'}</td>
              <td>{p.hasOfficeOnFloor ? 'Yes' : 'No'}</td>
              <td>{p.fixedRoom ? 'Yes' : 'No'}</td>
              <td>{p.type || 'Any'}</td>
              <td className="row-actions">
                <button type="button" onClick={() => startEdit(p)}>Edit</button>
                <button type="button" onClick={() => requestDelete(p.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="provider-form">
        <h3>{editingId ? 'Edit provider' : 'Add provider'}</h3>
        <div className="provider-form-grid">
          <label>
            <span>First name</span>
            <input value={draft.firstName} onChange={(e) => setDraft((d) => ({ ...d, firstName: e.target.value }))} />
          </label>
          <label>
            <span>Last name</span>
            <input value={draft.lastName} onChange={(e) => setDraft((d) => ({ ...d, lastName: e.target.value }))} />
          </label>
          <label>
            <span>Default desk</span>
            <select
              value={draft.homeDeskId}
              onChange={(e) => setDraft((d) => ({ ...d, homeDeskId: e.target.value }))}
            >
              <option value="">Select…</option>
              {desks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Preferred number of rooms</span>
            <select
              value={draft.preferredNumberOfRooms}
              onChange={(e) => setDraft((d) => ({ ...d, preferredNumberOfRooms: e.target.value }))}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label>
            <span>Primary preferred room</span>
            <select
              value={draft.primaryPreferredRoomId}
              onChange={(e) => setDraft((d) => ({ ...d, primaryPreferredRoomId: e.target.value }))}
            >
              <option value="">None</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.code}{r.hasWindow ? ' (window)' : ''}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Second preferred room</span>
            <select
              value={draft.secondPreferredRoomId}
              onChange={(e) => setDraft((d) => ({ ...d, secondPreferredRoomId: e.target.value }))}
              disabled={draft.preferredNumberOfRooms != 2}
            >
              <option value="">None</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.code}{r.hasWindow ? ' (window)' : ''}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Window preference</span>
            <select
              value={draft.windowPreference}
              onChange={(e) => setDraft((d) => ({ ...d, windowPreference: e.target.value }))}
            >
              <option value="none">No preference</option>
              <option value="prefers">Prefers window</option>
            </select>
          </label>
          <label>
            <span>Alt desk rooms (comma separated)</span>
            <input
              placeholder="e.g. 23E, 68W"
              value={draft.alternateRoomCodesText}
              onChange={(e) => setDraft((d) => ({ ...d, alternateRoomCodesText: e.target.value }))}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.hasOfficeOnFloor}
              onChange={(e) => setDraft((d) => ({ ...d, hasOfficeOnFloor: e.target.checked }))}
            />
            Has office on this floor
          </label>
          <fieldset>
            <legend>Alternate desks (overflow-eligible)</legend>
            {desks
              .filter((d) => d.id !== draft.homeDeskId)
              .map((d) => (
                <label key={d.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.alternateDeskIds.includes(d.id)}
                    onChange={() => toggleAlternateDesk(d.id)}
                  />
                  {d.name}
                </label>
              ))}
          </fieldset>
          <label>
            <span>Fixed room</span>
            <select
              value={draft.fixedRoom ? 'yes' : 'no'}
              onChange={(e) => setDraft((d) => ({ ...d, fixedRoom: e.target.value === 'yes' }))}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          <label>
            <span>Type</span>
            <select
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
            >
              <option value="Any">Any</option>
              <option value="Doctor">Doctor</option>
              <option value="Fellow">Fellow</option>
              <option value="Nurse">Nurse</option>
            </select>
          </label>
        </div>
        {error && <p className="upload-error">{error}</p>}
        <div className="provider-form-actions">
          <button type="button" onClick={handleSave}>{editingId ? 'Save changes' : 'Add provider'}</button>
          {editingId && <button type="button" onClick={resetDraft}>Cancel</button>}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete this provider?"
        message={pendingDeleteProvider ? `Are you sure you want to delete "${pendingDeleteProvider.name}"? This can't be undone.` : ''}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </section>
  );
}
