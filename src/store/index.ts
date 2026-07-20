import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import { audioEngine } from '../lib/audioEngine'
import { db } from '../lib/db'
import { buildPlaybackSnapshot } from '../lib/playbackSnapshot'
import { touchProject } from '../lib/project'
import { encodeWavFromChannels } from '../lib/wavEncode'
import { arrayBufferToHex, uid } from '../lib/utils'
import type {
  Project,
  SampleAsset,
  SequenceEvent,
  TrimSettings,
  BusId,
} from '../types'

enableMapSet()

import { registerConfirmDialog } from './confirmDialog'
import { transportVisualStore } from './visualStore'
import { normalizeProject, createLayer } from './helpers'
import { mutableRefs } from './refs'
import type { AppState } from './types'
import { createMixerActions } from './slices/mixer'
import { createUiActions } from './slices/ui'
import { createProjectActions } from './slices/project'
import { createPadActions } from './slices/pad'
import { createTransportActions } from './slices/transport'
import { createSequencerActions } from './slices/sequencer'
import { createPianoRollActions } from './slices/pianoRoll'
import { createPatternActions } from './slices/patterns'
import { createSongChainActions } from './slices/songChain'
import { createLibraryActions } from './slices/library'
import { createSampleGroupActions } from './slices/sampleGroups'
import { createChopSpreadDragActions } from './slices/chopSpreadDrag'
import { createRecordingActions } from './slices/recording'
import { createMidiOutActions } from './slices/midiOut'
import { createAudioMonitorActions } from './slices/audioMonitor'
import { createHistoryActions } from './slices/history'

