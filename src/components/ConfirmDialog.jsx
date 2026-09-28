import React, { useEffect } from 'react';

/**
 * Small reusable Yes/No confirmation popup, used before any destructive
 * action (currently: deleting a Provider or a Room). Renders nothing when
 * `open` is false. Confirming or cancelling is entirely up to the caller —
 * this component has no idea what it's confirming.
 */
export default function ConfirmDialog({ open, title, message, confirmLabel = 'Yes, delete', cancelLabel = 'No', onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h3 id="confirm-dialog-title">{title}</h3>
        <p>{message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-yes" onClick={onConfirm} autoFocus>{confirmLabel}</button>
          <button type="button" className="confirm-no" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
