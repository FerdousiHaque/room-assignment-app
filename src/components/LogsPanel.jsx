import React from 'react';

/**
 * Real, engine-emitted narration of the last assignment run — "Working on
 * Desk A providers…", "Shifting Dr. X to Desk B", "Finalizing all the
 * providers…" (see assignmentEngine.js's `logs` return value). This is
 * plain derived state passed down from App.jsx's live useMemo, so it goes
 * away on its own on page refresh — nothing here is persisted anywhere.
 */
export default function LogsPanel({ logs }) {
  return (
    <div className="logs-panel">
      <strong>Logs</strong>
      <ul>
        {logs.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
