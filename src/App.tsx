import { useEffect, useRef, useCallback, useState } from 'react'
import './App.css'
import { audioEngine } from './lib/audioEngine'
import { useResizableColumns } from './lib/useResizableColumns'
import { db } from './lib/db'
import { buildMidiForSequence } from './lib/midiExport'
import { renderProjectAudioWav } from './lib/audioExport'
import {
  buildImportConflictReport,
  exportProjectPackage,
  importPreview,
  importProjectPackage,
  readProjectFromPackage,
} from './lib/packageIO'
import { PADS_PER_BANK } from './lib/constants'
import type { SampleAsset, Pad, Project } from './types'
import {
  useStore,
  selectSelectedPad,
  selectSelectedLayer,
  selectDisplayedSample,
  selectActiveSequence,
  selectVisibleSequence,
  selectFilteredSamples,
  selectAssignedSampleIdsKey,
  normalizeProject,
  MIN_STEP_SEMITONES,
  MAX_STEP_SEMITONES,
  getLaneBoundsForEvent,
  updateGateEventRange,
  storeRefs,
} from './store'
import { buildStandaloneHtml } from './lib/standaloneHtml'
import { ExportDialog } from './components/ExportDialog'
import { ImportDialog } from './components/ImportDialog'
import { RecordDialog } from './components/RecordDialog'
import { AutosampleDialog } from './components/AutosampleDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SampleLibrary } from './components/SampleLibrary'
import { PadEditor } from './components/PadEditor'
import { PadGrid } from './components/PadGrid'
import { TopBar, SettingsContent } from './components/TopBar'
import { Sequencer } from './components/Sequencer'
import { Mixer } from './components/Mixer'
import { Toasts } from './components/Toasts'
import { ChopModal } from './components/ChopModal'
import { registerMidiOutput, unregisterMidiOutput, getMidiOutputInfos, releaseMidiNote, isMidiEcho } from './lib/midiOut'
import * as launchpad from './lib/launchpadProMk3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Computer keyboard note mapping (Ableton-style, 2 octaves)
// Bottom row: Z=C, S=C#, X=D, D=D#, C=E, V=F, G=F#, B=G, H=G#, N=A, J=A#, M=B
// Top row: Q=C+12, 2=C#+12, W=D+12, 3=D#+12, E=E+12, R=F+12, 5=F#+12, T=G+12, 6=G#+12, Y=A+12, 7=A#+12, U=B+12
const COMPUTER_KEY_NOTE_MAP: Record<string, number> = {
  // Lower octave (semitone offset from octave base)
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  // Upper octave (+12)
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
}
// Track active computer keyboard notes (code → MIDI note) to prevent repeats and handle note-off
const _activeComputerKeys = new Map<string, number>()

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

// Cache decoded full-resolution channel data per sample id for zoom waveform
let _waveformChannelCache: { sampleId: string; channel: Float32Array } | null = null

// ---------------------------------------------------------------------------
// Cross-platform download helper
// On iOS Safari PWA, programmatic anchor clicks are silently blocked.
// Use Web Share API (with file support) when available, fall back to anchor.
// ---------------------------------------------------------------------------
async function downloadOrShare(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type })
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (err) {
      // User cancelled share sheet (AbortError) — not an error worth toasting
      if (err instanceof Error && err.name === 'AbortError') return
      // Other share errors: fall through to anchor fallback
    }
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---------------------------------------------------------------------------
// Performance layout Settings panel
// ---------------------------------------------------------------------------

function PerfSettingsPanel() {
  return (
    <div className="perf-settings-panel">
      <SettingsContent />
    </div>
  )
}

