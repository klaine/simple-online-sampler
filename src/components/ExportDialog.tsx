import { useState } from 'react'
import { useStore } from '../store'
import type { ExportFormat } from '../lib/audioExport'

interface ExportDialogProps {
  onExportMidi: () => void
  onExportPack: () => void
  onExportStandalone: () => void
  onExportAudioPattern: (format: ExportFormat) => void
  onExportAudioSong: (format: ExportFormat) => void
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
  const [patternFormat, setPatternFormat] = useState<ExportFormat>('wav')
  const [songFormat, setSongFormat] = useState<ExportFormat>('wav')
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
              <div className="export-audio-row">
                <button type="button" onClick={() => onExportAudioPattern(patternFormat)}>
                  Audio: Active Pattern
                </button>
                <select
                  className="export-format-select"
                  value={patternFormat}
                  onChange={(e) => setPatternFormat(e.target.value as ExportFormat)}
                >
                  <option value="wav">WAV</option>
                  <option value="mp3">MP3 320k</option>
                </select>
              </div>
              <div className="export-audio-row">
                <button
                  type="button"
                  onClick={() => onExportAudioSong(songFormat)}
                  disabled={songChainEmpty}
                >
                  Audio: Song Chain
                </button>
                <select
                  className="export-format-select"
                  value={songFormat}
                  onChange={(e) => setSongFormat(e.target.value as ExportFormat)}
                >
                  <option value="wav">WAV</option>
                  <option value="mp3">MP3 320k</option>
                </select>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}