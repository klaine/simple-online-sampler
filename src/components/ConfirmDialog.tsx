import { useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { resolveConfirmDialog } from '../store'

export function ConfirmDialog() {
  const dialog = useStore((s) => s.confirmDialog)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const handleConfirm = useCallback(() => resolveConfirmDialog(true), [])
  const handleCancel = useCallback(() => resolveConfirmDialog(false), [])

  // Focus management: focus Cancel (safe default — confirms are destructive),
  // restore previously focused element on close
  useEffect(() => {
    if (!dialog) return
    const previousFocus = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previousFocus?.focus?.()
  }, [dialog])

  // ESC to cancel (Enter activates whichever button has focus — safe default is Cancel)
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, handleCancel])

  if (!dialog) return null

  return (
    <section className="import-dialog-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) handleCancel() }}>
      <div className="import-dialog confirm-dialog">
        <p className="confirm-dialog-message">{dialog.message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" ref={cancelRef} onClick={handleCancel}>{dialog.cancelLabel || 'Cancel'}</button>
          <button type="button" className="record-btn-save" onClick={handleConfirm}>{dialog.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </section>
  )
}
