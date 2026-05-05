import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import { audioEngine } from '../lib/audioEngine'
import { db } from '../lib/db'
import { buildPlaybackSnapshot, type PlaybackSnapshot } from '../lib/playbackSnapshot'
import { TransportScheduler } from '../lib/transportScheduler'
import { createDefaultProject, touchProject } from '../lib/project'
import { createDefaultEffectSlot, createDefaultMasterBus, createDefaultMixBuses, createDefaultSequence } from '../lib/utils'
import { encodeWavFromChannels } from '../lib/wavEncode'
import { normalizePcm, computeSilenceTrim } from '../lib/autotrim'
import { sendMidiNote, registerActiveNote } from '../lib/midiOut'
import { notifyPadTriggered as notifyLaunchpad, notifySequencerHit as notifyLaunchpadSeqHit } from '../lib/launchpadProMk3'
// constants used by selectors are re-exported from lib

enableMapSet()

/** Default parameter values for each effect type */
export const getDefaultEffectParams = (type: EffectType): Record<string, number> => {
  switch (type) {
    case 'compressor': return { threshold: -18, ratio: 4, knee: 10, attack: 0.003, release: 0.25 }
    case 'sidechain-compressor': return { threshold: -18, ratio: 4, knee: 10, attack: 0.003, release: 0.25 }
    case 'eq3': return { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1000 }
    case 'delay': return { time: 0.3, feedback: 0.35, mix: 0.3 }
    case 'reverb': return { decay: 1.5, mix: 0.25 }
    case 'chorus': return { rate: 1.5, depth: 5, mix: 0.3 }
    default: return {}
  }
}

import { arrayBufferToHex, clampSequenceLength, midiToName, uid } from '../lib/utils'
import { BANK_COUNT, PADS_PER_BANK } from '../lib/constants'
import { parseMpcPgm, matchMpcSamplesToFiles } from '../lib/mpcImport'
import { parseLcdk, matchLcdkSamplesToFiles } from '../lib/lcdkImport'
import JSZip from 'jszip'
import TransportClockWorker from '../workers/transportClock.worker?worker'
import type {
  BusId,
  EffectSlot,
  EffectType,
  ImportMode,
  MidiOutConfig,
  Pad,
  Project,
  SampleAsset,
  SampleLayer,
  SequenceEvent,
  SequencePattern,
  SequenceResolution,
  SongChainEntry,
  SynthPatch,
  TrimSettings,
} from '../types'

// ---------------------------------------------------------------------------
// Synth Patch Persistence (localStorage)
// ---------------------------------------------------------------------------

function loadSynthPatches(): SynthPatch[] {
  try {
    const raw = localStorage.getItem('synthPatches')
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

function saveSynthPatches(patches: SynthPatch[]): void {
  try {
    localStorage.setItem('synthPatches', JSON.stringify(patches))
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Transport Visual Store (lightweight, no immer — high-frequency updates)
// ---------------------------------------------------------------------------

type TransportVisualListener = () => void

let _tvPlayheadStep: number | null = null
let _tvSequencedPadHits = new Set<string>()
const _tvListeners = new Set<TransportVisualListener>()

function _tvNotify() {
  for (const listener of _tvListeners) listener()
}

export const transportVisualStore = {
  getPlayheadStep: () => _tvPlayheadStep,
  getSequencedPadHits: () => _tvSequencedPadHits,

  setPlayheadStep(step: number | null) {
    if (step === _tvPlayheadStep) return
    _tvPlayheadStep = step
    _tvNotify()
  },

  flashPadHit(padId: string) {
    if (_tvSequencedPadHits.has(padId)) return
    _tvSequencedPadHits = new Set(_tvSequencedPadHits)
    _tvSequencedPadHits.add(padId)
    _tvNotify()
  },

  clearPadHit(padId: string) {
    if (!_tvSequencedPadHits.has(padId)) return
    _tvSequencedPadHits = new Set(_tvSequencedPadHits)
    _tvSequencedPadHits.delete(padId)
    _tvNotify()
  },

  reset() {
    _tvPlayheadStep = null
    _tvSequencedPadHits = new Set()
    _tvNotify()
  },

  subscribe(listener: TransportVisualListener): () => void {
    _tvListeners.add(listener)
    return () => { _tvListeners.delete(listener) }
  },

  getSnapshot: () => ({ playheadStep: _tvPlayheadStep, sequencedPadHits: _tvSequencedPadHits }),
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATTERN_COLORS = [
  // Row 1 — pastels / light
  '#f8b4b4', '#f8c9a4', '#f8e3a1', '#a8e6a3', '#a1e8d8', '#a4cff8', '#c4b4f8', '#f0b4e8',
  // Row 2 — soft
  '#f28b8b', '#f2a86b', '#f2d06b', '#7dd87a', '#6bd8c2', '#6bb0f2', '#a08bf2', '#e88bd8',
  // Row 3 — medium
  '#ef6f7a', '#f28f3b', '#f2c12e', '#57c08b', '#3dcbab', '#59a9ff', '#8b6ff2', '#d96fbf',
  // Row 4 — vivid
  '#e8445a', '#e87030', '#e8b020', '#3aad6e', '#2ab896', '#3d8ef0', '#7350e8', '#c850a8',
  // Row 5 — saturated
  '#d42848', '#d45828', '#d49818', '#289858', '#1da080', '#2878d4', '#5e38d4', '#b03890',
  // Row 6 — deep
  '#b82040', '#b84820', '#b88018', '#208048', '#188868', '#2060b8', '#4828b8', '#982878',
  // Row 7 — dark
  '#981838', '#983818', '#986810', '#186838', '#107050', '#184898', '#381898', '#801860',
  // Row 8 — very dark
  '#781030', '#782810', '#785008', '#105028', '#085838', '#103878', '#280878', '#680848',
]

/** First 8 vivid colors used for auto-assigning new patterns */
const PATTERN_COLORS_CYCLE = PATTERN_COLORS.slice(16, 24)
const MIN_STEP_SEMITONES = -24
const MAX_STEP_SEMITONES = 24

// ---------------------------------------------------------------------------
// Helpers (moved from App.tsx)
// ---------------------------------------------------------------------------

const createLayer = (sampleId: string, overrides?: Partial<SampleLayer>): SampleLayer => ({
  id: uid(),
  sampleId,
  velocityLow: 1,
  velocityHigh: 127,
  gain: null,
  semitones: null,
  fineCents: null,
  trim: null,
  envelope: null,
  filterType: null,
  filterFreq: null,
  filterQ: null,
  stackOffsetMs: null,
  ...overrides,
})

export const normalizeProject = (incoming: Project): Project => {
  const normalizedChain = (incoming.songChain ?? []).map((entry) => ({
    ...entry,
    repeats: Math.max(1, entry.repeats ?? 1),
  }))

  const maxIndex = Math.max(0, normalizedChain.length - 1)
  const clampLoop = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) {
      return null
    }
    return Math.max(0, Math.min(maxIndex, value))
  }

  const loopStart = clampLoop(incoming.songLoopStart)
  const loopEnd = clampLoop(incoming.songLoopEnd)

  return {
    ...incoming,
    swing: incoming.swing ?? 0,
    pads: incoming.pads.map((pad) => ({
      ...pad,
      settings: {
        ...pad.settings,
        // Migrate 'adr' → 'adsr', 'trigger' → 'one-shot', 'gate' → 'adsr'
        mode: ((m: string) => m === 'adr' || m === 'gate' ? 'adsr' as const : m === 'trigger' ? 'one-shot' as const : pad.settings.mode)(pad.settings.mode as string),
        // Ensure sustain field exists (default 0 for legacy projects)
        envelope: { ...pad.settings.envelope, sustain: (pad.settings.envelope as any).sustain ?? 0 },
        // Migrate 'lowpass' → 'lp12'
        filterType: (pad.settings.filterType as string) === 'lowpass' ? 'lp12' as const : pad.settings.filterType ?? 'off',
        layers: (pad.settings.layers ?? []).map((layer: any) => ({
          ...layer,
          gain: layer.gain ?? null,
          semitones: layer.semitones ?? null,
          fineCents: layer.fineCents ?? null,
          trim: layer.trim ?? null,
          envelope: layer.envelope ? { ...layer.envelope, sustain: layer.envelope.sustain ?? 0 } : null,
          filterType: layer.filterType === 'lowpass' ? 'lp12' : (layer.filterType ?? null),
          filterFreq: layer.filterFreq ?? null,
          filterQ: layer.filterQ ?? null,
        })),
        multiMode: pad.settings.multiMode ?? 'single',
        filterFreq: pad.settings.filterFreq ?? 1000,
        filterQ: pad.settings.filterQ ?? 1,
        bus: pad.settings.bus ?? 'A',
        chokeGroup: (pad.settings as any).chokeGroup ?? 0,
        source: (pad.settings as any).source ?? 'sample',
        // Migrate LFO: old { depth, target } → per-target depths
        ...((pad.settings as any).synthParams?.lfo && 'target' in ((pad.settings as any).synthParams?.lfo ?? {}) ? {
          synthParams: {
            ...(pad.settings as any).synthParams,
            lfo: (() => {
              const old = (pad.settings as any).synthParams.lfo
              const { target, depth, ...rest } = old
              return {
                ...rest,
                pitchDepth: target === 'pitch' ? (depth ?? 0) : 0,
                filterDepth: target === 'filter' ? (depth ?? 0) : 0,
                gainDepth: target === 'gain' ? (depth ?? 0) : 0,
              }
            })(),
          },
        } : {}),
      },
    })),
    sequences: incoming.sequences.map((sequence, index) => ({
      ...sequence,
      color: sequence.color ?? PATTERN_COLORS_CYCLE[index % PATTERN_COLORS_CYCLE.length],
    })),
    songChain: normalizedChain,
    songLoopStart: normalizedChain.length === 0 ? null : loopStart,
    songLoopEnd: normalizedChain.length === 0 ? null : loopEnd,
    mixBuses: (incoming as any).mixBuses ?? createDefaultMixBuses(),
    masterBus: (incoming as any).masterBus ?? createDefaultMasterBus(),
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SequencerHistorySnapshot = {
  sequences: Project['sequences']
  songChain: Project['songChain']
  songLoopStart: Project['songLoopStart']
  songLoopEnd: Project['songLoopEnd']
  activeSequenceId: string | null
}

export interface GateResizeState {
  padId: string
  eventId: string
  side: 'left' | 'right'
  originX: number
  stepPitch: number
  initialStart: number
  initialEnd: number
}

export interface VelocityDragState {
  padId: string
  eventId: string
  originY: number
  initialVelocity: number
  patternId: string
}

export interface PitchDragState {
  padId: string
  eventId: string
  originY: number
  initialSemitones: number
  patternId: string
}

export type ToastType = 'info' | 'success' | 'error'

export interface Toast {
  id: string
  message: string
  type: ToastType
}

export interface PerfStatsState {
  tickCount: number
  lateNotes: number
  maxDriftMs: number
  p95DriftMs: number
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface AppState {
  // --- Project / Persistence ---
  project: Project | null
  samples: SampleAsset[]
  sampleMap: Map<string, SampleAsset>

  // --- Transport / Playback ---
  isPlaying: boolean
  playbackScope: 'pattern' | 'song'
  playingPatternId: string | null
  playingChainIndex: number | null
  playingChainRepeat: number
  loopEnabled: boolean
  playheadStep: number | null
  showPerfStats: boolean
  perfStats: PerfStatsState

  // --- Audio ---
  midiStatus: string
  midiInputEnabled: boolean
  midiInputDeviceId: string | null   // null = all inputs
  padMidiChannel: number | null      // null = all channels, 1–16 = specific channel
  launchpadSpecialMode: boolean      // true = use custom LP Pro MK3 integration, false = treat as generic MIDI
   midiInputs: Array<{ id: string; name: string }>
  midiOutputs: Array<{ id: string; name: string }>
  lastMidiNote: { note: number; velocity: number } | null
  // Audio input monitor
  audioMonitorEnabled: boolean
  audioMonitorDeviceId: string | null   // null = default
  audioMonitorBusId: BusId
  // Audio output device
  audioOutputs: Array<{ id: string; name: string }>
  audioOutputDeviceId: string | null   // null = system default
  // Audio input device
  audioInputs: Array<{ id: string; name: string }>
  audioInputDeviceId: string | null    // null = system default
  sequencedPadHits: Set<string>

  // --- Recording ---
  showRecordDialog: boolean
  recordTargetPadId: string | null
  padHoldRecordEnabled: boolean
  padHoldRecordingPadId: string | null

  // --- Sequencer Editing ---
  activeSequenceId: string | null
  mutedLanePadIds: Set<string>
  selectedGateNote: { padId: string; eventId: string } | null
  gateResize: GateResizeState | null
  velocityDrag: VelocityDragState | null
  pitchDrag: PitchDragState | null
  historyPast: SequencerHistorySnapshot[]
  historyFuture: SequencerHistorySnapshot[]
  historySilenced: boolean

  // --- UI / View ---
  activeBank: number
  selectedPadId: string | null
  selectedLayerId: string | null
  hideEmptyLanes: boolean
  seqFollowPlayback: boolean  // when true + song mode, active pattern follows playing pattern
  seqExpandedBanks: Set<number>   // banks user explicitly expanded (overrides auto-collapse)
  seqCollapsedBanks: Set<number>  // banks user explicitly collapsed (overrides auto-expand)
  layoutMode: 'classic' | 'wide' | 'performance'
  performanceTab: 'library' | 'padEditor' | 'sequencer' | 'mixer' | 'settings' | 'projects'
  showSongChain: boolean
  padEditorCollapsed: boolean
  showLibraryWaveforms: boolean
  showExportDialog: boolean
  isExporting: boolean
  showImportDialog: boolean
  showGateResizeTip: boolean
  toasts: Toast[]
  showSequencerHelp: boolean
  showSequencerTools: boolean
  bpmDraft: string
  swingDraft: string
  projectNameDraft: string
  sequenceLengthDraft: string
  trimDraft: { start: number; end: number }
  waveformZoom: 'full' | 'trim'
  patternRenameId: string | null
  patternRenameDraft: string
  importMode: ImportMode
  previewText: string
  conflicts: string[]
  importFile: File | null
  waveformPeaks: number[]

  // --- Sample Library ---
  sampleQuery: string
  sampleSort: 'recent' | 'name' | 'size'
  showFavoritesOnly: boolean
  favoriteSampleIds: Set<string>
  libraryWavePeaks: Record<string, number[]>
  previewSampleId: string | null

  // --- Synth Patches ---
  synthPatches: SynthPatch[]

  // --- Piano Roll ---
  expandedPianoRollPads: Set<string>
  pianoRollOctaveOffset: Record<string, number>  // per-pad octave offset for piano roll view

  // --- Computer Keyboard Input ---
  computerKeyboardEnabled: boolean
  computerKeyboardOctave: number  // base octave (default 3 → C3-B4)

  // --- Sample Assign Prompt ---
  sampleAssignPrompt: { padId: string; sample: SampleAsset } | null

  // --- Confirm Dialog ---
  confirmDialog: { message: string; confirmLabel?: string; cancelLabel?: string } | null

  // --- Chop Modal ---
  chopModalSampleId: string | null

  // --- Chromatic Spread ---
  chromaticSpreadSampleId: string | null

  // --- Pad Drag ---
  padDragPrompt: { sourcePadId: string; targetPadId: string } | null

  // --- Sequencer Recording ---
  seqRecordArmed: boolean
  seqRecordQuantize: boolean
  seqRecordOverdub: boolean

  // --- Metronome ---
  metronomeEnabled: boolean
  metronomeVolume: number        // 0–1
  countdownBars: number          // 0 = off, 1–4 bars of count-in before recording

  // --- Song Chain ---
  selectedChainEntryId: string | null
  copiedChainPatternId: string | null

  // --- Project List ---
  projectList: { id: string; name: string; updatedAt: number }[]

  // --- Internal refs (non-reactive, accessed via getState()) ---
  // (Mutable refs moved to module-level variables, see storeRefs export)
  // (Mutable refs moved to module-level variables, see storeRefs export)

  // --- Actions ---

  // Project
  hydrate: () => Promise<void>
  saveProject: (next: Project) => Promise<void>
  saveProjectLight: (next: Project, flushImmediately?: boolean) => void
  flushPendingProjectSave: () => void
  initializeCurrentProject: () => Promise<void>
  refreshProjectList: () => Promise<void>
  switchProject: (projectId: string) => Promise<void>
  createNewProject: () => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  duplicateProject: () => Promise<void>

  // Pad
  triggerPad: (pad: Pad, velocity?: number) => void
  updatePadSettings: (patch: Partial<Pad['settings']>) => void
  assignFileToPad: (pad: Pad, file: File) => Promise<void>
  assignSampleToPad: (sample: SampleAsset, padId: string) => Promise<void>
  assignSampleToSelectedPad: (sample: SampleAsset) => Promise<void>
  addLayerFile: (file: File) => Promise<void>
  addLayerSample: (sample: SampleAsset) => void
  removeLayer: (layerId: string) => void
  updateLayerVelocity: (layerId: string, low: number, high: number) => void
  selectLayer: (layerId: string | null) => void
  updateLayerSettings: (layerId: string, patch: Partial<SampleLayer>) => void
  renamePad: (name: string) => Promise<void>
  resetSelectedPadName: () => Promise<void>
  resetPad: (padId: string) => Promise<void>
  resetBank: (bank: number) => Promise<void>

  // Transport
  startTransport: () => Promise<void>
  stopTransport: () => void
  togglePlayPause: () => void
  flashSequencedPadHit: (padId: string) => void

  // Sequencer
  toggleStep: (step: number, padId: string) => Promise<void>
  pushSequencerHistory: (state: Project, sequenceId: string | null) => void
  beginDragHistoryCapture: () => void
  finishDragHistoryCapture: () => void
  undoSequencer: () => Promise<void>
  redoSequencer: () => Promise<void>
  clearLane: (padId: string) => Promise<void>
  duplicateLaneToNext: (padId: string) => Promise<void>
  laneToolFill: (padId: string, interval: number) => Promise<void>
  laneToolShift: (padId: string, direction: -1 | 1) => Promise<void>
  laneToolRandom: (padId: string) => Promise<void>
  duplicatePatternLength: (mode: 'double' | 'half') => Promise<void>
  toggleLaneMute: (padId: string) => void
  toggleSeqBankCollapsed: (bank: number) => void
  setSequenceResolution: (resolution: SequenceResolution) => Promise<void>
  setSequenceLength: (lengthSteps: number) => Promise<void>
  commitSequenceLengthDraft: () => Promise<void>

  // Piano Roll
  togglePianoRollExpanded: (padId: string) => void
  togglePianoRollNote: (step: number, padId: string, note: number) => Promise<void>
  setPianoRollNoteVelocity: (eventId: string, velocity: number) => Promise<void>
  setPianoRollNoteGate: (eventId: string, gate: number) => Promise<void>
  setPianoRollNoteStartAndGate: (eventId: string, step: number, gate: number) => Promise<void>
  setPianoRollOctaveOffset: (padId: string, offset: number) => void

  // Patterns
  addSequence: () => Promise<void>
  renamePattern: (patternId: string, name: string) => Promise<void>
  setPatternColor: (patternId: string, color: string) => Promise<void>
  duplicatePattern: (patternId: string) => Promise<void>
  reorderPattern: (patternId: string, targetPatternId: string) => Promise<void>
  deletePattern: (patternId: string) => Promise<void>

  // Song Chain
  addChainEntry: (patternId: string) => Promise<void>
  addChainEntryAt: (patternId: string, targetIndex: number) => Promise<void>
  removeChainEntry: (entryId: string) => Promise<void>
  moveChainEntry: (dragId: string, targetId: string) => Promise<void>
  updateChainRepeats: (entryId: string, repeats: number) => Promise<void>
  setSongLoopStart: (index: number | null, skipHistory?: boolean) => Promise<void>
  setSongLoopEnd: (index: number | null, skipHistory?: boolean) => Promise<void>
  copySelectedChainEntry: () => void
  pasteChainEntry: () => Promise<void>

  // Library
  previewSample: (sample: SampleAsset) => Promise<void>
  deleteSampleFromLibrary: (sample: SampleAsset) => Promise<void>
  cropSampleToTrim: (padId: string) => Promise<void>
  normalizeSample: (padId: string) => Promise<void>
  removeUnassignedSamples: () => Promise<void>
  compactProject: () => Promise<void>
  toggleFavoriteSample: (sampleId: string) => void
  addSamplesToLibrary: (files: File[], padIndexMap?: Map<string, number>, groupLabel?: string) => Promise<void>

  // Synth Patches
  saveSynthPatch: (name: string, pad: Pad) => void
  deleteSynthPatch: (patchId: string) => Promise<void>
  applySynthPatchToPad: (patch: SynthPatch, padId: string) => void

  // Chop Modal
  openChopModal: (sampleId: string) => void
  closeChopModal: () => void
  updateChopPoints: (sampleId: string, points: number[]) => Promise<void>
  assignChopsToPads: (sampleId: string, startBank: number, startSlot: number) => Promise<void>

  // Chromatic Spread
  openChromaticSpread: (sampleId: string) => void
  closeChromaticSpread: () => void
  spreadSampleChromatically: (sampleId: string, startBank: number, startSlot: number, count: number, chokeGroup: number) => Promise<void>

  // Pad Drag
  showPadDragPrompt: (sourcePadId: string, targetPadId: string) => void
  executePadMove: (sourcePadId: string, targetPadId: string) => Promise<void>
  executePadCopy: (sourcePadId: string, targetPadId: string) => Promise<void>
  executePadSwap: (sourcePadId: string, targetPadId: string) => Promise<void>
  cancelPadDragPrompt: () => void

  // Sequencer Recording
  recordPadHit: (padId: string, velocity: number, note?: number) => void
  recordPadRelease: (padId: string, note?: number) => void

  // Sample Assign Prompt
  confirmSampleReplace: () => Promise<void>
  confirmSampleAddLayer: () => Promise<void>
  cancelSampleAssignPrompt: () => void

  // Recording
  openRecordDialog: (targetPadId?: string) => void
  closeRecordDialog: () => void
  saveRecording: (blob: Blob, name: string) => Promise<void>
  togglePadHoldRecord: () => void
  startPadHoldRecord: (padId: string) => void
  stopPadHoldRecord: () => void

  // MIDI Out
  updatePadMidiOut: (padId: string, patch: Partial<import('../types').MidiOutConfig>) => Promise<void>

  // Auto-sample helpers
  createSampleFromPcm: (channels: Float32Array[], sampleRate: number, name: string, meta?: { autosampleRunId?: string; autosampleRunLabel?: string; autosampleTrim?: TrimSettings; autosampleBus?: BusId; autosampleChokeGroup?: number; autosamplePadIndex?: number }) => Promise<string>
  assignSampleIdToPad: (padId: string, sampleId: string, padName?: string) => Promise<void>
  showAutosampleDialog: boolean
  openAutosampleDialog: () => void
  closeAutosampleDialog: () => void

  // Audio input monitor
  setAudioMonitorEnabled: (enabled: boolean) => void
  setAudioMonitorDeviceId: (id: string | null) => void
  setAudioMonitorBusId: (busId: BusId) => void

  // Sample group management
  groupSamples: (sampleIds: string[], label?: string) => void
  ungroupSample: (sampleId: string) => void
  assignGroupToPads: (runId: string, startBank?: number) => Promise<void>
  importPatternsForGroup: (patternsJson: string, padIndexToId?: Map<number, string>, groupLabel?: string) => Promise<void>
  importPatternsForGroupByRunId: (runId: string) => Promise<void>
  renameAutosampleGroup: (runId: string, newLabel: string) => void
  updateAutosampleGroupSettings: (runId: string, patch: { bus?: BusId; chokeGroup?: number }) => void
  deleteAutosampleGroup: (runId: string) => Promise<void>
  exportAutosampleGroupZip: (runId: string) => Promise<void>

  // BPM / Name
  commitBpmDraft: () => Promise<void>
  commitSwingDraft: () => Promise<void>
  tapTempo: () => void
  commitProjectNameDraft: () => Promise<void>

  // Toasts
  addToast: (message: string, type?: ToastType) => void
  removeToast: (id: string) => void

  // Export / Import (kept thin — actions call external modules)
  exportAllMidi: () => void
  exportPack: () => Promise<void>
  exportStandalonePage: () => Promise<void>
  exportAudio: (mode: 'pattern' | 'song') => Promise<void>
  previewImport: () => Promise<void>
  runImport: () => Promise<void>

  // Mixer
  setBusName: (busId: BusId, name: string) => void
  setBankName: (bankIndex: number, name: string) => void
  setBusGain: (busId: BusId, gain: number) => void
  setBusPan: (busId: BusId, pan: number) => void
  setBusMute: (busId: BusId, mute: boolean) => void
  setBusSolo: (busId: BusId, solo: boolean) => void
  setBusEffectType: (busId: BusId, slotIndex: number, effectType: EffectType) => void
  setBusEffectEnabled: (busId: BusId, slotIndex: number, enabled: boolean) => void
  setBusEffectParam: (busId: BusId, slotIndex: number, paramName: string, value: number) => void
  setBusEffectSidechainSource: (busId: BusId, slotIndex: number, source: BusId) => void
  setPadEffectType: (padId: string, slotIndex: number, effectType: EffectType) => void
  setPadEffectEnabled: (padId: string, slotIndex: number, enabled: boolean) => void
  setPadEffectParam: (padId: string, slotIndex: number, paramName: string, value: number) => void
  setMasterGain: (gain: number) => void
  setMasterEffectType: (slotIndex: number, effectType: EffectType) => void
  setMasterEffectEnabled: (slotIndex: number, enabled: boolean) => void
  setMasterEffectParam: (slotIndex: number, paramName: string, value: number) => void
}

// ---------------------------------------------------------------------------
// Selectors (derived data – computed outside the store for memoisation)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memoization helper: caches result when deps haven't changed (by reference)
// ---------------------------------------------------------------------------
function memoize<S, R>(deps: (s: S) => unknown[], fn: (s: S) => R): (s: S) => R {
  let cachedDeps: unknown[] | null = null
  let cachedResult: R
  return (s: S) => {
    const nextDeps = deps(s)
    if (cachedDeps && cachedDeps.length === nextDeps.length && cachedDeps.every((d, i) => d === nextDeps[i])) {
      return cachedResult
    }
    cachedDeps = nextDeps
    cachedResult = fn(s)
    return cachedResult
  }
}

export const selectSelectedPad = (s: AppState): Pad | null => {
  if (!s.project || !s.selectedPadId) return null
  return s.project.pads.find((p) => p.id === s.selectedPadId) ?? null
}

export const selectSelectedSample = (s: AppState): SampleAsset | null => {
  const pad = selectSelectedPad(s)
  if (!pad?.settings.sampleId) return null
  return s.samples.find((sample) => sample.id === pad.settings.sampleId) ?? null
}

export const selectSelectedLayer = (s: AppState): SampleLayer | null => {
  if (!s.selectedLayerId) return null
  const pad = selectSelectedPad(s)
  if (!pad) return null
  return pad.settings.layers.find((l) => l.id === s.selectedLayerId) ?? null
}

export const selectDisplayedSample = (s: AppState): SampleAsset | null => {
  const layer = selectSelectedLayer(s)
  if (layer) {
    return s.samples.find((sample) => sample.id === layer.sampleId) ?? null
  }
  return selectSelectedSample(s)
}

export const selectActiveSequence = (s: AppState): SequencePattern | null => {
  if (!s.project || !s.activeSequenceId) return null
  return s.project.sequences.find((seq) => seq.id === s.activeSequenceId) ?? null
}

export const selectVisibleSequence = (s: AppState): SequencePattern | null => {
  const active = selectActiveSequence(s)
  if (!s.project || !active) return null
  if (s.playbackScope === 'song' && s.isPlaying && s.playingPatternId && s.seqFollowPlayback) {
    return s.project.sequences.find((seq) => seq.id === s.playingPatternId) ?? active
  }
  return active
}

export const selectCurrentBankPads = memoize<AppState, Pad[]>(
  (s) => [s.project?.pads, s.activeBank],
  (s) => {
    if (!s.project) return []
    return s.project.pads.filter((p) => p.bank === s.activeBank).sort((a, b) => a.slot - b.slot)
  },
)

export const selectDisplayedPads = memoize<AppState, Pad[]>(
  (s) => [s.project?.pads, s.activeBank],
  (s) => {
    const ordered = selectCurrentBankPads(s)
    const rows = [0, 1, 2, 3].map((r) => ordered.slice(r * 4, r * 4 + 4))
    return rows.reverse().flat()
  },
)

export const selectFilteredSamples = memoize<AppState, SampleAsset[]>(
  (s) => [s.samples, s.sampleQuery, s.showFavoritesOnly, s.favoriteSampleIds, s.sampleSort],
  (s) => {
    const query = s.sampleQuery.trim().toLowerCase()
    let next = s.samples.filter((sample) => {
      if (s.showFavoritesOnly && !s.favoriteSampleIds.has(sample.id)) return false
      if (!query) return true
      return sample.name.toLowerCase().includes(query)
    })

    if (s.sampleSort === 'name') {
      next = [...next].sort((a, b) => a.name.localeCompare(b.name))
    } else if (s.sampleSort === 'size') {
      next = [...next].sort((a, b) => b.size - a.size)
    } else {
      next = [...next].sort((a, b) => b.createdAt - a.createdAt)
    }

    return next
  },
)

export const selectAssignedSampleIdsKey = (s: AppState): string => {
  if (!s.project) return ''
  const ids = new Set<string>()
  for (const p of s.project.pads) {
    if (p.settings.sampleId) ids.add(p.settings.sampleId)
    if (p.settings.layers) {
      for (const l of p.settings.layers) {
        if (l.sampleId) ids.add(l.sampleId)
      }
    }
  }
  return Array.from(ids).sort().join('|')
}

// Pre-computed event lookup for sequencer rendering perf
export const selectEventsByPadAndStep = memoize<AppState, Map<string, Map<number, SequenceEvent>>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, Map<number, SequenceEvent>>()
    for (const event of seq.events) {
      let padMap = map.get(event.padId)
      if (!padMap) {
        padMap = new Map()
        map.set(event.padId, padMap)
      }
      padMap.set(event.step, event)
    }
    return map
  },
)

// Events grouped by padId for lane iteration
export const selectEventsByPad = memoize<AppState, Map<string, SequenceEvent[]>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, SequenceEvent[]>()
    for (const event of seq.events) {
      let arr = map.get(event.padId)
      if (!arr) {
        arr = []
        map.set(event.padId, arr)
      }
      arr.push(event)
    }
    return map
  },
)

// Pre-computed spanning event lookup: for each (padId, step), which event spans that step?
// This turns the O(events) per-step find into O(1).
export const selectSpanningByPadAndStep = memoize<AppState, Map<string, Map<number, SequenceEvent>>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, Map<number, SequenceEvent>>()
    for (const event of seq.events) {
      let padMap = map.get(event.padId)
      if (!padMap) {
        padMap = new Map()
        map.set(event.padId, padMap)
      }
      const end = event.step + Math.max(1, event.gate) - 1
      for (let step = event.step; step <= end; step++) {
        padMap.set(step, event)
      }
    }
    return map
  },
)

