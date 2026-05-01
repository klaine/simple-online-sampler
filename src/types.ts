export type PadMode = 'one-shot' | 'adsr'

export type PadSource = 'sample' | 'synth'

export type BusId = 'A' | 'B' | 'C' | 'D'
export const BUS_IDS: BusId[] = ['A', 'B', 'C', 'D']

export type EffectType = 'off' | 'compressor' | 'eq3' | 'delay' | 'reverb' | 'chorus' | 'sidechain-compressor'

export interface EffectSlot {
  id: string
  type: EffectType
  enabled: boolean
  params: Record<string, number>
  sidechainSource?: BusId  // only used when type === 'sidechain-compressor'
}

export interface MixBus {
  id: BusId
  name: string
  gain: number      // 0–2
  pan: number       // -1 to 1
  mute: boolean
  solo: boolean
  effects: [EffectSlot, EffectSlot, EffectSlot]
}

export interface MasterBus {
  gain: number      // 0–2
  effects: [EffectSlot, EffectSlot, EffectSlot]
}

export type SequenceResolution = 16 | 32

export type ImportMode = 'new' | 'merge' | 'overwrite'

export type MultiSampleMode = 'single' | 'round-robin' | 'random' | 'velocity' | 'stacked'

export interface EnvelopeSettings {
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface TrimSettings {
  start: number
  end: number
}

export interface SampleLayer {
  id: string
  sampleId: string
  velocityLow: number   // 0–127, inclusive
  velocityHigh: number  // 0–127, inclusive
  // Per-layer overrides (null = inherit from pad)
  gain: number | null
  semitones: number | null
  fineCents: number | null
  trim: TrimSettings | null
  envelope: EnvelopeSettings | null
  filterType: FilterType | null
  filterFreq: number | null
  filterQ: number | null
  stackOffsetMs: number | null  // timing offset in ms for stacked mode (null = 0)
}

export type FilterType = 'off' | 'lp12' | 'lp24' | 'highpass' | 'bandpass'

export interface MidiOutConfig {
  enabled: boolean
  deviceId: string | null  // null = first available output
  channel: number          // 1–16
  note: number             // 0–127
  velocity: number         // 1–127, or -1 to inherit trigger velocity
}

export type LfoWaveform = 'sine' | 'ramp-up' | 'ramp-down' | 'square'
export type LfoRateMode = 'free' | 'sync'

export interface LfoSettings {
  waveform: LfoWaveform
  rateMode: LfoRateMode
  rateHz: number           // free-running Hz (0.1–30)
  rateSyncDiv: number      // tempo-sync divisions: 1=1/1, 2=1/2, 4=1/4, 8=1/8, 16=1/16
  pitchDepth: number       // 0–1 (pitch modulation amount, 0=off)
  filterDepth: number      // 0–1 (filter cutoff modulation amount, 0=off)
  gainDepth: number        // 0–1 (gain/tremolo modulation amount, 0=off)
}

export interface FilterEnvelopeSettings {
  attack: number           // seconds
  decay: number            // seconds
  sustain: number          // 0–1 (fraction of depth)
  release: number          // seconds
  depth: number            // semitones of filter cutoff modulation (0–96)
}

export interface SynthParams {
  /** 16 harmonic amplitudes (0–1), index 0 = fundamental */
  harmonics: number[]
  /** Base frequency as MIDI note (default 60 = C4) */
  baseNote: number
  /** Filter envelope (modulates filter cutoff) */
  filterEnvelope: FilterEnvelopeSettings
  /** LFO */
  lfo: LfoSettings
}

export interface PadSettings {
  source: PadSource
  sampleId: string | null
  gain: number
  semitones: number
  fineCents: number
  mode: PadMode
  trim: TrimSettings
  envelope: EnvelopeSettings
  layers: SampleLayer[]
  multiMode: MultiSampleMode
  filterType: FilterType
  filterFreq: number  // Hz, 20–20000
  filterQ: number     // 0.1–20
  filterKeyTrack?: number // -100 to +100, 0 = off, 100 = full tracking (filter opens on higher notes)
  bus: BusId          // mix bus routing
  chokeGroup: number  // 0 = none, 1–8 = choke group
  pan?: number        // -1 (left) to 1 (right), undefined = 0 (center)
  randomPan?: boolean // when true, pan value controls random pan width
  midiOut?: MidiOutConfig  // optional MIDI out config (undefined = disabled)
  synthParams?: SynthParams // only used when source === 'synth'
  /** Per-synth-pad MIDI input channel for chromatic note input (1–16, undefined = disabled) */
  synthMidiChannel?: number
  /** Per-synth-pad MIDI input device ID (undefined = any device) */
  synthMidiDevice?: string
  /** Filter envelope for sample pads (undefined = no filter envelope modulation) */
  filterEnvelope?: FilterEnvelopeSettings
  /** Per-pad effect slots (used for synth pads, 2 slots) */
  padEffects?: [EffectSlot, EffectSlot]
}

export interface Pad {
  id: string
  bank: number
  slot: number
  midiNote: number
  name: string
  settings: PadSettings
}

export interface SampleAsset {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: number
  hash: string
  blob: Blob
  chopPoints?: number[]  // sorted fractional positions (0–1), N points = N+1 chops
  autosampleRunId?: string  // groups samples from the same autosample session
  autosampleRunLabel?: string  // user-editable group name
  autosampleTrim?: TrimSettings  // trim computed during autosample, applied on pad assignment
  autosampleBus?: BusId           // bus routing for group pads
  autosampleChokeGroup?: number   // choke group for group pads (0=off, 1–8)
  autosamplePadIndex?: number     // original pad index from imported program file (MPC .pgm, etc.)
  autosampleMpc?: boolean         // true only when imported via .pgm program file
  autosamplePreset?: boolean      // true for factory preset samples
}

export interface SequenceEvent {
  id: string
  step: number
  padId: string
  velocity: number
  gate: number
  semitones?: number
  /** MIDI note number for piano roll events (synth pads). When set, overrides pad base note. */
  note?: number
}

export interface SequencePattern {
  id: string
  name: string
  color: string
  resolution: SequenceResolution
  lengthSteps: number
  events: SequenceEvent[]
}

export interface SongChainEntry {
  id: string
  patternId: string
  repeats: number
}

export interface Project {
  id: string
  name: string
  bpm: number
  swing: number  // 0–100, default 0
  polyphony: 4 | 8 | 16 | 32
  pads: Pad[]
  sequences: SequencePattern[]
  songChain: SongChainEntry[]
  songLoopStart: number | null
  songLoopEnd: number | null
  mixBuses: [MixBus, MixBus, MixBus, MixBus]
  masterBus: MasterBus
  createdAt: number
  updatedAt: number
}

export interface SynthPatch {
  id: string
  name: string
  createdAt: number
  params: SynthParams
  /** Pad settings snapshot: mode, envelope, filter, bus, choke, gain, semitones, fineCents */
  padSettings: {
    mode: PadMode
    envelope: EnvelopeSettings
    filterType: FilterType
    filterFreq: number
    filterQ: number
    gain: number
    semitones: number
    fineCents: number
  }
}

export interface PackageManifest {
  schemaVersion: number
  exportedAt: number
  project: Project
  usedSampleIds: string[]
  sampleMeta?: { id: string; name: string; chopPoints?: number[]; autosampleRunId?: string; autosampleRunLabel?: string; autosamplePadIndex?: number; autosampleTrim?: TrimSettings; autosampleBus?: BusId; autosampleChokeGroup?: number; autosampleMpc?: boolean; autosamplePreset?: boolean }[]
  synthPatches?: SynthPatch[]
}
