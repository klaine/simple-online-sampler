import type { ImportMode } from '../types'
import { useStore } from '../store'

interface ImportDialogProps {
  onPreview: () => void
  onImport: () => void
}

export function ImportDialog({ onPreview, onImport }: ImportDialogProps) {
  const importMode = useStore((s) => s.importMode)
  const importFile = useStore((s) => s.importFile)
  const previewText = useStore((s) => s.previewText)
  const conflicts = useStore((s) => s.conflicts)

  return (
    <section className="import-dialog-overlay" role="dialog" aria-modal="true">
      <div className="import-dialog">
        <div className="import-dialog-head">
          <h2>Import Package</h2>
          <button type="button" onClick={() => useStore.setState({ showImportDialog: false })}>Close</button>
        </div>
        <label>
          Import Mode
          <select
            value={importMode}
            onChange={(e) => useStore.setState({ importMode: e.target.value as ImportMode })}
          >
            <option value="new">New Project</option>
            <option value="merge">Merge</option>
            <option value="overwrite">Overwrite Overlaps</option>
          </select>
        </label>
        <label>
          Package File
          <input type="file" accept=".ospack,.zip" onChange={(e) => useStore.setState({ importFile: e.target.files?.[0] ?? null })} />
        </label>
        <div className="import-actions">
          <button type="button" onClick={onPreview} disabled={!importFile}>Preview Conflicts</button>
          <button type="button" onClick={onImport} disabled={!importFile}>Import Now</button>
        </div>
        <p className="preview">{previewText}</p>
        <div className="conflicts">{conflicts.map((line) => <p key={line}>{line}</p>)}</div>
      </div>
    </section>
  )
}
