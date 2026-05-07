import type {
  BusId,
  EffectType,
  ImportMode,
  Pad,
  Project,
  SampleAsset,
  SampleLayer,
  SequenceResolution,
  TrimSettings,
} from '../types'

export interface SequencerHistorySnapshot {
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

export interface SequencerBankGroup {
  bank: number
  name: string
  pads: Pad[]
  hasEvents: boolean
  collapsed: boolean
}

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
  midiInputDeviceId: string | null
  padMidiChannel: number | null
  launchpadSpecialMode: boolean
  midiInputs: Array<{ id: string; name: string }>
  midiOutputs: Array<{ id: string; name: string }>
  lastMidiNote: { note: number; velocity: number } | null
  audioMonitorEnabled: boolean
  audioMonitorDeviceId: string | null
  audioMonitorBusId: BusId
  audioOutputs: Array<{ id: string; name: string }>
  audioOutputDeviceId: string | null
  audioInputs: Array<{ id: string; name: string }>
  audioInputDeviceId: string | null
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
  seqFollowPlayback: boolean
  seqExpandedBanks: Set<number>
  seqCollapsedBanks: Set<number>
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



  // --- Piano Roll ---
  expandedPianoRollPads: Set<string>
  pianoRollOctaveOffset: Record<string, number>

  // --- Computer Keyboard Input ---
  computerKeyboardEnabled: boolean
  computerKeyboardOctave: number

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

  // --- Capture MIDI ---
  captureBufferCount: number

  // --- Undo/Redo ---
  undoStack: { description: string; project: import('../types').Project }[]
  redoStack: { description: string; project: import('../types').Project }[]
  isUndoingOrRedoing: boolean

  // --- Metronome ---
  metronomeEnabled: boolean
  metronomeVolume: number
  countdownBars: number

  // --- Song Chain ---
  selectedChainEntryId: string | null
  copiedChainPatternId: string | null

  // --- Project List ---
  projectList: { id: string; name: string; updatedAt: number }[]

  // --- Internal refs (non-reactive, accessed via getState()) ---
  showAutosampleDialog: boolean

  // --- Actions ---
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

  startTransport: () => Promise<void>
  stopTransport: () => void
  togglePlayPause: () => void
  flashSequencedPadHit: (padId: string) => void

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

  togglePianoRollExpanded: (padId: string) => void
  togglePianoRollNote: (step: number, padId: string, note: number) => Promise<void>
  setPianoRollNoteVelocity: (eventId: string, velocity: number) => Promise<void>
  setPianoRollNoteGate: (eventId: string, gate: number) => Promise<void>
  setPianoRollNoteStartAndGate: (eventId: string, step: number, gate: number) => Promise<void>
  setPianoRollOctaveOffset: (padId: string, offset: number) => void

  addSequence: () => Promise<void>
  renamePattern: (patternId: string, name: string) => Promise<void>
  setPatternColor: (patternId: string, color: string) => Promise<void>
  duplicatePattern: (patternId: string) => Promise<void>
  reorderPattern: (patternId: string, targetPatternId: string) => Promise<void>
  deletePattern: (patternId: string) => Promise<void>

  addChainEntry: (patternId: string) => Promise<void>
  addChainEntryAt: (patternId: string, targetIndex: number) => Promise<void>
  removeChainEntry: (entryId: string) => Promise<void>
  moveChainEntry: (dragId: string, targetId: string) => Promise<void>
  updateChainRepeats: (entryId: string, repeats: number) => Promise<void>
  setSongLoopStart: (index: number | null, skipHistory?: boolean) => Promise<void>
  setSongLoopEnd: (index: number | null, skipHistory?: boolean) => Promise<void>
  copySelectedChainEntry: () => void
  pasteChainEntry: () => Promise<void>

  previewSample: (sample: SampleAsset) => Promise<void>
  deleteSampleFromLibrary: (sample: SampleAsset) => Promise<void>
  cropSampleToTrim: (padId: string) => Promise<void>
  normalizeSample: (padId: string) => Promise<void>
  removeUnassignedSamples: () => Promise<void>
  compactProject: () => Promise<void>
  toggleFavoriteSample: (sampleId: string) => void
  addSamplesToLibrary: (files: File[], padIndexMap?: Map<string, number>, groupLabel?: string) => Promise<void>

