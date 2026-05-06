let _confirmResolver: ((ok: boolean) => void) | null = null
let _setConfirmDialog: ((dialog: { message: string; confirmLabel?: string; cancelLabel?: string } | null) => void) | null = null

export function registerConfirmDialog(setter: typeof _setConfirmDialog) {
  _setConfirmDialog = setter
}

export function showConfirm(message: string, opts?: { confirmLabel?: string; cancelLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    _confirmResolver = resolve
    _setConfirmDialog?.({ message, confirmLabel: opts?.confirmLabel, cancelLabel: opts?.cancelLabel })
  })
}

export function resolveConfirmDialog(ok: boolean) {
  const resolver = _confirmResolver
  _confirmResolver = null
  _setConfirmDialog?.(null)
  if (resolver) resolver(ok)
}
