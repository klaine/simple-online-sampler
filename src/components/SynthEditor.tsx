import { useRef, useCallback, useEffect } from 'react'
import { useStore, selectSelectedPad } from '../store'
import { KnobControl } from './KnobControl'
import type { SynthParams, SynthMode, LfoWaveform, LfoRateMode, LfoTriggerMode, VAOscWaveform, VAOscillatorParams } from '../types'
import { createDefaultSynthParams, createDefaultVAParams } from '../lib/utils'
import { renderSynthToBuffer } from '../lib/synthEngine'
import { encodeWav } from '../lib/wavEncode'

const VA_WAVEFORMS: { value: VAOscWaveform; label: string }[] = [
  { value: 'saw', label: 'Saw' },
  { value: 'square', label: 'Square' },
  { value: 'triangle', label: 'Tri' },
  { value: 'sine', label: 'Sine' },
]

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
    const w = rect.width; const h = rect.height
    const barCount = harmonics.length
    const gap = 2
    const barWidth = (w - gap * (barCount + 1)) / barCount
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0c0d12'; ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#1c1f26'; ctx.lineWidth = 0.5
    for (let i = 1; i < 4; i++) { const y = h * (i / 4); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
    for (let i = 0; i < barCount; i++) {
      const x = gap + i * (barWidth + gap)
      const barH = harmonics[i] * h; const y = h - barH
      const gradient = ctx.createLinearGradient(x, y, x, h)
      gradient.addColorStop(0, '#e8a832'); gradient.addColorStop(1, '#c4943a88')
      ctx.fillStyle = gradient; ctx.fillRect(x, y, barWidth, barH)
      ctx.strokeStyle = '#e8a83266'; ctx.lineWidth = 0.5; ctx.strokeRect(x, y, barWidth, barH)
      ctx.fillStyle = '#6b7280'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), x + barWidth / 2, h - 2)
    }
  }, [harmonics])

  useEffect(() => { draw() }, [draw])

  const getBarFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left; const y = e.clientY - rect.top
    const barCount = harmonics.length; const gap = 2
    const barWidth = (rect.width - gap * (barCount + 1)) / barCount
    const barIndex = Math.floor((x - gap) / (barWidth + gap))
    if (barIndex < 0 || barIndex >= barCount) return null
    return { barIndex, amplitude: Math.max(0, Math.min(1, 1 - y / rect.height)) }
  }, [harmonics.length])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId)
    const hit = getBarFromEvent(e)
    if (hit) { const next = [...harmonics]; next[hit.barIndex] = Math.round(hit.amplitude * 100) / 100; onChange(next) }
  }, [harmonics, onChange, getBarFromEvent])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const hit = getBarFromEvent(e)
    if (hit) { const next = [...harmonics]; next[hit.barIndex] = Math.round(hit.amplitude * 100) / 100; onChange(next) }
  }, [harmonics, onChange, getBarFromEvent])

  return (
    <canvas ref={canvasRef} className="harmonic-editor-canvas"
      onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
      onPointerUp={() => { dragging.current = false }} onPointerLeave={() => { dragging.current = false }}
      style={{ width: '100%', height: 80, cursor: 'crosshair', borderRadius: 'var(--radius-sm)' }} />
  )
}

function WaveformPreview({ harmonics }: { harmonics: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr)
    const w = rect.width; const h = rect.height; const samples = Math.ceil(w)
    const waveform = new Float32Array(samples); let peak = 0
    for (let x = 0; x < samples; x++) {
      const phase = (x / samples) * 2 * Math.PI; let val = 0
      for (let k = 0; k < harmonics.length; k++) { if (harmonics[k] > 0) val += harmonics[k] * Math.sin((k + 1) * phase) }
      waveform[x] = val; if (Math.abs(val) > peak) peak = Math.abs(val)
    }
    if (peak === 0) peak = 1
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
    ctx.strokeStyle = '#f5b83d'; ctx.lineWidth = 1.5; ctx.beginPath()
    for (let x = 0; x < samples; x++) { const y = h / 2 - (waveform[x] / peak) * (h / 2 - 2); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) }
    ctx.stroke()
  }, [harmonics])
  return <canvas ref={canvasRef} style={{ width: '100%', height: 40, borderRadius: 'var(--radius-sm)' }} />
}

