import { useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { resolveConfirmDialog } from '../store'

export function ConfirmDialog() {
  const dialog = useStore((s) => s.confirmDialog)

  const handleConfirm = useCallback(() => resolveConfirmDialog(true), [])
  const handleCancel = useCallback(() => resolveConfirmDialog(false), [])

  // ESC to cancel
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
      if (e.key === 'Enter') handleConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, handleCancel, handleConfirm])

  if (!dialog) return null

  return (
    <section className="import-dialog-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) handleCancel() }}>
      <div className="import-dialog confirm-dialog">
        <p className="confirm-dialog-message">{dialog.message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={handleCancel}>{dialog.cancelLabel || 'Cancel'}</button>
          <button type="button" className="record-btn-save" autoFocus onClick={handleConfirm}>{dialog.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </section>
  )
}
