import { useRef, useCallback, useEffect } from 'react'
import { useStore, selectSelectedPad } from '../store'
import { KnobControl } from './KnobControl'
import type { SynthParams, LfoWaveform, LfoRateMode } from '../types'
import { createDefaultSynthParams } from '../lib/utils'
import { renderSynthToBuffer } from '../lib/synthEngine'
import { encodeWav } from '../lib/wavEncode'

/**
 * Harmonic bar editor — 16 vertical bars representing partial amplitudes.
 * User can click/drag to set amplitudes.
 */
function HarmonicEditor({ harmonics, onChange }: { harmonics: number[]; onChange: (h: number[]) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const w = rect.width
    const h = rect.height
    const barCount = harmonics.length
    const gap = 2
    const barWidth = (w - gap * (barCount + 1)) / barCount

    ctx.clearRect(0, 0, w, h)

    // Background
    ctx.fillStyle = '#0c0d12'
    ctx.fillRect(0, 0, w, h)

    // Grid lines
    ctx.strokeStyle = '#1c1f26'
    ctx.lineWidth = 0.5
    for (let i = 1; i < 4; i++) {
      const y = h * (i / 4)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    // Bars
    for (let i = 0; i < barCount; i++) {
      const x = gap + i * (barWidth + gap)
      const barH = harmonics[i] * h
      const y = h - barH

      // Bar fill
      const gradient = ctx.createLinearGradient(x, y, x, h)
      gradient.addColorStop(0, '#e8a832')
      gradient.addColorStop(1, '#c4943a88')
      ctx.fillStyle = gradient
      ctx.fillRect(x, y, barWidth, barH)

      // Bar outline
      ctx.strokeStyle = '#e8a83266'
      ctx.lineWidth = 0.5
      ctx.strokeRect(x, y, barWidth, barH)

      // Label
      ctx.fillStyle = '#6b7280'
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), x + barWidth / 2, h - 2)
    }
  }, [harmonics])

  useEffect(() => { draw() }, [draw])

  const getBarFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const barCount = harmonics.length
    const gap = 2
    const barWidth = (rect.width - gap * (barCount + 1)) / barCount
    const barIndex = Math.floor((x - gap) / (barWidth + gap))
    if (barIndex < 0 || barIndex >= barCount) return null
    const amplitude = Math.max(0, Math.min(1, 1 - y / rect.height))
    return { barIndex, amplitude }
  }, [harmonics.length])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    const hit = getBarFromEvent(e)
    if (hit) {
      const next = [...harmonics]
      next[hit.barIndex] = Math.round(hit.amplitude * 100) / 100
      onChange(next)
    }
  }, [harmonics, onChange, getBarFromEvent])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const hit = getBarFromEvent(e)
    if (hit) {
      const next = [...harmonics]
      next[hit.barIndex] = Math.round(hit.amplitude * 100) / 100
      onChange(next)
    }
  }, [harmonics, onChange, getBarFromEvent])

  const handlePointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="harmonic-editor-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{ width: '100%', height: 80, cursor: 'crosshair', borderRadius: 'var(--radius-sm)' }}
    />
  )
}

/** Renders one cycle of the additive synthesis waveform from harmonic amplitudes. */
function WaveformPreview({ harmonics }: { harmonics: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const w = rect.width
    const h = rect.height
    const samples = Math.ceil(w)

    // Compute one cycle of additive waveform
    const waveform = new Float32Array(samples)
    let peak = 0
    for (let x = 0; x < samples; x++) {
      const phase = (x / samples) * 2 * Math.PI
      let val = 0
      for (let k = 0; k < harmonics.length; k++) {
        if (harmonics[k] > 0) {
          val += harmonics[k] * Math.sin((k + 1) * phase)
        }
      }
      waveform[x] = val
      if (Math.abs(val) > peak) peak = Math.abs(val)
    }
    if (peak === 0) peak = 1

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, 0, w, h)

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()

    // Waveform
    ctx.strokeStyle = '#f5b83d'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x < samples; x++) {
      const y = h / 2 - (waveform[x] / peak) * (h / 2 - 2)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [harmonics])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 40, borderRadius: 'var(--radius-sm)' }}
    />
  )
}

const LFO_WAVEFORMS: { value: LfoWaveform; label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'ramp-up', label: 'Ramp Up' },
  { value: 'ramp-down', label: 'Ramp Down' },
  { value: 'square', label: 'Square' },
]

const LFO_SYNC_DIVS = [
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8, label: '1/8' },
  { value: 16, label: '1/16' },
]

