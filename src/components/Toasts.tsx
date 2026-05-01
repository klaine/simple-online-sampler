import { useStore } from '../store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const { removeToast } = useStore.getState()

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span>{toast.message}</span>
          <button type="button" className="toast-close" onClick={() => removeToast(toast.id)}>&times;</button>
        </div>
      ))}
    </div>
  )
}
