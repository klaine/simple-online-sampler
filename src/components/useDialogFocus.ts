import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  )
}

/**
 * Modal dialog focus management:
 * - Moves focus into the dialog when it opens (to `initialFocusRef` if given, else first focusable)
 * - Traps Tab / Shift+Tab inside the dialog
 * - Restores focus to the previously focused element on close/unmount
 *
 * Attach the returned ref to the dialog's root element.
 */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const rootRef = useRef<T | null>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const root = rootRef.current
    if (root) {
      const target = initialFocusRef?.current ?? getFocusable(root)[0]
      target?.focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const el = rootRef.current
      if (!el) return
      const focusables = getFocusable(el)
      if (focusables.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !el.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !el.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus?.()
    }
  }, [open, initialFocusRef])

  return rootRef
}