function VAWavPreview({ synth }: { synth: SynthParams }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const va = synth.va!
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr)
    const w = rect.width; const h = rect.height; const samples = Math.ceil(w)
    const waveform = new Float32Array(samples)
    const baseFreq = 440 * Math.pow(2, (synth.baseNote - 69) / 12)
    let peak = 0
    let phase = 0; let phase2 = 0; let syncTrig = false
    const ow1 = ['saw','square','triangle','sine'].indexOf(va.osc1.waveform)
    const ow2 = ['saw','square','triangle','sine'].indexOf(va.osc2.waveform)
    const pw1 = va.osc1.pulseWidth; const pw2 = va.osc2.pulseWidth
    const m2 = (va.oscMix + 1) / 2; const m1 = 1 - m2
    const sr = 44100
    for (let x = 0; x < samples; x++) {
      phase += baseFreq / sr; if (phase >= 1) { phase -= 1; syncTrig = true }
      if (va.oscSync && syncTrig) phase2 = 0; syncTrig = false
      phase2 += baseFreq / sr; if (phase2 >= 1) phase2 -= 1
      const p = phase - Math.floor(phase); const p2 = phase2 - Math.floor(phase2)
      let s1 = 0; switch (ow1) { case 0: s1 = 2*p-1; break; case 1: s1 = p<pw1?1:-1; break; case 2: s1 = 4*Math.abs(p-0.5)-1; break; case 3: s1 = Math.sin(2*Math.PI*p); break }
      let s2 = 0; switch (ow2) { case 0: s2 = 2*p2-1; break; case 1: s2 = p2<pw2?1:-1; break; case 2: s2 = 4*Math.abs(p2-0.5)-1; break; case 3: s2 = Math.sin(2*Math.PI*p2); break }
      waveform[x] = s1 * m1 + s2 * m2
      if (Math.abs(waveform[x]) > peak) peak = Math.abs(waveform[x])
    }
    if (peak === 0) peak = 1
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke()
    ctx.strokeStyle = '#3bf5b8'; ctx.lineWidth = 1.5; ctx.beginPath()
    for (let x = 0; x < samples; x++) { const y = h / 2 - (waveform[x] / peak) * (h / 2 - 2); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) }
    ctx.stroke()
  }, [synth])
  return <canvas ref={canvasRef} style={{ width: '100%', height: 40, borderRadius: 'var(--radius-sm)' }} />
}

function VAOscControls({ label, osc, onChange }: { label: string; osc: VAOscillatorParams; onChange: (p: Partial<VAOscillatorParams>) => void }) {
  return (
    <div className="va-osc-section">
      <span className="synth-section-label">{label}</span>
      <div className="va-osc-controls">
        <select value={osc.waveform} onChange={(e) => onChange({ waveform: e.target.value as VAOscWaveform })}>
          {VA_WAVEFORMS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <KnobControl label="Semi" value={osc.semitones} min={-24} max={24} step={1} precision={0} onChange={(v) => onChange({ semitones: v })} />
        <KnobControl label="Fine" value={osc.fineCents} min={-100} max={100} step={1} precision={0} onChange={(v) => onChange({ fineCents: v })} />
        <KnobControl label="Level" value={osc.level} min={0} max={1} step={0.01} onChange={(v) => onChange({ level: v })} />
        {osc.waveform === 'square' && (
          <KnobControl label="PW" value={osc.pulseWidth} min={0.1} max={0.9} step={0.01} onChange={(v) => onChange({ pulseWidth: v })} />
        )}
      </div>
    </div>
  )
}

export function SynthModeSelector() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()
  if (!selectedPad || selectedPad.settings.source !== 'synth') return null
  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()
  const mode = synth.synthMode ?? 'additive'

  const setMode = (m: SynthMode) => {
    if (m === mode) return
    if (m === 'va' && !synth.va) {
      void updatePadSettings({ synthParams: { ...synth, synthMode: 'va', va: createDefaultVAParams() } })
    } else {
      void updatePadSettings({ synthParams: { ...synth, synthMode: m } })
    }
  }

  return (
    <div className="synth-mode-selector">
      <button type="button" className={mode === 'additive' ? 'active' : ''} onClick={() => setMode('additive')}>Additive</button>
      <button type="button" className={mode === 'va' ? 'active' : ''} onClick={() => setMode('va')}>Virtual Analog</button>
    </div>
  )
}

export function SynthHarmonicsEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()
  if (!selectedPad || selectedPad.settings.source !== 'synth') return null
  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()
  if ((synth.synthMode ?? 'additive') !== 'additive') return null
  const updateSynth = (partial: Partial<SynthParams>) => { void updatePadSettings({ synthParams: { ...synth, ...partial } }) }
  return (
    <div className="synth-editor">
      <div className="synth-section">
        <span className="synth-section-label">Harmonics</span>
        <HarmonicEditor harmonics={synth.harmonics} onChange={(h) => updateSynth({ harmonics: h })} />
        <WaveformPreview harmonics={synth.harmonics} />
        <div className="synth-base-note">
          <label>Base Note <input type="number" min={0} max={127} value={synth.baseNote} onChange={(e) => updateSynth({ baseNote: Number(e.target.value) })} className="synth-input-sm" /></label>
          <span className="synth-note-name">{midiNoteName(synth.baseNote)}</span>
        </div>
      </div>
    </div>
  )
}