export const selectSequenceLanes = memoize<AppState, Pad[]>(
  (s) => [s.project?.pads, s.activeBank, s.hideEmptyLanes, selectVisibleSequence(s)?.id, selectVisibleSequence(s)?.events],
  (s) => {
    const bankPads = selectCurrentBankPads(s)
    if (!s.hideEmptyLanes) return bankPads.sort((a, b) => b.midiNote - a.midiNote)
    const visibleSeq = selectVisibleSequence(s)
    const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
    return bankPads
      .filter((pad) => activePadIds.has(pad.id))
      .sort((a, b) => b.midiNote - a.midiNote)
  },
)

export interface SequencerBankGroup {
  bank: number
  name: string
  pads: Pad[]
  hasEvents: boolean
  collapsed: boolean
}

export const selectSequencerBankGroups = memoize<AppState, SequencerBankGroup[]>(
  (s) => [s.project?.pads, s.project?.bankNames, s.hideEmptyLanes, s.seqExpandedBanks, s.seqCollapsedBanks, selectVisibleSequence(s)?.id, selectVisibleSequence(s)?.events],
  (s) => {
    if (!s.project) return []
    const visibleSeq = selectVisibleSequence(s)
    const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
    const bankNames = s.project.bankNames ?? Array.from({ length: BANK_COUNT }, (_, i) => `Bank ${i + 1}`)

    const groups: SequencerBankGroup[] = []
    for (let bank = 0; bank < BANK_COUNT; bank++) {
      const bankPads = s.project.pads.filter((p) => p.bank === bank).sort((a, b) => a.slot - b.slot)
      // Skip banks where no pad has content (no sample, no synth, no MIDI out)
      const hasPadContent = bankPads.some((p) => p.settings.sampleId || p.settings.source === 'synth' || p.settings.midiOut?.enabled)
      if (!hasPadContent) continue
      const hasEvents = bankPads.some((p) => activePadIds.has(p.id))

      // Determine collapsed state
      let collapsed: boolean
      if (s.seqCollapsedBanks.has(bank)) {
        collapsed = true
      } else if (s.seqExpandedBanks.has(bank)) {
        collapsed = false
      } else {
        // Default: collapsed if no events in current pattern
        collapsed = !hasEvents
      }

      // Filter pads if hideEmptyLanes is on
      let visiblePads: Pad[]
      if (s.hideEmptyLanes) {
        visiblePads = bankPads.filter((pad) => activePadIds.has(pad.id))
      } else {
        visiblePads = bankPads
      }

      groups.push({
        bank,
        name: bankNames[bank] ?? `Bank ${bank + 1}`,
        pads: visiblePads.sort((a, b) => b.midiNote - a.midiNote),
        hasEvents,
        collapsed,
      })
    }
    return groups
  },
)

// ---------------------------------------------------------------------------
// Utility functions used by actions
// ---------------------------------------------------------------------------

function getLaneBoundsForEvent(
  pattern: SequencePattern,
  padId: string,
  eventId: string,
): { minStart: number; maxEnd: number } {
  const target = pattern.events.find((e) => e.id === eventId)
  if (!target) return { minStart: 0, maxEnd: pattern.lengthSteps - 1 }

  const laneEvents = pattern.events
    .filter((e) => e.padId === padId && e.id !== eventId)
    .map((e) => ({ start: e.step, end: e.step + Math.max(1, e.gate) - 1 }))
    .sort((a, b) => a.start - b.start)

  const targetStart = target.step
  const targetEnd = target.step + Math.max(1, target.gate) - 1
  let minStart = 0
  let maxEnd = pattern.lengthSteps - 1
  laneEvents.forEach((e) => {
    if (e.end < targetStart) minStart = Math.max(minStart, e.end + 1)
    if (e.start > targetEnd) maxEnd = Math.min(maxEnd, e.start - 1)
  })
  return { minStart, maxEnd }
}

