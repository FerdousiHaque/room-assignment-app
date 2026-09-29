import React, { useMemo, useState } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';

const emptyDraft = {
  firstName: '',
  lastName: '',
  homeDeskId: '',
  preferredNumberOfRooms: 1,
  primaryPreferredRoomId: '',
  secondPreferredRoomId: '',
  otherPreferredRoomCodesText: '', // raw comma-separated text as typed; parsed to otherPreferredRoomCodes on save
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

// Numeric-aware ascending compare on room code, e.g. "9E" < "12E" — mirrors
// RoomManager.jsx's byCodeAsc, used everywhere a room dropdown is built so
// every list of rooms is always shown in the same ascending order.
function byCodeAsc(a, b) {
  return (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' });
}

// "22E" -> { num: 22, suffix: "E" }; null if unparseable.
function parseRoomCode(code) {
  const m = /^(\d+)([A-Za-z]*)$/.exec((code || '').trim());
  if (!m) return null;
  return { num: Number(m[1]), suffix: m[2] };
}

// Two rooms are a valid "two rooms beside each other" pair only when both
// codes parse, share the same letter suffix, and are exactly 2 apart (which
// also guarantees both odd or both even) — e.g. 22E/24E, 63E/65E, 30/32.
function roomsAdjacent(codeA, codeB) {
  const a = parseRoomCode(codeA);
  const b = parseRoomCode(codeB);
  if (!a || !b) return false;
  return a.suffix === b.suffix && Math.abs(a.num - b.num) === 2;
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
 *
 * Editing happens INLINE: clicking "Edit" on a row opens the same form
 * fields in a row right below it, instead of the page scrolling down to a
 * shared form at the bottom. The bottom form is reserved for adding a new
 * provider and stays exactly where it was; it's hidden while an existing
 * row is being edited (the same `draft` state drives both, so only one of
 * the two can be open at a time), and comes back once the edit is saved or
 * cancelled.
 */
export default function ProviderManager({ providers, desks, rooms, onChange }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  // Id of the provider awaiting delete confirmation, or null when the
  // confirm popup is closed — Delete never removes anything by itself.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  // Column sort, toggled by clicking a sortable header: column is null (the
  // table's default order — see sortedProviders below) or 'name' / 'desk';
  // clicking the active column flips 'asc' -> 'desc' -> back to the default.
  const [sort, setSort] = useState({ column: null, direction: 'asc' });
  const toggleSort = (column) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: 'asc' };
      if (prev.direction === 'asc') return { column, direction: 'desc' };
      return { column: null, direction: 'asc' };
    });
  };
  const sortIcon = (column) => (sort.column !== column ? '⇅' : sort.direction === 'asc' ? '▲' : '▼');

  // Used to restrict the Primary/Second preferred room dropdowns to the
  // provider's own selected desk, so they can't pick a room from a desk
  // they don't work at. Only exam rooms are ever assignable (office/utility
  // rooms are floor-map-only — see assignmentEngine.js), so those are left
  // out here too; always returned in ascending room-code order.
  const roomsForDesk = (deskId) =>
    rooms.filter((r) => r.deskId === deskId && (!r.kind || r.kind === 'exam')).sort(byCodeAsc);

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
      otherPreferredRoomCodesText: (provider.otherPreferredRoomCodes || []).join(', '),
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
    setDraft((d) => {
      const has = d.alternateDeskIds.includes(deskId);
      return {
        ...d,
        alternateDeskIds: has
          ? d.alternateDeskIds.filter((id) => id !== deskId)
          : [...d.alternateDeskIds, deskId]
      };
    });
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
    const { alternateRoomCodesText, otherPreferredRoomCodesText, ...rest } = draft;
    const record = {
      ...rest,
      preferredNumberOfRooms: Number(draft.preferredNumberOfRooms),
      alternateRoomCodes: parseRoomCodes(alternateRoomCodesText),
      otherPreferredRoomCodes: parseRoomCodes(otherPreferredRoomCodesText),
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

  // Default order is by last name, ascending (then first name to break
  // ties) — matches how the Name column displays ("Last, First"), and is
  // what the Name header's own asc/desc toggle also sorts by.
  const byLastNameAsc = (a, b) =>
    (a.lastName || '').localeCompare(b.lastName || '', undefined, { numeric: true, sensitivity: 'base' }) ||
    (a.firstName || '').localeCompare(b.firstName || '', undefined, { numeric: true, sensitivity: 'base' });

  const sortedProviders = useMemo(() => {
    const list = [...providers];
    if (sort.column === 'name') {
      list.sort((a, b) => (sort.direction === 'asc' ? 1 : -1) * byLastNameAsc(a, b));
    } else if (sort.column === 'desk') {
      list.sort((a, b) => {
        const cmp = deskName(a.homeDeskId).localeCompare(deskName(b.homeDeskId), undefined, { numeric: true, sensitivity: 'base' });
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    } else if (sort.column === 'type') {
      list.sort((a, b) => {
        const cmp = (a.type || 'Any').localeCompare(b.type || 'Any', undefined, { numeric: true, sensitivity: 'base' });
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    } else {
      list.sort(byLastNameAsc);
    }
    return list;
  }, [providers, sort, desks]);

  // Shared between the "Add provider" form (bottom of the page) and the
  // inline "Edit provider" row — both just show/edit the same `draft`
  // state, only one is ever open at a time (see the component doc comment).
  const renderFormFields = () => (
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
          onChange={(e) =>
            setDraft((d) => {
              const nextRooms = roomsForDesk(e.target.value);
              const keepPrimary = nextRooms.some((r) => r.id === d.primaryPreferredRoomId)
                ? d.primaryPreferredRoomId
                : '';
              const primaryCode = keepPrimary ? nextRooms.find((r) => r.id === keepPrimary)?.code : null;
              // Primary/second preferred room are always filtered to the
              // selected desk (see the two dropdowns below) — if the desk
              // changes, drop any previous pick that no longer belongs to
              // it rather than silently keeping a room from the old desk.
              // Second also has to stay adjacent to whatever primary ends
              // up being kept (see roomsAdjacent) or it gets dropped too.
              const keepSecond =
                keepPrimary &&
                nextRooms.some((r) => r.id === d.secondPreferredRoomId) &&
                roomsAdjacent(primaryCode, nextRooms.find((r) => r.id === d.secondPreferredRoomId)?.code)
                  ? d.secondPreferredRoomId
                  : '';
              return {
                ...d,
                homeDeskId: e.target.value,
                primaryPreferredRoomId: keepPrimary,
                secondPreferredRoomId: keepSecond
              };
            })
          }
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
          onChange={(e) => {
            const nextPrimary = e.target.value;
            const nextPrimaryCode = rooms.find((r) => r.id === nextPrimary)?.code;
            const secondCode = rooms.find((r) => r.id === draft.secondPreferredRoomId)?.code;
            setDraft((d) => ({
              ...d,
              primaryPreferredRoomId: nextPrimary,
              // A two-room provider's second room has to be adjacent to
              // whichever room ends up as primary (see roomsAdjacent) — if
              // the current second pick no longer qualifies (including a
              // straight duplicate), clear it rather than leave a stale or
              // invalid pick selected.
              secondPreferredRoomId:
                nextPrimary && d.secondPreferredRoomId && roomsAdjacent(nextPrimaryCode, secondCode)
                  ? d.secondPreferredRoomId
                  : ''
            }));
          }}
        >
          <option value="">None</option>
          {roomsForDesk(draft.homeDeskId)
            .filter((r) => r.id !== draft.secondPreferredRoomId)
            .map((r) => (
              <option key={r.id} value={r.id}>{r.code}{r.hasWindow ? ' (window)' : ''}</option>
            ))}
        </select>
      </label>
      <label>
        <span>Second preferred room</span>
        <select
          value={draft.secondPreferredRoomId}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              secondPreferredRoomId: e.target.value
            }))
          }
          disabled={draft.preferredNumberOfRooms != 2 || !draft.primaryPreferredRoomId}
        >
          <option value="">None</option>
          {/* Only rooms adjacent to the chosen primary room qualify — a
              two-room provider must always get two rooms beside each other
              (same letter suffix, numbers exactly 2 apart). */}
          {roomsForDesk(draft.homeDeskId)
            .filter((r) => r.id !== draft.primaryPreferredRoomId)
            .filter((r) => roomsAdjacent(r.code, rooms.find((pr) => pr.id === draft.primaryPreferredRoomId)?.code))
            .map((r) => (
              <option key={r.id} value={r.id}>{r.code}{r.hasWindow ? ' (window)' : ''}</option>
            ))}
        </select>
      </label>
      <label>
        <span>Other Set of Rooms (comma separated)</span>
        <input
          placeholder="e.g. 12, 14E"
          value={draft.otherPreferredRoomCodesText}
          onChange={(e) => setDraft((d) => ({ ...d, otherPreferredRoomCodesText: e.target.value }))}
        />
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
        <span>Provider Type</span>
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
      <label>
        <span>Alt desk rooms (comma separated)</span>
        <input
          placeholder="e.g. 23E, 68W"
          value={draft.alternateRoomCodesText}
          onChange={(e) => setDraft((d) => ({ ...d, alternateRoomCodesText: e.target.value }))}
        />
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
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.hasOfficeOnFloor}
          onChange={(e) => setDraft((d) => ({ ...d, hasOfficeOnFloor: e.target.checked }))}
        />
        Has office on this floor
      </label>
    </div>
  );

  const columnCount = 12;

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
            <th
              className="sortable-th"
              onClick={() => toggleSort('type')}
              title="Sort by type"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('type'); } }}
            >
              Type
              <span className={`sort-icon ${sort.column === 'type' ? 'active' : ''}`}>{sortIcon('type')}</span>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedProviders.map((p) => (
            <React.Fragment key={p.id}>
              <tr>
                <td>{p.lastName}, {p.firstName}</td>
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
                  <button type="button" onClick={() => (editingId === p.id ? resetDraft() : startEdit(p))}>
                    {editingId === p.id ? 'Close' : 'Edit'}
                  </button>
                  <button type="button" onClick={() => requestDelete(p.id)}>Delete</button>
                </td>
              </tr>
              {editingId === p.id && (
                <tr className="inline-edit-row">
                  <td colSpan={columnCount}>
                    <div className="provider-form inline">
                      <h3>Edit provider</h3>
                      {renderFormFields()}
                      {error && <p className="upload-error">{error}</p>}
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
          <h3>Add provider</h3>
          {renderFormFields()}
          {error && <p className="upload-error">{error}</p>}
          <div className="provider-form-actions">
            <button type="button" onClick={handleSave}>Add provider</button>
          </div>
        </div>
      )}

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
