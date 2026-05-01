import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import type { BusId, SampleLayer, TrimSettings } from '../types'
import { startPcmCapture, computePeaks, RECORDER_SAMPLE_RATE, type PcmRecorderSession } from '../lib/pcmRecorder'
import { audioEngine } from '../lib/audioEngine'
import { sendMidiNote, sendMidiNoteOff } from '../lib/midiOut'
import { computeSilenceTrim, normalizePcm } from '../lib/autotrim'
import { midiToName, uid } from '../lib/utils'
import { BANK_COUNT, PADS_PER_BANK } from '../lib/constants'
import { DEVICE_DRUMKITS, getDeviceDrumkit, getDrumName, getDrumChokeGroup, getDrumPadIndex } from '../lib/deviceDrumkits'
import type { DeviceDrumkit } from '../lib/deviceDrumkits'

type NoteMode = 'range' | 'scale' | 'custom' | 'drumkit'
type ScaleType = 'major' | 'minor'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const SCALE_INTERVALS: Record<ScaleType, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
}

/** Build the note list for a given scale config */
function buildScaleNotes(root: number, scaleType: ScaleType, octaveStart: number, octaves: number): number[] {
  const intervals = SCALE_INTERVALS[scaleType]
  const notes: number[] = []
  for (let oct = 0; oct < octaves; oct++) {
    for (const interval of intervals) {
      const note = (octaveStart + oct) * 12 + root + interval
      if (note >= 0 && note <= 127) notes.push(note)
    }
  }
  // Add the octave-up root to complete the scale
  const topNote = (octaveStart + octaves) * 12 + root
  if (topNote >= 0 && topNote <= 127 && !notes.includes(topNote)) notes.push(topNote)
  return notes
}

/**
 * Compute velocity layer splits for N layers.
 * Returns array of { velocity, velocityLow, velocityHigh } sorted low to high.
 * E.g. 2 layers: [{vel:63, low:1, high:63}, {vel:127, low:64, high:127}]
 * E.g. 3 layers: [{vel:42, low:1, high:42}, {vel:85, low:43, high:85}, {vel:127, low:86, high:127}]
 */
function computeVelocitySplits(layerCount: number): Array<{ velocity: number; velocityLow: number; velocityHigh: number }> {
  if (layerCount <= 1) return [{ velocity: 127, velocityLow: 1, velocityHigh: 127 }]
  const splits: Array<{ velocity: number; velocityLow: number; velocityHigh: number }> = []
  const rangeSize = Math.floor(127 / layerCount)
  for (let i = 0; i < layerCount; i++) {
    const low = i === 0 ? 1 : splits[i - 1].velocityHigh + 1
    const high = i === layerCount - 1 ? 127 : low + rangeSize - 1
    // Velocity to send = midpoint of range, except last layer always sends 127
    const velocity = i === layerCount - 1 ? 127 : Math.round((low + high) / 2)
    splits.push({ velocity, velocityLow: low, velocityHigh: high })
  }
  return splits
}

interface AutosampleConfig {
  outputId: string
  inputDeviceId: string
  channel: number
  startNote: number
  noteCount: number
  noteStep: number
  velocity: number
  velocityLayers: number
  noteDurationMs: number
  releaseTailMs: number
  thresholdDb: number
  startBank: number
  startSlot: number
  namePattern: string
  normalize: boolean
  autoTrim: boolean
  autoCrop: boolean
  bus: BusId
  chokeEnabled: boolean
  chokeGroup: number
}

const DEFAULT_CONFIG: AutosampleConfig = {
  outputId: '',
  inputDeviceId: '',
  channel: 1,
  startNote: 60,  // C4
  noteCount: 12,
  noteStep: 1,
  velocity: 100,
  velocityLayers: 1,
  noteDurationMs: 1500,
  releaseTailMs: 1000,
  thresholdDb: -60,
  startBank: 0,
  startSlot: 0,
  namePattern: 'AS_{seq}_{note}',
  normalize: true,
  autoTrim: true,
  autoCrop: false,
  bus: 'A' as BusId,
  chokeEnabled: false,
  chokeGroup: 1,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getPadName(pattern: string, note: number, seq: number): string {
  const seqStr = String(seq).padStart(3, '0')
  return pattern.replace('{note}', midiToName(note)).replace('{seq}', seqStr)
}

/** Create a SampleLayer matching the store's createLayer helper */
function makeSampleLayer(sampleId: string, velocityLow: number, velocityHigh: number, trim?: TrimSettings): SampleLayer {
  return {
    id: uid(),
    sampleId,
    velocityLow,
    velocityHigh,
    gain: null,
    semitones: null,
    fineCents: null,
    trim: trim ?? null,
    envelope: null,
    filterType: null,
    filterFreq: null,
    filterQ: null,
    stackOffsetMs: null,
  }
}

const STORAGE_KEY = 'autosampleSettings'

interface PersistedAutosampleState {
  config: Partial<AutosampleConfig>
  noteMode: NoteMode
  drumkitId?: string
  drumkitLabel?: string
  scaleRoot: number
  scaleType: ScaleType
  scaleOctaveStart: number
  scaleOctaves: number
  customNotes: number[]
}

function loadPersistedState(): PersistedAutosampleState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PersistedAutosampleState
  } catch { return null }
}

