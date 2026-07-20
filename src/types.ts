export type PadMode = 'one-shot' | 'adsr' | 'ahr'

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
  hold?: number  // AHR mode hold time (seconds), default 0
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

export type FilterType = 'off' | 'lp12' | 'lp24' | 'highpass' | 'bandpass' | 'lphp'

export interface MidiOutConfig {
  enabled: boolean
  deviceId: string | null  // null = first available output
  channel: number          // 1–16
  note: number             // 0–127
  velocity: number         // 1–127, or -1 to inherit trigger velocity
}

export interface PadSettings {
  sampleId: string | null
  gain: number
  semitones: number
  fineCents: number
  /** MIDI note for the sample's original pitch. Piano roll centers around this. Default 60 (C4). */
  baseNote?: number
  mode: PadMode
  trim: TrimSettings
  envelope: EnvelopeSettings
  layers: SampleLayer[]
  multiMode: MultiSampleMode
  filterType: FilterType
  filterFreq: number  // Hz, 20–20000
  filterFreq2?: number // Hz, second cutoff for 'lphp' filter (HP frequency)
  filterQ: number     // 0.1–20
  bus: BusId          // mix bus routing
  chokeGroup: number  // 0 = none, 1–8 = choke group
  pan?: number        // -1 (left) to 1 (right), undefined = 0 (center)
  randomPan?: boolean // when true, pan value controls random pan width
  reverse?: boolean   // play sample backwards within trim markers (undefined/false = forward)
  midiOut?: MidiOutConfig  // optional MIDI out config (undefined = disabled)
  /** Per-pad mute (undefined/false = not muted) */
  mute?: boolean
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
  autosamplePreset?: boolean       // true for factory preset samples
  autosampleLcdk?: boolean        // true when imported via .lcdk Loopcloud Drum kit file
  autosampleBattery?: boolean      // true when imported via Battery 4 monolith .nbkt
  /** Metadata tags extracted from WAV LIST/INFO chunks (e.g. INAM, IART, ICMT) */
  metadataTags?: Record<string, string>
  /** Imported kit pad settings (applied on pad assignment) */
  autosampleImportedPadSettings?: ImportedPadSettings
  /** MPC velocity layer index within a pad (0=primary, 1–3=additional layers) */
  autosampleMpcLayerIndex?: number
  /** MPC velocity range max for this layer (used to compute velocity splits) */
  autosampleMpcVelocityMax?: number
  /** Sequencer pattern data from imported kit (stored on first sample in group only) */
  autosamplePatterns?: string  // JSON-encoded LcdkPattern[] (kept as string to avoid IndexedDB serialization issues)
}

/** Per-pad settings extracted from imported kit files (.pgm, .lcdk), applied when sample is assigned to a pad */
export interface ImportedPadSettings {
  pan?: number              // -1 to +1
  level?: number            // 0.0–1.0
  mute?: boolean            // true = muted pad
  semitones?: number        // semitone offset
  fineCents?: number        // fine tuning in cents
  filterType?: FilterType   // 'off' | 'lp12' | 'highpass' | 'bandpass' | 'lphp'
  filterFreq?: number       // Hz (LP cutoff, or single filter freq)
  filterFreq2?: number      // Hz (HP cutoff for 'lphp' filter)
  filterQ?: number          // Q value
  attack?: number           // seconds
  decay?: number            // seconds
  hold?: number             // seconds (AHR mode)
  release?: number          // seconds (AHR mode)
  sustain?: number          // 0-1
  playMode?: PadMode
  chokeGroup?: number       // 1–8 (0=off)
}

export interface SequenceEvent {
  id: string
  step: number
  padId: string
  velocity: number
  gate: number
  semitones?: number
  /** MIDI note number for piano roll events. When set, overrides pad base note. */
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
  bankNames?: string[]  // custom bank names (length = BANK_COUNT), undefined entries use default "Bank N"
  createdAt: number
  updatedAt: number
}

export interface PackageManifest {
  schemaVersion: number
  exportedAt: number
  project: Project
  usedSampleIds: string[]
  sampleMeta?: { id: string; name: string; chopPoints?: number[]; autosampleRunId?: string; autosampleRunLabel?: string; autosamplePadIndex?: number; autosampleTrim?: TrimSettings; autosampleBus?: BusId; autosampleChokeGroup?: number; autosampleMpc?: boolean; autosamplePreset?: boolean; autosampleLcdk?: boolean; autosampleBattery?: boolean; metadataTags?: Record<string, string>; autosampleImportedPadSettings?: ImportedPadSettings; autosampleMpcLayerIndex?: number; autosampleMpcVelocityMax?: number }[]
}