  openChopModal: (sampleId: string) => void
  closeChopModal: () => void
  updateChopPoints: (sampleId: string, points: number[]) => Promise<void>
  assignChopsToPads: (sampleId: string, startBank: number, startSlot: number) => Promise<void>

  openChromaticSpread: (sampleId: string) => void
  closeChromaticSpread: () => void
  spreadSampleChromatically: (sampleId: string, startBank: number, startSlot: number, count: number, chokeGroup: number) => Promise<void>

  showPadDragPrompt: (sourcePadId: string, targetPadId: string) => void
  executePadMove: (sourcePadId: string, targetPadId: string) => Promise<void>
  executePadCopy: (sourcePadId: string, targetPadId: string) => Promise<void>
  executePadSwap: (sourcePadId: string, targetPadId: string) => Promise<void>
  cancelPadDragPrompt: () => void

  recordPadHit: (padId: string, velocity: number, note?: number) => void
  recordPadRelease: (padId: string, note?: number) => void

  feedCaptureBuffer: (padId: string, velocity: number, type: 'on' | 'off', note?: number) => void
  captureMidi: () => Promise<void>
  clearCaptureBuffer: () => void

  pushUndo: (description: string) => void
  undo: () => void
  redo: () => void
  clearUndoHistory: () => void

  confirmSampleReplace: () => Promise<void>
  confirmSampleAddLayer: () => Promise<void>
  cancelSampleAssignPrompt: () => void

  openRecordDialog: (targetPadId?: string) => void
  closeRecordDialog: () => void
  saveRecording: (blob: Blob, name: string) => Promise<void>
  togglePadHoldRecord: () => void
  startPadHoldRecord: (padId: string) => void
  stopPadHoldRecord: () => void

  updatePadMidiOut: (padId: string, patch: Partial<import('../types').MidiOutConfig>) => Promise<void>

  createSampleFromPcm: (
    channels: Float32Array[],
    sampleRate: number,
    name: string,
    meta?: {
      autosampleRunId?: string
      autosampleRunLabel?: string
      autosampleTrim?: TrimSettings
      autosampleBus?: BusId
      autosampleChokeGroup?: number
      autosamplePadIndex?: number
    },
  ) => Promise<string>
  assignSampleIdToPad: (padId: string, sampleId: string, padName?: string) => Promise<void>
  openAutosampleDialog: () => void
  closeAutosampleDialog: () => void

  setAudioMonitorEnabled: (enabled: boolean) => void
  setAudioMonitorDeviceId: (id: string | null) => void
  setAudioMonitorBusId: (busId: BusId) => void

  groupSamples: (sampleIds: string[], label?: string) => void
  ungroupSample: (sampleId: string) => void
  assignGroupToPads: (runId: string, startBank?: number, skipPatternPrompt?: boolean) => Promise<void>
  importPatternsForGroup: (patternsJson: string, padIndexToId?: Map<number, string>, groupLabel?: string) => Promise<void>
  importPatternsForGroupByRunId: (runId: string) => Promise<void>
  renameAutosampleGroup: (runId: string, newLabel: string) => void
  updateAutosampleGroupSettings: (runId: string, patch: { bus?: BusId; chokeGroup?: number }) => void
  deleteAutosampleGroup: (runId: string) => Promise<void>
  exportAutosampleGroupZip: (runId: string) => Promise<void>

  commitBpmDraft: () => Promise<void>
  commitSwingDraft: () => Promise<void>
  tapTempo: () => void
  commitProjectNameDraft: () => Promise<void>

  addToast: (message: string, type?: ToastType) => void
  removeToast: (id: string) => void

  exportAllMidi: () => void
  exportPack: () => Promise<void>
  exportStandalonePage: () => Promise<void>
  exportAudio: (mode: 'pattern' | 'song') => Promise<void>
  previewImport: () => Promise<void>
  runImport: () => Promise<void>

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
  setMasterGain: (gain: number) => void
  setMasterEffectType: (slotIndex: number, effectType: EffectType) => void
  setMasterEffectEnabled: (slotIndex: number, enabled: boolean) => void
  setMasterEffectParam: (slotIndex: number, paramName: string, value: number) => void
}
