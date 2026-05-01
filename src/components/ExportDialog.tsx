import { useStore } from '../store'

interface ExportDialogProps {
  onExportMidi: () => void
  onExportPack: () => void
  onExportStandalone: () => void
  onExportAudioPattern: () => void
  onExportAudioSong: () => void
  songChainEmpty: boolean
}

export function ExportDialog({
  onExportMidi,
  onExportPack,
  onExportStandalone,
  onExportAudioPattern,
  onExportAudioSong,
  songChainEmpty,
}: ExportDialogProps) {
  const isExporting = useStore((s) => s.isExporting)
  const close = () => { if (!isExporting) useStore.setState({ showExportDialog: false }) }

  return (
    <section className="import-dialog-overlay" role="dialog" aria-modal="true">
      <div className="import-dialog">
        <div className="import-dialog-head">
          <h2>Export</h2>
          <button type="button" onClick={close} disabled={isExporting}>Close</button>
        </div>
        {isExporting ? (
          <p className="preview export-spinner">Rendering audio...</p>
        ) : (
          <>
            <p className="preview">Choose export format:</p>
            <div className="import-actions">
              <button type="button" onClick={() => { onExportMidi(); close() }}>
                MIDI Files
              </button>
              <button type="button" onClick={() => { onExportPack(); close() }}>
                Project Package
              </button>
              <button type="button" onClick={() => { onExportStandalone(); close() }}>
                Standalone HTML
              </button>
              <button type="button" onClick={onExportAudioPattern}>
                Audio: Active Pattern
              </button>
              <button
                type="button"
                onClick={onExportAudioSong}
                disabled={songChainEmpty}
              >
                Audio: Song Chain
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
