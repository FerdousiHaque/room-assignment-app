import React from 'react';

export default function WarningList({ warnings }) {
  return (
    <div className="warning-list">
      <strong>Needs review</strong>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}