function ProjectsPanel() {
  const projectList = useStore((s) => s.projectList)
  const currentProjectId = useStore((s) => s.project?.id ?? null)
  const { createNewProject, switchProject, deleteProject, duplicateProject } = useStore.getState()

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        <section>
          <div className="projects-list">
            {projectList.map((p) => (
              <div
                key={p.id}
                className={`project-row${p.id === currentProjectId ? ' active' : ''}`}
                onClick={() => void switchProject(p.id)}
              >
                <span className="project-row-name">{p.name}</span>
                <span className="project-row-actions">
                  {p.id === currentProjectId && (
                    <button type="button" title="Duplicate" onClick={(e) => { e.stopPropagation(); void duplicateProject() }}>⧉</button>
                  )}
                  <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); void deleteProject(p.id) }}>✕</button>
                </span>
              </div>
            ))}
          </div>
          <div className="record-controls">
            <button type="button" onClick={() => void createNewProject()}>+ New Project</button>
          </div>
        </section>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  // --- Store subscriptions (only what App itself needs) ---
  const project = useStore((s) => s.project)
  const samples = useStore((s) => s.samples)
  const isPlaying = useStore((s) => s.isPlaying)
  const showLibraryWaveforms = useStore((s) => s.showLibraryWaveforms)
  const showExportDialog = useStore((s) => s.showExportDialog)
  const showImportDialog = useStore((s) => s.showImportDialog)
  const sampleAssignPrompt = useStore((s) => s.sampleAssignPrompt)
  const showRecordDialog = useStore((s) => s.showRecordDialog)
  const showAutosampleDialog = useStore((s) => s.showAutosampleDialog)
  const audioMonitorEnabled = useStore((s) => s.audioMonitorEnabled)
  const audioMonitorDeviceId = useStore((s) => s.audioMonitorDeviceId)
  const audioMonitorBusId = useStore((s) => s.audioMonitorBusId)
  const audioOutputDeviceId = useStore((s) => s.audioOutputDeviceId)
  const layoutMode = useStore((s) => s.layoutMode)
  const performanceTab = useStore((s) => s.performanceTab)
  const altLayout = layoutMode === 'wide'

  // --- Phone detection (pointer: coarse + phone-sized viewport) ---
  // iPads also have pointer: coarse, so we explicitly exclude them
  const isIPad = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const PHONE_MQ = '(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 767px)'
  const [isMobile, setIsMobile] = useState(() => isIPad ? false : matchMedia(PHONE_MQ).matches)
  useEffect(() => {
    const mql = matchMedia(PHONE_MQ)
    const onChange = () => setIsMobile(isIPad ? false : mql.matches)
    if ('addEventListener' in mql) mql.addEventListener('change', onChange)
    else (mql as unknown as { addListener: (cb: () => void) => void }).addListener(onChange)
    return () => {
      if ('removeEventListener' in mql) mql.removeEventListener('change', onChange)
      else (mql as unknown as { removeListener: (cb: () => void) => void }).removeListener(onChange)
    }
  }, [])

  const {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed,
    toggleLeft, toggleRight, leftDividerProps, rightDividerProps,
  } = useResizableColumns(altLayout)

  // --- Sequencer / Mixer horizontal split ---
  const SEQ_SPLIT_KEY = 'layout-seq-mixer-split'
  const DEFAULT_SEQ_RATIO = 0.6
  const [seqMixerRatio, setSeqMixerRatio] = useState<number>(() => {
    try {
      const v = localStorage.getItem(SEQ_SPLIT_KEY)
      if (v) { const n = parseFloat(v); if (n >= 0.2 && n <= 0.85) return n }
    } catch { /* ignore */ }
    return DEFAULT_SEQ_RATIO
  })
  const seqMixerRatioRef = useRef(seqMixerRatio)
  seqMixerRatioRef.current = seqMixerRatio
  useEffect(() => { try { localStorage.setItem(SEQ_SPLIT_KEY, String(seqMixerRatio)) } catch { /* ignore */ } }, [seqMixerRatio])
  const hDivDragging = useRef(false)
  const hDivStartY = useRef(0)
  const hDivStartRatio = useRef(0)
  const hDivContainerRef = useRef<HTMLDivElement | null>(null)
  const hDivRafId = useRef(0)

  const onHDivPointerMove = useCallback((e: PointerEvent) => {
    const dy = e.clientY - hDivStartY.current
    cancelAnimationFrame(hDivRafId.current)
    hDivRafId.current = requestAnimationFrame(() => {
      const container = hDivContainerRef.current
      if (!container) return
      const h = container.clientHeight
      if (h <= 0) return
      const newRatio = Math.min(0.85, Math.max(0.2, hDivStartRatio.current + dy / h))
      setSeqMixerRatio(newRatio)
    })
  }, [])

  const onHDivPointerUp = useCallback(() => {
    hDivDragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onHDivPointerMove)
    window.removeEventListener('pointerup', onHDivPointerUp)
  }, [onHDivPointerMove])

  const onHDivPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    hDivDragging.current = true
    hDivStartY.current = e.clientY
    hDivStartRatio.current = seqMixerRatioRef.current
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onHDivPointerMove)
    window.addEventListener('pointerup', onHDivPointerUp)
  }, [onHDivPointerMove, onHDivPointerUp])

  // --- Performance layout left/right split ---
  const PERF_SPLIT_KEY = 'layout-perf-split'
  const DEFAULT_PERF_RATIO = 0.55
  const [perfSplitRatio, setPerfSplitRatio] = useState<number>(() => {
    try {
      const v = localStorage.getItem(PERF_SPLIT_KEY)
      if (v) { const n = parseFloat(v); if (n >= 0.25 && n <= 0.75) return n }
    } catch { /* ignore */ }
    return DEFAULT_PERF_RATIO
  })
  const perfSplitRatioRef = useRef(perfSplitRatio)
  perfSplitRatioRef.current = perfSplitRatio
  useEffect(() => { try { localStorage.setItem(PERF_SPLIT_KEY, String(perfSplitRatio)) } catch { /* ignore */ } }, [perfSplitRatio])
  const perfDivDragging = useRef(false)
  const perfDivStartX = useRef(0)
  const perfDivStartRatio = useRef(0)
  const perfDivContainerRef = useRef<HTMLDivElement | null>(null)
  const perfDivRafId = useRef(0)

  const onPerfDivPointerMove = useCallback((e: PointerEvent) => {
    const dx = e.clientX - perfDivStartX.current
    cancelAnimationFrame(perfDivRafId.current)
    perfDivRafId.current = requestAnimationFrame(() => {
      const container = perfDivContainerRef.current
      if (!container) return
      const w = container.clientWidth
      if (w <= 0) return
      const newRatio = Math.min(0.75, Math.max(0.25, perfDivStartRatio.current + dx / w))
      setPerfSplitRatio(newRatio)
    })
  }, [])

  const onPerfDivPointerUp = useCallback(() => {
    perfDivDragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onPerfDivPointerMove)
    window.removeEventListener('pointerup', onPerfDivPointerUp)
  }, [onPerfDivPointerMove])

  const onPerfDivPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    perfDivDragging.current = true
    perfDivStartX.current = e.clientX
    perfDivStartRatio.current = perfSplitRatioRef.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPerfDivPointerMove)
    window.addEventListener('pointerup', onPerfDivPointerUp)
  }, [onPerfDivPointerMove, onPerfDivPointerUp])

  const importMode = useStore((s) => s.importMode)
  const importFile = useStore((s) => s.importFile)
  const waveformPeaks = useStore((s) => s.waveformPeaks)
  const waveformZoom = useStore((s) => s.waveformZoom)
  const trimDraft = useStore((s) => s.trimDraft)


  const selectedPad = useStore(selectSelectedPad)
  const selectedLayer = useStore(selectSelectedLayer)
  const selectedSample = useStore(selectDisplayedSample)
  const padEditorCollapsed = useStore((s) => s.padEditorCollapsed)
  const activeSequence = useStore(selectActiveSequence)
  const visibleSequence = useStore(selectVisibleSequence)
  const filteredSamples = useStore(selectFilteredSamples)
  const assignedSampleIdsKey = useStore(selectAssignedSampleIdsKey)

  // --- Actions ---
  const { hydrate, flushPendingProjectSave } = useStore.getState()

  // --- Refs for DOM ---
  const waveformRef = useRef<HTMLDivElement | null>(null)
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragTargetRef = useRef<'start' | 'end' | null>(null)

  // --- Hydrate on mount ---
  useEffect(() => {
    void hydrate()
  }, [])

  // --- Auto-detect performance layout for landscape mobile ---
  useEffect(() => {
    // Only auto-detect if user hasn't explicitly set a layout mode
    if (localStorage.getItem('layoutMode')) return
    const isIPad = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    if (isIPad) return // iPads use desktop performance layout, not phone layout
    const isTouch = matchMedia('(pointer: coarse)').matches
    const isLandscape = window.innerWidth > window.innerHeight
    const isSmall = window.innerWidth <= 1099
    if (isTouch && isLandscape && isSmall) {
      useStore.setState({ layoutMode: 'performance' })
    }
  }, [])

  // --- Flush pending save on unmount ---
  useEffect(() => {
    return () => flushPendingProjectSave()
  }, [])

  // --- MIDI input binding (stable — uses getState, no re-bind on project change) ---
  useEffect(() => {
    if (!navigator.requestMIDIAccess) return

    let cancelled = false
    let midiNoteMap: Map<number, Pad> | null = null
    let midiNoteMapProject: Project | null = null
    const onMessage = (message: MIDIMessageEvent) => {
      if (!message.data || message.data.length < 3) return

      // Respect MIDI input enabled toggle and device filter
      const st0 = useStore.getState()
      if (!st0.midiInputEnabled) return
      if (st0.midiInputDeviceId) {
        // Check the message came from the selected input
        const inputPort = message.currentTarget as MIDIInput | null
        if (inputPort && inputPort.id !== st0.midiInputDeviceId) return
      }

      const [status, note, velocity] = message.data
      const command = status & 0xf0
      const channel = (status & 0x0f) + 1  // 1-indexed MIDI channel

      const currentProject = useStore.getState().project
      if (!currentProject) return

      // --- Per-synth-pad chromatic MIDI routing ---
      // Check if any synth pad is configured to receive on this channel
      if (command === 0x90 && velocity > 0) {
        for (const p of currentProject.pads) {
          if (
            p.settings.source === 'synth' &&
            p.settings.synthParams &&
            p.settings.synthMidiChannel === channel &&
            (!p.settings.synthMidiDevice || p.settings.synthMidiDevice === (message.currentTarget as MIDIInput | null)?.id)
          ) {
            if (isMidiEcho(status & 0x0f, note)) return
            const baseNote = p.settings.synthParams.baseNote + (p.settings.semitones ?? 0)
            const semitoneOffset = note - baseNote
            audioEngine.playPad(p, velocity / 127, {
              semitoneOffset,
              hold: p.settings.mode === 'adsr',
              bpm: currentProject.bpm,
            })
            requestAnimationFrame(() => {
              useStore.getState().flashSequencedPadHit(p.id)
            })
            // Feed capture buffer
            useStore.getState().feedCaptureBuffer(p.id, velocity, 'on', note)
            // Record as piano roll event if sequencer is recording
            const recState = useStore.getState()
            if (recState.isPlaying && recState.seqRecordArmed) {
              recState.recordPadHit(p.id, velocity, note)
            }
            return
          }
        }
      }
      if ((command === 0x80 || (command === 0x90 && velocity === 0))) {
        for (const p of currentProject.pads) {
          if (
            p.settings.source === 'synth' &&
            p.settings.synthMidiChannel === channel &&
            (!p.settings.synthMidiDevice || p.settings.synthMidiDevice === (message.currentTarget as MIDIInput | null)?.id)
          ) {
            audioEngine.releasePad(p.id)
            // Feed capture buffer
            useStore.getState().feedCaptureBuffer(p.id, 0, 'off', note)
            // Update gate length for recording
            const recState = useStore.getState()
            if (recState.isPlaying && recState.seqRecordArmed) {
              recState.recordPadRelease(p.id, note)
            }
            return
          }
        }
      }

      // --- Global pad MIDI channel filter ---
      const padMidiCh = useStore.getState().padMidiChannel
      if (padMidiCh != null && channel !== padMidiCh) return

      // Build/rebuild O(1) MIDI note lookup map when project changes
      if (!midiNoteMap || midiNoteMapProject !== currentProject) {
        midiNoteMap = new Map()
        midiNoteMapProject = currentProject
        for (const p of currentProject.pads) {
          if (p.midiNote != null) midiNoteMap.set(p.midiNote, p)
        }
      }
      const pad = midiNoteMap.get(note)
      if (!pad) return

      if (command === 0x90 && velocity > 0) {
        // Suppress echo: if this note was just sent by our MIDI output, ignore it
        if (isMidiEcho(status & 0x0f, note)) return

        const st = useStore.getState()
        // Hold-record mode: if enabled and pad is empty, start recording
        if (st.padHoldRecordEnabled && !pad.settings.sampleId) {
          st.startPadHoldRecord(pad.id)
          requestAnimationFrame(() => {
            useStore.setState({ selectedPadId: pad.id, lastMidiNote: { note, velocity } })
          })
        } else {
          // AUDIO FIRST — trigger pad synchronously before any React state updates
          st.triggerPad(pad, velocity / 127)

          // Defer all visual/state updates to avoid blocking the audio thread
          requestAnimationFrame(() => {
            // Don't switch pad editor focus during sequencer playback
            if (!useStore.getState().isPlaying) {
              useStore.setState({ selectedPadId: pad.id })
            }
            useStore.setState({ lastMidiNote: { note, velocity } })
            useStore.getState().flashSequencedPadHit(pad.id)
          })
        }
      }
      if (command === 0x80 || (command === 0x90 && velocity === 0)) {
        const st = useStore.getState()
        if (st.padHoldRecordingPadId === pad.id) {
          st.stopPadHoldRecord()
        } else {
          audioEngine.releasePad(pad.id)
          useStore.getState().feedCaptureBuffer(pad.id, 0, 'off')
          // Send MIDI note-off for gate/adsr pads via the active-note registry
          releaseMidiNote(pad.id)
        }
      }
    }

    const tryConnectLaunchpad = (access: MIDIAccess) => {
      // If special mode is disabled, disconnect and treat as generic MIDI
      if (!useStore.getState().launchpadSpecialMode) {
        if (launchpad.isConnected()) launchpad.disconnect()
        // Ensure generic handler is attached to LP inputs
        access.inputs.forEach((input) => {
          if (launchpad.isLaunchpadProMk3(input.name || '')) {
            input.onmidimessage = onMessage
          }
        })
        return
      }
      // Check if launchpad disappeared
      if (launchpad.isConnected()) {
        let found = false
        access.outputs.forEach((o) => { if (launchpad.isLaunchpadProMk3(o.name || '')) found = true })
        if (!found) launchpad.disconnect()
        return
      }
      const lpOutputs: MIDIOutput[] = []
      const lpInputs: MIDIInput[] = []
      // LP Pro MK3 exposes multiple ports — collect ALL matching ports
      access.outputs.forEach((o) => {
        if (launchpad.isLaunchpadProMk3(o.name || '')) {
          console.log('[LaunchpadProMk3] Found output:', o.name, o.id)
          lpOutputs.push(o)
        }
      })
      access.inputs.forEach((i) => {
        if (launchpad.isLaunchpadProMk3(i.name || '')) {
          console.log('[LaunchpadProMk3] Found input:', i.name, i.id)
          lpInputs.push(i)
        }
      })
      if (lpOutputs.length > 0 && lpInputs.length > 0) {
        console.log('[LaunchpadProMk3] Detected:', lpOutputs.map((o) => o.name).join(', '))
        // Pre-create and unlock AudioContext — MIDI access grant counts as user gesture
        audioEngine.unlockSync()
        // Auto-select the DAW input for the app's MIDI input
        const dawInput = lpInputs.find((i) => (i.name || '').toLowerCase().includes('daw')) ?? lpInputs[0]
        if (dawInput && !useStore.getState().midiInputDeviceId) {
          useStore.setState({ midiInputDeviceId: dawInput.id, midiInputEnabled: true })
        }
        launchpad.connect(lpOutputs, lpInputs, {
          getPads: () => useStore.getState().project?.pads ?? [],
          getEvents: () => {
            const s = useStore.getState()
            return selectActiveSequence(s)?.events ?? []
          },
          getStepCount: () => {
            const s = useStore.getState()
            return selectActiveSequence(s)?.lengthSteps ?? 16
          },
          getIsPlaying: () => useStore.getState().isPlaying,
          getIsRecordArmed: () => useStore.getState().seqRecordArmed,
          getActiveBank: () => useStore.getState().activeBank ?? 0,
          getSelectedPadId: () => useStore.getState().selectedPadId,
          triggerPad: (pad, velocity) => {
            audioEngine.unlockSync()
            const st = useStore.getState()
            if (st.padHoldRecordEnabled && !pad.settings.sampleId) {
              st.startPadHoldRecord(pad.id)
            } else {
              st.triggerPad(pad, velocity)
            }
          },
          triggerChromatic: (pad, velocity, semitoneOffset) => {
            audioEngine.unlockSync()
            const st = useStore.getState()
            const baseNote = (pad.settings.synthParams?.baseNote ?? 60) + (pad.settings.semitones ?? 0)
            const midiNote = baseNote + semitoneOffset
            audioEngine.playPad(pad, velocity, {
              semitoneOffset,
              hold: pad.settings.mode === 'adsr',
              bpm: st.project?.bpm ?? 120,
            })
            st.feedCaptureBuffer(pad.id, Math.round(velocity * 127), 'on', midiNote)
            // Record if armed
            if (st.isPlaying && st.seqRecordArmed) {
              st.recordPadHit(pad.id, Math.round(velocity * 127), midiNote)
            }
          },
          releasePad: (padId) => {
            const st = useStore.getState()
            if (st.padHoldRecordingPadId === padId) {
              st.stopPadHoldRecord()
            } else {
              audioEngine.releasePad(padId)
              st.feedCaptureBuffer(padId, 0, 'off')
              releaseMidiNote(padId)
            }
          },
          releaseChromatic: (padId, semitoneOffset) => {
            const st = useStore.getState()
            const pad = st.project?.pads.find((p) => p.id === padId)
            if (!pad) return
            audioEngine.releasePad(padId)
            st.feedCaptureBuffer(padId, 0, 'off')
            // Record gate length if recording
            if (st.isPlaying && st.seqRecordArmed) {
              const baseNote = (pad.settings.synthParams?.baseNote ?? 60) + (pad.settings.semitones ?? 0)
              const midiNote = baseNote + semitoneOffset
              st.recordPadRelease(padId, midiNote)
            }
          },
          toggleStep: (step, padId) => { void useStore.getState().toggleStep(step, padId) },
          selectPad: (padId) => {
            requestAnimationFrame(() => {
              if (!useStore.getState().isPlaying) {
                useStore.setState({ selectedPadId: padId })
              }
              useStore.getState().flashSequencedPadHit(padId)
            })
          },
          togglePlay: () => useStore.getState().togglePlayPause(),
          toggleRecord: () => {
            useStore.setState((s) => ({ seqRecordArmed: !s.seqRecordArmed }))
          },
          setBank: (bank) => {
            useStore.setState({ activeBank: bank })
          },
          duplicateLength: (mode) => {
            void useStore.getState().duplicatePatternLength(mode)
          },
          switchPattern: (direction) => {
            const s = useStore.getState()
            if (!s.project || s.project.sequences.length <= 1) return
            const currentId = s.activeSequenceId
            const idx = s.project.sequences.findIndex((seq) => seq.id === currentId)
            if (idx === -1) return
            const nextIdx = (idx + direction + s.project.sequences.length) % s.project.sequences.length
            useStore.setState({ activeSequenceId: s.project.sequences[nextIdx].id })
          },
          subscribeStore: (listener) => useStore.subscribe(listener),
        })
      }
    }

    const connectMidi = async () => {
      try {
        const access = await navigator.requestMIDIAccess?.({ sysex: true })
        if (!access || cancelled) return
        access.inputs.forEach((input) => {
          // Don't attach generic handler to Launchpad if special mode is on
          if (!useStore.getState().launchpadSpecialMode || !launchpad.isLaunchpadProMk3(input.name || '')) {
            input.onmidimessage = onMessage
          }
        })

        // Register MIDI outputs
        access.outputs.forEach((output) => registerMidiOutput(output))

        // Auto-detect Launchpad Pro MK3
        tryConnectLaunchpad(access)

        const inputInfos = Array.from(access.inputs.values()).map((i) => ({ id: i.id, name: i.name || i.id }))
        useStore.setState({
          midiStatus: `MIDI: ${access.inputs.size} input(s)`,
          midiInputs: inputInfos,
          midiOutputs: getMidiOutputInfos(),
        })

        // Keep lists in sync when devices connect/disconnect
        access.onstatechange = () => {
           access.inputs.forEach((input) => {
            // Don't override launchpad's own handler when special mode is active
            if (!useStore.getState().launchpadSpecialMode || !launchpad.isConnected() || !launchpad.isLaunchpadProMk3(input.name || '')) {
              input.onmidimessage = onMessage
            }
          })
          access.outputs.forEach((output) => registerMidiOutput(output))
          // Re-check launchpad connection
          tryConnectLaunchpad(access)
          // Remove outputs that are no longer present
          const currentOutputIds = new Set(Array.from(access.outputs.keys()))
          getMidiOutputInfos().forEach((info) => {
            if (!currentOutputIds.has(info.id)) unregisterMidiOutput(info.id)
          })
          const updatedInputInfos = Array.from(access.inputs.values()).map((i) => ({ id: i.id, name: i.name || i.id }))
          // If the selected input device disappeared, reset to all
          const currentInputId = useStore.getState().midiInputDeviceId
          const currentInputIds = new Set(Array.from(access.inputs.keys()))
          useStore.setState({
            midiStatus: `MIDI: ${access.inputs.size} input(s)`,
            midiInputs: updatedInputInfos,
            midiOutputs: getMidiOutputInfos(),
            ...(currentInputId && !currentInputIds.has(currentInputId) ? { midiInputDeviceId: null } : {}),
          })
        }
      } catch {
        useStore.setState({ midiStatus: 'MIDI: unavailable' })
      }
    }

    void connectMidi()
    return () => { cancelled = true; launchpad.disconnect() }
  }, [])

  // --- Enumerate audio output devices ---
  useEffect(() => {
    const enumerate = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const outputs = devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({ id: d.deviceId, name: d.label || `Output ${d.deviceId.slice(0, 6)}` }))
        const inputs = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ id: d.deviceId, name: d.label || `Input ${d.deviceId.slice(0, 6)}` }))
        useStore.setState({ audioOutputs: outputs, audioInputs: inputs })
      } catch { /* ignore */ }
    }
    enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  // --- Audio output device selection ---
  useEffect(() => {
    if (audioOutputDeviceId) {
      localStorage.setItem('audioOutputDeviceId', audioOutputDeviceId)
    } else {
      localStorage.removeItem('audioOutputDeviceId')
    }
    audioEngine.setOutputDevice(audioOutputDeviceId).catch(() => {
      // setSinkId not supported or device unavailable — reset
      useStore.setState({ audioOutputDeviceId: null })
      localStorage.removeItem('audioOutputDeviceId')
    })
  }, [audioOutputDeviceId])

  // --- Load audio buffers for assigned samples ---
  useEffect(() => {
    const loadBuffers = async () => {
      const s = useStore.getState()
      if (!s.project) return
      const ids = new Set(assignedSampleIdsKey.split('|').filter(Boolean))
      for (const sample of s.samples) {
        if (!ids.has(sample.id) || audioEngine.hasSample(sample.id)) continue
        await audioEngine.registerSample(sample)
      }
    }
    void loadBuffers()
  }, [samples, assignedSampleIdsKey])

  // --- Library waveform peaks ---
  useEffect(() => {
    if (!showLibraryWaveforms || isPlaying) return

    let cancelled = false
    const buildPeaks = async () => {
      while (!cancelled) {
        const currentPeaks = useStore.getState().libraryWavePeaks
        const missing = filteredSamples.filter((s) => !currentPeaks[s.id]).slice(0, 8)
        if (missing.length === 0) break

        const nextEntries: Array<[string, number[]]> = []
        const bucketCount = 112
        const decodeContext = new AudioContext()
        for (const sample of missing) {
          if (cancelled) break
          try {
            const cached = await db.getWaveformPeaksByHash(sample.hash, bucketCount)
            if (cached) { nextEntries.push([sample.id, cached]); continue }
            const buffer = await decodeContext.decodeAudioData(await sample.blob.arrayBuffer())
            const channel = buffer.getChannelData(0)
            const bucketSize = Math.max(16, Math.floor(channel.length / bucketCount))
            const peaks = Array.from({ length: bucketCount }, (_, i) => {
              const start = i * bucketSize
              const end = Math.min(channel.length, start + bucketSize)
              let max = 0
              for (let c = start; c < end; c++) max = Math.max(max, Math.abs(channel[c]))
              return max
            })
            await db.putWaveformPeaks({
              key: `${sample.hash}:${bucketCount}`, sampleId: sample.id, hash: sample.hash,
              bucketCount, peaks, updatedAt: Date.now(),
            })
            nextEntries.push([sample.id, peaks])
          } catch { nextEntries.push([sample.id, []]) }
        }
        void decodeContext.close().catch(() => undefined)
        if (!cancelled && nextEntries.length > 0) {
          useStore.setState((s) => {
            const updated = { ...s.libraryWavePeaks }
            nextEntries.forEach(([id, peaks]) => { updated[id] = peaks })
            return { libraryWavePeaks: updated }
          })
        }
        // Small yield before next batch to keep UI responsive
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    void buildPeaks()
    return () => { cancelled = true }
  }, [filteredSamples, showLibraryWaveforms, isPlaying]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Sync trimDraft from selected pad/layer ---
  useEffect(() => {
    if (!selectedPad) return
    const trim = selectedLayer?.trim ?? selectedPad.settings.trim
    useStore.setState({ trimDraft: trim })
  }, [selectedPad?.id, selectedPad?.settings.trim.start, selectedPad?.settings.trim.end, selectedLayer?.id, selectedLayer?.trim?.start, selectedLayer?.trim?.end])

  // --- Reset selected layer when pad changes ---
  useEffect(() => {
    useStore.setState({ selectedLayerId: null })
  }, [selectedPad?.id])

  // --- Sync mixer state to audio engine ---
  useEffect(() => {
    if (!project) return
    const anySoloed = project.mixBuses.some((b) => b.solo)
    for (const bus of project.mixBuses) {
      audioEngine.updateBus(bus.id, bus, anySoloed)
    }
    audioEngine.updateMasterGain(project.masterBus.gain)
  }, [project?.mixBuses, project?.masterBus?.gain])

  // --- Rebuild bus effect chains when structural config changes (type/enabled/sidechain) ---
  const prevBusStructKeysRef = useRef<Map<string, string>>(new Map())
  const prevMasterStructRef = useRef<string>('')
  useEffect(() => {
    if (!project) return
    for (const bus of project.mixBuses) {
      // Structural key: only type + enabled + sidechainSource + reverb decay (requires new IR)
      const structKey = JSON.stringify(bus.effects.map((s) => ({ type: s.type, enabled: s.enabled, sc: s.sidechainSource, ...(s.type === 'reverb' ? { decay: s.params.decay } : {}) })))
      if (structKey !== prevBusStructKeysRef.current.get(bus.id)) {
        prevBusStructKeysRef.current.set(bus.id, structKey)
        audioEngine.rebuildBusEffects(bus.id, bus.effects)
      } else {
        // Only params changed — update in-place without graph rebuild
        audioEngine.updateBusEffectParams(bus.id, bus.effects)
      }
    }
    const masterStructKey = JSON.stringify(project.masterBus.effects.map((s) => ({ type: s.type, enabled: s.enabled, ...(s.type === 'reverb' ? { decay: s.params.decay } : {}) })))
    if (masterStructKey !== prevMasterStructRef.current) {
      prevMasterStructRef.current = masterStructKey
      audioEngine.rebuildMasterEffects(project.masterBus.effects)
    } else {
      audioEngine.updateMasterEffectParams(project.masterBus.effects)
    }
  }, [project?.mixBuses, project?.masterBus?.effects])

  // --- Audio input monitor ---
  useEffect(() => {
    if (audioMonitorEnabled) {
      audioEngine.startInputMonitor(audioMonitorDeviceId, audioMonitorBusId).catch(() => {
        useStore.getState().setAudioMonitorEnabled(false)
      })
    } else {
      audioEngine.stopInputMonitor()
    }
  }, [audioMonitorEnabled, audioMonitorDeviceId, audioMonitorBusId])

  // --- Decode waveform for selected sample ---
  useEffect(() => {
    if (!selectedSample) {
      useStore.setState({ waveformPeaks: [] })
      _waveformChannelCache = null
      return
    }
    let cancelled = false
    const decode = async () => {
      const context = new AudioContext()
      try {
        const buffer = await context.decodeAudioData(await selectedSample.blob.arrayBuffer())
        const channel = buffer.getChannelData(0)
        // Cache full-res channel for zoom
        _waveformChannelCache = { sampleId: selectedSample.id, channel: new Float32Array(channel) }
        const bucketCount = 720
        const bucketSize = Math.max(32, Math.floor(channel.length / bucketCount))
        const peaks = Array.from({ length: bucketCount }, (_, i) => {
          const start = i * bucketSize
          const end = Math.min(channel.length, start + bucketSize)
          let max = 0
          for (let c = start; c < end; c++) max = Math.max(max, Math.abs(channel[c]))
          return max
        })
        if (!cancelled) useStore.setState({ waveformPeaks: peaks })
      } catch {
        if (!cancelled) useStore.setState({ waveformPeaks: [] })
      } finally {
        void context.close().catch(() => undefined)
      }
    }
    void decode()
    return () => { cancelled = true }
  }, [selectedSample])

  // --- Draw waveform canvas ---
  const effectiveGain = useStore((s) => {
    const pad = selectSelectedPad(s)
    if (!pad) return 1
    if (s.selectedLayerId) {
      const layer = pad.settings.layers.find((l) => l.id === s.selectedLayerId)
      if (layer?.gain != null) return layer.gain
    }
    return pad.settings.gain
  })
  useEffect(() => {
    const canvas = waveformCanvasRef.current
    if (!canvas) return

    const draw = () => {
      const width = Math.max(1, Math.floor(canvas.clientWidth))
      const height = Math.max(1, Math.floor(canvas.clientHeight))
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.floor(width * pixelRatio)
      canvas.height = Math.floor(height * pixelRatio)
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (waveformPeaks.length === 0) return

      // Determine visible range based on zoom
      // Use frozen range during trim drag to prevent viewport jumps
      const zoomRange = storeRefs.frozenZoomRange ?? trimDraft
      const viewStart = waveformZoom === 'trim' ? zoomRange.start : 0
      const viewEnd = waveformZoom === 'trim' ? zoomRange.end : 1

      // In zoom mode, compute peaks directly from cached full-res channel data
      // for much higher resolution than the 720-bucket overview
      let visiblePeaks: number[]
      const cache = _waveformChannelCache
      if (waveformZoom === 'trim' && cache && cache.channel.length > 0) {
        const ch = cache.channel
        const sampleStart = Math.floor(viewStart * ch.length)
        const sampleEnd = Math.max(sampleStart + 1, Math.ceil(viewEnd * ch.length))
        const bucketCount = Math.max(width, 1)
        const span = sampleEnd - sampleStart
        visiblePeaks = Array.from({ length: bucketCount }, (_, i) => {
          const bStart = sampleStart + Math.floor((i / bucketCount) * span)
          const bEnd = sampleStart + Math.max(bStart + 1 - sampleStart, Math.ceil(((i + 1) / bucketCount) * span))
          let max = 0
          for (let c = bStart; c < bEnd && c < ch.length; c++) max = Math.max(max, Math.abs(ch[c]))
          return max
        })
      } else {
        const peakStart = Math.floor(viewStart * waveformPeaks.length)
        const peakEnd = Math.max(peakStart + 1, Math.ceil(viewEnd * waveformPeaks.length))
        visiblePeaks = waveformPeaks.slice(peakStart, peakEnd)
      }

      const gradient = context.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, '#7cc5ff')
      gradient.addColorStop(1, '#2f89d8')
      context.fillStyle = gradient
      const barCount = width
      const centerY = height / 2
      for (let i = 0; i < barCount; i++) {
        const samplePos = (i / barCount) * visiblePeaks.length
        const start = Math.floor(samplePos)
        const end = Math.max(start + 1, Math.ceil(((i + 1) / barCount) * visiblePeaks.length))
        let peak = 0
        for (let c = start; c < end && c < visiblePeaks.length; c++) peak = Math.max(peak, visiblePeaks[c] ?? 0)
        peak *= effectiveGain
        const halfH = Math.max(1, Math.floor(peak * height * 0.5))
        context.fillRect(i, centerY - halfH, 1, Math.max(2, halfH * 2))
      }
    }

    draw()
    const observer = new ResizeObserver(() => draw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [waveformPeaks, waveformZoom, padEditorCollapsed, effectiveGain])

  // --- Sync sequenceLengthDraft from visible sequence ---
  useEffect(() => {
    if (!visibleSequence) return
    useStore.setState({ sequenceLengthDraft: String(visibleSequence.lengthSteps) })
  }, [visibleSequence?.id, visibleSequence?.lengthSteps])

  // --- Global drag handlers (velocity, pitch, gate resize, trim) ---
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const s = useStore.getState()

      if (s.velocityDrag) {
        const proj = s.project
        const seq = selectActiveSequence(s)
        if (!proj || !seq || seq.id !== s.velocityDrag.patternId) return
        const delta = s.velocityDrag.originY - event.clientY
        const nextVelocity = Math.max(1, Math.min(127, Math.round(s.velocityDrag.initialVelocity + delta * 1.4)))
        const next = {
          ...proj,
          sequences: proj.sequences.map((sequence) =>
            sequence.id === seq.id
              ? {
                  ...sequence,
                  events: sequence.events.map((e) =>
                    e.id === s.velocityDrag!.eventId && e.padId === s.velocityDrag!.padId
                      ? { ...e, velocity: nextVelocity }
                      : e,
                  ),
                }
              : sequence,
          ),
        }
        useStore.setState({ project: next })
        return
      }

      if (s.pitchDrag) {
        const proj = s.project
        const seq = selectActiveSequence(s)
        if (!proj || !seq || seq.id !== s.pitchDrag.patternId) return
        const delta = s.pitchDrag.originY - event.clientY
        const semitoneDelta = Math.round(delta / 14)
        const nextSemitones = Math.max(
          MIN_STEP_SEMITONES,
          Math.min(MAX_STEP_SEMITONES, s.pitchDrag.initialSemitones + semitoneDelta),
        )
        const next = {
          ...proj,
          sequences: proj.sequences.map((sequence) =>
            sequence.id === seq.id
              ? {
                  ...sequence,
                  events: sequence.events.map((e) =>
                    e.id === s.pitchDrag!.eventId && e.padId === s.pitchDrag!.padId
                      ? { ...e, semitones: nextSemitones }
                      : e,
                  ),
                }
              : sequence,
          ),
        }
        useStore.setState({ project: next })
        return
      }

      if (s.gateResize) {
        const proj = s.project
        const seq = selectActiveSequence(s)
        if (!proj || !seq) return
        const target = seq.events.find((e) => e.id === s.gateResize!.eventId && e.padId === s.gateResize!.padId)
        if (!target) return
        const movement = event.clientX - s.gateResize.originX
        const stepDelta = Math.round(movement / s.gateResize.stepPitch)
        let nextStart = s.gateResize.initialStart
        let nextEnd = s.gateResize.initialEnd
        if (s.gateResize.side === 'left') nextStart = s.gateResize.initialStart + stepDelta
        else nextEnd = s.gateResize.initialEnd + stepDelta
        const bounds = getLaneBoundsForEvent(seq, s.gateResize.padId, s.gateResize.eventId)
        nextStart = Math.max(bounds.minStart, Math.min(nextStart, bounds.maxEnd))
        nextEnd = Math.max(bounds.minStart, Math.min(nextEnd, bounds.maxEnd))
        if (nextStart > nextEnd) {
          if (s.gateResize.side === 'left') nextStart = nextEnd
          else nextEnd = nextStart
        }
        nextStart = Math.max(bounds.minStart, nextStart)
        nextEnd = Math.min(bounds.maxEnd, nextEnd)
        const updated = updateGateEventRange(proj, seq.id, s.gateResize.padId, s.gateResize.eventId, nextStart, nextEnd)
        useStore.setState({ project: updated })
        storeRefs.gateResizeDirty = true
        return
      }

      // Trim drag
      const target = dragTargetRef.current
      if (!target || !waveformRef.current) return

      // Freeze zoom range on first drag frame
      const zoom = useStore.getState().waveformZoom
      if (zoom === 'trim' && !storeRefs.frozenZoomRange) {
        storeRefs.frozenZoomRange = { ...useStore.getState().trimDraft }
      }

      const bounds = waveformRef.current.getBoundingClientRect()
      const rawRatio = (event.clientX - bounds.left) / bounds.width
      let ratio = Math.max(0, Math.min(1, rawRatio))

      // When zoomed to trim region, remap and auto-scroll the viewport
      if (zoom === 'trim' && storeRefs.frozenZoomRange) {
        const fz = storeRefs.frozenZoomRange
        const viewSpan = fz.end - fz.start

        // Auto-scroll: when mouse is past the edge, expand the frozen viewport
        const SCROLL_SPEED = viewSpan * 0.03 // 3% of view per frame
        if (rawRatio > 0.95 && fz.end < 1) {
          const expansion = Math.min(SCROLL_SPEED, 1 - fz.end)
          fz.end = Math.min(1, fz.end + expansion)
        } else if (rawRatio < 0.05 && fz.start > 0) {
          const expansion = Math.min(SCROLL_SPEED, fz.start)
          fz.start = Math.max(0, fz.start - expansion)
        }

        ratio = fz.start + Math.max(0, Math.min(1, rawRatio)) * (fz.end - fz.start)
        ratio = Math.max(0, Math.min(1, ratio))
      }

      const current = useStore.getState().trimDraft
      const nextTrim =
        target === 'start'
          ? { start: Math.min(ratio, current.end - 0.01), end: current.end }
          : { start: current.start, end: Math.max(ratio, current.start + 0.01) }

      useStore.setState({ trimDraft: nextTrim })
      storeRefs.trimDirty = true

      // Route through updatePadSettings so layer overrides are respected
      useStore.getState().updatePadSettings({ trim: nextTrim })
    }

    const onUp = () => {
      const s = useStore.getState()
      if (s.velocityDrag) {
        useStore.setState({ velocityDrag: null })
        if (s.project) s.saveProjectLight(s.project, true)
        s.finishDragHistoryCapture()
        return
      }
      if (s.pitchDrag) {
        useStore.setState({ pitchDrag: null })
        if (s.project) s.saveProjectLight(s.project, true)
        s.finishDragHistoryCapture()
        return
      }
      if (s.gateResize) {
        useStore.setState({ gateResize: null })
        if (storeRefs.gateResizeDirty && s.project) {
          storeRefs.gateResizeDirty = false
          s.saveProjectLight(s.project, true)
        }
        s.finishDragHistoryCapture()
        return
      }
      dragTargetRef.current = null
      waveformRef.current?.classList.remove('trim-dragging')
      storeRefs.frozenZoomRange = null
      // Force re-render so handle positions update after frozen range is cleared
      const currentTrim = s.trimDraft
      useStore.setState({ trimDraft: { ...currentTrim } })
      if (!storeRefs.trimDirty || !s.project) return
      storeRefs.trimDirty = false
      s.saveProjectLight(s.project, true)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // --- Global keydown ---
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable)
      ) return

      // --- Computer keyboard chromatic input ---
      const ckState = useStore.getState()
      if (ckState.computerKeyboardEnabled) {
        const selectedPadForCk = ckState.selectedPadId
          ? ckState.project?.pads.find((p) => p.id === ckState.selectedPadId)
          : null
        const isSynthPad = selectedPadForCk?.settings.source === 'synth' && selectedPadForCk?.settings.synthParams

        if (isSynthPad) {
          // Octave shift: Z down, X up (only when not already mapped to notes — we repurpose these)
          // Actually Z and X ARE in the note map. Use Comma/Period instead... No, the plan says Z/X.
          // Conflict: Z=C note. Solution: use dedicated octave keys outside the note map.
          // Let's use - and = (minus/equals) for octave down/up to avoid conflicts.
          if (event.code === 'Minus' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            useStore.setState((s) => ({ computerKeyboardOctave: Math.max(-1, s.computerKeyboardOctave - 1) }))
            return
          }
          if (event.code === 'Equal' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            useStore.setState((s) => ({ computerKeyboardOctave: Math.min(8, s.computerKeyboardOctave + 1) }))
            return
          }

          const noteOffset = COMPUTER_KEY_NOTE_MAP[event.code]
          if (noteOffset != null && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            if (_activeComputerKeys.has(event.code)) return // key repeat, ignore

            const midiNote = ckState.computerKeyboardOctave * 12 + 12 + noteOffset // C3 = MIDI 48 when octave=3
            _activeComputerKeys.set(event.code, midiNote)

            const baseNote = selectedPadForCk!.settings.synthParams!.baseNote + (selectedPadForCk!.settings.semitones ?? 0)
            const semitoneOffset = midiNote - baseNote

            audioEngine.playPad(selectedPadForCk!, 0.85, {
              semitoneOffset,
              hold: selectedPadForCk!.settings.mode === 'adsr',
              bpm: ckState.project?.bpm ?? 120,
            })

            // Feed capture buffer
            useStore.getState().feedCaptureBuffer(selectedPadForCk!.id, 108, 'on', midiNote)

            // If sequencer is recording, record the note as a piano roll event
            if (ckState.isPlaying && ckState.seqRecordArmed) {
              ckState.recordPadHit(selectedPadForCk!.id, 108, midiNote)
            }

            return
          }
        }
      }

      if (event.code === 'Space') {
        event.preventDefault()
        useStore.getState().togglePlayPause()
        return
      }

      // Escape: close dialogs
      if (event.key === 'Escape') {
        const s = useStore.getState()
        if (s.confirmDialog) return // handled by ConfirmDialog's own listener
        if (s.showExportDialog && !s.isExporting) useStore.setState({ showExportDialog: false })
        else if (s.showImportDialog) useStore.setState({ showImportDialog: false })
        else if (s.sampleAssignPrompt) s.cancelSampleAssignPrompt()
        return
      }

      // S: stop transport
      if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey) {
        useStore.getState().stopTransport()
        return
      }

      // T: tap tempo
      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey) {
        useStore.getState().tapTempo()
        return
      }

      // Number keys 1-8: switch bank
      if (event.key >= '1' && event.key <= '8' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const bank = Number(event.key) - 1
        useStore.setState({ activeBank: bank })
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const s = useStore.getState()
        if (s.selectedChainEntryId) {
          event.preventDefault()
          void s.removeChainEntry(s.selectedChainEntryId)
        }
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        const s = useStore.getState()
        if (s.selectedChainEntryId) {
          event.preventDefault()
          s.copySelectedChainEntry()
        }
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) void useStore.getState().redoSequencer()
        else void useStore.getState().undoSequencer()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        void useStore.getState().redoSequencer()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        const s = useStore.getState()
        if (s.copiedChainPatternId) {
          event.preventDefault()
          void s.pasteChainEntry()
        }
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        const s = useStore.getState()
        const seq = selectActiveSequence(s)
        if (seq) void s.duplicatePattern(seq.id)
        return
      }

      // Gate nudge
      const s = useStore.getState()
      if (!event.altKey || !s.selectedGateNote || !s.project) return
      const seq = selectActiveSequence(s)
      if (!seq) return
      const targetEvent = seq.events.find(
        (e) => e.id === s.selectedGateNote!.eventId && e.padId === s.selectedGateNote!.padId,
      )
      if (!targetEvent) return
      const pad = s.project.pads.find((p) => p.id === s.selectedGateNote!.padId)
      if (pad?.settings.mode !== 'adsr') return

      const bounds = getLaneBoundsForEvent(seq, s.selectedGateNote!.padId, s.selectedGateNote!.eventId)
      let start = targetEvent.step
      let end = targetEvent.step + Math.max(1, targetEvent.gate) - 1

      if (event.key === 'ArrowLeft') {
        if (event.shiftKey) start = Math.max(bounds.minStart, start - 1)
        else end = Math.max(start, end - 1)
      } else if (event.key === 'ArrowRight') {
        if (event.shiftKey) end = Math.min(bounds.maxEnd, end + 1)
        else start = Math.min(end, start + 1)
      } else return

      event.preventDefault()
      void s.saveProject(
        updateGateEventRange(s.project, seq.id, s.selectedGateNote!.padId, s.selectedGateNote!.eventId, start, end),
      )
    }

    window.addEventListener('keydown', onKeyDown)
    
    const onKeyUp = (event: KeyboardEvent) => {
      // Computer keyboard note-off
      if (_activeComputerKeys.has(event.code)) {
        const midiNote = _activeComputerKeys.get(event.code)!
        _activeComputerKeys.delete(event.code)
        const s = useStore.getState()
        const pad = s.selectedPadId ? s.project?.pads.find((p) => p.id === s.selectedPadId) : null
        if (pad) {
          audioEngine.releasePad(pad.id)
          useStore.getState().feedCaptureBuffer(pad.id, 0, 'off', midiNote)
          // Update gate length for recording
          if (s.isPlaying && s.seqRecordArmed && pad.settings.source === 'synth') {
            s.recordPadRelease(pad.id, midiNote)
          }
        }
      }
    }
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // --- Export actions ---
  const exportAllMidi = useCallback(async () => {
    if (!project) return
    for (const sequence of project.sequences) {
      const bytes = await buildMidiForSequence(sequence, project.pads, project.bpm)
      const safeBytes = new Uint8Array(bytes.length)
      safeBytes.set(bytes)
      const blob = new Blob([safeBytes], { type: 'audio/midi' })
      void downloadOrShare(blob, `${sequence.name}.mid`)
    }
  }, [project])

  const exportPack = useCallback(async () => {
    if (!project) return
    const { samples, synthPatches } = useStore.getState()
    const blob = await exportProjectPackage(project, samples, synthPatches)
    await downloadOrShare(blob, `${project.name.replace(/\s+/g, '-')}.ospack`)
  }, [project])

  const exportStandalonePage = useCallback(async () => {
    if (!project) return
    const usedIds = Array.from(
      new Set(project.pads.map((p) => p.settings.sampleId).filter((id): id is string => Boolean(id))),
    )
    const embeddedSamples: Array<{ id: string; name: string; mimeType: string; base64: string }> = []
    for (const sampleId of usedIds) {
      const sample = await db.getSample(sampleId)
      if (!sample) continue
      embeddedSamples.push({
        id: sample.id,
        name: sample.name,
        mimeType: sample.mimeType,
        base64: arrayBufferToBase64(await sample.blob.arrayBuffer()),
      })
    }
    const html = buildStandaloneHtml(project, embeddedSamples)
    const blob = new Blob([html], { type: 'text/html' })
    await downloadOrShare(blob, `${project.name.replace(/\s+/g, '-')}.standalone.html`)
  }, [project])

  const exportAudio = useCallback(async (mode: 'pattern' | 'song') => {
    if (!project || !activeSequence) return
    if (mode === 'song' && project.songChain.length === 0) return
    useStore.setState({ isExporting: true })
    const sampleIds = Array.from(
      new Set(project.pads.flatMap((p) => {
        const ids: string[] = []
        if (p.settings.sampleId) ids.push(p.settings.sampleId)
        for (const layer of p.settings.layers ?? []) {
          if (layer.sampleId) ids.push(layer.sampleId)
        }
        return ids
      })),
    )
    const samplePairs = await Promise.all(
      sampleIds.map(async (sid) => [sid, await db.getSample(sid)] as const),
    )
    const samplesById = new Map(samplePairs.filter((e): e is [string, SampleAsset] => Boolean(e[1])))
    try {
      const wav = await renderProjectAudioWav(project, samplesById, {
        mode,
        activeSequenceId: activeSequence.id,
      })
      const safeName = project.name.replace(/\s+/g, '-')
      const bpmTag = `${project.bpm}bpm`
      const filename =
        mode === 'pattern'
          ? `${safeName}-${bpmTag}-pattern-${activeSequence.name.replace(/\s+/g, '-')}-x2-loop.wav`
          : `${safeName}-${bpmTag}-song-chain.wav`
      await downloadOrShare(wav, filename)
      useStore.getState().addToast(`Exported ${filename}`, 'success')
      useStore.setState({ showExportDialog: false })
    } catch (error) {
      useStore.getState().addToast(
        error instanceof Error ? error.message : 'Audio export failed.',
        'error',
      )
    } finally {
      useStore.setState({ isExporting: false })
    }
  }, [project, activeSequence])

  const doPreviewImport = useCallback(async () => {
    if (!project || !importFile) return
    const incoming = normalizeProject(await readProjectFromPackage(importFile))
    const quick = importPreview(project, incoming)
    const report = buildImportConflictReport(project, incoming)
    useStore.setState({
      previewText: `Preview ${importMode}: ${quick.overlaps} overlap, ${quick.additions} additions, ${quick.unchanged} unchanged`,
      conflicts: [
        `Pad overlaps: ${report.padOverlaps.length}`,
        `Pad additions: ${report.padAdditions.length}`,
        `Sequence name collisions: ${report.sequenceNameCollisions.length}`,
        `Incoming-only sequences: ${report.incomingOnlySequences.length}`,
        ...report.padOverlaps.slice(0, 8).map((e) => `Overlap -> ${e}`),
        ...report.sequenceNameCollisions.slice(0, 8).map((e) => `Seq collision -> ${e}`),
      ],
    })
  }, [project, importFile, importMode])

  const doRunImport = useCallback(async () => {
    if (!project || !importFile) return
    const result = await importProjectPackage(importFile, importMode, project)
    const normalized = normalizeProject(result.project)
    const allSamples = await db.getAllSamples()
    const stateUpdate: Partial<ReturnType<typeof useStore.getState>> = {
      project: normalized,
      selectedPadId: normalized.pads[0]?.id ?? null,
      activeSequenceId: normalized.sequences[0]?.id ?? null,
      samples: allSamples,
      sampleMap: new Map(allSamples.map((s: SampleAsset) => [s.id, s])),
      bpmDraft: String(normalized.bpm),
      swingDraft: String(normalized.swing ?? 0),
      projectNameDraft: normalized.name,
      previewText: `Imported: ${result.preview.overlaps} overlap, ${result.preview.additions} additions, ${result.preview.unchanged} unchanged`,
      showImportDialog: false,
    }
    // Restore synth patches if present in package
    if (result.synthPatches && result.synthPatches.length > 0) {
      stateUpdate.synthPatches = result.synthPatches
      try { localStorage.setItem('synthPatches', JSON.stringify(result.synthPatches)) } catch { /* ignore */ }
    }
    useStore.setState(stateUpdate)
    // Sync audio engine and rebuild playback snapshot
    audioEngine.setBpm(normalized.bpm)
    audioEngine.setPolyphony(normalized.polyphony)
    void useStore.getState().saveProject(normalized)
  }, [project, importFile, importMode])

  // --- Shared performance tab UI ---
  const desktopTabs = (
    <div className="perf-tabs">
      {([
        ['library', 'Samples'],
        ['padEditor', 'Pad Edit'],
        ['sequencer', 'Sequencer'],
        ['mixer', 'Mixer'],
        ['projects', 'Projects'],
        ['settings', 'Settings'],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`perf-tab${performanceTab === id ? ' active' : ''}`}
          onClick={() => {
            useStore.setState({ performanceTab: id })
            localStorage.setItem('performanceTab', id)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )

  const mobileTabs = (
    <div className="perf-mobile-tabs">
      {([
        ['library', 'Lib'],
        ['padEditor', 'Pad'],
        ['sequencer', 'Seq'],
        ['mixer', 'Mix'],
        ['projects', 'Prj'],
        ['settings', 'Set'],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`perf-mobile-tab${performanceTab === id ? ' active' : ''}`}
          onClick={() => {
            useStore.setState({ performanceTab: id })
            localStorage.setItem('performanceTab', id)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )

  const activeTabPanel = (
    <>
      {performanceTab === 'library' && <SampleLibrary />}
      {performanceTab === 'padEditor' && (
        <PadEditor
          waveformRef={waveformRef}
          waveformCanvasRef={waveformCanvasRef}
          dragTargetRef={dragTargetRef}
        />
      )}
      {performanceTab === 'sequencer' && <Sequencer />}
      {performanceTab === 'mixer' && <Mixer />}
      {performanceTab === 'projects' && <ProjectsPanel />}
      {performanceTab === 'settings' && <PerfSettingsPanel />}
    </>
  )

  const perfDropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    onDrop: (e: React.DragEvent) => {
      // Only intercept when NOT on library tab (library has its own handler)
      if (performanceTab === 'library') return
      const items = Array.from(e.dataTransfer.items)
      const hasFiles = items.some((it) => it.kind === 'file')
      if (!hasFiles) return
      e.preventDefault()
      e.stopPropagation()
      // Switch to library tab
      useStore.setState({ performanceTab: 'library' })
      localStorage.setItem('performanceTab', 'library')
      // Read entries (supports folders via webkitGetAsEntry)
      const allFiles: File[] = []
      const readEntry = (entry: FileSystemEntry): Promise<void> => {
        if (entry.isFile) {
          return new Promise((resolve) => {
            (entry as FileSystemFileEntry).file((f) => { allFiles.push(f); resolve() }, () => resolve())
          })
        } else if (entry.isDirectory) {
          return new Promise((resolve) => {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            const readBatch = () => {
              reader.readEntries(async (entries) => {
                if (entries.length === 0) { resolve(); return }
                for (const ent of entries) await readEntry(ent)
                readBatch()
              }, () => resolve())
            }
            readBatch()
          })
        }
        return Promise.resolve()
      }
      void (async () => {
        for (const item of items) {
          const entry = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
          if (entry) {
            await readEntry(entry)
          } else if (item.kind === 'file') {
            const f = item.getAsFile()
            if (f) allFiles.push(f)
          }
        }
        if (allFiles.length > 0) {
          void useStore.getState().addSamplesToLibrary(allFiles)
        }
      })()
    },
  }

  // --- Render ---

  if (!project || !activeSequence) {
    return <main className="app">Loading project...</main>
  }

  return (
    <main className={`app${altLayout ? ' app-alt-layout' : ''}${layoutMode === 'performance' ? ' app-perf-layout' : ''}`}>
      <TopBar isPhone={isMobile} />

      {showExportDialog && (
        <ExportDialog
          onExportMidi={exportAllMidi}
          onExportPack={() => void exportPack()}
          onExportStandalone={() => void exportStandalonePage()}
          onExportAudioPattern={() => void exportAudio('pattern')}
          onExportAudioSong={() => void exportAudio('song')}
          songChainEmpty={project.songChain.length === 0}
        />
      )}

      {showImportDialog && (
        <ImportDialog
          onPreview={() => void doPreviewImport()}
          onImport={() => void doRunImport()}
        />
      )}

      {sampleAssignPrompt && (
        <section className="import-dialog-overlay" role="dialog" aria-modal="true">
          <div className="import-dialog sample-assign-prompt">
            <div className="import-dialog-head">
              <h2>Pad already has a sample</h2>
              <button type="button" onClick={() => useStore.getState().cancelSampleAssignPrompt()}>Close</button>
            </div>
            <p className="preview">
              Assign <strong>{sampleAssignPrompt.sample.name}</strong> — replace the existing sample or add as a multisample layer?
            </p>
            <div className="import-actions">
              <button type="button" onClick={() => void useStore.getState().confirmSampleReplace()}>
                Replace
              </button>
              <button type="button" onClick={() => void useStore.getState().confirmSampleAddLayer()}>
                Add as Layer
              </button>
              <button type="button" onClick={() => useStore.getState().cancelSampleAssignPrompt()}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}

      {layoutMode === 'performance' ? (
        isMobile ? (
          <section className="perf-mobile-layout">
            <div className="perf-mobile-content" {...perfDropHandlers}>
              {activeTabPanel}
            </div>
            {mobileTabs}
            <div className="perf-mobile-pads">
              <PadGrid />
            </div>
          </section>
        ) : (
          <section className="perf-layout" ref={perfDivContainerRef}>
            <div className="perf-left" style={{ flex: perfSplitRatio }} {...perfDropHandlers}>
              {desktopTabs}
              {activeTabPanel}
            </div>
            <div className="perf-divider" onPointerDown={onPerfDivPointerDown}>
              <div className="divider-grip" />
            </div>
            <div className="perf-right" style={{ flex: 1 - perfSplitRatio }}>
              <PadGrid />
            </div>
          </section>
        )
      ) : (
      <section className={`studio-layout${altLayout ? ' studio-layout-alt' : ''}`}>
        <div className="studio-col studio-col-left" style={{ width: leftWidth, flexShrink: 0 }}>
          {leftCollapsed ? (
            <div className="studio-collapse-strip" onClick={toggleLeft} title="Expand Library">
              <span className="collapse-strip-label">Library</span>
              <button type="button" className="collapse-strip-btn" aria-label="Expand Library">&#x25B8;</button>
            </div>
          ) : (
            <SampleLibrary onCollapse={toggleLeft} />
          )}
        </div>
        <div className="studio-divider" {...leftDividerProps}>
          <div className="divider-grip" />
        </div>

        {altLayout ? (
          <div className="studio-col studio-col-main" ref={hDivContainerRef} style={{ flex: 1, minWidth: 0 }}>
            <div className="seq-mixer-pane" style={{ flex: seqMixerRatio }}>
              <Sequencer />
            </div>
            <div className="seq-mixer-divider" onPointerDown={onHDivPointerDown}>
              <div className="divider-grip-h" />
            </div>
            <div className="seq-mixer-pane alt-bottom-row" style={{ flex: 1 - seqMixerRatio }}>
              <Mixer />
              <PadEditor
                waveformRef={waveformRef}
                waveformCanvasRef={waveformCanvasRef}
                dragTargetRef={dragTargetRef}
              />
              <PadGrid />
            </div>
          </div>
        ) : (<>
          <div className="studio-col studio-col-center" style={{ flex: 1, minWidth: 0 }}>
            <PadEditor
              waveformRef={waveformRef}
              waveformCanvasRef={waveformCanvasRef}
              dragTargetRef={dragTargetRef}
            />
            <PadGrid />
          </div>

          <div className="studio-divider" {...rightDividerProps}>
            <div className="divider-grip" />
          </div>
          <div className="studio-col studio-col-right" ref={hDivContainerRef} style={{ width: rightWidth, flexShrink: 0 }}>
            {rightCollapsed ? (
              <div className="studio-collapse-strip" onClick={toggleRight} title="Expand Sequencer & Mixer">
                <span className="collapse-strip-label">Seq</span>
                <button type="button" className="collapse-strip-btn" aria-label="Expand">&#x25C2;</button>
              </div>
            ) : (<>
              <div className="seq-mixer-pane" style={{ flex: seqMixerRatio }}>
                <Sequencer />
              </div>
              <div className="seq-mixer-divider" onPointerDown={onHDivPointerDown}>
                <div className="divider-grip-h" />
              </div>
              <div className="seq-mixer-pane" style={{ flex: 1 - seqMixerRatio }}>
                <Mixer />
              </div>
            </>)}
          </div>
        </>)}
      </section>
      )}

      {layoutMode !== 'performance' && (
      <footer className="footer">
        <span>8 banks x {PADS_PER_BANK} pads (C1 start)</span>
        <span>Drag files to pads, trim from waveform handles, sequence and export.</span>
      </footer>
      )}

      <Toasts />
      {showRecordDialog && <RecordDialog />}
      {showAutosampleDialog && <AutosampleDialog />}
      <ConfirmDialog />
      <ChopModal />
    </main>
  )
}

export default App
