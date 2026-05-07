import { buildPlaybackSnapshot } from '../lib/playbackSnapshot'
import { TransportScheduler } from '../lib/transportScheduler'
import { createDefaultProject } from '../lib/project'
import type { PlaybackSnapshot } from '../lib/playbackSnapshot'

export const mutableRefs = {
  playbackSnapshot: buildPlaybackSnapshot(createDefaultProject(), 0) as PlaybackSnapshot,
  playbackVersion: 1,
  hydratePromise: null as Promise<void> | null,
  transportScheduler: new TransportScheduler(),
  transportWorker: null as Worker | null,
  projectSaveDebounce: null as number | null,
  pendingPersist: false,
  sequencedPadHitTimers: new Map<string, number>(),
  dragHistoryCaptured: false,
  trimDirty: false,
  gateResizeDirty: false,
  perfDriftWindow: [] as number[],
  tapTimestamps: [] as number[],
  draggedPatternId: null as string | null,
  draggedChainEntryId: null as string | null,
  seqRecordCleared: new Set<string>(),
  activeRecordingNotes: new Map<string, { eventId: string; startStep: number; patternId: string; startTimeMs: number }>(),
  frozenZoomRange: null as { start: number; end: number } | null,

  // Capture MIDI buffer
  captureBuffer: [] as Array<{
    padId: string
    velocity: number
    note?: number
    type: 'on' | 'off'
    timestamp: number
  }>,
  captureTransportStartMs: null as number | null,
  captureFirstNoteTimeMs: null as number | null,

  // Pad hold record
  holdRecStream: null as MediaStream | null,
  holdRecWorklet: null as AudioWorkletNode | null,
  holdRecSource: null as MediaStreamAudioSourceNode | null,
  holdRecChunks: [] as Float32Array[],
  holdRecWorkletRegistered: false,
  holdRecStartTime: 0,
}

export const HOLD_REC_WORKLET_SRC = `
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

export const HOLD_REC_SAMPLE_RATE = 44_100
export const HOLD_REC_MIN_MS = 150 // discard taps shorter than this

// Expose for App.tsx drag handlers
export const storeRefs = {
  get trimDirty() { return mutableRefs.trimDirty },
  set trimDirty(v: boolean) { mutableRefs.trimDirty = v },
  get gateResizeDirty() { return mutableRefs.gateResizeDirty },
  set gateResizeDirty(v: boolean) { mutableRefs.gateResizeDirty = v },
  get dragHistoryCaptured() { return mutableRefs.dragHistoryCaptured },
  set dragHistoryCaptured(v: boolean) { mutableRefs.dragHistoryCaptured = v },
  get draggedPatternId() { return mutableRefs.draggedPatternId },
  set draggedPatternId(v: string | null) { mutableRefs.draggedPatternId = v },
  get draggedChainEntryId() { return mutableRefs.draggedChainEntryId },
  set draggedChainEntryId(v: string | null) { mutableRefs.draggedChainEntryId = v },
  get frozenZoomRange() { return mutableRefs.frozenZoomRange },
  set frozenZoomRange(v: { start: number; end: number } | null) { mutableRefs.frozenZoomRange = v },
}