export function SynthHarmonicsEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()

  if (!selectedPad || selectedPad.settings.source !== 'synth') return null

  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()

  const updateSynth = (partial: Partial<SynthParams>) => {
    void updatePadSettings({ synthParams: { ...synth, ...partial } })
  }

  return (
    <div className="synth-editor">
      <div className="synth-section">
        <span className="synth-section-label">Harmonics</span>
        <HarmonicEditor
          harmonics={synth.harmonics}
          onChange={(harmonics) => updateSynth({ harmonics })}
        />
        <WaveformPreview harmonics={synth.harmonics} />
        <div className="synth-base-note">
          <label>
            Base Note
            <input
              type="number"
              min={0}
              max={127}
              value={synth.baseNote}
              onChange={(e) => updateSynth({ baseNote: Number(e.target.value) })}
              className="synth-input-sm"
            />
          </label>
          <span className="synth-note-name">{midiNoteName(synth.baseNote)}</span>
        </div>
      </div>
    </div>
  )
}

export function SynthLfoEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()

  if (!selectedPad || selectedPad.settings.source !== 'synth') return null

  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()

  const updateSynth = (partial: Partial<SynthParams>) => {
    void updatePadSettings({ synthParams: { ...synth, ...partial } })
  }

  const lfo = synth.lfo

  return (
    <div className="synth-editor">
      <div className="synth-section">
        <span className="synth-section-label">LFO</span>
        <div className="synth-lfo-row">
          <label>
            Wave
            <select value={lfo.waveform} onChange={(e) => updateSynth({ lfo: { ...lfo, waveform: e.target.value as LfoWaveform } })}>
              {LFO_WAVEFORMS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </label>
          <label>
            Rate
            <select value={lfo.rateMode} onChange={(e) => updateSynth({ lfo: { ...lfo, rateMode: e.target.value as LfoRateMode } })}>
              <option value="free">Free</option>
              <option value="sync">Sync</option>
            </select>
          </label>
        </div>
        <div className="knob-row">
          {lfo.rateMode === 'free' ? (
            <KnobControl label="Rate Hz" value={lfo.rateHz} min={0.1} max={30} step={0.1} precision={1} onChange={(v) => updateSynth({ lfo: { ...lfo, rateHz: v } })} />
          ) : (
            <div className="knob-control">
              <select className="synth-sync-select" value={lfo.rateSyncDiv} onChange={(e) => updateSynth({ lfo: { ...lfo, rateSyncDiv: Number(e.target.value) } })}>
                {LFO_SYNC_DIVS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <span className="knob-label">Div</span>
            </div>
          )}
          <KnobControl label="Pitch" value={lfo.pitchDepth ?? 0} min={0} max={1} step={0.01} onChange={(v) => updateSynth({ lfo: { ...lfo, pitchDepth: v } })} />
          <KnobControl label="Filter" value={lfo.filterDepth ?? 0} min={0} max={1} step={0.01} onChange={(v) => updateSynth({ lfo: { ...lfo, filterDepth: v } })} />
          <KnobControl label="Gain" value={lfo.gainDepth ?? 0} min={0} max={1} step={0.01} onChange={(v) => updateSynth({ lfo: { ...lfo, gainDepth: v } })} />
        </div>
      </div>

      <button
        type="button"
        className="synth-export-btn"
        onClick={() => {
          const settings = selectedPad!.settings
          const { buffer, loopStart, loopEnd } = renderSynthToBuffer(synth, settings)
          const wavBlob = encodeWav(buffer, { startFrame: loopStart, endFrame: loopEnd })
          const filename = `${selectedPad!.name.replace(/\s+/g, '-')}-synth.wav`
          const file = new File([wavBlob], filename, { type: 'audio/wav' })
          const doDownload = async () => {
            if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
              try { await navigator.share({ files: [file] }); return } catch (err) { if (err instanceof Error && err.name === 'AbortError') return }
            }
            const url = URL.createObjectURL(wavBlob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
          }
          void doDownload()
          useStore.getState().addToast('Exported synth WAV', 'success')
        }}
      >
        Export Synth WAV
      </button>
    </div>
  )
}

/** @deprecated Use SynthHarmonicsEditor + SynthLfoEditor instead */
export function SynthEditor() {
  return (
    <>
      <SynthHarmonicsEditor />
      <SynthLfoEditor />
    </>
  )
}

function midiNoteName(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const octave = Math.floor(note / 12) - 1
  return `${names[note % 12]}${octave}`
}
