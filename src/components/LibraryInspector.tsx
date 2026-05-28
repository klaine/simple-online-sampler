import { useEffect, useRef, useState, memo } from 'react'
import { useStore, selectSampleToPadMap } from '../store'
import type { Pad, SampleAsset } from '../types'

interface InspectorProps {
  sample: SampleAsset
  onDismiss: () => void
  onNavigateToPad: (pad: Pad) => void
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  if (seconds < 60) return `${seconds.toFixed(2)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const InspectorWaveform = memo(function InspectorWaveform({ sample }: { sample: SampleAsset }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [peaks, setPeaks] = useState<number[]>([])

  useEffect(() => {
    let cancelled = false
    const decode = async () => {
      try {
        const ctx = new AudioContext()
        const buffer = await ctx.decodeAudioData(await sample.blob.arrayBuffer())
        void ctx.close().catch(() => undefined)
        if (cancelled) return
        const channel = buffer.getChannelData(0)
        const bucketCount = 300
        const bucketSize = Math.max(16, Math.floor(channel.length / bucketCount))
        const p = Array.from({ length: bucketCount }, (_, i) => {
          const start = i * bucketSize
          const end = Math.min(channel.length, start + bucketSize)
          let max = 0
          for (let c = start; c < end; c++) max = Math.max(max, Math.abs(channel[c]))
          return max
        })
        if (!cancelled) setPeaks(p)
      } catch {
        if (!cancelled) setPeaks([])
      }
    }
    void decode()
    return () => { cancelled = true }
  }, [sample.id, sample.blob])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const cssWidth = Math.max(1, Math.floor(canvas.clientWidth || 300))
      const cssHeight = Math.max(1, Math.floor(canvas.clientHeight || 48))
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.floor(cssWidth * pixelRatio)
      canvas.height = Math.floor(cssHeight * pixelRatio)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      if (peaks.length === 0) return
      const gradient = ctx.createLinearGradient(0, 0, 0, cssHeight)
      gradient.addColorStop(0, '#7cc5ff')
      gradient.addColorStop(1, '#2f89d8')
      ctx.fillStyle = gradient
      const barCount = Math.min(cssWidth, peaks.length)
      const samplesPerBar = peaks.length / barCount
      const centerY = cssHeight / 2
      for (let i = 0; i < barCount; i++) {
        const start = Math.floor(i * samplesPerBar)
        const end = Math.max(start + 1, Math.floor((i + 1) * samplesPerBar))
        let peak = 0
        for (let c = start; c < end; c++) peak = Math.max(peak, peaks[c] ?? 0)
        const halfH = Math.max(1, Math.floor(peak * cssHeight * 0.5))
        ctx.fillRect(i, centerY - halfH, 1, Math.max(2, halfH * 2))
      }
    }
    draw()
    const ro = new ResizeObserver(() => draw())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [peaks])

  return <canvas ref={canvasRef} className="inspector-wave-canvas" />
})

export function LibraryInspector({ sample, onDismiss, onNavigateToPad }: InspectorProps) {
  const sampleToPadMap = useStore(selectSampleToPadMap)
  const assignedPads = sampleToPadMap.get(sample.id) ?? []
  const {
    previewSample,
    previewSampleId,
    assignSampleToSelectedPad,
    openChopModal,
    deleteSampleFromLibrary,
  } = useStore((s) => ({
    previewSample: s.previewSample,
    previewSampleId: s.previewSampleId,
    assignSampleToSelectedPad: s.assignSampleToSelectedPad,
    openChopModal: s.openChopModal,
    deleteSampleFromLibrary: s.deleteSampleFromLibrary,
  }))
  const selectedPad = useStore((s) => {
    if (!s.project || !s.selectedPadId) return null
    return s.project.pads.find((p) => p.id === s.selectedPadId) ?? null
  })

  const [audioInfo, setAudioInfo] = useState<{ duration: number; sampleRate: number; channels: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const getInfo = async () => {
      try {
        const ctx = new AudioContext()
        const buffer = await ctx.decodeAudioData(await sample.blob.arrayBuffer())
        void ctx.close().catch(() => undefined)
        if (!cancelled) {
          setAudioInfo({
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
          })
        }
      } catch {
        if (!cancelled) setAudioInfo(null)
      }
    }
    void getInfo()
    return () => { cancelled = true }
  }, [sample.id, sample.blob])

  const isPreviewing = previewSampleId === sample.id
  const isMpc = sample.autosampleMpc === true
  const isBattery = sample.autosampleBattery === true
  const isLcdk = sample.autosampleLcdk === true
  const importedSettings = sample.autosampleImportedPadSettings

  return (
    <div className="library-inspector">
      <div className="inspector-header">
        <h3 className="inspector-title">{sample.name}</h3>
        <button type="button" className="inspector-close-btn" onClick={onDismiss} title="Close inspector">×</button>
      </div>

      <div className="inspector-waveform">
        <InspectorWaveform sample={sample} />
      </div>

      <div className="inspector-controls">
        <button
          type="button"
          className={`inspector-play-btn${isPreviewing ? ' active' : ''}`}
          onClick={() => void previewSample(sample)}
        >
          {isPreviewing ? '■ Stop' : '▶ Play'}
        </button>
      </div>

      <div className="inspector-props">
        <div className="inspector-prop">
          <span className="inspector-prop-label">Size</span>
          <span className="inspector-prop-value">{formatSize(sample.size)}</span>
        </div>
        {audioInfo && (
          <>
            <div className="inspector-prop">
              <span className="inspector-prop-label">Duration</span>
              <span className="inspector-prop-value">{formatDuration(audioInfo.duration)}</span>
            </div>
            <div className="inspector-prop">
              <span className="inspector-prop-label">Sample Rate</span>
              <span className="inspector-prop-value">{(audioInfo.sampleRate / 1000).toFixed(1)} kHz</span>
            </div>
            <div className="inspector-prop">
              <span className="inspector-prop-label">Channels</span>
              <span className="inspector-prop-value">{audioInfo.channels === 1 ? 'Mono' : audioInfo.channels === 2 ? 'Stereo' : audioInfo.channels}</span>
            </div>
          </>
        )}
        <div className="inspector-prop">
          <span className="inspector-prop-label">Format</span>
          <span className="inspector-prop-value">{sample.mimeType.replace('audio/', '').toUpperCase()}</span>
        </div>
      </div>

      {assignedPads.length > 0 && (
        <div className="inspector-section">
          <h4 className="inspector-section-title">Assigned Pads</h4>
          <div className="inspector-pad-list">
            {assignedPads.map((pad) => (
              <button
                key={pad.id}
                type="button"
                className="inspector-pad-badge"
                onClick={() => onNavigateToPad(pad)}
              >
                B{pad.bank + 1}·{pad.slot + 1} <em>{pad.name}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {(isMpc || isBattery || isLcdk) && (
        <div className="inspector-section">
          <h4 className="inspector-section-title">Imported Settings</h4>
          <div className="inspector-imported">
            {sample.autosampleChokeGroup != null && sample.autosampleChokeGroup > 0 && (
              <div className="inspector-prop">
                <span className="inspector-prop-label">Choke</span>
                <span className="inspector-prop-value">Group {sample.autosampleChokeGroup}</span>
              </div>
            )}
            {sample.autosamplePadIndex != null && (
              <div className="inspector-prop">
                <span className="inspector-prop-label">Pad Index</span>
                <span className="inspector-prop-value">{sample.autosamplePadIndex + 1}</span>
              </div>
            )}
            {importedSettings && (
              <>
                {importedSettings.pan != null && (
                  <div className="inspector-prop">
                    <span className="inspector-prop-label">Pan</span>
                    <span className="inspector-prop-value">{importedSettings.pan > 0 ? `R${importedSettings.pan}` : importedSettings.pan < 0 ? `L${-importedSettings.pan}` : 'C'}</span>
                  </div>
                )}
                {importedSettings.level != null && (
                  <div className="inspector-prop">
                    <span className="inspector-prop-label">Level</span>
                    <span className="inspector-prop-value">{Math.round(importedSettings.level * 100)}%</span>
                  </div>
                )}
                {importedSettings.semitones != null && importedSettings.semitones !== 0 && (
                  <div className="inspector-prop">
                    <span className="inspector-prop-label">Tune</span>
                    <span className="inspector-prop-value">{importedSettings.semitones > 0 ? '+' : ''}{importedSettings.semitones} st</span>
                  </div>
                )}
                {importedSettings.filterType && importedSettings.filterType !== 'off' && (
                  <div className="inspector-prop">
                    <span className="inspector-prop-label">Filter</span>
                    <span className="inspector-prop-value">{importedSettings.filterType}{importedSettings.filterFreq ? ` ${Math.round(importedSettings.filterFreq)} Hz` : ''}</span>
                  </div>
                )}
                {importedSettings.playMode && (
                  <div className="inspector-prop">
                    <span className="inspector-prop-label">Mode</span>
                    <span className="inspector-prop-value">{importedSettings.playMode}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {sample.metadataTags && Object.keys(sample.metadataTags).length > 0 && (
        <div className="inspector-section">
          <h4 className="inspector-section-title">Metadata</h4>
          <div className="inspector-tags">
            {Object.entries(sample.metadataTags).map(([k, v]) => (
              <div key={k} className="inspector-prop">
                <span className="inspector-prop-label">{k}</span>
                <span className="inspector-prop-value">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="inspector-actions">
        <button
          type="button"
          className="inspector-action-btn"
          disabled={!selectedPad}
          onClick={() => void assignSampleToSelectedPad(sample)}
          title={selectedPad ? `Assign to ${selectedPad.name}` : 'No pad selected'}
        >
          + Assign to Pad
        </button>
        <button
          type="button"
          className="inspector-action-btn"
          onClick={() => openChopModal(sample.id)}
        >
          ✂ Chop
        </button>
        <button
          type="button"
          className="inspector-action-btn inspector-action-danger"
          onClick={() => void deleteSampleFromLibrary(sample)}
        >
          × Delete
        </button>
      </div>
    </div>
  )
}