function updateGateEventRange(
  projectState: Project,
  patternId: string,
  padId: string,
  eventId: string,
  start: number,
  end: number,
): Project {
  return {
    ...projectState,
    sequences: projectState.sequences.map((seq) => {
      if (seq.id !== patternId) return seq
      return {
        ...seq,
        events: seq.events.map((e) =>
          e.id === eventId && e.padId === padId
            ? { ...e, step: start, gate: Math.max(1, end - start + 1) }
            : e,
        ),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Module-level mutable refs (NOT in immer store — immer freezes objects)
// ---------------------------------------------------------------------------
let _playbackSnapshot: PlaybackSnapshot = buildPlaybackSnapshot(createDefaultProject(), 0)
let _playbackVersion = 1
let _hydratePromise: Promise<void> | null = null
const _transportScheduler = new TransportScheduler()
let _transportWorker: Worker | null = null
let _projectSaveDebounce: number | null = null
let _pendingPersist = false
const _sequencedPadHitTimers = new Map<string, number>()
let _dragHistoryCaptured = false
let _trimDirty = false
let _gateResizeDirty = false
const _perfDriftWindow: number[] = []
const _tapTimestamps: number[] = []
let _draggedPatternId: string | null = null
let _draggedChainEntryId: string | null = null
const _seqRecordCleared = new Set<string>() // tracks patterns cleared during replace-mode recording
// Tracks active recording notes: key = "padId:note" (or "padId:" for non-piano-roll), value = { eventId, startStep }
const _activeRecordingNotes = new Map<string, { eventId: string; startStep: number; patternId: string; startTimeMs: number }>()
let _frozenZoomRange: { start: number; end: number } | null = null

// --- Confirm dialog promise resolver ---
let _confirmResolver: ((ok: boolean) => void) | null = null

export function showConfirm(message: string, opts?: { confirmLabel?: string; cancelLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    _confirmResolver = resolve
    useStore.setState({ confirmDialog: { message, confirmLabel: opts?.confirmLabel, cancelLabel: opts?.cancelLabel } } as any)
  })
}

export function resolveConfirmDialog(ok: boolean) {
  const resolver = _confirmResolver
  _confirmResolver = null
  useStore.setState({ confirmDialog: null } as any)
  if (resolver) resolver(ok)
}

// --- MIDI out: track outstanding note-on for gate/adsr note-off on release ---
// Now managed inside lib/midiOut.ts via registerActiveNote / releaseMidiNote

// --- Pad Hold Record infrastructure (module-level, outside immer) ---
const HOLD_REC_WORKLET_SRC = `
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.writeIndex = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i];
      if (this.writeIndex >= this.buffer.length) {
        this.port.postMessage({ samples: this.buffer.slice() });
        this.writeIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor('hold-recorder-worklet', RecorderWorkletProcessor);
`
let _holdRecStream: MediaStream | null = null
let _holdRecWorklet: AudioWorkletNode | null = null
let _holdRecSource: MediaStreamAudioSourceNode | null = null
let _holdRecChunks: Float32Array[] = []
let _holdRecWorkletRegistered = false
let _holdRecStartTime = 0
const HOLD_REC_SAMPLE_RATE = 44_100
const HOLD_REC_MIN_MS = 150 // discard taps shorter than this

// Expose for App.tsx drag handlers
export const storeRefs = {
  get trimDirty() { return _trimDirty },
  set trimDirty(v: boolean) { _trimDirty = v },
  get gateResizeDirty() { return _gateResizeDirty },
  set gateResizeDirty(v: boolean) { _gateResizeDirty = v },
  get dragHistoryCaptured() { return _dragHistoryCaptured },
  set dragHistoryCaptured(v: boolean) { _dragHistoryCaptured = v },
  get draggedPatternId() { return _draggedPatternId },
  set draggedPatternId(v: string | null) { _draggedPatternId = v },
  get draggedChainEntryId() { return _draggedChainEntryId },
  set draggedChainEntryId(v: string | null) { _draggedChainEntryId = v },
  get frozenZoomRange() { return _frozenZoomRange },
  set frozenZoomRange(v: { start: number; end: number } | null) { _frozenZoomRange = v },
}

// ---------------------------------------------------------------------------
// Shared helper: import a File as a SampleAsset (dedup by hash)
// Returns the SampleAsset. Callers are responsible for updating store state.
// ---------------------------------------------------------------------------
async function importFileAsSample(
  file: File,
  _getState: () => AppState,
  setState: (fn: (s: AppState) => void) => void,
): Promise<SampleAsset> {
  const raw = await file.arrayBuffer()
  const hash = await arrayBufferToHex(raw)
  const existing = await db.findSampleByHash(hash)

  const sample: SampleAsset =
    existing ?? {
      id: uid(),
      name: file.name,
      mimeType: file.type || 'audio/wav',
      size: file.size,
      createdAt: Date.now(),
      hash,
      blob: file,
    }

  if (!existing) {
    await db.putSample(sample)
    await audioEngine.registerSample(sample)
    setState((s) => {
      s.samples = [...s.samples, sample]
      s.sampleMap.set(sample.id, sample)
    })
  } else if (!audioEngine.hasSample(sample.id)) {
    await audioEngine.registerSample(sample)
  }

  return sample
}

const PRESET_KITS = ['TR7x7ISH_Kit.zip', 'TR8x8ISH_Kit.zip', 'TR9x9ISH_Kit.zip']

/** Load factory preset drumkit ZIPs from /public on first launch.
 *  Returns array of { runId, bankIndex } for pad assignment. */
async function loadPresetKits(
  _getState: () => AppState,
  setState: (fn: (s: AppState) => void) => void,
): Promise<{ runId: string; bank: number }[]> {
  const loaded: { runId: string; bank: number }[] = []
  for (let ki = 0; ki < PRESET_KITS.length; ki++) {
    const filename = PRESET_KITS[ki]
    try {
      const resp = await fetch(`/${filename}`)
      if (!resp.ok) continue
      const buf = await resp.arrayBuffer()
      const zip = await JSZip.loadAsync(buf)
      const metaFile = zip.file('metadata.json')
      const meta = metaFile ? JSON.parse(await metaFile.async('text')) as {
        label?: string;
        samples?: { name: string; autosampleTrim?: { start: number; end: number } | null;
          autosampleBus?: BusId | null; autosampleChokeGroup?: number | null;
          autosamplePadIndex?: number | null; autosampleMpc?: boolean }[]
      } : null
      const runId = `preset-${filename.replace(/\.zip$/i, '')}`
      const runLabel = meta?.label || filename.replace(/\.zip$/i, '')
      const metaMap = new Map((meta?.samples || []).map((m) => [m.name, m]))
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || path === 'metadata.json') continue
        if (!path.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)) continue
        const blob = await entry.async('blob')
        const file = new File([blob], entry.name, { type: 'audio/wav' })
        const raw = await file.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const m = metaMap.get(entry.name)
        // Build the complete sample with all preset metadata upfront
        const sample: SampleAsset = {
          id: uid(),
          name: file.name,
          mimeType: file.type || 'audio/wav',
          size: file.size,
          createdAt: Date.now(),
          hash,
          blob: file,
          autosampleRunId: runId,
          autosampleRunLabel: runLabel,
          autosampleTrim: m?.autosampleTrim ?? undefined,
          autosampleBus: m?.autosampleBus ?? undefined,
          autosampleChokeGroup: m?.autosampleChokeGroup ?? undefined,
          autosamplePadIndex: m?.autosamplePadIndex ?? undefined,
          autosamplePreset: true,
        }
        await db.putSample(sample)
        await audioEngine.registerSample(sample)
        setState((s) => {
          s.samples.push(sample)
          s.sampleMap.set(sample.id, sample)
        })
      }
      loaded.push({ runId, bank: ki })
    } catch (e) {
      console.warn('Failed to load preset kit', filename, e)
    }
  }
  return loaded
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<AppState>()(
  immer((set, get) => {
    // Internal helpers
    // Track snapshot-relevant fields to avoid unnecessary rebuilds
    let _lastSnapshotPads: unknown = null
    let _lastSnapshotSequences: unknown = null
    let _lastSnapshotBpm: unknown = null
    let _lastSnapshotSwing: unknown = null
    let _lastSnapshotSongChain: unknown = null
    let _lastSnapshotSongLoopStart: unknown = null
    let _lastSnapshotSongLoopEnd: unknown = null

    const rebuildPlaybackSnapshot = (proj: Project) => {
      // Only rebuild if snapshot-relevant fields actually changed
      if (
        proj.pads === _lastSnapshotPads &&
        proj.sequences === _lastSnapshotSequences &&
        proj.bpm === _lastSnapshotBpm &&
        (proj.swing ?? 0) === _lastSnapshotSwing &&
        proj.songChain === _lastSnapshotSongChain &&
        proj.songLoopStart === _lastSnapshotSongLoopStart &&
        proj.songLoopEnd === _lastSnapshotSongLoopEnd
      ) {
        return // no snapshot-relevant changes
      }
      _lastSnapshotPads = proj.pads
      _lastSnapshotSequences = proj.sequences
      _lastSnapshotBpm = proj.bpm
      _lastSnapshotSwing = proj.swing ?? 0
      _lastSnapshotSongChain = proj.songChain
      _lastSnapshotSongLoopStart = proj.songLoopStart
      _lastSnapshotSongLoopEnd = proj.songLoopEnd
      _playbackVersion += 1
      _playbackSnapshot = buildPlaybackSnapshot(proj, _playbackVersion)
    }

    const touchAndNormalize = (proj: Project): Project => touchProject(normalizeProject(proj))

    const persistProject = async (proj: Project) => {
      const touched = touchAndNormalize(proj)
      set((s) => {
        s.project = touched
      })
      rebuildPlaybackSnapshot(touched)
      await db.putProject(touched)
      return touched
    }

    // Debounced cleanup of unused AudioBuffers and stale effect chains (runs 2s after last pad assignment)
    let _pruneTimer: ReturnType<typeof setTimeout> | null = null
    const schedulePruneBuffers = () => {
      if (_pruneTimer) clearTimeout(_pruneTimer)
      _pruneTimer = setTimeout(() => {
        _pruneTimer = null
        const state = get()
        if (!state.project) return
        const usedIds = new Set<string>()
        for (const pad of state.project.pads) {
          if (pad.settings.sampleId) usedIds.add(pad.settings.sampleId)
          if (pad.settings.layers) {
            for (const l of pad.settings.layers) {
              if (l.sampleId) usedIds.add(l.sampleId)
            }
          }
          // Dispose pad effect chains for pads that are no longer synth
          if (pad.settings.source !== 'synth') {
            audioEngine.disposePadEffectChain(pad.id)
          }
        }
        audioEngine.pruneUnusedBuffers(usedIds)
      }, 2000)
    }

    const historySnapshotFrom = (state: Project, sequenceId: string | null): SequencerHistorySnapshot => ({
      sequences: state.sequences,
      songChain: state.songChain,
      songLoopStart: state.songLoopStart,
      songLoopEnd: state.songLoopEnd,
      activeSequenceId: sequenceId,
    })

    return {
      // --- Initial state ---
      project: null,
      samples: [],
      sampleMap: new Map(),

      isPlaying: false,
      playbackScope: 'pattern',
      playingPatternId: null,
      playingChainIndex: null,
      playingChainRepeat: 1,
      loopEnabled: true,
      playheadStep: null,
      showPerfStats: false,
      perfStats: { tickCount: 0, lateNotes: 0, maxDriftMs: 0, p95DriftMs: 0 },

      midiStatus: 'MIDI: not connected',
      midiInputEnabled: true,
      midiInputDeviceId: null,
      padMidiChannel: null,
      launchpadSpecialMode: localStorage.getItem('launchpadSpecialMode') !== 'false',
      midiInputs: [],
      midiOutputs: [],
      lastMidiNote: null,
      audioMonitorEnabled: false,
      audioMonitorDeviceId: null,
      audioMonitorBusId: 'A' as BusId,
      audioOutputs: [],
      audioOutputDeviceId: localStorage.getItem('audioOutputDeviceId') || null,
      audioInputs: [],
      audioInputDeviceId: localStorage.getItem('audioInputDeviceId') || null,
      showRecordDialog: false,
      recordTargetPadId: null,
      padHoldRecordEnabled: false,
      padHoldRecordingPadId: null,
      sequencedPadHits: new Set(),

      activeSequenceId: null,
      mutedLanePadIds: new Set(),
      selectedGateNote: null,
      gateResize: null,
      velocityDrag: null,
      pitchDrag: null,
      historyPast: [],
      historyFuture: [],
      historySilenced: false,

      activeBank: 0,
      selectedPadId: null,
      selectedLayerId: null,
      hideEmptyLanes: true,
      seqFollowPlayback: true,
      seqExpandedBanks: new Set<number>(),
      seqCollapsedBanks: new Set<number>(),
      layoutMode: (() => {
        const stored = localStorage.getItem('layoutMode')
        if (stored === 'classic' || stored === 'wide' || stored === 'performance') return stored
        // migrate old altLayout key
        const old = localStorage.getItem('altLayout')
        if (old === 'false') return 'classic'
        if (old === 'true') return 'wide'
        return 'performance'
      })(),
      performanceTab: (localStorage.getItem('performanceTab') as 'library' | 'padEditor' | 'sequencer' | 'mixer' | 'settings') || 'sequencer',
      showSongChain: false,
      padEditorCollapsed: false,
      showLibraryWaveforms: true,
      showExportDialog: false,
      isExporting: false,
      showImportDialog: false,
      showGateResizeTip: false,
      toasts: [],
      showSequencerHelp: false,
      showSequencerTools: false,
      bpmDraft: '94',
      swingDraft: '0',
      projectNameDraft: '',
      sequenceLengthDraft: '16',
      trimDraft: { start: 0, end: 1 },
      waveformZoom: 'full' as const,
      patternRenameId: null,
      patternRenameDraft: '',
      importMode: 'merge' as ImportMode,
      previewText: '',
      conflicts: [],
      importFile: null,
      waveformPeaks: [],

      sampleQuery: '',
      sampleSort: 'recent',
      showFavoritesOnly: false,
      favoriteSampleIds: new Set(),
      libraryWavePeaks: {},
      previewSampleId: null,

      synthPatches: loadSynthPatches(),

      expandedPianoRollPads: new Set<string>(),
      pianoRollOctaveOffset: {},
      computerKeyboardEnabled: localStorage.getItem('computerKeyboardEnabled') === 'true',
      computerKeyboardOctave: Number(localStorage.getItem('computerKeyboardOctave') || '3') || 3,

      sampleAssignPrompt: null,
      confirmDialog: null,

      chopModalSampleId: null,

      chromaticSpreadSampleId: null,

      padDragPrompt: null,

      seqRecordArmed: false,
      seqRecordQuantize: true,
      seqRecordOverdub: true,

      metronomeEnabled: localStorage.getItem('metronomeEnabled') === 'true',
      metronomeVolume: Number(localStorage.getItem('metronomeVolume') || '0.7') || 0.7,
      countdownBars: Number(localStorage.getItem('countdownBars') || '0') || 0,

      selectedChainEntryId: null,
      copiedChainPatternId: null,

      projectList: [],

      showAutosampleDialog: false,

      // =================================================================
      // Actions
      // =================================================================

      hydrate: async () => {
        // Guard against double-invoke (React Strict Mode)
        if (_hydratePromise) return _hydratePromise
        _hydratePromise = (async () => {
        const existing = await db.getLatestProject()
        const loadedProject = normalizeProject(existing ?? createDefaultProject('Sketch 01'))
        if (!existing) {
          await db.putProject(loadedProject)
        }

        const allSamples = await db.getAllSamples()
        set((s) => {
          s.project = loadedProject
          s.projectNameDraft = loadedProject.name
          s.bpmDraft = String(loadedProject.bpm)
          s.swingDraft = String(loadedProject.swing ?? 0)
          s.selectedPadId = loadedProject.pads[0]?.id ?? null
          s.activeSequenceId = loadedProject.sequences[0]?.id ?? null
          s.samples = allSamples
          s.sampleMap = new Map(allSamples.map((sample) => [sample.id, sample]))
        })
        audioEngine.setBpm(loadedProject.bpm)
        audioEngine.setPolyphony(loadedProject.polyphony)
        rebuildPlaybackSnapshot(loadedProject)

        // Load factory preset kits on first launch (no samples in DB)
        if (allSamples.length === 0) {
          const loaded = await loadPresetKits(get, set)
          for (const { runId, bank } of loaded) {
            await get().assignGroupToPads(runId, bank)
          }
        }
        await get().refreshProjectList()
        })()
        return _hydratePromise
      },

      saveProject: async (next: Project) => {
        await persistProject(next)
        schedulePruneBuffers()
      },

      saveProjectLight: (next: Project, flushImmediately = false) => {
        // Skip normalizeProject in hot path — project is already normalized after initial load
        const touched = touchProject(next)
        set((s) => {
          s.project = touched
        })
        rebuildPlaybackSnapshot(touched)

        const state = get()
        if (state.isPlaying && !flushImmediately) {
          _pendingPersist = true
          return
        }

        if (_projectSaveDebounce !== null) {
          window.clearTimeout(_projectSaveDebounce)
        }

        if (flushImmediately) {
          void db.putProject(touched)
          _projectSaveDebounce = null
          return
        }

        const timerId = window.setTimeout(() => {
          const current = get().project
          if (current) void db.putProject(current)
          _projectSaveDebounce = null
        }, 180)
        _projectSaveDebounce = timerId
      },

      flushPendingProjectSave: () => {
        if (_projectSaveDebounce !== null) {
          window.clearTimeout(_projectSaveDebounce)
          _projectSaveDebounce = null
        }
        const s = get()
        if (s.project) {
          void db.putProject(s.project)
          _pendingPersist = false
        }
      },

      initializeCurrentProject: async () => {
        const ok = await showConfirm(
          'Initialize project to fresh start? This clears this app local data (projects, samples, settings).',
        )
        if (!ok) return

        get().stopTransport()
        await db.resetAll()

        const next = createDefaultProject('Sketch 01')
        await persistProject(next)
        set((s) => {
          s.samples = []
          s.sampleMap = new Map()
          s.selectedPadId = next.pads[0]?.id ?? null
          s.activeSequenceId = next.sequences[0]?.id ?? null
          s.activeBank = 0
          s.mutedLanePadIds = new Set()
          s.playbackScope = 'pattern'
          s.playingPatternId = null
          s.playingChainIndex = null
          s.playingChainRepeat = 1
          s.historyPast = []
          s.historyFuture = []
          s.selectedChainEntryId = null
          s.copiedChainPatternId = null
          s.sampleQuery = ''
          s.sampleSort = 'recent'
          s.showFavoritesOnly = false
          s.favoriteSampleIds = new Set()
          s.showGateResizeTip = true
        })
        await get().refreshProjectList()
      },

      refreshProjectList: async () => {
        const all = await db.getAllProjects()
        const list = all
          .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        set((s) => {
          s.projectList = list
        })
      },

      switchProject: async (projectId: string) => {
        const current = get().project
        if (current && current.id === projectId) return

        get().stopTransport()
        get().flushPendingProjectSave()

        const proj = await db.getProject(projectId)
        if (!proj) return
        const loaded = normalizeProject(proj)

        const allSamples = await db.getAllSamples()
        set((s) => {
          s.project = loaded
          s.projectNameDraft = loaded.name
          s.bpmDraft = String(loaded.bpm)
          s.swingDraft = String(loaded.swing ?? 0)
          s.selectedPadId = loaded.pads[0]?.id ?? null
          s.activeSequenceId = loaded.sequences[0]?.id ?? null
          s.activeBank = 0
          s.mutedLanePadIds = new Set()
          s.playbackScope = 'pattern'
          s.playingPatternId = null
          s.playingChainIndex = null
          s.playingChainRepeat = 1
          s.historyPast = []
          s.historyFuture = []
          s.selectedChainEntryId = null
          s.copiedChainPatternId = null
          s.samples = allSamples
          s.sampleMap = new Map(allSamples.map((sample) => [sample.id, sample]))
          s.libraryWavePeaks = {}
          s.waveformPeaks = []
        })
        audioEngine.setBpm(loaded.bpm)
        audioEngine.setPolyphony(loaded.polyphony)
        rebuildPlaybackSnapshot(loaded)
      },

      createNewProject: async () => {
        get().stopTransport()
        get().flushPendingProjectSave()

        // Generate a name like "Sketch 02", "Sketch 03", etc.
        const all = await db.getAllProjects()
        const existingNames = new Set(all.map((p) => p.name))
        let num = all.length + 1
        let name = `Sketch ${String(num).padStart(2, '0')}`
        while (existingNames.has(name)) {
          num++
          name = `Sketch ${String(num).padStart(2, '0')}`
        }

        const next = createDefaultProject(name)
        await db.putProject(next)

        set((s) => {
          s.project = next
          s.projectNameDraft = next.name
          s.bpmDraft = String(next.bpm)
          s.swingDraft = String(next.swing ?? 0)
          s.selectedPadId = next.pads[0]?.id ?? null
          s.activeSequenceId = next.sequences[0]?.id ?? null
          s.activeBank = 0
          s.mutedLanePadIds = new Set()
          s.playbackScope = 'pattern'
          s.playingPatternId = null
          s.playingChainIndex = null
          s.playingChainRepeat = 1
          s.historyPast = []
          s.historyFuture = []
          s.selectedChainEntryId = null
          s.copiedChainPatternId = null
        })
        audioEngine.setBpm(next.bpm)
        audioEngine.setPolyphony(next.polyphony)
        rebuildPlaybackSnapshot(next)
        await get().refreshProjectList()
      },

      deleteProject: async (projectId: string) => {
        const current = get().project
        if (!current) return

        const all = await db.getAllProjects()
        if (all.length <= 1) {
          get().addToast('Cannot delete the only project', 'error')
          return
        }

        const target = all.find((p) => p.id === projectId)
        const ok = await showConfirm(`Delete project "${target?.name ?? 'Untitled'}"?`)
        if (!ok) return

        await db.deleteProject(projectId)

        // If deleting the current project, switch to the most recent remaining
        if (current.id === projectId) {
          const remaining = all.filter((p) => p.id !== projectId)
          remaining.sort((a, b) => b.updatedAt - a.updatedAt)
          if (remaining.length > 0) {
            await get().switchProject(remaining[0].id)
          }
        }
        await get().refreshProjectList()
      },

      duplicateProject: async () => {
        const current = get().project
        if (!current) return

        get().flushPendingProjectSave()

        const dupe: Project = JSON.parse(JSON.stringify(current))
        dupe.id = uid()
        dupe.name = current.name + ' Copy'
        dupe.createdAt = Date.now()
        dupe.updatedAt = Date.now()

        await db.putProject(dupe)
        await get().switchProject(dupe.id)
        await get().refreshProjectList()
      },

      // --- Pad ---

      triggerPad: (pad: Pad, velocity = 1) => {
        if (pad.settings.mute) return
        // Collect all sample IDs that might be needed (primary + layers)
        const neededSampleIds: string[] = []
        if (pad.settings.sampleId) neededSampleIds.push(pad.settings.sampleId)
        for (const layer of pad.settings.layers ?? []) {
          if (layer.sampleId) neededSampleIds.push(layer.sampleId)
        }

        // Start unlock synchronously in the user gesture callstack (critical for iOS)
        const unlockP = audioEngine.unlockAndPrepare()

        const ctx = audioEngine.getContextIfReady()
        if (!ctx || ctx.state !== 'running') {
          // No context yet or suspended — use async path to unlock + decode + play
          void (async () => {
            await unlockP
            for (const sid of neededSampleIds) {
              if (!audioEngine.hasSample(sid)) {
                const sample = get().sampleMap.get(sid)
                if (sample) await audioEngine.registerSample(sample)
              }
            }
            audioEngine.playPad(pad, velocity, { bpm: get().project?.bpm })
          })()
        } else {
          // Hot path: check if all needed samples are loaded
          const missing = neededSampleIds.filter((sid) => !audioEngine.hasSample(sid))
          if (missing.length > 0) {
            // Must go async to decode missing buffers
            void (async () => {
              await unlockP
              for (const sid of missing) {
                const sample = get().sampleMap.get(sid)
                if (sample) await audioEngine.registerSample(sample)
              }
              audioEngine.playPad(pad, velocity, { bpm: get().project?.bpm })
            })()
          } else {
            audioEngine.playPad(pad, velocity, { bpm: get().project?.bpm })
          }
        }

        // Sequencer live recording
        const st = get()
        if (st.seqRecordArmed && st.isPlaying) {
          st.recordPadHit(pad.id, Math.round(velocity * 127))
        }

        // MIDI out
        const midiOut = pad.settings.midiOut
        if (midiOut?.enabled) {
          const note = midiOut.note
          const vel = midiOut.velocity < 0
            ? Math.max(1, Math.min(127, Math.round(velocity * 127)))
            : midiOut.velocity
          // Always: note-on now, note-off fired by releaseMidiNote when pad is released
          // (works for trigger, gate, and adsr modes — MIDI note held as long as pad is held)
          sendMidiNote(midiOut.deviceId, midiOut.channel, note, vel, null)
          registerActiveNote(pad.id, midiOut.deviceId, midiOut.channel, note)
        }

        // Notify Launchpad Pro MK3 (if connected)
        notifyLaunchpad(pad.id)
      },

      updatePadSettings: (patch: Partial<Pad['settings']>) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return

        // If a layer is selected, route overridable fields to the layer
        const layer = selectSelectedLayer(s)
        if (layer) {
          const layerPatch: Partial<SampleLayer> = {}
          let hasPadPatch = false
          const padPatch: Partial<Pad['settings']> = {}

          const LAYER_FIELDS = ['gain', 'semitones', 'fineCents', 'trim', 'envelope', 'filterType', 'filterFreq', 'filterQ', 'stackOffsetMs'] as const
          for (const key of LAYER_FIELDS) {
            if (key in patch) {
              (layerPatch as any)[key] = (patch as any)[key]
            }
          }
          for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
            if (!(LAYER_FIELDS as readonly string[]).includes(key)) {
              (padPatch as any)[key] = (patch as any)[key]
              hasPadPatch = true
            }
          }

          if (Object.keys(layerPatch).length > 0) {
            get().updateLayerSettings(layer.id, layerPatch)
          }
          if (hasPadPatch) {
            s.saveProjectLight({
              ...s.project,
              pads: s.project.pads.map((p) =>
                p.id === pad.id ? { ...p, settings: { ...p.settings, ...padPatch } } : p,
              ),
            })
          }
          return
        }

        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id ? { ...p, settings: { ...p.settings, ...patch } } : p,
          ),
        })

        // Live-update filter params on active voices
        if ('filterType' in patch || 'filterFreq' in patch || 'filterQ' in patch || 'filterFreq2' in patch) {
          const merged = { ...pad.settings, ...patch }
          audioEngine.updateActiveFilters(pad.id, merged.filterType, merged.filterFreq, merged.filterQ, merged.filterFreq2)
        }
      },

      assignFileToPad: async (pad: Pad, file: File) => {
        const raw = await file.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const existing = await db.findSampleByHash(hash)

        const sample: SampleAsset =
          existing ?? {
            id: uid(),
            name: file.name,
            mimeType: file.type || 'audio/wav',
            size: file.size,
            createdAt: Date.now(),
            hash,
            blob: file,
          }

        if (!existing) {
          await db.putSample(sample)
          await audioEngine.registerSample(sample)
          set((s) => {
            s.samples = [...s.samples, sample]
            s.sampleMap.set(sample.id, sample)
          })
        } else if (!audioEngine.hasSample(sample.id)) {
          await audioEngine.registerSample(sample)
        }

        const { project } = get()
        if (!project) return

        // If pad already has a sample assigned, show replace-or-layer prompt
        if (pad.settings.sampleId && pad.settings.sampleId !== sample.id) {
          set((d) => { d.sampleAssignPrompt = { padId: pad.id, sample } })
          return
        }

        await get().saveProject({
          ...project,
          pads: project.pads.map((item) =>
            item.id === pad.id
              ? {
                  ...item,
                  name: file.name.replace(/\.[^/.]+$/, ''),
                  settings: { ...item.settings, sampleId: sample.id },
                }
              : item,
          ),
        })
      },

      assignSampleToPad: async (sample: SampleAsset, padId: string) => {
        const { project, saveProject } = get()
        if (!project) return
        const pad = project.pads.find((p) => p.id === padId)
        if (pad?.settings.sampleId && pad.settings.sampleId !== sample.id) {
          set((d) => { d.sampleAssignPrompt = { padId, sample } })
          return
        }
        await saveProject({
          ...project,
          pads: project.pads.map((p) =>
            p.id === padId
              ? { ...p, name: sample.name, settings: { ...p.settings, sampleId: sample.id } }
              : p,
          ),
        })
      },

      assignSampleToSelectedPad: async (sample: SampleAsset) => {
        const pad = selectSelectedPad(get())
        if (!pad) return
        await get().assignSampleToPad(sample, pad.id)
      },

      addLayerFile: async (file: File) => {
        const pad = selectSelectedPad(get())
        if (!pad) return

        const raw = await file.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const existing = await db.findSampleByHash(hash)
        const sample: SampleAsset =
          existing ?? {
            id: uid(),
            name: file.name,
            mimeType: file.type || 'audio/wav',
            size: file.size,
            createdAt: Date.now(),
            hash,
            blob: file,
          }

        if (!existing) {
          await db.putSample(sample)
          await audioEngine.registerSample(sample)
          set((s) => {
            s.samples = [...s.samples, sample]
            s.sampleMap.set(sample.id, sample)
          })
        } else if (!audioEngine.hasSample(sample.id)) {
          await audioEngine.registerSample(sample)
        }

        get().addLayerSample(sample)
      },

      addLayerSample: (sample: SampleAsset) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return

        const newLayer = createLayer(sample.id)

        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id
              ? { ...p, settings: { ...p.settings, layers: [...p.settings.layers, newLayer] } }
              : p,
          ),
        })
      },

      removeLayer: (layerId: string) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return

        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id
              ? { ...p, settings: { ...p.settings, layers: p.settings.layers.filter((l) => l.id !== layerId) } }
              : p,
          ),
        })
      },

      updateLayerVelocity: (layerId: string, low: number, high: number) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return

        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id
              ? {
                  ...p,
                  settings: {
                    ...p.settings,
                    layers: p.settings.layers.map((l) =>
                      l.id === layerId ? { ...l, velocityLow: low, velocityHigh: high } : l,
                    ),
                  },
                }
              : p,
          ),
        })
      },

      selectLayer: (layerId: string | null) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) {
          set((d) => { d.selectedLayerId = null })
          return
        }

        if (layerId === null) {
          set((d) => { d.selectedLayerId = null })
          return
        }

        const layer = pad.settings.layers.find((l) => l.id === layerId)
        if (!layer) return

        // Make the selected layer's sample the pad's primary sampleId
        set((d) => { d.selectedLayerId = layerId })
        if (pad.settings.sampleId !== layer.sampleId) {
          s.saveProjectLight({
            ...s.project!,
            pads: s.project!.pads.map((p) =>
              p.id === pad.id
                ? { ...p, settings: { ...p.settings, sampleId: layer.sampleId } }
                : p,
            ),
          })
        }
      },

      updateLayerSettings: (layerId: string, patch: Partial<SampleLayer>) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return

        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id
              ? {
                  ...p,
                  settings: {
                    ...p.settings,
                    layers: p.settings.layers.map((l) =>
                      l.id === layerId ? { ...l, ...patch } : l,
                    ),
                  },
                }
              : p,
          ),
        })
      },

      renamePad: async (name: string) => {
        const s = get()
        const pad = selectSelectedPad(s)
        if (!pad || !s.project) return
        const nextName = name.trim()
        if (!nextName) return
        await s.saveProject({
          ...s.project,
          pads: s.project.pads.map((p) => (p.id === pad.id ? { ...p, name: nextName } : p)),
        })
      },

      resetSelectedPadName: async () => {
        const pad = selectSelectedPad(get())
        if (!pad) return
        await get().renamePad(`${midiToName(pad.midiNote)} Pad`)
      },

      resetPad: async (padId: string) => {
        const s = get()
        if (!s.project) return
        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad) return
        if (pad.settings.sampleId || pad.settings.source === 'synth') {
          if (!(await showConfirm(`Reset pad "${pad.name}" to defaults? This will clear its sample/synth and sequencer events.`))) return
        }
        const updatedPads = s.project.pads.map((p) => {
          if (p.id !== padId) return p
          return {
            ...p,
            name: `${midiToName(p.midiNote)} Pad`,
            settings: {
              source: 'sample' as const,
              sampleId: null,
              gain: 1,
              semitones: 0,
              fineCents: 0,
              mode: 'one-shot' as const,
              trim: { start: 0, end: 1 },
              envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
              layers: [],
              multiMode: 'single' as const,
              filterType: 'off' as const,
              filterFreq: 1000,
              filterQ: 1,
              bus: 'A' as BusId,
              chokeGroup: 0,
            },
          }
        })
        // Also clear sequencer events for this pad
        const updatedSequences = s.project.sequences.map((seq) => {
          const filtered = seq.events.filter((e) => e.padId !== padId)
          return filtered.length === seq.events.length ? seq : { ...seq, events: filtered }
        })
        await s.saveProject({ ...s.project, pads: updatedPads, sequences: updatedSequences })
        s.addToast(`Pad reset to defaults`)
      },

      resetBank: async (bank: number) => {
        const s = get()
        if (!s.project) return
        const bankPads = s.project.pads.filter((p) => p.bank === bank)
        const hasContent = bankPads.some((p) => p.settings.sampleId || p.settings.source === 'synth')
        if (hasContent) {
          if (!(await showConfirm(`Reset all 16 pads in Bank ${bank + 1} to defaults? This will clear all samples/synths and sequencer events.`))) return
        }
        const bankPadIds = new Set(bankPads.map((p) => p.id))
        const updatedPads = s.project.pads.map((p) => {
          if (!bankPadIds.has(p.id)) return p
          return {
            ...p,
            name: `${midiToName(p.midiNote)} Pad`,
            settings: {
              source: 'sample' as const,
              sampleId: null,
              gain: 1,
              semitones: 0,
              fineCents: 0,
              mode: 'one-shot' as const,
              trim: { start: 0, end: 1 },
              envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
              layers: [],
              multiMode: 'single' as const,
              filterType: 'off' as const,
              filterFreq: 1000,
              filterQ: 1,
              bus: 'A' as BusId,
              chokeGroup: 0,
            },
          }
        })
        const updatedSequences = s.project.sequences.map((seq) => {
          const filtered = seq.events.filter((e) => !bankPadIds.has(e.padId))
          return filtered.length === seq.events.length ? seq : { ...seq, events: filtered }
        })
        await s.saveProject({ ...s.project, pads: updatedPads, sequences: updatedSequences })
        s.addToast(`Bank ${bank + 1} reset to defaults`)
      },

      // --- Transport ---

      stopTransport: () => {
        if (_transportWorker) {
          _transportWorker.postMessage({ type: 'stop' })
          _transportWorker.terminate()
        }
        _sequencedPadHitTimers.forEach((timerId) => window.clearTimeout(timerId))
        _sequencedPadHitTimers.clear()
        _transportWorker = null

        transportVisualStore.reset()

        set((d) => {
          d.isPlaying = false
          d.playingPatternId = null
          d.playingChainIndex = null
          d.playingChainRepeat = 1
          d.seqRecordArmed = false
        })

        _seqRecordCleared.clear()
        _activeRecordingNotes.clear()

        if (_pendingPersist) {
          get().flushPendingProjectSave()
        }
      },

      flashSequencedPadHit: (padId: string) => {
        transportVisualStore.flashPadHit(padId)

        const existing = _sequencedPadHitTimers.get(padId)
        if (existing) window.clearTimeout(existing)

        const timerId = window.setTimeout(() => {
          transportVisualStore.clearPadHit(padId)
          _sequencedPadHitTimers.delete(padId)
        }, 120)
        _sequencedPadHitTimers.set(padId, timerId)
      },

      startTransport: async () => {
        try {
        const s = get()
        if (!s.project || !s.activeSequenceId || s.isPlaying) return

        const activeSeq = selectActiveSequence(s)
        if (!activeSeq) return

        if (_transportWorker) {
          _transportWorker.postMessage({ type: 'stop' })
          _transportWorker.terminate()
          _transportWorker = null
        }

        // Prepare buffers
        const patternIdsToPrepare =
          s.playbackScope === 'song' && s.project.songChain.length > 0
            ? Array.from(new Set(s.project.songChain.map((entry) => entry.patternId)))
            : [activeSeq.id]
        const patternsToPrepare = s.project.sequences.filter((seq) => patternIdsToPrepare.includes(seq.id))
        const sampleIdsToPrepare = Array.from(
          new Set(
            patternsToPrepare
              .flatMap((seq) => seq.events)
              .flatMap((event) => {
                const pad = s.project!.pads.find((p) => p.id === event.padId)
                if (!pad) return []
                const ids: string[] = []
                if (pad.settings.sampleId) ids.push(pad.settings.sampleId)
                for (const layer of pad.settings.layers ?? []) {
                  if (layer.sampleId) ids.push(layer.sampleId)
                }
                return ids
              }),
          ),
        )
        await audioEngine.unlock()

        for (const sampleId of sampleIdsToPrepare) {
          if (audioEngine.hasSample(sampleId)) continue
          const sample = s.sampleMap.get(sampleId)
          if (sample) await audioEngine.registerSample(sample)
        }

        const initialChainIndex =
          s.playbackScope === 'song' && s.project.songLoopStart !== null
            ? Math.max(0, Math.min(s.project.songChain.length - 1, s.project.songLoopStart))
            : 0

        set((d) => {
          d.isPlaying = true
          d.playingChainRepeat = 1
          if (s.playbackScope === 'song' && s.project!.songChain.length > 0) {
            const firstPattern = s.project!.sequences.find(
              (seq) => seq.id === s.project!.songChain[initialChainIndex]?.patternId,
            )
            d.playingPatternId = firstPattern?.id ?? activeSeq.id
            d.playingChainIndex = initialChainIndex
          } else {
            d.playingPatternId = activeSeq.id
            d.playingChainIndex = null
          }
        })

        const snapshot = _playbackSnapshot
        const lookaheadMs = 128
        const schedulerMs = 20
        const startLatencyMs = 30
        let visualStep = -1
        let tickCount = 0
        let lateNotes = 0
        let maxDriftMs = 0

        // Countdown: schedule metronome-only bars before actual playback
        const countdownBars = get().seqRecordArmed ? get().countdownBars : 0
        const bpm = snapshot.bpm
        const beatDurationSec = 60 / bpm
        const countdownBeats = countdownBars * 4
        const countdownDurationMs = countdownBeats * beatDurationSec * 1000
        let transportStartMs = performance.now() + startLatencyMs

        if (countdownBeats > 0 && get().metronomeEnabled) {
          const audioNow = audioEngine.nowSeconds()
          const audioStartSec = audioNow + startLatencyMs / 1000
          const vol = get().metronomeVolume
          for (let i = 0; i < countdownBeats; i++) {
            const t = audioStartSec + i * beatDurationSec
            audioEngine.playMetronomeClick(t, i % 4 === 0, vol)
          }
          transportStartMs += countdownDurationMs
        }

        _transportScheduler.start(transportStartMs, snapshot, {
          mode: get().playbackScope,
          loopEnabled: get().loopEnabled,
          activePatternId: activeSeq.id,
          lookaheadMs,
          visualCompMs: 46,
        })

        const tick = () => {
          const currentState = get()
          if (!currentState.isPlaying) return

          const currentSnapshot = _playbackSnapshot
          const activeSequence = selectActiveSequence(currentState)
          if (!activeSequence) {
            get().stopTransport()
            return
          }

          const tickPerfNow = performance.now()
          const tickAudioNow = audioEngine.nowSeconds()
          const result = _transportScheduler.tick(
            tickPerfNow,
            tickAudioNow,
            currentSnapshot,
            {
              mode: currentState.playbackScope,
              loopEnabled: currentState.loopEnabled,
              activePatternId: activeSequence.id,
              lookaheadMs,
              visualCompMs: 46,
            },
          )

          if (result.shouldStop) {
            get().stopTransport()
            return
          }

          result.events.forEach((event: { padId: string; velocity: number; gate: number; semitoneOffset: number; note?: number; atTimeSec: number; stepDurationSec: number }) => {
            const pad = currentSnapshot.padById.get(event.padId)
            if (!pad || currentState.mutedLanePadIds.has(pad.id) || pad.settings.mute) return

            tickCount += 1
            const driftMs = Math.max(0, (audioEngine.nowSeconds() - event.atTimeSec) * 1000)
            maxDriftMs = Math.max(maxDriftMs, driftMs)
            _perfDriftWindow.push(driftMs)
            if (_perfDriftWindow.length > 200) _perfDriftWindow.splice(0, _perfDriftWindow.length - 200)
            if (driftMs > 5) lateNotes += 1

            // For piano roll events with absolute note, compute semitone offset from pad base
            let effectiveSemitoneOffset = event.semitoneOffset
            if (event.note != null && pad.settings.source === 'synth' && pad.settings.synthParams) {
              effectiveSemitoneOffset = event.note - (pad.settings.synthParams.baseNote + (pad.settings.semitones ?? 0))
            }

            get().flashSequencedPadHit(pad.id)
            notifyLaunchpadSeqHit(pad.id)
            void audioEngine.playPad(pad, event.velocity / 127, {
              forceDuration:
                pad.settings.mode === 'one-shot'
                  ? undefined
                  : Math.max(0.04, event.gate * event.stepDurationSec),
              semitoneOffset: effectiveSemitoneOffset,
              atTimeSec: event.atTimeSec,
              bpm: currentSnapshot.bpm,
            })

            // MIDI out from sequencer
            const midiOut = pad.settings.midiOut
            if (midiOut?.enabled) {
              const note = event.note != null ? event.note : Math.max(0, Math.min(127, midiOut.note + event.semitoneOffset))
              const vel = midiOut.velocity < 0
                ? Math.max(1, Math.min(127, Math.round((event.velocity / 127) * 127)))
                : midiOut.velocity
              const durationMs = Math.max(40, event.gate * event.stepDurationSec * 1000)
              // Align MIDI timing with Web Audio scheduled time (account for audio output latency)
              const audioLatencyMs = (audioEngine.getOutputLatency()) * 1000
              const midiDelayMs = Math.max(0, (event.atTimeSec - tickAudioNow) * 1000 + audioLatencyMs)
              sendMidiNote(midiOut.deviceId, midiOut.channel, note, vel, durationMs, `midiout:seq:${pad.id}:${note}`, midiDelayMs)
            }
          })

          // Metronome clicks
          if (currentState.metronomeEnabled && result.metronomeBeats.length > 0) {
            const vol = currentState.metronomeVolume
            for (const beat of result.metronomeBeats) {
              audioEngine.playMetronomeClick(beat.atTimeSec, beat.accent, vol)
            }
          }

          if (result.visual.playheadStep !== visualStep) {
            visualStep = result.visual.playheadStep
            transportVisualStore.setPlayheadStep(result.visual.playheadStep)
          }

          {
            const s = get()
            if (
              s.playingPatternId !== result.visual.patternId ||
              s.playingChainIndex !== result.visual.chainIndex ||
              s.playingChainRepeat !== result.visual.chainRepeat
            ) {
              set((d) => {
                d.playingPatternId = result.visual.patternId
                d.playingChainIndex = result.visual.chainIndex
                d.playingChainRepeat = result.visual.chainRepeat
              })
            }
          }

          if (tickCount > 0 && tickCount % 24 === 0) {
            const sorted = [..._perfDriftWindow].sort((a, b) => a - b)
            const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0
            set((d) => {
              d.perfStats = { tickCount, lateNotes, maxDriftMs, p95DriftMs: p95 }
            })
          }
        }

        tick()
        const worker = new TransportClockWorker()
        _transportWorker = worker
        worker.onmessage = (message: MessageEvent<{ type: 'tick'; nowMs: number }>) => {
          if (message.data.type === 'tick') tick()
        }
        worker.postMessage({ type: 'start', intervalMs: schedulerMs })
        } catch (e) {
          console.error('[startTransport] failed:', e)
          set((d) => { d.isPlaying = false })
        }
      },

      togglePlayPause: () => {
        if (get().isPlaying) {
          get().stopTransport()
        } else {
          // Kick off audio unlock synchronously in gesture callstack (iOS requirement)
          audioEngine.unlockAndPrepare()
          void get().startTransport()
        }
      },

      // --- Sequencer ---

      pushSequencerHistory: (state: Project, sequenceId: string | null) => {
        if (get().historySilenced) return
        set((s) => {
          const snap = historySnapshotFrom(state, sequenceId)
          s.historyPast = [...s.historyPast, snap].slice(-50)
          s.historyFuture = []
        })
      },

      beginDragHistoryCapture: () => {
        const s = get()
        if (_dragHistoryCaptured || !s.project) return
        _dragHistoryCaptured = true
        s.pushSequencerHistory(s.project, s.activeSequenceId)
      },

      finishDragHistoryCapture: () => {
        _dragHistoryCaptured = false
      },

      toggleStep: async (step: number, padId: string) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)

        const existing = activeSeq.events.find((e) => e.step === step && e.padId === padId)
        const events = existing
          ? activeSeq.events.filter((e) => e.id !== existing.id)
          : [...activeSeq.events, { id: uid(), step, padId, velocity: 112, gate: 1, semitones: 0 }]

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, events } : seq,
          ),
        })
      },

      togglePianoRollExpanded: (padId: string) => {
        set((d) => {
          const next = new Set(d.expandedPianoRollPads)
          if (next.has(padId)) next.delete(padId)
          else next.add(padId)
          d.expandedPianoRollPads = next
        })
      },

      togglePianoRollNote: async (step: number, padId: string, note: number) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)

        const existing = activeSeq.events.find((e) => e.step === step && e.padId === padId && e.note === note)
        const events = existing
          ? activeSeq.events.filter((e) => e.id !== existing.id)
          : [...activeSeq.events, { id: uid(), step, padId, velocity: 100, gate: 1, note }]

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, events } : seq,
          ),
        })
      },

      setPianoRollNoteVelocity: async (eventId: string, velocity: number) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return
        const events = activeSeq.events.map((e) =>
          e.id === eventId ? { ...e, velocity: Math.max(1, Math.min(127, velocity)) } : e,
        )
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, events } : seq,
          ),
        })
      },

      setPianoRollNoteGate: async (eventId: string, gate: number) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return
        const events = activeSeq.events.map((e) =>
          e.id === eventId ? { ...e, gate: Math.max(1, gate) } : e,
        )
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, events } : seq,
          ),
        })
      },

      setPianoRollNoteStartAndGate: async (eventId: string, step: number, gate: number) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return
        const events = activeSeq.events.map((e) =>
          e.id === eventId ? { ...e, step: Math.max(0, step), gate: Math.max(1, gate) } : e,
        )
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, events } : seq,
          ),
        })
      },

      setPianoRollOctaveOffset: (padId: string, offset: number) => {
        set((d) => {
          d.pianoRollOctaveOffset = { ...d.pianoRollOctaveOffset, [padId]: offset }
        })
      },

      undoSequencer: async () => {
        const s = get()
        if (!s.project || s.historyPast.length === 0) return

        const previous = s.historyPast[s.historyPast.length - 1]
        const current = historySnapshotFrom(s.project, s.activeSequenceId)
        set((d) => {
          d.historySilenced = true
          d.historyPast = d.historyPast.slice(0, -1)
          d.historyFuture = [...d.historyFuture, current]
        })
        const proj = get().project!
        await persistProject({
          ...proj,
          sequences: previous.sequences,
          songChain: previous.songChain,
          songLoopStart: previous.songLoopStart,
          songLoopEnd: previous.songLoopEnd,
        })
        set((d) => {
          d.activeSequenceId = previous.activeSequenceId
          d.historySilenced = false
        })
        _dragHistoryCaptured = false
      },

      redoSequencer: async () => {
        const s = get()
        if (!s.project || s.historyFuture.length === 0) return

        const next = s.historyFuture[s.historyFuture.length - 1]
        const current = historySnapshotFrom(s.project, s.activeSequenceId)
        set((d) => {
          d.historySilenced = true
          d.historyFuture = d.historyFuture.slice(0, -1)
          d.historyPast = [...d.historyPast, current]
        })
        const proj = get().project!
        await persistProject({
          ...proj,
          sequences: next.sequences,
          songChain: next.songChain,
          songLoopStart: next.songLoopStart,
          songLoopEnd: next.songLoopEnd,
        })
        set((d) => {
          d.activeSequenceId = next.activeSequenceId
          d.historySilenced = false
        })
        _dragHistoryCaptured = false
      },

      clearLane: async (padId: string) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return
        if (!(await showConfirm('Clear this lane events?'))) return

        s.pushSequencerHistory(s.project, activeSeq.id)
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id
              ? { ...seq, events: seq.events.filter((e) => e.padId !== padId) }
              : seq,
          ),
        })
      },

      duplicateLaneToNext: async (padId: string) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)
        const ordered = selectCurrentBankPads(s).sort((a, b) => a.midiNote - b.midiNote)
        const index = ordered.findIndex((p) => p.id === padId)
        if (index < 0 || index >= ordered.length - 1) return

        const targetPadId = ordered[index + 1].id
        const cloned = activeSeq.events
          .filter((e) => e.padId === padId)
          .map((e) => ({ ...e, id: uid(), padId: targetPadId }))

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id
              ? { ...seq, events: [...seq.events.filter((e) => e.padId !== targetPadId), ...cloned] }
              : seq,
          ),
        })
      },

      laneToolFill: async (padId: string, interval: number) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)
        const existingMap = new Map(
          activeSeq.events.filter((e) => e.padId === padId).map((e) => [e.step, e]),
        )
        const generated = Array.from({ length: activeSeq.lengthSteps }, (_, step) => step)
          .filter((step) => step % interval === 0)
          .map((step) => existingMap.get(step) ?? { id: uid(), step, padId, velocity: 112, gate: 1, semitones: 0 })

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id
              ? { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...generated] }
              : seq,
          ),
        })
      },

      laneToolShift: async (padId: string, direction: -1 | 1) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) => {
            if (seq.id !== activeSeq.id) return seq
            const shifted = seq.events
              .filter((e) => e.padId === padId)
              .map((e) => ({ ...e, step: (e.step + direction + seq.lengthSteps) % seq.lengthSteps }))
            return { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...shifted] }
          }),
        })
      },

      laneToolRandom: async (padId: string) => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return

        s.pushSequencerHistory(s.project, activeSeq.id)
        const randomEvents = Array.from({ length: activeSeq.lengthSteps }, (_, step) => step)
          .filter(() => Math.random() > 0.7)
          .map((step) => ({ id: uid(), step, padId, velocity: Math.floor(80 + Math.random() * 47), gate: 1, semitones: 0 }))

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id
              ? { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...randomEvents] }
              : seq,
          ),
        })
      },

      duplicatePatternLength: async (mode: 'double' | 'half') => {
        const s = get()
        const activeSeq = selectActiveSequence(s)
        if (!s.project || !activeSeq) return
        if (
          !(await showConfirm(
            mode === 'double'
              ? 'Duplicate pattern length and copy events?'
              : 'Halve pattern length and truncate out-of-range events?',
          ))
        )
          return

        s.pushSequencerHistory(s.project, activeSeq.id)
        const nextLength =
          mode === 'double'
            ? clampSequenceLength(Math.min(128, activeSeq.lengthSteps * 2))
            : clampSequenceLength(Math.max(8, Math.floor(activeSeq.lengthSteps / 2)))

        const nextEvents =
          mode === 'double'
            ? [
                ...activeSeq.events,
                ...activeSeq.events
                  .map((e) => ({ ...e, id: uid(), step: e.step + activeSeq.lengthSteps }))
                  .filter((e) => e.step < nextLength),
              ]
            : activeSeq.events.filter((e) => e.step < nextLength)

        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === activeSeq.id ? { ...seq, lengthSteps: nextLength, events: nextEvents } : seq,
          ),
        })
      },

      toggleLaneMute: (padId: string) => {
        set((s) => {
          const next = new Set(s.mutedLanePadIds)
          if (next.has(padId)) next.delete(padId)
          else next.add(padId)
          s.mutedLanePadIds = next
        })
      },

      toggleSeqBankCollapsed: (bank: number) => {
        set((s) => {
          const expanded = new Set(s.seqExpandedBanks)
          const collapsed = new Set(s.seqCollapsedBanks)
          if (collapsed.has(bank)) {
            // User is expanding a collapsed bank
            collapsed.delete(bank)
            expanded.add(bank)
          } else if (expanded.has(bank)) {
            // User is collapsing an expanded bank
            expanded.delete(bank)
            collapsed.add(bank)
          } else {
            // No explicit state — toggle from default
            // Default: collapsed if no events, expanded if has events
            // So toggling means: if it was showing (has events), collapse it; if hidden (no events), expand it
            const state = get()
            const visibleSeq = selectVisibleSequence(state)
            const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
            const bankPads = state.project?.pads.filter((p) => p.bank === bank) ?? []
            const hasEvents = bankPads.some((p) => activePadIds.has(p.id))
            if (hasEvents) {
              collapsed.add(bank)
            } else {
              expanded.add(bank)
            }
          }
          s.seqExpandedBanks = expanded
          s.seqCollapsedBanks = collapsed
        })
      },

      setSequenceResolution: async (resolution: SequenceResolution) => {
        const s = get()
        const visible = selectVisibleSequence(s)
        if (!s.project || !visible) return
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === visible.id ? { ...seq, resolution } : seq,
          ),
        })
      },

      setSequenceLength: async (lengthSteps: number) => {
        const s = get()
        const visible = selectVisibleSequence(s)
        if (!s.project || !visible) return
        const length = clampSequenceLength(lengthSteps)
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === visible.id
              ? { ...seq, lengthSteps: length, events: seq.events.filter((e) => e.step < length) }
              : seq,
          ),
        })
      },

      commitSequenceLengthDraft: async () => {
        const parsed = Number(get().sequenceLengthDraft)
        if (!Number.isFinite(parsed)) {
          const visible = selectVisibleSequence(get())
          if (visible) set((s) => { s.sequenceLengthDraft = String(visible.lengthSteps) })
          return
        }
        await get().setSequenceLength(parsed)
      },

      // --- Patterns ---

      addSequence: async () => {
        const s = get()
        if (!s.project) return
        const sequence: SequencePattern = {
          id: uid(),
          name: `Pattern ${s.project.sequences.length + 1}`,
          color: PATTERN_COLORS_CYCLE[s.project.sequences.length % PATTERN_COLORS_CYCLE.length],
          resolution: 16,
          lengthSteps: 16,
          events: [],
        }
        await s.saveProject({ ...s.project, sequences: [...s.project.sequences, sequence] })
        set((d) => {
          d.activeSequenceId = sequence.id
          d.playingPatternId = sequence.id
        })
      },

      renamePattern: async (patternId: string, name: string) => {
        const s = get()
        if (!s.project) return
        const nextName = name.trim()
        if (!nextName) return
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === patternId ? { ...seq, name: nextName } : seq,
          ),
        })
      },

      setPatternColor: async (patternId: string, color: string) => {
        const s = get()
        if (!s.project) return
        await s.saveProject({
          ...s.project,
          sequences: s.project.sequences.map((seq) =>
            seq.id === patternId ? { ...seq, color } : seq,
          ),
        })
      },

      duplicatePattern: async (patternId: string) => {
        const s = get()
        if (!s.project) return
        const source = s.project.sequences.find((seq) => seq.id === patternId)
        if (!source) return
        const clone: SequencePattern = {
          ...source,
          id: uid(),
          name: `${source.name} Copy`,
          color: PATTERN_COLORS_CYCLE[s.project.sequences.length % PATTERN_COLORS_CYCLE.length],
          events: source.events.map((e) => ({ ...e, id: uid() })),
        }
        await s.saveProject({ ...s.project, sequences: [...s.project.sequences, clone] })
        set((d) => { d.activeSequenceId = clone.id })
      },

      reorderPattern: async (patternId: string, targetPatternId: string) => {
        const s = get()
        if (!s.project || patternId === targetPatternId) return
        const sequences = [...s.project.sequences]
        const srcIdx = sequences.findIndex((seq) => seq.id === patternId)
        const tgtIdx = sequences.findIndex((seq) => seq.id === targetPatternId)
        if (srcIdx === -1 || tgtIdx === -1) return
        const [moved] = sequences.splice(srcIdx, 1)
        sequences.splice(tgtIdx, 0, moved)
        await s.saveProject({ ...s.project, sequences })
      },

      deletePattern: async (patternId: string) => {
        const s = get()
        if (!s.project) return
        if (s.project.sequences.length <= 1) return // must keep at least one
        const remaining = s.project.sequences.filter((seq) => seq.id !== patternId)
        // Also remove from song chain
        const chain = s.project.songChain.filter((e) => e.patternId !== patternId)
        const needSwitch = s.activeSequenceId === patternId || s.playingPatternId === patternId
        await s.saveProject({ ...s.project, sequences: remaining, songChain: chain })
        if (needSwitch) {
          set((d) => {
            d.activeSequenceId = remaining[0].id
            d.playingPatternId = remaining[0].id
          })
        }
      },

      // --- Song Chain ---

      addChainEntry: async (patternId: string) => {
        const s = get()
        if (!s.project) return
        s.pushSequencerHistory(s.project, s.activeSequenceId)
        const entry: SongChainEntry = { id: uid(), patternId, repeats: 1 }
        await s.saveProject({ ...s.project, songChain: [...s.project.songChain, entry] })
      },

      addChainEntryAt: async (patternId: string, targetIndex: number) => {
        const s = get()
        if (!s.project) return
        s.pushSequencerHistory(s.project, s.activeSequenceId)
        const entry: SongChainEntry = { id: uid(), patternId, repeats: 1 }
        const next = [...s.project.songChain]
        next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, entry)
        await s.saveProject({ ...s.project, songChain: next })
      },

      removeChainEntry: async (entryId: string) => {
        const s = get()
        if (!s.project) return
        s.pushSequencerHistory(s.project, s.activeSequenceId)
        await s.saveProject({ ...s.project, songChain: s.project.songChain.filter((e) => e.id !== entryId) })
        set((d) => { if (d.selectedChainEntryId === entryId) d.selectedChainEntryId = null })
      },

      moveChainEntry: async (dragId: string, targetId: string) => {
        const s = get()
        if (!s.project || dragId === targetId) return
        s.pushSequencerHistory(s.project, s.activeSequenceId)
        const srcIdx = s.project.songChain.findIndex((e) => e.id === dragId)
        const tgtIdx = s.project.songChain.findIndex((e) => e.id === targetId)
        if (srcIdx < 0 || tgtIdx < 0) return
        const reordered = [...s.project.songChain]
        const [moved] = reordered.splice(srcIdx, 1)
        reordered.splice(tgtIdx, 0, moved)
        await s.saveProject({ ...s.project, songChain: reordered })
      },

      updateChainRepeats: async (entryId: string, repeats: number) => {
        const s = get()
        if (!s.project) return
        const nextRepeats = Math.max(1, Math.min(32, Math.round(repeats)))
        await s.saveProject({
          ...s.project,
          songChain: s.project.songChain.map((e) =>
            e.id === entryId ? { ...e, repeats: nextRepeats } : e,
          ),
        })
      },

      setSongLoopStart: async (index: number | null, skipHistory = false) => {
        const s = get()
        if (!s.project) return
        if (!skipHistory) s.pushSequencerHistory(s.project, s.activeSequenceId)
        const maxIdx = Math.max(0, s.project.songChain.length - 1)
        const nextStart = index === null ? null : Math.max(0, Math.min(maxIdx, index))
        const nextEnd =
          s.project.songLoopEnd !== null && nextStart !== null && s.project.songLoopEnd < nextStart
            ? nextStart
            : s.project.songLoopEnd
        await s.saveProject({ ...s.project, songLoopStart: nextStart, songLoopEnd: nextEnd })
      },

      setSongLoopEnd: async (index: number | null, skipHistory = false) => {
        const s = get()
        if (!s.project) return
        if (!skipHistory) s.pushSequencerHistory(s.project, s.activeSequenceId)
        const maxIdx = Math.max(0, s.project.songChain.length - 1)
        const nextEnd = index === null ? null : Math.max(0, Math.min(maxIdx, index))
        const nextStart =
          s.project.songLoopStart !== null && nextEnd !== null && s.project.songLoopStart > nextEnd
            ? nextEnd
            : s.project.songLoopStart
        await s.saveProject({ ...s.project, songLoopStart: nextStart, songLoopEnd: nextEnd })
      },

      copySelectedChainEntry: () => {
        const s = get()
        if (!s.project || !s.selectedChainEntryId) return
        const entry = s.project.songChain.find((e) => e.id === s.selectedChainEntryId)
        if (!entry) return
        set((d) => { d.copiedChainPatternId = entry.patternId })
      },

      pasteChainEntry: async () => {
        const pid = get().copiedChainPatternId
        if (!pid) return
        await get().addChainEntry(pid)
      },

      // --- Library ---

      previewSample: async (sample: SampleAsset) => {
        // Stop any current preview
        audioEngine.stopPreview()

        // If same sample is already previewing, just stop (toggle off)
        if (get().previewSampleId === sample.id) {
          set((s) => { s.previewSampleId = null })
          return
        }

        // Ensure buffer is loaded
        if (!audioEngine.hasSample(sample.id)) {
          await audioEngine.registerSample(sample)
        }

        set((s) => { s.previewSampleId = sample.id })
        audioEngine.playPreview(sample.id, () => {
          set((s) => { if (s.previewSampleId === sample.id) s.previewSampleId = null })
        })
      },

      deleteSampleFromLibrary: async (sample: SampleAsset) => {
        const s = get()
        if (!s.project) return
        const usedByPrimary = s.project.pads.filter((p) => p.settings.sampleId === sample.id)
        const usedByLayer = s.project.pads.filter((p) =>
          p.settings.layers.some((l) => l.sampleId === sample.id),
        )
        const totalUsed = new Set([...usedByPrimary, ...usedByLayer].map((p) => p.id)).size
        const confirmText =
          totalUsed > 0
            ? `Delete ${sample.name}? It is used by ${totalUsed} pad(s) and will be unassigned.`
            : `Delete ${sample.name}?`
        if (!(await showConfirm(confirmText))) return

        await db.deleteSample(sample.id)
        await db.deleteWaveformPeaksBySampleId(sample.id)
        audioEngine.unregisterSample(sample.id)
        set((d) => {
          d.samples = d.samples.filter((item) => item.id !== sample.id)
          d.sampleMap.delete(sample.id)
          d.favoriteSampleIds.delete(sample.id)
          const nextPeaks = { ...d.libraryWavePeaks }
          delete nextPeaks[sample.id]
          d.libraryWavePeaks = nextPeaks
        })

        const needsSave = s.project.pads.some(
          (p) => p.settings.sampleId === sample.id || p.settings.layers.some((l) => l.sampleId === sample.id),
        )
        if (needsSave) {
          await s.saveProject({
            ...s.project,
            pads: s.project.pads.map((p) => {
              let settings = p.settings
              if (settings.sampleId === sample.id) {
                settings = { ...settings, sampleId: null }
              }
              if (settings.layers.some((l) => l.sampleId === sample.id)) {
                settings = { ...settings, layers: settings.layers.filter((l) => l.sampleId !== sample.id) }
              }
              return settings === p.settings ? p : { ...p, settings }
            }),
          })
        }
      },

      cropSampleToTrim: async (padId: string) => {
        const s = get()
        if (!s.project) return

        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad || !pad.settings.sampleId) return

        const sampleId = pad.settings.sampleId
        const { trim } = pad.settings
        if (trim.start === 0 && trim.end === 1) {
          s.addToast('Nothing to crop — trim markers span entire sample', 'info')
          return
        }

        const buffer = audioEngine.getBuffer(sampleId)
        if (!buffer) return

        const startFrame = Math.floor(trim.start * buffer.length)
        const endFrame = Math.ceil(trim.end * buffer.length)
        const cropLength = Math.max(1, endFrame - startFrame)

        // Extract trimmed channel data
        const channels: Float32Array[] = []
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const full = buffer.getChannelData(ch)
          channels.push(full.slice(startFrame, startFrame + cropLength))
        }

        // Encode as WAV blob
        const wavBlob = encodeWavFromChannels(channels, buffer.sampleRate)

        // Update sample in store + DB
        const sample = s.samples.find((sa) => sa.id === sampleId)
        if (!sample) return

        const updatedSample: SampleAsset = {
          ...sample,
          blob: wavBlob,
          size: wavBlob.size,
          // Clear chop points and autosample trim — they're invalid after crop
          chopPoints: undefined,
          autosampleTrim: undefined,
        }
        await db.putSample(updatedSample)
        await db.deleteWaveformPeaksBySampleId(sampleId)
        await audioEngine.registerSample(updatedSample)

        // Update store: replace sample, reset trim to full range
        set((d) => {
          const idx = d.samples.findIndex((sa) => sa.id === sampleId)
          if (idx !== -1) d.samples[idx] = updatedSample as any
          d.sampleMap.set(sampleId, updatedSample as any)
        })

        // Reset trim markers on all pads using this sample (including layers)
        const updatedPads = s.project.pads.map((p) => {
          let settings = p.settings
          if (settings.sampleId === sampleId && (settings.trim.start !== 0 || settings.trim.end !== 1)) {
            settings = { ...settings, trim: { start: 0, end: 1 } }
          }
          const layersChanged = settings.layers.some(
            (l) => l.sampleId === sampleId && l.trim && (l.trim.start !== 0 || l.trim.end !== 1),
          )
          if (layersChanged) {
            settings = {
              ...settings,
              layers: settings.layers.map((l) =>
                l.sampleId === sampleId && l.trim ? { ...l, trim: { start: 0, end: 1 } } : l,
              ),
            }
          }
          return settings === p.settings ? p : { ...p, settings }
        })
        s.saveProjectLight({ ...s.project, pads: updatedPads })
        s.addToast('Sample cropped to trim markers', 'success')
      },

      normalizeSample: async (padId: string) => {
        const s = get()
        if (!s.project) return

        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad || !pad.settings.sampleId) return

        const sampleId = pad.settings.sampleId
        const buffer = audioEngine.getBuffer(sampleId)
        if (!buffer) return

        // Find peak across all channels
        let peak = 0
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const data = buffer.getChannelData(ch)
          for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i])
            if (abs > peak) peak = abs
          }
        }

        if (peak === 0) {
          s.addToast('Sample is silent — nothing to normalize', 'info')
          return
        }

        const targetLinear = Math.pow(10, -0.3 / 20) // -0.3 dBFS
        if (Math.abs(peak - targetLinear) < 0.001) {
          s.addToast('Sample is already normalized', 'info')
          return
        }

        const gain = targetLinear / peak

        // Apply gain to all channels
        const channels: Float32Array[] = []
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const data = buffer.getChannelData(ch).slice()
          for (let i = 0; i < data.length; i++) data[i] *= gain
          channels.push(data)
        }

        // Re-encode as WAV
        const wavBlob = encodeWavFromChannels(channels, buffer.sampleRate)

        const sample = s.samples.find((sa) => sa.id === sampleId)
        if (!sample) return

        const updatedSample: SampleAsset = {
          ...sample,
          blob: wavBlob,
          size: wavBlob.size,
        }
        await db.putSample(updatedSample)
        await db.deleteWaveformPeaksBySampleId(sampleId)
        await audioEngine.registerSample(updatedSample)

        set((d) => {
          const idx = d.samples.findIndex((sa) => sa.id === sampleId)
          if (idx !== -1) d.samples[idx] = updatedSample as any
          d.sampleMap.set(sampleId, updatedSample as any)
        })

        s.addToast(`Normalized (${gain > 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB)`, 'success')
      },

      removeUnassignedSamples: async () => {
        const s = get()
        if (!s.project) return
        // Collect all sample IDs referenced by any pad (primary + layers)
        const usedIds = new Set<string>()
        for (const pad of s.project.pads) {
          if (pad.settings.sampleId) usedIds.add(pad.settings.sampleId)
          for (const layer of pad.settings.layers) {
            usedIds.add(layer.sampleId)
          }
        }
        const unassigned = s.samples.filter((sa) => !usedIds.has(sa.id))
        if (unassigned.length === 0) {
          s.addToast('No unassigned samples to remove')
          return
        }
        if (!(await showConfirm(`Remove ${unassigned.length} unassigned sample(s) from the library?`))) return
        for (const sa of unassigned) {
          await db.deleteSample(sa.id)
          await db.deleteWaveformPeaksBySampleId(sa.id)
        }
        const removedIds = new Set(unassigned.map((sa) => sa.id))
        set((d) => {
          d.samples = d.samples.filter((sa) => !removedIds.has(sa.id))
          for (const id of removedIds) {
            d.sampleMap.delete(id)
            d.favoriteSampleIds.delete(id)
          }
          const nextPeaks = { ...d.libraryWavePeaks }
          for (const id of removedIds) delete nextPeaks[id]
          d.libraryWavePeaks = nextPeaks
        })
        s.addToast(`Removed ${unassigned.length} unassigned sample(s)`)
      },

      compactProject: async () => {
        const s = get()
        const project = s.project
        if (!project) return

        // 1. Collect all padIds referenced in any sequence event
        const usedPadIds = new Set<string>()
        for (const seq of project.sequences) {
          for (const ev of seq.events) {
            usedPadIds.add(ev.padId)
          }
        }

        if (usedPadIds.size === 0) {
          s.addToast('No pads are used in any sequence — nothing to compact', 'info')
          return
        }

        // 2. Find used pads (preserve bank/slot order)
        const usedPads = project.pads.filter((p) => usedPadIds.has(p.id))
        const totalBanks = Math.ceil(usedPads.length / PADS_PER_BANK)

        // 3. Collect used sampleIds from used pads
        const usedSampleIds = new Set<string>()
        for (const p of usedPads) {
          if (p.settings.sampleId) usedSampleIds.add(p.settings.sampleId)
          for (const layer of (p.settings.layers ?? [])) {
            usedSampleIds.add(layer.sampleId)
          }
        }

        // Count what will be removed
        const allAssignedSampleIds = new Set<string>()
        for (const p of project.pads) {
          if (p.settings.sampleId) allAssignedSampleIds.add(p.settings.sampleId)
          for (const layer of (p.settings.layers ?? [])) {
            allAssignedSampleIds.add(layer.sampleId)
          }
        }
        const samplesToRemove = s.samples.filter((sa) => !usedSampleIds.has(sa.id))
        const padsToRemove = project.pads.filter((p) => p.settings.sampleId && !usedPadIds.has(p.id))

        const msg = [
          `Compact will consolidate ${usedPads.length} sequenced pad(s) into bank${totalBanks > 1 ? 's' : ''} 1${totalBanks > 1 ? `–${totalBanks}` : ''}.`,
          padsToRemove.length > 0 ? `${padsToRemove.length} un-sequenced pad(s) will be cleared.` : '',
          samplesToRemove.length > 0 ? `${samplesToRemove.length} unused sample(s) will be deleted.` : '',
          'This is irreversible.',
        ].filter(Boolean).join('\n')

        if (!(await showConfirm(msg, { confirmLabel: 'Compact' }))) return

        // 4. Build pad ID mapping: old pad ID → target pad's ID
        const padIdMap = new Map<string, string>()
        const newPads = [...project.pads] // clone array (shallow)

        // Reset all pads to default first
        for (let i = 0; i < newPads.length; i++) {
          const pad = newPads[i]
          newPads[i] = {
            ...pad,
            name: `${midiToName(pad.midiNote)} Pad`,
            settings: {
              source: 'sample' as const,
              sampleId: null, gain: 1, semitones: 0, fineCents: 0,
              mode: 'one-shot' as const, trim: { start: 0, end: 1 },
              envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
              layers: [], multiMode: 'single' as const,
              filterType: 'off' as const, filterFreq: 1000, filterQ: 1,
              bus: 'A' as const, chokeGroup: 0,
            },
          }
        }

        // Place used pads into sequential positions
        for (let i = 0; i < usedPads.length; i++) {
          const targetPad = newPads[i]
          const sourcePad = usedPads[i]
          padIdMap.set(sourcePad.id, targetPad.id)
          newPads[i] = {
            ...targetPad,
            name: sourcePad.name,
            settings: { ...sourcePad.settings },
          }
        }

        // 5. Remap sequence events
        const newSequences = project.sequences.map((seq) => ({
          ...seq,
          events: seq.events.map((ev) => ({
            ...ev,
            padId: padIdMap.get(ev.padId) ?? ev.padId,
          })),
        }))

        // 6. Delete unused samples
        for (const sa of samplesToRemove) {
          await db.deleteSample(sa.id)
          await db.deleteWaveformPeaksBySampleId(sa.id)
          audioEngine.unregisterSample(sa.id)
        }
        const removedIds = new Set(samplesToRemove.map((sa) => sa.id))

        // 7. Save
        const compacted = {
          ...project,
          pads: newPads,
          sequences: newSequences,
          updatedAt: Date.now(),
        }
        set((d) => {
          d.samples = d.samples.filter((sa) => !removedIds.has(sa.id))
          for (const id of removedIds) {
            d.sampleMap.delete(id)
            d.favoriteSampleIds.delete(id)
          }
          const nextPeaks = { ...d.libraryWavePeaks }
          for (const id of removedIds) delete nextPeaks[id]
          d.libraryWavePeaks = nextPeaks
        })
        await get().saveProject(compacted)
        // Update selectedPadId to first pad if current is cleared
        const currentSelected = get().selectedPadId
        if (currentSelected && !usedPadIds.has(currentSelected)) {
          set((d) => { d.selectedPadId = newPads[0]?.id ?? null })
        }
        s.addToast(`Compacted: ${usedPads.length} pad(s), ${samplesToRemove.length} sample(s) removed`, 'success')
      },

      toggleFavoriteSample: (sampleId: string) => {
        set((s) => {
          if (s.favoriteSampleIds.has(sampleId)) s.favoriteSampleIds.delete(sampleId)
          else s.favoriteSampleIds.add(sampleId)
        })
      },

      // --- F1: Add Samples to Library (drop) ---

      addSamplesToLibrary: async (files: File[], padIndexMap?: Map<string, number>, groupLabel?: string) => {
        let added = 0
        const importedSamples: SampleAsset[] = []

        // --- MPC .pgm import: detect program files among dropped files ---
        const pgmFiles = files.filter((f) => f.name.match(/\.pgm$/i))
        if (pgmFiles.length > 0) {
          const audioFiles = files.filter((f) => !f.name.match(/\.pgm$/i) && (f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)))
          const claimedFiles = new Set<File>() // track files consumed by pgms (for remaining handling)
          const kitNames: string[] = []

          for (const pgmFile of pgmFiles) {
            try {
              const pgmResult = parseMpcPgm(await pgmFile.arrayBuffer(), pgmFile.name)
              if (!pgmResult || pgmResult.pads.length === 0) {
                console.warn('Empty or invalid MPC program', pgmFile.name)
                continue
              }
              const matched = matchMpcSamplesToFiles(pgmResult.pads, audioFiles)
              if (matched.length === 0) {
                get().addToast(`No matching audio files for "${pgmResult.label}"`)
                continue
              }
              const runId = uid()
              const runLabel = pgmResult.label
              let kitAdded = 0
              for (const { padIndex, file, mapping, additionalLayerFiles } of matched) {
                try {
                  const sample = await importFileAsSample(file, get, set)
                  // Build MPC pad settings from parsed mapping
                  const mpcSettings: import('../types').ImportedPadSettings = {}
                  if (mapping.pan != null) mpcSettings.pan = mapping.pan
                  if (mapping.level != null) mpcSettings.level = mapping.level
                  if (mapping.semitones != null) mpcSettings.semitones = mapping.semitones
                  if (mapping.fineCents != null) mpcSettings.fineCents = mapping.fineCents
                  if (mapping.filterType && mapping.filterType !== 'off') {
                    mpcSettings.filterType = mapping.filterType
                    if (mapping.filterFreq != null) mpcSettings.filterFreq = mapping.filterFreq
                    if (mapping.filterQ != null) mpcSettings.filterQ = mapping.filterQ
                  }
                  if (mapping.attack != null) mpcSettings.attack = mapping.attack
                  if (mapping.decay != null) mpcSettings.decay = mapping.decay
                  if (mapping.playMode) mpcSettings.playMode = mapping.playMode
                  const hasMpcSettings = Object.keys(mpcSettings).length > 0
                  const hasMultiLayers = additionalLayerFiles && additionalLayerFiles.length > 0
                  const velocityRanges = mapping.velocityRanges
                  const updated: SampleAsset = {
                    ...sample,
                    autosampleRunId: runId,
                    autosampleRunLabel: runLabel,
                    autosamplePadIndex: padIndex,
                    autosampleMpc: true,
                    autosampleChokeGroup: mapping.chokeGroup ?? 0,
                    ...(hasMpcSettings ? { autosampleImportedPadSettings: mpcSettings } : {}),
                    ...(hasMultiLayers ? { autosampleMpcLayerIndex: 0, autosampleMpcVelocityMax: velocityRanges?.[0] ?? 127 } : {}),
                  }
                  await db.putSample(updated)
                  set((s) => {
                    const idx = s.samples.findIndex((x) => x.id === updated.id)
                    if (idx >= 0) s.samples[idx] = updated
                    s.sampleMap.set(updated.id, updated)
                  })
                  kitAdded++
                  claimedFiles.add(file)

                  // Import additional velocity layers for this pad
                  if (hasMultiLayers && additionalLayerFiles) {
                    for (let li = 0; li < additionalLayerFiles.length; li++) {
                      try {
                        const layerSample = await importFileAsSample(additionalLayerFiles[li], get, set)
                        const layerUpdated: SampleAsset = {
                          ...layerSample,
                          autosampleRunId: runId,
                          autosampleRunLabel: runLabel,
                          autosamplePadIndex: padIndex,
                          autosampleMpc: true,
                          autosampleChokeGroup: mapping.chokeGroup ?? 0,
                          autosampleMpcLayerIndex: li + 1,
                          autosampleMpcVelocityMax: velocityRanges?.[li + 1] ?? 127,
                          ...(hasMpcSettings ? { autosampleImportedPadSettings: mpcSettings } : {}),
                        }
                        await db.putSample(layerUpdated)
                        set((s) => {
                          const idx = s.samples.findIndex((x) => x.id === layerUpdated.id)
                          if (idx >= 0) s.samples[idx] = layerUpdated
                          s.sampleMap.set(layerUpdated.id, layerUpdated)
                        })
                        kitAdded++
                        claimedFiles.add(additionalLayerFiles[li])
                      } catch (e) {
                        console.warn('Failed to import MPC layer sample', additionalLayerFiles[li].name, e)
                      }
                    }
                  }
                } catch (e) {
                  console.warn('Failed to import MPC sample', file.name, e)
                }
              }
              if (kitAdded > 0) {
                kitNames.push(runLabel)
                added += kitAdded
              }
            } catch (e) {
              console.warn('Failed to parse MPC program', pgmFile.name, e)
            }
          }

          if (kitNames.length > 0) {
            get().addToast(`Imported ${kitNames.length} MPC kit${kitNames.length > 1 ? 's' : ''}: ${kitNames.join(', ')}`)
          }

          // Process remaining unclaimed audio files through normal import flow
          const remainingAudioFiles = audioFiles.filter((f) => !claimedFiles.has(f))
          if (remainingAudioFiles.length > 0) {
            for (const file of remainingAudioFiles) {
              try {
                const sample = await importFileAsSample(file, get, set)
                importedSamples.push(sample)
                added++
              } catch (e) {
                console.warn('Failed to import file', file.name, e)
              }
            }
          }

          // If we had pgm files, skip the normal loop below (all files already processed)
          if (remainingAudioFiles.length === 0) {
            if (added > 0) return
            if (audioFiles.length === 0) get().addToast('No audio files found in drop')
            return
          }
          // Fall through to auto-grouping logic for remaining samples
        }

        // --- Loopcloud Drum .lcdk import ---
        const lcdkFiles = files.filter((f) => f.name.match(/\.lcdk$/i))
        if (lcdkFiles.length > 0) {
          const audioFiles = files.filter((f) => !f.name.match(/\.(lcdk|pgm)$/i) && (f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)))
          const kitNames: string[] = []

          for (const lcdkFile of lcdkFiles) {
            try {
              const jsonStr = await lcdkFile.text()
              const lcdkResult = parseLcdk(jsonStr, lcdkFile.name)
              if (!lcdkResult || lcdkResult.pads.length === 0) {
                console.warn('Empty or invalid Loopcloud kit', lcdkFile.name)
                continue
              }
              const matched = matchLcdkSamplesToFiles(lcdkResult.pads, audioFiles)
              if (matched.length === 0) {
                get().addToast(`No matching audio files for "${lcdkResult.label}"`)
                continue
              }
              const runId = uid()
              const runLabel = lcdkResult.label
              let kitAdded = 0
              const hasPatterns = lcdkResult.patterns.length > 0
              for (const { padIndex, file, mapping } of matched) {
                try {
                  const sample = await importFileAsSample(file, get, set)
                  const padSettings = mapping.settings
                  const hasPadSettings = Object.keys(padSettings).length > 0
                  const isFirst = kitAdded === 0
                  const updated: SampleAsset = {
                    ...sample,
                    autosampleRunId: runId,
                    autosampleRunLabel: runLabel,
                    autosamplePadIndex: padIndex,
                    autosampleChokeGroup: padSettings.chokeGroup ?? 0,
                    ...(mapping.trimStart ? { autosampleTrim: { start: mapping.trimStart, end: 1 } } : {}),
                    ...(hasPadSettings ? { autosampleImportedPadSettings: padSettings } : {}),
                    ...(isFirst && hasPatterns ? { autosamplePatterns: JSON.stringify(lcdkResult.patterns) } : {}),
                  }
                  await db.putSample(updated)
                  set((s) => {
                    const idx = s.samples.findIndex((x) => x.id === updated.id)
                    if (idx >= 0) s.samples[idx] = updated
                    s.sampleMap.set(updated.id, updated)
                  })
                  kitAdded++
                } catch (e) {
                  console.warn('Failed to import Loopcloud sample', file.name, e)
                }
              }
              if (kitAdded > 0) {
                kitNames.push(runLabel)
                added += kitAdded
              }
            } catch (e) {
              console.warn('Failed to parse Loopcloud kit', lcdkFile.name, e)
            }
          }

          if (kitNames.length > 0) {
            get().addToast(`Imported ${kitNames.length} Loopcloud kit${kitNames.length > 1 ? 's' : ''}: ${kitNames.join(', ')}`)
          }
          if (added > 0) return
          return
        }

        // Normal file import loop (when no pgm files in drop)
        if (pgmFiles.length === 0) {
        for (const file of files) {
          // Handle ZIP files (autosample group import)
          if (file.name.endsWith('.zip') || file.type === 'application/zip') {
            try {
              const zip = await JSZip.loadAsync(await file.arrayBuffer())
              const metaFile = zip.file('metadata.json')
              const meta = metaFile ? JSON.parse(await metaFile.async('text')) as { label?: string; samples?: { name: string; autosampleTrim?: { start: number; end: number } | null; autosampleBus?: BusId | null; autosampleChokeGroup?: number | null; autosamplePadIndex?: number | null; autosampleMpc?: boolean }[] } : null
              const runId = uid()
              const runLabel = meta?.label || file.name.replace(/\.zip$/i, '')
              const metaMap = new Map((meta?.samples || []).map((m) => [m.name, m]))
              for (const [path, entry] of Object.entries(zip.files)) {
                if (entry.dir || path === 'metadata.json') continue
                if (!path.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)) continue
                const blob = await entry.async('blob')
                const audioFile = new File([blob], entry.name, { type: 'audio/wav' })
                const sample = await importFileAsSample(audioFile, get, set)
                const m = metaMap.get(entry.name)
                const updated: SampleAsset = { ...sample, autosampleRunId: runId, autosampleRunLabel: runLabel, autosampleTrim: m?.autosampleTrim ?? undefined, autosampleBus: m?.autosampleBus ?? undefined, autosampleChokeGroup: m?.autosampleChokeGroup ?? undefined, autosamplePadIndex: m?.autosamplePadIndex ?? undefined, autosampleMpc: m?.autosampleMpc || undefined }
                await db.putSample(updated)
                set((s) => {
                  const idx = s.samples.findIndex((x) => x.id === updated.id)
                  if (idx >= 0) s.samples[idx] = updated
                  s.sampleMap.set(updated.id, updated)
                })
                added++
              }
            } catch (e) {
              console.warn('Failed to import zip', file.name, e)
            }
            continue
          }
          if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|ogg|flac|aiff|aif|m4a|webm)$/i)) continue
          try {
            const sample = await importFileAsSample(file, get, set)
            importedSamples.push(sample)
            added++
          } catch (e) {
            console.warn('Failed to import file', file.name, e)
          }
        }
        } // end if pgmFiles.length === 0
        // Auto-group when multiple audio files dropped at once
        if (importedSamples.length >= 2) {
          const runId = uid()
          // Use provided group label, or derive from common prefix of filenames
          let runLabel = groupLabel
          if (!runLabel) {
            const names = importedSamples.map((s) => s.name.replace(/\.[^.]+$/, ''))
            let prefix = names[0]
            for (const n of names) {
              while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1)
            }
            // Trim trailing separators/digits from prefix
            prefix = prefix.replace(/[\s_\-0-9]+$/, '')
            runLabel = prefix || `${names[0]}…${names[names.length - 1]}`
          }
          set((d) => {
            const idSet = new Set(importedSamples.map((s) => s.id))
            for (const s of d.samples) {
              if (idSet.has(s.id)) {
                s.autosampleRunId = runId
                s.autosampleRunLabel = runLabel
                // Apply kit mapping pad index if provided
                if (padIndexMap) {
                  const idx = padIndexMap.get(s.name) ?? padIndexMap.get(s.name.replace(/\.[^.]+$/, ''))
                  if (idx != null) s.autosamplePadIndex = idx
                }
              }
            }
          })
          const updated = get().samples.filter((s) => s.autosampleRunId === runId)
          for (const sample of updated) void db.putSample(sample)
        }
        if (added > 0) get().addToast(`Added ${added} sample${added > 1 ? 's' : ''} to library`)
        else if (!pgmFiles.length) get().addToast('No audio files found in drop')
      },

      // --- Synth Patches ---

      saveSynthPatch: (name: string, pad: Pad) => {
        const s = pad.settings
        const patch: SynthPatch = {
          id: uid(),
          name,
          createdAt: Date.now(),
          params: s.synthParams ?? { harmonics: [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], baseNote: 60, filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3, depth: 48 }, lfo: { waveform: 'sine', rateMode: 'free', rateHz: 4, rateSyncDiv: 4, pitchDepth: 0, filterDepth: 0, gainDepth: 0 } },
          padSettings: {
            mode: s.mode,
            envelope: { ...s.envelope },
            filterType: s.filterType,
            filterFreq: s.filterFreq,
            filterQ: s.filterQ,
            gain: s.gain,
            semitones: s.semitones,
            fineCents: s.fineCents,
          },
        }
        set((d) => {
          d.synthPatches = [...d.synthPatches, patch]
        })
        saveSynthPatches([...get().synthPatches])
        get().addToast(`Saved patch "${name}"`, 'success')
      },

      deleteSynthPatch: async (patchId: string) => {
        const patch = get().synthPatches.find((p) => p.id === patchId)
        if (!patch) return
        if (!(await showConfirm(`Delete synth patch "${patch.name}"?`))) return
        set((d) => {
          d.synthPatches = d.synthPatches.filter((p) => p.id !== patchId)
        })
        saveSynthPatches(get().synthPatches)
      },

      applySynthPatchToPad: (patch: SynthPatch, padId: string) => {
        const project = get().project
        if (!project) return
        set((d) => {
          const pad = d.project!.pads.find((p) => p.id === padId)
          if (!pad) return
          pad.settings.source = 'synth'
          pad.settings.synthParams = { ...patch.params }
          pad.settings.mode = patch.padSettings.mode
          pad.settings.envelope = { ...patch.padSettings.envelope, sustain: (patch.padSettings.envelope as any).sustain ?? 0 }
          pad.settings.filterType = patch.padSettings.filterType
          pad.settings.filterFreq = patch.padSettings.filterFreq
          pad.settings.filterQ = patch.padSettings.filterQ
          pad.settings.gain = patch.padSettings.gain
          pad.settings.semitones = patch.padSettings.semitones
          pad.settings.fineCents = patch.padSettings.fineCents
        })
        void get().saveProjectLight(get().project!)
      },

      // --- F2: Chop Modal ---

      openChopModal: (sampleId: string) => {
        set((s) => { s.chopModalSampleId = sampleId })
      },

      closeChopModal: () => {
        set((s) => { s.chopModalSampleId = null })
      },

      updateChopPoints: async (sampleId: string, points: number[]) => {
        const sorted = [...points].sort((a, b) => a - b)
        const sample = get().sampleMap.get(sampleId)
        if (!sample) return
        const updated = { ...sample, chopPoints: sorted }
        await db.putSample(updated)
        set((s) => {
          s.sampleMap.set(sampleId, updated)
          s.samples = s.samples.map((sa) => sa.id === sampleId ? updated : sa)
        })
      },

      assignChopsToPads: async (sampleId: string, startBank: number, startSlot: number) => {
        const s = get()
        const sample = s.sampleMap.get(sampleId)
        if (!sample || !s.project) return

        const chopPts = sample.chopPoints ?? []
        // N chop points => N+1 chops; boundaries: [0, ...chopPts, 1]
        const boundaries = [0, ...chopPts, 1]
        const chopCount = boundaries.length - 1
        if (chopCount < 1) return

        // Find first unused choke group (1–8), fallback to 1
        const usedGroups = new Set(
          s.project.pads
            .filter((p) => p.settings.chokeGroup > 0)
            .map((p) => p.settings.chokeGroup),
        )
        let chokeGroup = 1
        for (let g = 1; g <= 8; g++) {
          if (!usedGroups.has(g)) { chokeGroup = g; break }
        }

        const pads = [...s.project.pads]
        let padIndex = startBank * PADS_PER_BANK + startSlot
        let assigned = 0

        for (let i = 0; i < chopCount && padIndex < pads.length; i++, padIndex++) {
          const pad = pads[padIndex]
          pads[padIndex] = {
            ...pad,
            name: `${sample.name.replace(/\.[^.]+$/, '')} chop ${i + 1}`,
            settings: {
              ...pad.settings,
              sampleId: sample.id,
              trim: { start: boundaries[i], end: boundaries[i + 1] },
              chokeGroup,
            },
          }
          assigned++
        }

        await s.saveProject({ ...s.project, pads })
        set((d) => { d.chopModalSampleId = null })
        get().addToast(`Assigned ${assigned} chop${assigned > 1 ? 's' : ''} to pads (choke group ${chokeGroup})`)
      },

      // --- Chromatic Spread ---

      openChromaticSpread: (sampleId: string) => {
        set((s) => { s.chromaticSpreadSampleId = sampleId })
      },

      closeChromaticSpread: () => {
        set((s) => { s.chromaticSpreadSampleId = null })
      },

      spreadSampleChromatically: async (sampleId: string, startBank: number, startSlot: number, count: number, chokeGroup: number) => {
        const s = get()
        const sample = s.sampleMap.get(sampleId)
        if (!sample || !s.project) return

        const pads = [...s.project.pads]
        let padIndex = startBank * PADS_PER_BANK + startSlot
        let assigned = 0
        const baseName = sample.name.replace(/\.[^.]+$/, '')

        for (let i = 0; i < count && padIndex < pads.length; i++, padIndex++) {
          const pad = pads[padIndex]
          pads[padIndex] = {
            ...pad,
            name: i === 0 ? baseName : `${baseName} +${i}st`,
            settings: {
              ...pad.settings,
              sampleId: sample.id,
              semitones: i,
              trim: { start: 0, end: 1 },
              chokeGroup,
            },
          }
          assigned++
        }

        await s.saveProject({ ...s.project, pads })
        set((d) => { d.chromaticSpreadSampleId = null })
        const msg = chokeGroup > 0
          ? `Spread ${assigned} pad${assigned > 1 ? 's' : ''} chromatically (choke group ${chokeGroup})`
          : `Spread ${assigned} pad${assigned > 1 ? 's' : ''} chromatically`
        get().addToast(msg)
      },

      // --- F3: Pad Drag (Move/Copy) ---

      showPadDragPrompt: (sourcePadId: string, targetPadId: string) => {
        if (sourcePadId === targetPadId) return
        set((s) => { s.padDragPrompt = { sourcePadId, targetPadId } })
      },

      executePadMove: async (sourcePadId: string, targetPadId: string) => {
        const s = get()
        if (!s.project) return
        const src = s.project.pads.find((p) => p.id === sourcePadId)
        const tgt = s.project.pads.find((p) => p.id === targetPadId)
        if (!src || !tgt) return

        const pads = s.project.pads.map((p) => {
          if (p.id === targetPadId) {
            return { ...p, name: src.name, settings: { ...src.settings } }
          }
          if (p.id === sourcePadId) {
            return {
              ...p,
              name: `${midiToName(p.midiNote)} Pad`,
              settings: {
                source: 'sample' as const,
                sampleId: null, gain: 1, semitones: 0, fineCents: 0, mode: 'one-shot' as const,
                trim: { start: 0, end: 1 }, envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
                layers: [], multiMode: 'single' as const,
                filterType: 'off' as const, filterFreq: 1000, filterQ: 1, bus: 'A' as const, chokeGroup: 0,
              },
            }
          }
          return p
        })

        // Also move sequencer events
        const sequences = s.project.sequences.map((seq) => ({
          ...seq,
          events: seq.events.map((ev) =>
            ev.padId === sourcePadId ? { ...ev, padId: targetPadId } : ev,
          ),
        }))

        await s.saveProject({ ...s.project, pads, sequences })
        set((d) => { d.padDragPrompt = null })
        get().addToast(`Moved pad to ${tgt.bank + 1}-${tgt.slot + 1}`)
      },

      executePadCopy: async (sourcePadId: string, targetPadId: string) => {
        const s = get()
        if (!s.project) return
        const src = s.project.pads.find((p) => p.id === sourcePadId)
        const tgt = s.project.pads.find((p) => p.id === targetPadId)
        if (!src || !tgt) return

        const pads = s.project.pads.map((p) => {
          if (p.id === targetPadId) {
            return { ...p, name: src.name, settings: { ...src.settings } }
          }
          return p
        })

        await s.saveProject({ ...s.project, pads })
        set((d) => { d.padDragPrompt = null })
        get().addToast(`Copied pad to ${tgt.bank + 1}-${tgt.slot + 1}`)
      },

      executePadSwap: async (sourcePadId: string, targetPadId: string) => {
        const s = get()
        if (!s.project) return
        const src = s.project.pads.find((p) => p.id === sourcePadId)
        const tgt = s.project.pads.find((p) => p.id === targetPadId)
        if (!src || !tgt) return

        const pads = s.project.pads.map((p) => {
          if (p.id === targetPadId) {
            return { ...p, name: src.name, settings: { ...src.settings } }
          }
          if (p.id === sourcePadId) {
            return { ...p, name: tgt.name, settings: { ...tgt.settings } }
          }
          return p
        })

        // Swap sequencer events
        const sequences = s.project.sequences.map((seq) => ({
          ...seq,
          events: seq.events.map((ev) => {
            if (ev.padId === sourcePadId) return { ...ev, padId: targetPadId }
            if (ev.padId === targetPadId) return { ...ev, padId: sourcePadId }
            return ev
          }),
        }))

        await s.saveProject({ ...s.project, pads, sequences })
        set((d) => { d.padDragPrompt = null })
        get().addToast(`Swapped pads ${src.bank + 1}-${src.slot + 1} ↔ ${tgt.bank + 1}-${tgt.slot + 1}`)
      },

      cancelPadDragPrompt: () => {
        set((d) => { d.padDragPrompt = null })
      },

      // --- F4: Sequencer Recording ---

      recordPadHit: (padId: string, velocity: number, note?: number) => {
        const s = get()
        if (!s.seqRecordArmed || !s.isPlaying || !s.project) return

        // Determine target pattern
        const targetPatternId = s.playingPatternId ?? s.activeSequenceId
        if (!targetPatternId) return

        const seq = s.project.sequences.find((p) => p.id === targetPatternId)
        if (!seq) return

        // Determine target step
        let step = transportVisualStore.getPlayheadStep() ?? 0
        const rawStep = step
        if (s.seqRecordQuantize) {
          step = Math.round(step) % seq.lengthSteps
        } else {
          step = step % seq.lengthSteps
        }

        // Replace mode: clear all events for this pad in this pattern on first hit
        if (!s.seqRecordOverdub) {
          const key = `${targetPatternId}:${padId}`
          if (!_seqRecordCleared.has(key)) {
            _seqRecordCleared.add(key)
            // Clear existing events for this pad
            const filtered = seq.events.filter((e) => e.padId !== padId)
            const sequences = s.project.sequences.map((p) =>
              p.id === targetPatternId ? { ...p, events: filtered } : p,
            )
            s.saveProjectLight({ ...s.project, sequences })
            // Re-get after the save
          }
        }

        // Re-read state after potential clear
        const freshState = get()
        if (!freshState.project) return
        const freshSeq = freshState.project.sequences.find((p) => p.id === targetPatternId)
        if (!freshSeq) return

        // Check if there's already an event at this step for this pad (and note, for piano roll)
        const existing = freshSeq.events.find((e) =>
          e.step === step && e.padId === padId && (note != null ? e.note === note : e.note == null)
        )
        if (existing) return // don't double-record

        const newEvent: SequenceEvent = {
          id: uid(),
          step,
          padId,
          velocity: Math.max(1, Math.min(127, Math.round(velocity))),
          gate: 1,
          semitones: 0,
          ...(note != null ? { note } : {}),
        }

        // Track this note for gate-length computation on release
        // Adjust startTimeMs so it represents when the quantized step occurs
        const stepDurationMs = (60_000 / s.project.bpm) / 4
        const quantizeOffsetMs = (step - (rawStep % seq.lengthSteps)) * stepDurationMs
        const noteKey = `${padId}:${note ?? ''}`
        _activeRecordingNotes.set(noteKey, { eventId: newEvent.id, startStep: step, patternId: targetPatternId, startTimeMs: performance.now() + quantizeOffsetMs })

        const events = [...freshSeq.events, newEvent]
        const sequences = freshState.project.sequences.map((p) =>
          p.id === targetPatternId ? { ...p, events } : p,
        )

        freshState.saveProjectLight({ ...freshState.project, sequences })
      },

      recordPadRelease: (padId: string, note?: number) => {
        const noteKey = `${padId}:${note ?? ''}`
        const active = _activeRecordingNotes.get(noteKey)
        if (!active) return
        _activeRecordingNotes.delete(noteKey)

        const s = get()
        if (!s.project || !s.isPlaying) return

        const seq = s.project.sequences.find((p) => p.id === active.patternId)
        if (!seq) return

        // Compute gate from elapsed time + BPM (more accurate than visual playhead)
        const elapsedMs = performance.now() - active.startTimeMs
        const stepDurationMs = (60_000 / s.project.bpm) / 4 // 16th note duration
        let gate = Math.round(elapsedMs / stepDurationMs)
        gate = Math.max(1, Math.min(seq.lengthSteps, gate))

        const events = seq.events.map((e) =>
          e.id === active.eventId ? { ...e, gate } : e,
        )
        const sequences = s.project.sequences.map((p) =>
          p.id === active.patternId ? { ...p, events } : p,
        )
        s.saveProjectLight({ ...s.project, sequences })
      },

      // --- Sample Assign Prompt ---

      confirmSampleReplace: async () => {
        const prompt = get().sampleAssignPrompt
        if (!prompt) return
        set((d) => { d.sampleAssignPrompt = null })
        const { project, saveProject } = get()
        if (!project) return
        await saveProject({
          ...project,
          pads: project.pads.map((pad) =>
            pad.id === prompt.padId
              ? { ...pad, name: prompt.sample.name, settings: { ...pad.settings, sampleId: prompt.sample.id } }
              : pad,
          ),
        })
      },

      confirmSampleAddLayer: async () => {
        const prompt = get().sampleAssignPrompt
        if (!prompt) return
        set((d) => { d.sampleAssignPrompt = null })
        const { project } = get()
        if (!project) return
        const pad = project.pads.find((p) => p.id === prompt.padId)
        if (!pad) return

        const newLayer = createLayer(prompt.sample.id)

        // If pad has an existing sampleId but empty layers, migrate the existing sample into layers first
        let existingLayers = pad.settings.layers
        if (pad.settings.sampleId && existingLayers.length === 0) {
          existingLayers = [createLayer(pad.settings.sampleId)]
        }

        const multiMode = pad.settings.multiMode === 'single' ? 'round-robin' : pad.settings.multiMode

        get().saveProjectLight({
          ...project,
          pads: project.pads.map((p) =>
            p.id === prompt.padId
              ? { ...p, settings: { ...p.settings, layers: [...existingLayers, newLayer], multiMode } }
              : p,
          ),
        })
      },

      cancelSampleAssignPrompt: () => {
        set((d) => { d.sampleAssignPrompt = null })
      },

      // --- Recording ---

      openRecordDialog: (targetPadId?: string) => {
        set((d) => {
          d.showRecordDialog = true
          d.recordTargetPadId = targetPadId ?? null
        })
      },

      closeRecordDialog: () => {
        set((d) => {
          d.showRecordDialog = false
          d.recordTargetPadId = null
        })
      },

      saveRecording: async (blob: Blob, name: string) => {
        const s = get()
        const raw = await blob.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const sample: SampleAsset = {
          id: uid(),
          name,
          mimeType: blob.type,
          size: blob.size,
          createdAt: Date.now(),
          hash,
          blob,
        }
        await db.putSample(sample)
        await audioEngine.registerSample(sample)
        set((d) => {
          d.samples = [...d.samples, sample]
          d.sampleMap.set(sample.id, sample)
        })
        // Assign to target pad if set
        const targetPadId = s.recordTargetPadId
        if (targetPadId) {
          await get().assignSampleToPad(sample, targetPadId)
        }
        set((d) => {
          d.showRecordDialog = false
          d.recordTargetPadId = null
        })
      },

      togglePadHoldRecord: () => {
        const next = !get().padHoldRecordEnabled
        set((d) => { d.padHoldRecordEnabled = next })
        // Release mic stream when disabling
        if (!next) {
          if (_holdRecWorklet) { try { _holdRecWorklet.disconnect() } catch { /* */ }; _holdRecWorklet = null }
          if (_holdRecSource) { try { _holdRecSource.disconnect() } catch { /* */ }; _holdRecSource = null }
          if (_holdRecStream) { _holdRecStream.getTracks().forEach((t) => t.stop()); _holdRecStream = null }
        }
      },

      startPadHoldRecord: (padId: string) => {
        if (get().padHoldRecordingPadId) return // already recording
        set((d) => { d.padHoldRecordingPadId = padId })
        _holdRecChunks = []
        _holdRecStartTime = Date.now()

        const setup = async () => {
          try {
            // Get mic stream (reuse if already acquired)
            if (!_holdRecStream) {
              _holdRecStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
              })
            }
            // Guard: recording may have been stopped while awaiting getUserMedia
            if (!get().padHoldRecordingPadId) {
              _holdRecStream?.getTracks().forEach(t => t.stop())
              _holdRecStream = null
              return
            }
            // Use the main AudioContext (avoid creating a second one — Chrome audio thread degrades)
            const ctx = audioEngine.getContextIfReady()
            if (!ctx) { set((d) => { d.padHoldRecordingPadId = null }); return }

            // Register worklet on main context once
            if (!_holdRecWorkletRegistered) {
              const url = 'data:application/javascript,' + encodeURIComponent(HOLD_REC_WORKLET_SRC)
              await ctx.audioWorklet.addModule(url)
              _holdRecWorkletRegistered = true
            }
            // Guard: recording may have been stopped while awaiting addModule
            if (!get().padHoldRecordingPadId) {
              return
            }

            _holdRecSource = ctx.createMediaStreamSource(_holdRecStream)
            _holdRecWorklet = new AudioWorkletNode(ctx, 'hold-recorder-worklet')
            _holdRecWorklet.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
              _holdRecChunks.push(e.data.samples)
            }
            _holdRecSource.connect(_holdRecWorklet)
            // Connect to destination so process() runs (output is silent)
            _holdRecWorklet.connect(ctx.destination)
          } catch {
            set((d) => { d.padHoldRecordingPadId = null })
            get().addToast('Mic access denied', 'error')
          }
        }
        void setup()
      },

      stopPadHoldRecord: () => {
        const padId = get().padHoldRecordingPadId
        if (!padId) return
        set((d) => { d.padHoldRecordingPadId = null })

        // Stop worklet + source
        if (_holdRecWorklet) {
          try { _holdRecWorklet.disconnect() } catch { /* */ }
          _holdRecWorklet = null
        }
        if (_holdRecSource) {
          try { _holdRecSource.disconnect() } catch { /* */ }
          _holdRecSource = null
        }

        const elapsed = Date.now() - _holdRecStartTime
        if (elapsed < HOLD_REC_MIN_MS || _holdRecChunks.length === 0) {
          get().addToast('Hold longer to record', 'info')
          return
        }

        // Concatenate PCM chunks
        const totalSamples = _holdRecChunks.reduce((n, c) => n + c.length, 0)
        const pcm = new Float32Array(totalSamples)
        let offset = 0
        for (const chunk of _holdRecChunks) {
          pcm.set(chunk, offset)
          offset += chunk.length
        }
        _holdRecChunks = []

        // Normalize to -0.3 dBFS (peak)
        normalizePcm(pcm)

        // Auto-trim silence from start/end
        const sampleRate = audioEngine.getContextIfReady()?.sampleRate ?? HOLD_REC_SAMPLE_RATE
        const autoTrim = computeSilenceTrim(pcm, sampleRate)

        // Encode WAV + save
        const finalize = async () => {
          const wavBlob = encodeWavFromChannels([pcm], sampleRate)
          const raw = await wavBlob.arrayBuffer()
          const hash = await arrayBufferToHex(raw)
          const s = get()
          const pad = s.project?.pads.find((p) => p.id === padId)
          const name = `Rec ${pad ? `${pad.bank + 1}-${pad.slot + 1}` : 'pad'}`
          const sample: SampleAsset = {
            id: uid(),
            name,
            mimeType: 'audio/wav',
            size: wavBlob.size,
            createdAt: Date.now(),
            hash,
            blob: wavBlob,
          }
          await db.putSample(sample)
          await audioEngine.registerSample(sample)
          set((d) => {
            d.samples = [...d.samples, sample]
            d.sampleMap.set(sample.id, sample)
          })
          await get().assignSampleToPad(sample, padId)
          // Apply auto-trim to the pad
          if (autoTrim.start > 0 || autoTrim.end < 1) {
            set((d) => {
              const p = d.project?.pads.find((pp) => pp.id === padId)
              if (p) p.settings.trim = autoTrim
            })
            const proj = get().project
            if (proj) get().saveProjectLight(proj)
          }
          get().addToast(`Recorded to ${name}`, 'success')
        }
          void finalize()
      },

      // --- MIDI Out ---

      updatePadMidiOut: async (padId: string, patch: Partial<MidiOutConfig>) => {
        const s = get()
        if (!s.project) return
        const existing = s.project.pads.find((p) => p.id === padId)
        if (!existing) return
        const currentMidiOut: MidiOutConfig = existing.settings.midiOut ?? {
          enabled: false,
          deviceId: null,
          channel: 1,
          note: existing.midiNote,
          velocity: -1,
        }
        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === padId
              ? { ...p, settings: { ...p.settings, midiOut: { ...currentMidiOut, ...patch } } }
              : p,
          ),
        })
      },

      // --- Auto-sample helpers ---

      createSampleFromPcm: async (channels: Float32Array[], sampleRate: number, name: string, meta?: { autosampleRunId?: string; autosampleRunLabel?: string; autosampleTrim?: TrimSettings; autosampleBus?: BusId; autosampleChokeGroup?: number; autosamplePadIndex?: number }) => {
        const wavBlob = encodeWavFromChannels(channels, sampleRate)
        const raw = await wavBlob.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const sample: SampleAsset = {
          id: uid(),
          name,
          mimeType: 'audio/wav',
          size: wavBlob.size,
          createdAt: Date.now(),
          hash,
          blob: wavBlob,
          ...(meta?.autosampleRunId ? { autosampleRunId: meta.autosampleRunId } : {}),
          ...(meta?.autosampleRunLabel ? { autosampleRunLabel: meta.autosampleRunLabel } : {}),
          ...(meta?.autosampleTrim ? { autosampleTrim: meta.autosampleTrim } : {}),
          ...(meta?.autosampleBus ? { autosampleBus: meta.autosampleBus } : {}),
          ...(meta?.autosampleChokeGroup ? { autosampleChokeGroup: meta.autosampleChokeGroup } : {}),
          ...(meta?.autosamplePadIndex != null ? { autosamplePadIndex: meta.autosamplePadIndex } : {}),
        }
        await db.putSample(sample)
        await audioEngine.registerSample(sample)
        set((d) => {
          d.samples = [...d.samples, sample]
          d.sampleMap.set(sample.id, sample)
        })
        return sample.id
      },

      assignSampleIdToPad: async (padId: string, sampleId: string, padName?: string) => {
        const { project, saveProject } = get()
        if (!project) return
        const sample = get().sampleMap.get(sampleId)
        if (!sample) return
        await saveProject({
          ...project,
          pads: project.pads.map((p) =>
            p.id === padId
              ? { ...p, name: padName ?? sample.name, settings: { ...p.settings, sampleId } }
              : p,
          ),
        })
      },

      openAutosampleDialog: () => set((d) => { d.showAutosampleDialog = true }),
      closeAutosampleDialog: () => set((d) => { d.showAutosampleDialog = false }),

      setAudioMonitorEnabled: (enabled) => set((d) => { d.audioMonitorEnabled = enabled }),
      setAudioMonitorDeviceId: (id) => set((d) => { d.audioMonitorDeviceId = id }),
      setAudioMonitorBusId: (busId) => set((d) => { d.audioMonitorBusId = busId }),

      // --- Sample group management ---

      groupSamples: (sampleIds, label) => {
        if (sampleIds.length < 2) return
        const runId = uid()
        const runLabel = label || 'Group'
        set((d) => {
          const idSet = new Set(sampleIds)
          for (const s of d.samples) {
            if (idSet.has(s.id)) {
              s.autosampleRunId = runId
              s.autosampleRunLabel = runLabel
            }
          }
        })
        const samples = get().samples.filter((s) => s.autosampleRunId === runId)
        for (const sample of samples) void db.putSample(sample)
        get().addToast(`Grouped ${samples.length} samples as "${runLabel}"`)
      },

      ungroupSample: (sampleId) => {
        set((d) => {
          const s = d.samples.find((x) => x.id === sampleId)
          if (s) {
            s.autosampleRunId = undefined
            s.autosampleRunLabel = undefined
            s.autosampleTrim = undefined
            s.autosampleBus = undefined
            s.autosampleChokeGroup = undefined
            s.autosamplePadIndex = undefined
            s.autosampleMpc = undefined
          }
        })
        const sample = get().samples.find((s) => s.id === sampleId)
        if (sample) void db.putSample(sample)
      },

      assignGroupToPads: async (runId, startBank) => {
        const s = get()
        if (!s.project) return
        const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
        if (groupSamples.length === 0) return

        // Always sort by name with numeric comparison for consistent ordering
        // BUT if autosamplePadIndex is set (kit mapping), use that for ordering
        const hasKitMap = groupSamples.some((s) => s.autosamplePadIndex != null)
        if (hasKitMap) {
          groupSamples.sort((a, b) => (a.autosamplePadIndex ?? 999) - (b.autosamplePadIndex ?? 999))
        } else {
          groupSamples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        }

        // Detect velocity layers: MPC multi-layer (by padIndex + layerIndex) OR filename _vNN suffix
        const hasMpcLayers = groupSamples.some((s) => s.autosampleMpcLayerIndex != null)
        const noteGroups: { baseName: string; samples: { sample: SampleAsset; velocity: number }[] }[] = []

        if (hasMpcLayers) {
          // MPC multi-layer grouping: group by autosamplePadIndex
          const padIndexMap = new Map<number, SampleAsset[]>()
          for (const sample of groupSamples) {
            const pi = sample.autosamplePadIndex ?? -1
            let arr = padIndexMap.get(pi)
            if (!arr) { arr = []; padIndexMap.set(pi, arr) }
            arr.push(sample)
          }
          // Sort pad indices
          const sortedPadIndices = [...padIndexMap.keys()].sort((a, b) => a - b)
          for (const pi of sortedPadIndices) {
            const samples = padIndexMap.get(pi)!
            samples.sort((a, b) => (a.autosampleMpcLayerIndex ?? 0) - (b.autosampleMpcLayerIndex ?? 0))
            const primary = samples[0]
            const group = {
              baseName: primary.name,
              samples: samples.map((s) => ({ sample: s, velocity: s.autosampleMpcVelocityMax ?? 127 })),
            }
            noteGroups.push(group)
          }
        } else {
          // Standard velocity detection by _vNN filename suffix
          const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/
          const noteGroupMap = new Map<string, typeof noteGroups[0]>()

          for (const sample of groupSamples) {
            const m = veloRegex.exec(sample.name)
            if (m) {
              const baseKey = m[1] + m[3]  // e.g. "C3.wav"
              let group = noteGroupMap.get(baseKey)
              if (!group) {
                group = { baseName: m[1] + m[3], samples: [] }
                noteGroupMap.set(baseKey, group)
                noteGroups.push(group)
              }
              group.samples.push({ sample, velocity: Number(m[2]) })
            } else {
              // Non-velocity sample — treat as single-layer note
              const group = { baseName: sample.name, samples: [{ sample, velocity: 127 }] }
              noteGroups.push(group)
            }
          }
        }

        // Sort samples within each velocity group by velocity ascending
        for (const group of noteGroups) {
          group.samples.sort((a, b) => a.velocity - b.velocity)
        }

        // Find starting pad: use explicit startBank, selected pad, or first pad in current bank
        const padsSorted = [...s.project.pads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
        let startIdx = -1
        if (startBank != null) {
          startIdx = padsSorted.findIndex((p) => p.bank === startBank && p.slot === 0)
        }
        if (startIdx === -1 && s.selectedPadId) {
          startIdx = padsSorted.findIndex((p) => p.id === s.selectedPadId)
        }
        if (startIdx === -1) {
          startIdx = padsSorted.findIndex((p) => p.bank === s.activeBank)
        }
        if (startIdx === -1) startIdx = 0

        // Build assignment map: padId → note group
        const assignMap = new Map<string, typeof noteGroups[0]>()
        for (let i = 0; i < noteGroups.length; i++) {
          const targetPad = padsSorted[startIdx + i]
          if (!targetPad) break
          assignMap.set(targetPad.id, noteGroups[i])
        }

        if (assignMap.size === 0) return

        // Helper: compute velocity splits for N layers (same logic as AutosampleDialog)
        const computeVelocitySplits = (count: number): Array<{ velocityLow: number; velocityHigh: number }> => {
          if (count <= 1) return [{ velocityLow: 1, velocityHigh: 127 }]
          const splits: Array<{ velocityLow: number; velocityHigh: number }> = []
          for (let i = 0; i < count; i++) {
            const low = i === 0 ? 1 : splits[i - 1].velocityHigh + 1
            const high = i === count - 1 ? 127 : Math.round(((i + 1) / count) * 127)
            splits.push({ velocityLow: low, velocityHigh: high })
          }
          return splits
        }

        // Single atomic update
        const updatedPads = s.project.pads.map((p) => {
          const noteGroup = assignMap.get(p.id)
          if (!noteGroup) return p
          const primarySample = noteGroup.samples[0].sample
          const hasVeloLayers = noteGroup.samples.length > 1

          if (hasVeloLayers) {
            // Build velocity layers — use MPC ranges if available, otherwise compute evenly
            const isMpcLayers = noteGroup.samples[0].sample.autosampleMpcLayerIndex != null
            const splits = isMpcLayers
              ? noteGroup.samples.map((entry, i) => {
                  const low = i === 0 ? 1 : (noteGroup.samples[i - 1].velocity + 1)
                  const high = i === noteGroup.samples.length - 1 ? 127 : entry.velocity
                  return { velocityLow: Math.max(1, low), velocityHigh: Math.min(127, high) }
                })
              : computeVelocitySplits(noteGroup.samples.length)
            const layers: SampleLayer[] = noteGroup.samples.map((entry, i) => ({
              id: uid(),
              sampleId: entry.sample.id,
              velocityLow: splits[i].velocityLow,
              velocityHigh: splits[i].velocityHigh,
              gain: null, semitones: null, fineCents: null, trim: entry.sample.autosampleTrim ?? null,
              envelope: null, filterType: null, filterFreq: null, filterQ: null,
              stackOffsetMs: null,
            }))
            const mpc = primarySample.autosampleImportedPadSettings
            return {
              ...p,
              name: noteGroup.baseName.replace(/\.[^.]+$/, ''),
              settings: {
                ...p.settings,
                sampleId: primarySample.id,
                source: 'sample' as const,
                layers,
                multiMode: 'velocity' as const,
                trim: { start: 0, end: 1 },  // per-layer trim overrides via SampleLayer.trim
                bus: primarySample.autosampleBus ?? p.settings.bus,
                chokeGroup: primarySample.autosampleChokeGroup ?? 0,
                // Apply MPC pad settings if present
                ...(mpc?.pan != null ? { pan: mpc.pan } : {}),
                ...(mpc?.level != null ? { gain: mpc.level } : {}),
                ...(mpc?.semitones != null ? { semitones: mpc.semitones } : {}),
                ...(mpc?.fineCents != null ? { fineCents: mpc.fineCents } : {}),
                ...(mpc?.filterType ? { filterType: mpc.filterType } : {}),
                ...(mpc?.filterFreq != null ? { filterFreq: mpc.filterFreq } : {}),
                ...(mpc?.filterFreq2 != null ? { filterFreq2: mpc.filterFreq2 } : {}),
                ...(mpc?.filterQ != null ? { filterQ: mpc.filterQ } : {}),
                ...(mpc?.playMode ? { mode: mpc.playMode } : {}),
                ...(mpc?.attack != null || mpc?.decay != null || mpc?.hold != null || mpc?.release != null || mpc?.sustain != null ? {
                  envelope: {
                    ...p.settings.envelope,
                    ...(mpc.attack != null ? { attack: mpc.attack } : {}),
                    ...(mpc.decay != null ? { decay: mpc.decay } : {}),
                    ...(mpc.hold != null ? { hold: mpc.hold } : {}),
                    ...(mpc.release != null ? { release: mpc.release } : {}),
                    ...(mpc.sustain != null ? { sustain: mpc.sustain } : {}),
                  },
                } : {}),
              },
            }
          } else {
            // Single sample per pad
            const mpc = primarySample.autosampleImportedPadSettings
            return {
              ...p,
              name: primarySample.name,
              settings: {
                ...p.settings,
                sampleId: primarySample.id,
                source: 'sample' as const,
                layers: [],
                multiMode: 'single' as const,
                trim: primarySample.autosampleTrim ?? { start: 0, end: 1 },
                bus: primarySample.autosampleBus ?? p.settings.bus,
                chokeGroup: primarySample.autosampleChokeGroup ?? 0,
                // Apply MPC pad settings if present
                ...(mpc?.pan != null ? { pan: mpc.pan } : {}),
                ...(mpc?.level != null ? { gain: mpc.level } : {}),
                ...(mpc?.semitones != null ? { semitones: mpc.semitones } : {}),
                ...(mpc?.fineCents != null ? { fineCents: mpc.fineCents } : {}),
                ...(mpc?.filterType ? { filterType: mpc.filterType } : {}),
                ...(mpc?.filterFreq != null ? { filterFreq: mpc.filterFreq } : {}),
                ...(mpc?.filterFreq2 != null ? { filterFreq2: mpc.filterFreq2 } : {}),
                ...(mpc?.filterQ != null ? { filterQ: mpc.filterQ } : {}),
                ...(mpc?.playMode ? { mode: mpc.playMode } : {}),
                ...(mpc?.attack != null || mpc?.decay != null || mpc?.hold != null || mpc?.release != null || mpc?.sustain != null ? {
                  envelope: {
                    ...p.settings.envelope,
                    ...(mpc.attack != null ? { attack: mpc.attack } : {}),
                    ...(mpc.decay != null ? { decay: mpc.decay } : {}),
                    ...(mpc.hold != null ? { hold: mpc.hold } : {}),
                    ...(mpc.release != null ? { release: mpc.release } : {}),
                    ...(mpc.sustain != null ? { sustain: mpc.sustain } : {}),
                  },
                } : {}),
              },
            }
          }
        })
        await s.saveProject({ ...s.project, pads: updatedPads })

        // Update autosamplePadIndex on samples for future ordering
        set((d) => {
          let i = 0
          for (const [, noteGroup] of assignMap) {
            for (const entry of noteGroup.samples) {
              const sam = d.samples.find((x) => x.id === entry.sample.id)
              if (sam) sam.autosamplePadIndex = i
            }
            i++
          }
        })
        const updated = get().samples.filter((x) => x.autosampleRunId === runId)
        for (const sample of updated) void db.putSample(sample)

        s.addToast(`Assigned ${noteGroups.length} note${noteGroups.length !== 1 ? 's' : ''} from group to ${assignMap.size} pads`)

        // --- Import sequencer patterns from LCDK/imported kit data ---
        const patternSource = groupSamples.find((sam) => sam.autosamplePatterns)
        if (patternSource?.autosamplePatterns) {
          // Build padIndex → padId map (based on assignment order)
          const padIndexToId = new Map<number, string>()
          let assignIdx = 0
          for (const [padId] of assignMap) {
            padIndexToId.set(assignIdx, padId)
            assignIdx++
          }
          await get().importPatternsForGroup(patternSource.autosamplePatterns, padIndexToId, patternSource.autosampleRunLabel)
        }
      },

      // Import sequencer patterns from JSON (LCDK/imported kit data)
      // padIndexToId maps source pad indices to our pad IDs.
      // Always appends new patterns (never overwrites existing).
      importPatternsForGroup: async (patternsJson: string, padIndexToId?: Map<number, string>, groupLabel?: string) => {
        try {
          const patterns = JSON.parse(patternsJson) as Array<{ index: number; steps: Array<{ padIndex: number; step: number; velocity: number }> }>
          if (patterns.length === 0) return

          const { project } = get()
          if (!project) return

          const updatedSequences = [...project.sequences]
          const baseName = groupLabel || 'Imported'

          let totalEvents = 0
          let patternsAdded = 0
          for (const pat of patterns) {
            // Build events from imported steps
            const newEvents: import('../types').SequenceEvent[] = []
            for (const step of pat.steps) {
              const padId = padIndexToId?.get(step.padIndex)
              if (!padId) continue
              newEvents.push({
                id: uid(),
                step: step.step,
                padId,
                velocity: step.velocity,
                gate: 1,
              })
            }
            if (newEvents.length > 0) {
              // Always append as a new pattern
              const newPattern = createDefaultSequence()
              newPattern.name = `${baseName} ${patternsAdded + 1}`
              newPattern.events = newEvents
              updatedSequences.push(newPattern)
              totalEvents += newEvents.length
              patternsAdded++
            }
          }

          if (totalEvents > 0) {
            await get().saveProject({ ...project, pads: project.pads, sequences: updatedSequences })
            get().addToast(`Imported ${totalEvents} events into ${patternsAdded} new pattern${patternsAdded !== 1 ? 's' : ''}`, 'success')
          }
        } catch (e) {
          console.warn('Failed to import sequencer patterns', e)
        }
      },

      // Import patterns for a group by runId (looks up assigned pads automatically)
      importPatternsForGroupByRunId: async (runId: string) => {
        const s = get()
        if (!s.project) return
        const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
        const patternSource = groupSamples.find((sam) => sam.autosamplePatterns)
        if (!patternSource?.autosamplePatterns) {
          s.addToast('No patterns found for this group')
          return
        }

        // Find pads that have samples from this group assigned
        // Build padIndex → padId based on which pads have group samples
        const sampleIds = new Set(groupSamples.map((sam) => sam.id))
        const padIndexToId = new Map<number, string>()

        // Try to use autosamplePadIndex ordering
        const padsWithGroup = s.project.pads.filter((p) => {
          return p.settings.sampleId && sampleIds.has(p.settings.sampleId)
        })

        if (padsWithGroup.length === 0) {
          s.addToast('Assign group to pads first, then import patterns')
          return
        }

        // Map: find each pad's sample → that sample's padIndex
        for (const pad of padsWithGroup) {
          const sample = groupSamples.find((sam) => sam.id === pad.settings.sampleId)
          if (sample?.autosamplePadIndex != null) {
            padIndexToId.set(sample.autosamplePadIndex, pad.id)
          }
        }

        // Fallback: if no autosamplePadIndex, use sequential order
        if (padIndexToId.size === 0) {
          const sorted = [...padsWithGroup].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
          sorted.forEach((p, i) => padIndexToId.set(i, p.id))
        }

        await get().importPatternsForGroup(patternSource.autosamplePatterns, padIndexToId, patternSource.autosampleRunLabel)
      },

      // --- Autosample group management ---

      renameAutosampleGroup: (runId, newLabel) => {
        set((d) => {
          for (const s of d.samples) {
            if (s.autosampleRunId === runId) s.autosampleRunLabel = newLabel
          }
        })
        // Persist updated samples to DB
        const samples = get().samples.filter((s) => s.autosampleRunId === runId)
        for (const sample of samples) void db.putSample(sample)
      },

      updateAutosampleGroupSettings: (runId, patch) => {
        // Update metadata on samples
        set((d) => {
          for (const s of d.samples) {
            if (s.autosampleRunId === runId) {
              if (patch.bus !== undefined) s.autosampleBus = patch.bus
              if (patch.chokeGroup !== undefined) s.autosampleChokeGroup = patch.chokeGroup
            }
          }
        })
        const samples = get().samples.filter((s) => s.autosampleRunId === runId)
        for (const sample of samples) void db.putSample(sample)
        // Update pads that use these samples
        const s = get()
        if (!s.project) return
        const sampleIds = new Set(samples.map((x) => x.id))
        const updatedPads = s.project.pads.map((p) => {
          if (!p.settings.sampleId || !sampleIds.has(p.settings.sampleId)) return p
          const padPatch: Record<string, unknown> = {}
          if (patch.bus !== undefined) padPatch.bus = patch.bus
          if (patch.chokeGroup !== undefined) padPatch.chokeGroup = patch.chokeGroup
          if (Object.keys(padPatch).length === 0) return p
          return { ...p, settings: { ...p.settings, ...padPatch } }
        })
        s.saveProjectLight({ ...s.project, pads: updatedPads })
      },

      deleteAutosampleGroup: async (runId) => {
        const s = get()
        if (!s.project) return
        const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
        if (groupSamples.length === 0) return
        const label = groupSamples[0].autosampleRunLabel || 'this group'
        if (!(await showConfirm(`Delete all ${groupSamples.length} samples in "${label}" and reset assigned pads?`))) return

        const groupIds = new Set(groupSamples.map((sam) => sam.id))

        // Delete from DB
        for (const sam of groupSamples) {
          await db.deleteSample(sam.id)
          await db.deleteWaveformPeaksBySampleId(sam.id)
        }

        // Remove from store
        set((d) => {
          d.samples = d.samples.filter((sam) => !groupIds.has(sam.id))
          for (const id of groupIds) {
            d.sampleMap.delete(id)
            d.favoriteSampleIds.delete(id)
          }
          const nextPeaks = { ...d.libraryWavePeaks }
          for (const id of groupIds) delete nextPeaks[id]
          d.libraryWavePeaks = nextPeaks
        })

        // Reset pads that reference any sample in the group
        const padsNeedReset = s.project.pads.some(
          (p) => (p.settings.sampleId && groupIds.has(p.settings.sampleId)) ||
            p.settings.layers.some((l) => groupIds.has(l.sampleId)),
        )
        if (padsNeedReset) {
          await s.saveProject({
            ...s.project,
            pads: s.project.pads.map((p) => {
              const hasPrimary = p.settings.sampleId && groupIds.has(p.settings.sampleId)
              const hasLayer = p.settings.layers.some((l) => groupIds.has(l.sampleId))
              if (!hasPrimary && !hasLayer) return p
              return {
                ...p,
                name: `${midiToName(p.midiNote)} Pad`,
                settings: {
                  ...p.settings,
                  sampleId: hasPrimary ? null : p.settings.sampleId,
                  layers: hasLayer ? p.settings.layers.filter((l) => !groupIds.has(l.sampleId)) : p.settings.layers,
                  gain: hasPrimary ? 1 : p.settings.gain,
                  semitones: hasPrimary ? 0 : p.settings.semitones,
                  fineCents: hasPrimary ? 0 : p.settings.fineCents,
                  trim: hasPrimary ? { start: 0, end: 1 } : p.settings.trim,
                  midiOut: hasPrimary ? undefined : p.settings.midiOut,
                },
              }
            }),
          })
        }
      },

      exportAutosampleGroupZip: async (runId) => {
        const samples = get().samples.filter((s) => s.autosampleRunId === runId)
        if (samples.length === 0) return
        const label = samples[0].autosampleRunLabel || 'autosample'
        const zip = new JSZip()
        for (const sample of samples) {
          zip.file(sample.name, sample.blob)
        }
        const metadata = {
          label,
          samples: samples.map((s) => ({
            name: s.name,
            autosampleTrim: s.autosampleTrim ?? null,
            autosampleBus: s.autosampleBus ?? null,
            autosampleChokeGroup: s.autosampleChokeGroup ?? null,
            autosamplePadIndex: s.autosamplePadIndex ?? null,
            autosampleMpc: s.autosampleMpc ?? false,
          })),
        }
        zip.file('metadata.json', JSON.stringify(metadata, null, 2))
        const blob = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${label}.zip`
        a.click()
        URL.revokeObjectURL(url)
      },

      // --- BPM / Name ---

      commitBpmDraft: async () => {
        const s = get()
        if (!s.project) return
        const parsed = Number(s.bpmDraft)
        if (!Number.isFinite(parsed)) {
          set((d) => { d.bpmDraft = String(s.project!.bpm) })
          return
        }
        const bpm = Math.max(50, Math.min(200, Math.round(parsed)))
        set((d) => { d.bpmDraft = String(bpm) })
        audioEngine.setBpm(bpm)
        await s.saveProject({ ...s.project, bpm })
      },

      commitSwingDraft: async () => {
        const s = get()
        if (!s.project) return
        const parsed = Number(s.swingDraft)
        if (!Number.isFinite(parsed)) {
          set((d) => { d.swingDraft = String(s.project!.swing ?? 0) })
          return
        }
        const swing = Math.max(0, Math.min(100, Math.round(parsed)))
        set((d) => { d.swingDraft = String(swing) })
        await s.saveProject({ ...s.project, swing })
      },

      tapTempo: () => {
        const now = performance.now()
        const s = get()
        // Reset if last tap was more than 2 seconds ago
        if (_tapTimestamps.length > 0 && now - _tapTimestamps[_tapTimestamps.length - 1] > 2000) {
          _tapTimestamps.length = 0
        }
        _tapTimestamps.push(now)
        // Keep last 8 taps
        if (_tapTimestamps.length > 8) _tapTimestamps.splice(0, _tapTimestamps.length - 8)
        if (_tapTimestamps.length < 2) return

        // Average interval from tap history
        const intervals: number[] = []
        for (let i = 1; i < _tapTimestamps.length; i++) {
          intervals.push(_tapTimestamps[i] - _tapTimestamps[i - 1])
        }
        const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
        const bpm = Math.max(50, Math.min(200, Math.round(60000 / avgMs)))
        set((d) => { d.bpmDraft = String(bpm) })
        if (s.project) {
          void s.saveProject({ ...s.project, bpm })
        }
      },

      commitProjectNameDraft: async () => {
        const s = get()
        if (!s.project) return
        const nextName = s.projectNameDraft.trim()
        if (!nextName) {
          set((d) => { d.projectNameDraft = s.project!.name })
          return
        }
        if (nextName === s.project.name) {
          set((d) => { d.projectNameDraft = nextName })
          return
        }
        await s.saveProject({ ...s.project, name: nextName })
        await get().refreshProjectList()
      },

      addToast: (message: string, type: ToastType = 'info') => {
        const id = uid()
        set((d) => { d.toasts.push({ id, message, type }) })
        window.setTimeout(() => { get().removeToast(id) }, 4000)
      },

      removeToast: (id: string) => {
        set((d) => { d.toasts = d.toasts.filter((t) => t.id !== id) })
      },

      // --- Export / Import (delegated to modules) ---

      exportAllMidi: () => {
        // Will be implemented in component using external module
      },

      exportPack: async () => {
        // Will be implemented in component using external module
      },

      exportStandalonePage: async () => {
        // Will be implemented in component using external module
      },

      exportAudio: async (_mode: 'pattern' | 'song') => {
        // Will be implemented in component using external module
      },

      previewImport: async () => {
        // Will be implemented in component using external module
      },

      runImport: async () => {
        // Will be implemented in component using external module
      },

      // --- Mixer ---

      setBusName: (busId: BusId, name: string) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) =>
            b.id === busId ? { ...b, name } : b,
          ) as [any, any, any, any],
        })
      },

      setBankName: (bankIndex: number, name: string) => {
        const s = get()
        if (!s.project) return
        const names = [...(s.project.bankNames ?? Array.from({ length: BANK_COUNT }, (_, i) => `Bank ${i + 1}`))]
        names[bankIndex] = name
        s.saveProjectLight({ ...s.project, bankNames: names })
      },

      setBusGain: (busId: BusId, gain: number) => {
        const s = get()
        if (!s.project) return
        const clamped = Math.max(0, Math.min(2, gain))
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) =>
            b.id === busId ? { ...b, gain: clamped } : b,
          ) as [any, any, any, any],
        })
      },

      setBusPan: (busId: BusId, pan: number) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) =>
            b.id === busId ? { ...b, pan: Math.max(-1, Math.min(1, pan)) } : b,
          ) as [any, any, any, any],
        })
      },

      setBusMute: (busId: BusId, mute: boolean) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) =>
            b.id === busId ? { ...b, mute } : b,
          ) as [any, any, any, any],
        })
      },

      setBusSolo: (busId: BusId, solo: boolean) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) =>
            b.id === busId ? { ...b, solo } : b,
          ) as [any, any, any, any],
        })
      },

      setBusEffectType: (busId: BusId, slotIndex: number, effectType: EffectType) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) => {
            if (b.id !== busId) return b
            const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
            effects[slotIndex] = { ...effects[slotIndex], type: effectType, params: effectType === 'off' ? {} : getDefaultEffectParams(effectType) }
            return { ...b, effects }
          }) as [any, any, any, any],
        })
      },

      setBusEffectEnabled: (busId: BusId, slotIndex: number, enabled: boolean) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) => {
            if (b.id !== busId) return b
            const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
            effects[slotIndex] = { ...effects[slotIndex], enabled }
            return { ...b, effects }
          }) as [any, any, any, any],
        })
      },

      setBusEffectParam: (busId: BusId, slotIndex: number, paramName: string, value: number) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) => {
            if (b.id !== busId) return b
            const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
            effects[slotIndex] = { ...effects[slotIndex], params: { ...effects[slotIndex].params, [paramName]: value } }
            return { ...b, effects }
          }) as [any, any, any, any],
        })
      },

      setBusEffectSidechainSource: (busId: BusId, slotIndex: number, source: BusId) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          mixBuses: s.project.mixBuses.map((b) => {
            if (b.id !== busId) return b
            const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
            effects[slotIndex] = { ...effects[slotIndex], sidechainSource: source }
            return { ...b, effects }
          }) as [any, any, any, any],
        })
      },

      setPadEffectType: (padId: string, slotIndex: number, effectType: EffectType) => {
        const s = get()
        if (!s.project) return
        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad) return
        const effects = [...(pad.settings.padEffects ?? [createDefaultEffectSlot(), createDefaultEffectSlot()])] as [EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], type: effectType, enabled: effectType !== 'off', params: effectType === 'off' ? {} : getDefaultEffectParams(effectType) }
        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) => p.id === padId ? { ...p, settings: { ...p.settings, padEffects: effects } } : p),
        })
        // Structural change — rebuild effect chain
        audioEngine.rebuildPadEffectChain(padId, pad.settings.bus ?? 'A', effects)
      },

      setPadEffectEnabled: (padId: string, slotIndex: number, enabled: boolean) => {
        const s = get()
        if (!s.project) return
        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad) return
        const effects = [...(pad.settings.padEffects ?? [createDefaultEffectSlot(), createDefaultEffectSlot()])] as [EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], enabled }
        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) => p.id === padId ? { ...p, settings: { ...p.settings, padEffects: effects } } : p),
        })
        // Structural change — rebuild effect chain
        audioEngine.rebuildPadEffectChain(padId, pad.settings.bus ?? 'A', effects)
      },

      setPadEffectParam: (padId: string, slotIndex: number, paramName: string, value: number) => {
        const s = get()
        if (!s.project) return
        const pad = s.project.pads.find((p) => p.id === padId)
        if (!pad) return
        const effects = [...(pad.settings.padEffects ?? [createDefaultEffectSlot(), createDefaultEffectSlot()])] as [EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], params: { ...effects[slotIndex].params, [paramName]: value } }
        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) => p.id === padId ? { ...p, settings: { ...p.settings, padEffects: effects } } : p),
        })
        // Param-only change — update in-place
        audioEngine.updatePadEffectParams(padId, effects)
      },

      setMasterGain: (gain: number) => {
        const s = get()
        if (!s.project) return
        s.saveProjectLight({
          ...s.project,
          masterBus: { ...s.project.masterBus, gain: Math.max(0, Math.min(2, gain)) },
        })
      },

      setMasterEffectType: (slotIndex: number, effectType: EffectType) => {
        const s = get()
        if (!s.project) return
        const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], type: effectType, params: effectType === 'off' ? {} : getDefaultEffectParams(effectType) }
        s.saveProjectLight({
          ...s.project,
          masterBus: { ...s.project.masterBus, effects },
        })
      },

      setMasterEffectEnabled: (slotIndex: number, enabled: boolean) => {
        const s = get()
        if (!s.project) return
        const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], enabled }
        s.saveProjectLight({
          ...s.project,
          masterBus: { ...s.project.masterBus, effects },
        })
      },

      setMasterEffectParam: (slotIndex: number, paramName: string, value: number) => {
        const s = get()
        if (!s.project) return
        const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], params: { ...effects[slotIndex].params, [paramName]: value } }
        s.saveProjectLight({
          ...s.project,
          masterBus: { ...s.project.masterBus, effects },
        })
      },
    }
  }),
)

// Persist computer keyboard settings to localStorage
{
  let prevEnabled = useStore.getState().computerKeyboardEnabled
  let prevOctave = useStore.getState().computerKeyboardOctave
  useStore.subscribe((state) => {
    if (state.computerKeyboardEnabled !== prevEnabled) {
      prevEnabled = state.computerKeyboardEnabled
      localStorage.setItem('computerKeyboardEnabled', String(prevEnabled))
    }
    if (state.computerKeyboardOctave !== prevOctave) {
      prevOctave = state.computerKeyboardOctave
      localStorage.setItem('computerKeyboardOctave', String(prevOctave))
    }
  })
}

// Re-export constants for components
export { PATTERN_COLORS, MIN_STEP_SEMITONES, MAX_STEP_SEMITONES }
// Re-export getLaneBoundsForEvent and updateGateEventRange for drag handlers
export { getLaneBoundsForEvent, updateGateEventRange }