function savePersistedState(state: PersistedAutosampleState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* */ }
}

export function AutosampleDialog() {
  const project = useStore((s) => s.project)
  const midiOutputs = useStore((s) => s.midiOutputs)
  const { closeAutosampleDialog, createSampleFromPcm, assignSampleIdToPad, addToast } = useStore.getState()

  const [phase, setPhase] = useState<'setup' | 'running' | 'done'>('setup')
  const persisted = loadPersistedState()
  const [config, setConfig] = useState<AutosampleConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...persisted?.config,
    outputId: persisted?.config?.outputId || midiOutputs[0]?.id || '',
    inputDeviceId: persisted?.config?.inputDeviceId || '',
  }))
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentNote, setCurrentNote] = useState<number | null>(null)
  const [currentLayer, setCurrentLayer] = useState<number | null>(null)
  const [lastPeaks, setLastPeaks] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [completedCount, setCompletedCount] = useState(0)

  // Note mode state
  const [noteMode, setNoteMode] = useState<NoteMode>(persisted?.noteMode ?? 'range')
  const [drumkitId, setDrumkitId] = useState<string>(persisted?.drumkitId ?? 'mc707')
  const [drumkitLabel, setDrumkitLabel] = useState<string>(persisted?.drumkitLabel ?? '')
  const [scaleRoot, setScaleRoot] = useState(persisted?.scaleRoot ?? 0)
  const [scaleType, setScaleType] = useState<ScaleType>(persisted?.scaleType ?? 'major')
  const [scaleOctaveStart, setScaleOctaveStart] = useState(persisted?.scaleOctaveStart ?? 3)
  const [scaleOctaves, setScaleOctaves] = useState(persisted?.scaleOctaves ?? 2)
  const [customNotes, setCustomNotes] = useState<number[]>(persisted?.customNotes ?? [])
  const [customNoteInput, setCustomNoteInput] = useState(60)
  const [midiLearnActive, setMidiLearnActive] = useState(false)

  const cancelRef = useRef(false)
  const sessionRef = useRef<PcmRecorderSession | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const midiAccessRef = useRef<MIDIAccess | null>(null)
  const midiListenersRef = useRef<Array<{ input: MIDIInput; handler: (e: MIDIMessageEvent) => void }>>([])

  // Active drumkit (if in drumkit mode)
  const activeKit: DeviceDrumkit | undefined = noteMode === 'drumkit' ? getDeviceDrumkit(drumkitId) : undefined

  // Compute the note list based on current mode
  const computeNoteList = useCallback((): number[] => {
    switch (noteMode) {
      case 'range': {
        const notes: number[] = []
        for (let i = 0; i < config.noteCount; i++) {
          const n = config.startNote + i * config.noteStep
          if (n >= 0 && n <= 127) notes.push(n)
        }
        return notes
      }
      case 'scale':
        return buildScaleNotes(scaleRoot, scaleType, scaleOctaveStart, scaleOctaves)
      case 'custom':
        return [...customNotes].sort((a, b) => a - b)
      case 'drumkit': {
        const kit = getDeviceDrumkit(drumkitId)
        return kit ? kit.pads.map((p) => p.note) : []
      }
    }
  }, [noteMode, config.startNote, config.noteCount, config.noteStep, scaleRoot, scaleType, scaleOctaveStart, scaleOctaves, customNotes, drumkitId])

  // Enumerate audio input devices
  useEffect(() => {
    const enumerate = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop())
        const devices = await navigator.mediaDevices.enumerateDevices()
        setInputDevices(devices.filter((d) => d.kind === 'audioinput'))
      } catch {
        // ignore — user will see no device options
      }
    }
    void enumerate()
  }, [])

  // MIDI Learn: attach/detach listeners
  useEffect(() => {
    if (!midiLearnActive) {
      for (const { input, handler } of midiListenersRef.current) {
        input.removeEventListener('midimessage', handler as EventListener)
      }
      midiListenersRef.current = []
      return
    }

    const startListening = async () => {
      try {
        if (!midiAccessRef.current) {
          midiAccessRef.current = await navigator.requestMIDIAccess()
        }
        const access = midiAccessRef.current
        const inputs = Array.from(access.inputs.values())
        for (const input of inputs) {
          const handler = (e: MIDIMessageEvent) => {
            const data = e.data
            if (!data || data.length < 3) return
            const status = data[0] & 0xf0
            const note = data[1]
            const vel = data[2]
            if (status === 0x90 && vel > 0 && note >= 0 && note <= 127) {
              setCustomNotes((prev) => prev.includes(note) ? prev : [...prev, note])
            }
          }
          input.addEventListener('midimessage', handler as EventListener)
          midiListenersRef.current.push({ input, handler })
        }
      } catch {
        addToast('Failed to access MIDI inputs for learn mode', 'error')
        setMidiLearnActive(false)
      }
    }
    void startListening()

    return () => {
      for (const { input, handler } of midiListenersRef.current) {
        input.removeEventListener('midimessage', handler as EventListener)
      }
      midiListenersRef.current = []
    }
  }, [midiLearnActive, addToast])

  // Draw preview waveform
  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas || lastPeaks.length === 0) return
    const w = canvas.width
    const h = canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    const gradient = ctx.createLinearGradient(0, 0, 0, h)
    gradient.addColorStop(0, '#7cc5ff')
    gradient.addColorStop(1, '#2f89d8')
    ctx.fillStyle = gradient
    const barCount = Math.min(w, lastPeaks.length)
    const samplesPerBar = lastPeaks.length / barCount
    const centerY = h / 2
    for (let i = 0; i < barCount; i++) {
      const start = Math.floor(i * samplesPerBar)
      const end = Math.max(start + 1, Math.floor((i + 1) * samplesPerBar))
      let peak = 0
      for (let c = start; c < end; c++) peak = Math.max(peak, lastPeaks[c] ?? 0)
      const halfH = Math.max(1, Math.floor(peak * h * 0.45))
      ctx.fillRect(i, centerY - halfH, 1, halfH * 2)
    }
  }, [lastPeaks])

  // Calculate effective note count (clamped to available pads)
  const getEffectiveNotes = useCallback((): number[] => {
    if (!project) return []
    const noteList = computeNoteList()
    const startIndex = config.startBank * PADS_PER_BANK + config.startSlot
    const available = BANK_COUNT * PADS_PER_BANK - startIndex
    return noteList.slice(0, available)
  }, [project, computeNoteList, config.startBank, config.startSlot])

  const cfg = (patch: Partial<AutosampleConfig>) => setConfig((c) => ({ ...c, ...patch }))

  // Persist settings to localStorage on change
  useEffect(() => {
    savePersistedState({ config, noteMode, drumkitId, drumkitLabel, scaleRoot, scaleType, scaleOctaveStart, scaleOctaves, customNotes })
  }, [config, noteMode, drumkitId, drumkitLabel, scaleRoot, scaleType, scaleOctaveStart, scaleOctaves, customNotes])

  const resetSettings = useCallback(() => {
    setConfig({ ...DEFAULT_CONFIG, outputId: midiOutputs[0]?.id ?? '', inputDeviceId: config.inputDeviceId })
    setNoteMode('range')
    setScaleRoot(0)
    setScaleType('major')
    setScaleOctaveStart(3)
    setScaleOctaves(2)
    setCustomNotes([])
    localStorage.removeItem(STORAGE_KEY)
  }, [midiOutputs, config.inputDeviceId])

  const veloSplits = computeVelocitySplits(config.velocityLayers)

  const handleStart = useCallback(async () => {
    if (!project) return
    setError(null)
    cancelRef.current = false
    setMidiLearnActive(false)

    const noteList = getEffectiveNotes()
    if (noteList.length === 0) {
      setError('No notes to sample (empty note list or no available pads).')
      return
    }

    const splits = computeVelocitySplits(config.velocityLayers)
    const totalSamples = noteList.length * splits.length

    setPhase('running')
    setProgress(0)
    setTotal(totalSamples)
    setCompletedCount(0)

    const runId = uid()
    const runLabel = noteMode === 'drumkit' && activeKit
      ? (drumkitLabel.trim() || activeKit.label)
      : config.namePattern.replace(/\{note\}/g, '').replace(/\{seq\}/g, '').replace(/_+$/, '').replace(/_+/g, '_') || 'Autosample'

    // Start audio capture
    let session: PcmRecorderSession
    try {
      session = await startPcmCapture(config.inputDeviceId || null, audioEngine.getContextIfReady() ?? undefined)
      sessionRef.current = session
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open audio input')
      setPhase('setup')
      return
    }

    // Let audio stream settle
    await sleep(150)
    session.pcmChunks.length = 0

    let completed = 0
    let sampleIndex = 0
    const useVeloLayers = splits.length > 1

    for (let i = 0; i < noteList.length; i++) {
      if (cancelRef.current) break

      const note = noteList[i]
      const padIndex = config.startBank * PADS_PER_BANK + config.startSlot + i
      const bank = Math.floor(padIndex / PADS_PER_BANK)
      const slot = padIndex % PADS_PER_BANK
      const pad = project.pads.find((p) => p.bank === bank && p.slot === slot)
      if (!pad) continue

      setCurrentNote(note)

      // Collect layers for this note
      const layers: SampleLayer[] = []
      let firstSampleId: string | null = null
      let lastTrim = { start: 0, end: 1 }
      let noteCompleted = true

      for (let v = 0; v < splits.length; v++) {
        if (cancelRef.current) { noteCompleted = false; break }

        const split = splits[v]
        const sendVel = useVeloLayers ? split.velocity : config.velocity

        setCurrentLayer(useVeloLayers ? v + 1 : null)

        // Clear PCM buffer and wait briefly to discard any residual audio
        session.pcmChunks.length = 0
        await sleep(50)
        session.pcmChunks.length = 0

        // Send note-on
        const outputId = config.outputId || null
        sendMidiNote(outputId, config.channel, note, sendVel, null, `as:${sampleIndex}`)

        await sleep(config.noteDurationMs)
        if (cancelRef.current) {
          sendMidiNoteOff(outputId, config.channel, note, `as:${sampleIndex}`)
          noteCompleted = false
          break
        }

        sendMidiNoteOff(outputId, config.channel, note, `as:${sampleIndex}`)
        await sleep(config.releaseTailMs)

        const pcm = session.flush()
        if (config.normalize) normalizePcm(pcm)
        const rawTrim = config.autoTrim || config.autoCrop
          ? computeSilenceTrim(pcm, RECORDER_SAMPLE_RATE, config.thresholdDb)
          : { start: 0, end: 1 }

        // Auto-crop: slice PCM to trim boundaries, discard silent head/tail
        let finalPcm = pcm
        let trim = rawTrim
        if (config.autoCrop && (rawTrim.start > 0 || rawTrim.end < 1)) {
          const cropStart = Math.floor(rawTrim.start * pcm.length)
          const cropEnd = Math.ceil(rawTrim.end * pcm.length)
          finalPcm = pcm.slice(cropStart, cropEnd)
          trim = { start: 0, end: 1 }
        }
        lastTrim = trim

        const peaks = computePeaks(finalPcm, 200)
        setLastPeaks(peaks)

        try {
          const veloLabel = useVeloLayers ? `_v${split.velocity}` : ''
          // Drumkit mode: use drum name; other modes: use name pattern
          const drumName = activeKit ? getDrumName(activeKit, note) : undefined
          const baseName = drumName
            ? `${runLabel}_${drumName}`
            : getPadName(config.namePattern, note, i + 1)
          const sampleName = `${baseName}${veloLabel}.wav`
          const drumPadIndex = activeKit ? getDrumPadIndex(activeKit, note) : undefined
          const drumChokeGroup = activeKit ? getDrumChokeGroup(activeKit, note) : undefined
          const sampleId = await createSampleFromPcm([finalPcm], RECORDER_SAMPLE_RATE, sampleName, {
            autosampleRunId: runId,
            autosampleRunLabel: runLabel,
            autosampleTrim: trim,
            autosampleBus: config.bus,
            autosampleChokeGroup: drumChokeGroup ?? (config.chokeEnabled ? config.chokeGroup : 0),
            ...(drumPadIndex != null && drumPadIndex >= 0 ? { autosamplePadIndex: drumPadIndex } : {}),
          })

          if (v === 0) firstSampleId = sampleId

          if (useVeloLayers) {
            layers.push(makeSampleLayer(sampleId, split.velocityLow, split.velocityHigh, trim))
          }
        } catch (err) {
          addToast(`Failed to save ${midiToName(note)} vel ${sendVel}: ${err instanceof Error ? err.message : 'error'}`, 'error')
        }

        sampleIndex++
        setProgress(sampleIndex)
      }

      // Assign to pad
      if (noteCompleted && firstSampleId) {
        try {
          const drumName = activeKit ? getDrumName(activeKit, note) : undefined
          const padLabel = drumName
            ? `${runLabel}_${drumName}`
            : getPadName(config.namePattern, note, i + 1)
          await assignSampleIdToPad(pad.id, firstSampleId, padLabel)

          const st = useStore.getState()
          if (st.project) {
            const drumChokeGroup = activeKit ? getDrumChokeGroup(activeKit, note) : undefined
            const padSettings: Record<string, unknown> = {
              trim: useVeloLayers ? { start: 0, end: 1 } : lastTrim,  // layers carry per-layer trim
              semitones: 0,
              bus: config.bus,
              chokeGroup: drumChokeGroup ?? (config.chokeEnabled ? config.chokeGroup : 0),
            }
            if (useVeloLayers) {
              padSettings.layers = layers
              padSettings.multiMode = 'velocity'
            }
            await st.saveProject({
              ...st.project,
              pads: st.project.pads.map((p) =>
                p.id === pad.id
                  ? { ...p, settings: { ...p.settings, ...padSettings } }
                  : p,
              ),
            })
          }
          completed++
        } catch (err) {
          addToast(`Failed to assign ${midiToName(note)}: ${err instanceof Error ? err.message : 'error'}`, 'error')
        }
      }

      setCompletedCount(completed)
    }

    session.stop()
    sessionRef.current = null
    setCurrentNote(null)
    setCurrentLayer(null)
    setPhase('done')
    if (!cancelRef.current) {
      addToast(`Auto-sample complete: ${completed} note(s) assigned`, 'success')
    }
  }, [project, config, noteMode, activeKit, getEffectiveNotes, createSampleFromPcm, assignSampleIdToPad, addToast])

  const handleCancel = useCallback(() => {
    cancelRef.current = true
    sessionRef.current?.stop()
    sessionRef.current = null
  }, [])

  const handleClose = useCallback(() => {
    cancelRef.current = true
    sessionRef.current?.stop()
    sessionRef.current = null
    setMidiLearnActive(false)
    closeAutosampleDialog()
  }, [closeAutosampleDialog])

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'running') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, handleClose])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelRef.current = true
      if (sessionRef.current) {
        sessionRef.current.stop()
        sessionRef.current = null
      }
    }
  }, [])

  const effectiveNotes = getEffectiveNotes()
  const effectiveCount = effectiveNotes.length
  const fullNoteList = computeNoteList()
  const overflowClamped = fullNoteList.length > effectiveCount && effectiveCount > 0
  const totalSamples = effectiveCount * config.velocityLayers

  const summaryRange = effectiveCount > 0
    ? `${midiToName(effectiveNotes[0])}–${midiToName(effectiveNotes[effectiveCount - 1])}`
    : ''

  return (
    <section className="import-dialog-overlay" role="dialog" aria-modal="true">
      <div className="import-dialog autosample-dialog">
        <div className="import-dialog-head">
          <h2>Auto-Sample External Gear</h2>
          {phase !== 'running' && (
            <>
              <button type="button" className="tb-secondary" onClick={resetSettings} title="Reset all settings to defaults">Reset</button>
              <button type="button" onClick={handleClose}>Close</button>
            </>
          )}
        </div>

        {error && <div className="record-error"><p>{error}</p></div>}

        {/* ---- Setup ---- */}
        {phase === 'setup' && (
          <div className="autosample-setup">
            <div className="autosample-grid">
              {/* MIDI Out */}
              <fieldset className="autosample-fieldset">
                <legend>MIDI Output</legend>
                <label>
                  Device
                  <select value={config.outputId} onChange={(e) => cfg({ outputId: e.target.value })}>
                    <option value="">Default (first available)</option>
                    {midiOutputs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </label>
                {midiOutputs.length === 0 && (
                  <p className="autosample-hint">No MIDI outputs detected. Connect a device and reload.</p>
                )}
                <label>
                  Channel
                  <input type="number" min={1} max={16} value={config.channel} onChange={(e) => cfg({ channel: Math.max(1, Math.min(16, Number(e.target.value))) })} />
                </label>
              </fieldset>

              {/* Audio Input */}
              <fieldset className="autosample-fieldset">
                <legend>Audio Input</legend>
                <label>
                  Device
                  <select value={config.inputDeviceId} onChange={(e) => cfg({ inputDeviceId: e.target.value })}>
                    <option value="">Default</option>
                    {inputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                    ))}
                  </select>
                </label>
                <label title="dBFS threshold below which audio is considered silence">
                  Silence threshold (dBFS)
                  <input type="number" min={-100} max={0} step={1} value={config.thresholdDb} onChange={(e) => cfg({ thresholdDb: Number(e.target.value) })} />
                </label>
                <label className="autosample-checkbox">
                  <input type="checkbox" checked={config.normalize} onChange={(e) => cfg({ normalize: e.target.checked })} />
                  Normalize volume
                </label>
                <label className="autosample-checkbox">
                  <input type="checkbox" checked={config.autoTrim} onChange={(e) => cfg({ autoTrim: e.target.checked, ...(e.target.checked ? {} : { autoCrop: false }) })} />
                  Auto-trim silence
                </label>
                <label className="autosample-checkbox" title="Destructively remove silent head/tail from samples to reduce memory usage">
                  <input type="checkbox" checked={config.autoCrop} onChange={(e) => cfg({ autoCrop: e.target.checked, ...(e.target.checked ? { autoTrim: false } : {}) })} />
                  Auto-crop silence (smaller files)
                </label>
              </fieldset>

              {/* Note Selection */}
              <fieldset className="autosample-fieldset autosample-notes-fieldset">
                <legend>Notes</legend>

                {/* Mode toggle */}
                <div className="autosample-note-mode-toggle">
                  {(['range', 'scale', 'custom'] as NoteMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`autosample-mode-btn${noteMode === m ? ' active' : ''}`}
                      onClick={() => setNoteMode(m)}
                    >
                      {m === 'range' ? 'Range' : m === 'scale' ? 'Scale' : 'Custom'}
                    </button>
                  ))}
                  {DEVICE_DRUMKITS.map((dk) => (
                    <button
                      key={dk.id}
                      type="button"
                      className={`autosample-mode-btn${noteMode === 'drumkit' && drumkitId === dk.id ? ' active' : ''}`}
                      onClick={() => { setNoteMode('drumkit'); setDrumkitId(dk.id); cfg({ autoTrim: true }) }}
                    >
                      {dk.label}
                    </button>
                  ))}
                </div>

                {/* Range mode */}
                {noteMode === 'range' && (
                  <>
                    <label>
                      Start note
                      <span className="midi-out-note-name">{midiToName(config.startNote)}</span>
                      <input type="number" min={0} max={127} value={config.startNote} onChange={(e) => cfg({ startNote: Math.max(0, Math.min(127, Number(e.target.value))) })} />
                    </label>
                    <label>
                      Note count
                      <input type="number" min={1} max={128} value={config.noteCount} onChange={(e) => cfg({ noteCount: Math.max(1, Math.min(128, Number(e.target.value))) })} />
                    </label>
                    <label title="Semitone increment between successive notes (default 1 = chromatic)">
                      Semitone step
                      <input type="number" min={1} max={12} value={config.noteStep} onChange={(e) => cfg({ noteStep: Math.max(1, Math.min(12, Number(e.target.value))) })} />
                    </label>
                  </>
                )}

                {/* Scale mode */}
                {noteMode === 'scale' && (
                  <>
                    <label>
                      Root note
                      <select value={scaleRoot} onChange={(e) => setScaleRoot(Number(e.target.value))}>
                        {NOTE_NAMES.map((name, i) => (
                          <option key={i} value={i}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Scale
                      <select value={scaleType} onChange={(e) => setScaleType(e.target.value as ScaleType)}>
                        <option value="major">Major</option>
                        <option value="minor">Minor</option>
                      </select>
                    </label>
                    <label>
                      Start octave
                      <input type="number" min={0} max={8} value={scaleOctaveStart} onChange={(e) => setScaleOctaveStart(Math.max(0, Math.min(8, Number(e.target.value))))} />
                    </label>
                    <label>
                      Octaves
                      <input type="number" min={1} max={5} value={scaleOctaves} onChange={(e) => setScaleOctaves(Math.max(1, Math.min(5, Number(e.target.value))))} />
                    </label>
                  </>
                )}

                {/* Custom mode */}
                {noteMode === 'custom' && (
                  <>
                    <div className="autosample-custom-add">
                      <label>
                        Note
                        <span className="midi-out-note-name">{midiToName(customNoteInput)}</span>
                        <input type="number" min={0} max={127} value={customNoteInput} onChange={(e) => setCustomNoteInput(Math.max(0, Math.min(127, Number(e.target.value))))} />
                      </label>
                      <button
                        type="button"
                        className="autosample-add-btn"
                        onClick={() => {
                          if (!customNotes.includes(customNoteInput)) {
                            setCustomNotes((prev) => [...prev, customNoteInput])
                          }
                        }}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        className={`autosample-learn-btn${midiLearnActive ? ' active' : ''}`}
                        onClick={() => setMidiLearnActive((v) => !v)}
                        title="Listen for MIDI note-on to add notes"
                      >
                        {midiLearnActive ? 'Stop Learn' : 'MIDI Learn'}
                      </button>
                    </div>
                    {customNotes.length > 0 && (
                      <div className="autosample-custom-notes">
                        {[...customNotes].sort((a, b) => a - b).map((n) => (
                          <span key={n} className="autosample-note-tag">
                            {midiToName(n)}
                            <button
                              type="button"
                              className="autosample-note-remove"
                              onClick={() => setCustomNotes((prev) => prev.filter((x) => x !== n))}
                              title="Remove"
                            >
                              x
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="autosample-clear-btn"
                          onClick={() => setCustomNotes([])}
                        >
                          Clear all
                        </button>
                      </div>
                    )}
                    {customNotes.length === 0 && (
                      <p className="autosample-hint">Add notes manually or use MIDI Learn to input them from a controller.</p>
                    )}
                  </>
                )}

                {/* Drumkit mode */}
                {noteMode === 'drumkit' && activeKit && (
                  <div className="autosample-drumkit-summary">
                    <label>
                      Kit name
                      <input type="text" value={drumkitLabel} onChange={(e) => setDrumkitLabel(e.target.value)} placeholder={activeKit.label} />
                    </label>
                    <p className="autosample-hint">{activeKit.pads.length} pads — fixed MIDI mapping:</p>
                    <div className="autosample-drumkit-pads">
                      {activeKit.pads.map((p) => (
                        <span key={p.pad} className="autosample-note-tag" title={`MIDI ${p.note} (${midiToName(p.note)})${p.chokeGroup ? ` — Choke ${p.chokeGroup}` : ''}`}>
                          {p.pad}. {p.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Velocity */}
                {config.velocityLayers <= 1 && (
                  <label>
                    Velocity
                    <input type="number" min={1} max={127} value={config.velocity} onChange={(e) => cfg({ velocity: Math.max(1, Math.min(127, Number(e.target.value))) })} />
                  </label>
                )}

                {/* Velocity layers */}
                <label title="Number of velocity layers per note (1 = single sample, 2–4 = velocity-switched layers)">
                  Velocity layers
                  <select value={config.velocityLayers} onChange={(e) => cfg({ velocityLayers: Number(e.target.value) })}>
                    <option value={1}>1 (single)</option>
                    <option value={2}>2 layers</option>
                    <option value={3}>3 layers</option>
                    <option value={4}>4 layers</option>
                  </select>
                </label>

                {config.velocityLayers > 1 && (
                  <div className="autosample-velo-splits">
                    {veloSplits.map((s, i) => (
                      <span key={i} className="autosample-velo-tag">
                        Layer {i + 1}: vel {s.velocity} (range {s.velocityLow}–{s.velocityHigh})
                      </span>
                    ))}
                  </div>
                )}
              </fieldset>

              {/* Timing */}
              <fieldset className="autosample-fieldset">
                <legend>Timing</legend>
                <label title="How long the MIDI note-on is held (ms)">
                  Note duration (ms)
                  <input type="number" min={100} max={30000} step={100} value={config.noteDurationMs} onChange={(e) => cfg({ noteDurationMs: Math.max(100, Number(e.target.value)) })} />
                </label>
                <label title="Extra recording time after note-off to capture reverb/release tail (ms)">
                  Release tail (ms)
                  <input type="number" min={0} max={10000} step={100} value={config.releaseTailMs} onChange={(e) => cfg({ releaseTailMs: Math.max(0, Number(e.target.value)) })} />
                </label>
              </fieldset>

              {/* Pad Assignment */}
              <fieldset className="autosample-fieldset">
                <legend>Pad Assignment</legend>
                <label>
                  Start bank
                  <select value={config.startBank} onChange={(e) => cfg({ startBank: Number(e.target.value) })}>
                    {Array.from({ length: BANK_COUNT }, (_, i) => (
                      <option key={i} value={i}>Bank {i + 1}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Start pad
                  <select value={config.startSlot} onChange={(e) => cfg({ startSlot: Number(e.target.value) })}>
                    {Array.from({ length: PADS_PER_BANK }, (_, i) => (
                      <option key={i} value={i}>Pad {i + 1}</option>
                    ))}
                  </select>
                </label>
                <label title="Use {note} for note name, {seq} for sequence number (zero-padded), e.g. AS_{seq}_{note} -> AS_001_C4">
                  Name pattern
                  <input type="text" value={config.namePattern} onChange={(e) => cfg({ namePattern: e.target.value })} placeholder="AS_{seq}_{note}" />
                </label>
                <label>
                  Mix Bus
                  <select value={config.bus} onChange={(e) => cfg({ bus: e.target.value as BusId })}>
                    <option value="A">Bus A</option>
                    <option value="B">Bus B</option>
                    <option value="C">Bus C</option>
                    <option value="D">Bus D</option>
                  </select>
                </label>
                <label className="autosample-checkbox">
                  <input type="checkbox" checked={config.chokeEnabled} onChange={(e) => cfg({ chokeEnabled: e.target.checked })} />
                  Choke group
                </label>
                {config.chokeEnabled && (
                  <label>
                    Group
                    <select value={config.chokeGroup} onChange={(e) => cfg({ chokeGroup: Number(e.target.value) })}>
                      {Array.from({ length: 8 }, (_, i) => (
                        <option key={i + 1} value={i + 1}>{i + 1}</option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>
            </div>

            {overflowClamped && (
              <p className="autosample-warn">
                Note count exceeds available pads — will sample {effectiveCount} of {fullNoteList.length} notes.
              </p>
            )}
            {effectiveCount > 0 && (
              <p className="autosample-summary">
                Will sample {effectiveCount} note{effectiveCount !== 1 ? 's' : ''} ({summaryRange}){config.velocityLayers > 1 ? ` x ${config.velocityLayers} velocity layers (${totalSamples} samples total)` : ''},
                starting at Bank {config.startBank + 1} / Pad {config.startSlot + 1}.
                Est. time: ~{Math.round((config.noteDurationMs + config.releaseTailMs) * totalSamples / 1000)}s.
              </p>
            )}

            <div className="autosample-footer">
              <button type="button" onClick={handleClose}>Cancel</button>
              <button
                type="button"
                className="record-btn-save"
                onClick={() => void handleStart()}
                disabled={effectiveCount === 0 || midiOutputs.length === 0}
              >
                Start Auto-Sample
              </button>
            </div>
          </div>
        )}

        {/* ---- Running ---- */}
        {phase === 'running' && (
          <div className="autosample-running">
            <div className="autosample-progress-row">
              <span>Sampling {progress} / {total}</span>
              {currentNote !== null && (
                <span className="autosample-current-note">
                  Note: <strong>{midiToName(currentNote)}</strong>
                  {currentLayer !== null && ` — Layer ${currentLayer}/${config.velocityLayers}`}
                </span>
              )}
            </div>
            <div className="autosample-progress-bar-wrap">
              <div className="autosample-progress-bar" style={{ width: `${total > 0 ? (progress / total) * 100 : 0}%` }} />
            </div>
            {lastPeaks.length > 0 && (
              <div className="autosample-preview-wave">
                <canvas ref={previewCanvasRef} width={400} height={60} />
              </div>
            )}
            <div className="autosample-footer">
              <button type="button" onClick={handleCancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* ---- Done ---- */}
        {phase === 'done' && (
          <div className="autosample-done">
            <p>
              {cancelRef.current
                ? `Cancelled. ${completedCount} note(s) assigned before cancel.`
                : `Done! ${completedCount} note(s) assigned successfully${config.velocityLayers > 1 ? ` with ${config.velocityLayers} velocity layers each` : ''}.`}
            </p>
            {lastPeaks.length > 0 && (
              <div className="autosample-preview-wave">
                <canvas ref={previewCanvasRef} width={400} height={60} />
              </div>
            )}
            <div className="autosample-footer">
              <button type="button" onClick={() => { setPhase('setup'); setLastPeaks([]) }}>Sample Again</button>
              <button type="button" className="record-btn-save" onClick={handleClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