export function SynthVAEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()
  if (!selectedPad || selectedPad.settings.source !== 'synth') return null
  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()
  if ((synth.synthMode ?? 'additive') !== 'va') return null
  const va = synth.va ?? createDefaultVAParams()
  const updateSynth = (partial: Partial<SynthParams>) => { void updatePadSettings({ synthParams: { ...synth, ...partial } }) }
  const updateVA = (partial: Partial<typeof va>) => { void updatePadSettings({ synthParams: { ...synth, va: { ...va, ...partial } } }) }

  return (
    <div className="synth-editor">
      <div className="synth-section">
        <div className="va-osc-grid">
          <VAOscControls label="OSC 1" osc={va.osc1} onChange={(p) => updateVA({ osc1: { ...va.osc1, ...p } })} />
          <VAOscControls label="OSC 2" osc={va.osc2} onChange={(p) => updateVA({ osc2: { ...va.osc2, ...p } })} />
        </div>
        <div className="va-mixer-section">
          <label className="va-sync-toggle">
            <input type="checkbox" checked={va.oscSync} onChange={(e) => updateVA({ oscSync: e.target.checked })} />
            <span>SYNC</span>
          </label>
          <KnobControl label="Mix" value={va.oscMix} min={-1} max={1} step={0.01} onChange={(v) => updateVA({ oscMix: v })} />
        </div>
        <VAWavPreview synth={synth} />
        <div className="va-voice-section">
          <label className="va-poly-toggle">
            <span>Voice</span>
            <select value={synth.polyMode ?? 'poly'} onChange={(e) => updateSynth({ polyMode: e.target.value as 'mono' | 'poly' })}>
              <option value="poly">Poly</option>
              <option value="mono">Mono</option>
            </select>
          </label>
          {(synth.polyMode ?? 'poly') === 'mono' && (
            <KnobControl label="Glide" value={va.glide} min={0} max={2} step={0.01} logScale onChange={(v) => updateVA({ glide: v })} />
          )}
        </div>
      </div>
    </div>
  )
}

/** Shared base note editor for VA mode (shown outside the VA editor) */
export function SynthBaseNoteEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()
  if (!selectedPad || selectedPad.settings.source !== 'synth') return null
  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()
  const updateSynth = (partial: Partial<SynthParams>) => { void updatePadSettings({ synthParams: { ...synth, ...partial } }) }
  return (
    <div className="synth-base-note">
      <label>Base Note <input type="number" min={0} max={127} value={synth.baseNote} onChange={(e) => updateSynth({ baseNote: Number(e.target.value) })} className="synth-input-sm" /></label>
      <span className="synth-note-name">{midiNoteName(synth.baseNote)}</span>
    </div>
  )
}

export function SynthLfoEditor() {
  const selectedPad = useStore(selectSelectedPad)
  const { updatePadSettings } = useStore.getState()
  if (!selectedPad || selectedPad.settings.source !== 'synth') return null
  const synth = selectedPad.settings.synthParams ?? createDefaultSynthParams()
  const isVA = (synth.synthMode ?? 'additive') === 'va'
  const updateSynth = (partial: Partial<SynthParams>) => { void updatePadSettings({ synthParams: { ...synth, ...partial } }) }
  const lfo = synth.lfo
  return (
    <div className="synth-editor">
      <div className="synth-section">
        <span className="synth-section-label">LFO</span>
        <div className="synth-lfo-row">
          <label>Wave <select value={lfo.waveform} onChange={(e) => updateSynth({ lfo: { ...lfo, waveform: e.target.value as LfoWaveform } })}>
            {LFO_WAVEFORMS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select></label>
          <label>Rate <select value={lfo.rateMode} onChange={(e) => updateSynth({ lfo: { ...lfo, rateMode: e.target.value as LfoRateMode } })}>
            <option value="free">Free</option><option value="sync">Sync</option>
          </select></label>
          <label>Trig <select value={lfo.triggerMode ?? 'free'} onChange={(e) => updateSynth({ lfo: { ...lfo, triggerMode: e.target.value as LfoTriggerMode } })}>
            <option value="free">Free</option><option value="trigger">Retrig</option>
          </select></label>
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
          {isVA && <KnobControl label="PW" value={lfo.pwDepth ?? 0} min={0} max={1} step={0.01} onChange={(v) => updateSynth({ lfo: { ...lfo, pwDepth: v } })} />}
        </div>
      </div>
      <button type="button" className="synth-export-btn" onClick={() => {
        const settings = selectedPad!.settings
        const { buffer, loopStart, loopEnd } = renderSynthToBuffer(synth, settings)
        const wavBlob = encodeWav(buffer, { startFrame: loopStart, endFrame: loopEnd })
        const filename = `${selectedPad!.name.replace(/\s+/g, '-')}-synth.wav`
        const file = new File([wavBlob], filename, { type: 'audio/wav' })
        const doDownload = async () => {
          if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file] }); return } catch (err) { if (err instanceof Error && err.name === 'AbortError') return }
          }
          const url = URL.createObjectURL(wavBlob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
        void doDownload()
        useStore.getState().addToast('Exported synth WAV', 'success')
      }}>Export Synth WAV</button>
    </div>
  )
}

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