export const useStore = create<AppState>()(
  immer((set, get) => {
    registerConfirmDialog((dialog) => set((s) => { s.confirmDialog = dialog }))

    // Track snapshot-relevant fields to avoid unnecessary rebuilds
    let _lastSnapshotPads: unknown = null
    let _lastSnapshotSequences: unknown = null
    let _lastSnapshotBpm: unknown = null
    let _lastSnapshotSwing: unknown = null
    let _lastSnapshotSongChain: unknown = null
    let _lastSnapshotSongLoopStart: unknown = null
    let _lastSnapshotSongLoopEnd: unknown = null

    // Throttle state: knob/trim/drag edits can fire rebuilds every rAF frame.
    // Coalesce to at most one build per SNAPSHOT_MIN_INTERVAL_MS with a trailing
    // build so the snapshot always catches up. The scheduler reads
    // mutableRefs.playbackSnapshot fresh every tick, so a trailing build is
    // picked up automatically (max ~100ms staleness during continuous drags).
    const SNAPSHOT_MIN_INTERVAL_MS = 100
    let _lastSnapshotBuildMs = 0
    let _snapshotTrailingTimer: number | null = null
    let _pendingSnapshotProj: Project | null = null

    const buildSnapshotNow = (proj: Project) => {
      _lastSnapshotBuildMs = performance.now()
      mutableRefs.playbackVersion += 1
      mutableRefs.playbackSnapshot = buildPlaybackSnapshot(proj, mutableRefs.playbackVersion)
    }

    const rebuildPlaybackSnapshot = (proj: Project) => {
      if (
        proj.pads === _lastSnapshotPads &&
        proj.sequences === _lastSnapshotSequences &&
        proj.bpm === _lastSnapshotBpm &&
        (proj.swing ?? 0) === _lastSnapshotSwing &&
        proj.songChain === _lastSnapshotSongChain &&
        proj.songLoopStart === _lastSnapshotSongLoopStart &&
        proj.songLoopEnd === _lastSnapshotSongLoopEnd
      ) {
        return
      }
      _lastSnapshotPads = proj.pads
      _lastSnapshotSequences = proj.sequences
      _lastSnapshotBpm = proj.bpm
      _lastSnapshotSwing = proj.swing ?? 0
      _lastSnapshotSongChain = proj.songChain
      _lastSnapshotSongLoopStart = proj.songLoopStart
      _lastSnapshotSongLoopEnd = proj.songLoopEnd

      const now = performance.now()
      const elapsed = now - _lastSnapshotBuildMs
      if (elapsed >= SNAPSHOT_MIN_INTERVAL_MS) {
        buildSnapshotNow(proj)
        return
      }
      _pendingSnapshotProj = proj
      if (_snapshotTrailingTimer === null) {
        _snapshotTrailingTimer = window.setTimeout(() => {
          _snapshotTrailingTimer = null
          if (_pendingSnapshotProj) {
            buildSnapshotNow(_pendingSnapshotProj)
            _pendingSnapshotProj = null
          }
        }, SNAPSHOT_MIN_INTERVAL_MS - elapsed)
      }
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

    // Debounced cleanup of unused AudioBuffers and stale effect chains
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
        }
        audioEngine.pruneUnusedBuffers(usedIds)
      }, 2000)
    }

    const ctx = { set, get }
    const mixerActions = createMixerActions(ctx)
    const uiActions = createUiActions(ctx)
    const projectActions = createProjectActions(ctx)
    const padActions = createPadActions(ctx)
    const transportActions = createTransportActions(ctx)
    const sequencerActions = createSequencerActions(ctx)
    const pianoRollActions = createPianoRollActions(ctx)
    const patternActions = createPatternActions(ctx)
    const songChainActions = createSongChainActions(ctx)
    const libraryActions = createLibraryActions(ctx)
    const sampleGroupActions = createSampleGroupActions(ctx)
    const chopSpreadDragActions = createChopSpreadDragActions(ctx)
    const recordingActions = createRecordingActions(ctx)
    const midiOutActions = createMidiOutActions(ctx)
    const audioMonitorActions = createAudioMonitorActions(ctx)
    const historyActions = createHistoryActions(ctx)

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
      selectedPadIds: [],
      selectedLayerId: null,
      hideEmptyLanes: true,
      seqFollowPlayback: true,
      seqExpandedBanks: new Set<number>(),
      seqCollapsedBanks: new Set<number>(),
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
      importMode: 'merge' as import('../types').ImportMode,
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
      showMetadataTags: localStorage.getItem('showMetadataTags') !== 'false',
      metadataTagWhitelist: new Set(JSON.parse(localStorage.getItem('metadataTagWhitelist') || '["INAM","IART","ICMT","IPRD"]')),
      libraryInspectorSampleId: null,
      libraryExpanded: localStorage.getItem('libraryExpanded') === 'true',
      kitPreviewRunId: null,

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

      captureBufferCount: 0,

      undoStack: [],
      redoStack: [],
      isUndoingOrRedoing: false,

      metronomeEnabled: localStorage.getItem('metronomeEnabled') === 'true',
      metronomeVolume: Number(localStorage.getItem('metronomeVolume') || '0.7') || 0.7,
      countdownBars: Number(localStorage.getItem('countdownBars') || '0') || 0,

      selectedChainEntryId: null,
      copiedChainPatternId: null,

      projectList: [],

      showAutosampleDialog: false,

      // =================================================================
      // Core actions that stay in index.ts
      // =================================================================

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
          mutableRefs.pendingPersist = true
          return
        }

        if (mutableRefs.projectSaveDebounce !== null) {
          window.clearTimeout(mutableRefs.projectSaveDebounce)
        }

        if (flushImmediately) {
          void db.putProject(touched)
          mutableRefs.projectSaveDebounce = null
          return
        }

        const timerId = window.setTimeout(() => {
          const current = get().project
          if (current) void db.putProject(current)
          mutableRefs.projectSaveDebounce = null
        }, 180)
        mutableRefs.projectSaveDebounce = timerId
      },

      flushPendingProjectSave: () => {
        if (mutableRefs.projectSaveDebounce !== null) {
          window.clearTimeout(mutableRefs.projectSaveDebounce)
          mutableRefs.projectSaveDebounce = null
        }
        const s = get()
        if (s.project) {
          void db.putProject(s.project)
          mutableRefs.pendingPersist = false
        }
      },

      // --- Sequencer Recording (stays in index.ts — uses mutableRefs + transportVisualStore heavily) ---

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
          if (!mutableRefs.seqRecordCleared.has(key)) {
            mutableRefs.seqRecordCleared.add(key)
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
        mutableRefs.activeRecordingNotes.set(noteKey, { eventId: newEvent.id, startStep: step, patternId: targetPatternId, startTimeMs: performance.now() + quantizeOffsetMs })

        const events = [...freshSeq.events, newEvent]
        const sequences = freshState.project.sequences.map((p) =>
          p.id === targetPatternId ? { ...p, events } : p,
        )

        freshState.saveProjectLight({ ...freshState.project, sequences })
      },

      recordPadRelease: (padId: string, note?: number) => {
        const noteKey = `${padId}:${note ?? ''}`
        const active = mutableRefs.activeRecordingNotes.get(noteKey)
        if (!active) return
        mutableRefs.activeRecordingNotes.delete(noteKey)

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

      // --- Autosample helpers (stays in index.ts) ---

      createSampleFromPcm: async (
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
      ) => {
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

      // --- Sliced actions ---
      ...mixerActions,
      ...uiActions,
      ...projectActions,
      ...padActions,
      ...transportActions,
      ...sequencerActions,
      ...pianoRollActions,
      ...patternActions,
      ...songChainActions,
      ...libraryActions,
      ...sampleGroupActions,
      ...chopSpreadDragActions,
      ...recordingActions,
      ...midiOutActions,
      ...audioMonitorActions,
      ...historyActions,
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

// Re-export public APIs so component imports remain unchanged
export { transportVisualStore } from './visualStore'
export { showConfirm, resolveConfirmDialog } from './confirmDialog'
export { storeRefs } from './refs'
export * from './types'
export * from './constants'
export * from './helpers'
export * from './selectors'
export { importFileAsSample, loadPresetKits } from './importHelpers'
