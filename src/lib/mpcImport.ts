/**
 * MPC1000/MPC2500 .pgm file parser
 *
 * Binary format (MPC1000 PGM 1.00):
 *   Header: 24 bytes (4 magic + 16 identifier + 4 padding)
 *   64 pad records × 164 bytes each
 *     - bytes 0–63: 4 layer sample names (16 bytes each, null-padded, no extension)
 *     - bytes 64–163: pad parameters (play mode, envelope, filter, tuning, level, pan, etc.)
 *   Footer: ~236 bytes (MIDI note map, etc.)
 *
 * Pad record layout (164 bytes):
 *   0–15:  Layer 1 sample name
 *   16–31: Layer 2 sample name
 *   32–47: Layer 3 sample name
 *   48–63: Layer 4 sample name
 *   64:    Padding
 *   65:    Padding
 *   66:    Padding
 *   67:    Padding
 *   68:    Play mode (0=one-shot, 1=note-on)
 *   69:    Voice overlap (0=poly, 1=mono)
 *   70:    Mute group / choke group (0=off, 1–34)
 *   71:    Padding
 *   72:    Padding
 *   73:    Attack (0–100)
 *   74:    Decay (0–100)
 *   75:    Decay mode (0=end, 1=start)
 *   76–79: Velocity layer ranges (4 bytes: layer1max, layer2max, layer3max, layer4max)
 *          Ranges are top-down: layer4 = velocityRange[3]..127, etc.
 *   80:    Level (0–100)
 *   81:    Pan (0=hard left, 50=center, 100=hard right)
 *   82:    Filter type (0=off, 1=lowpass, 2=bandpass, 3=highpass)
 *   83:    Filter frequency (0–100)
 *   84:    Filter resonance (0–100)
 *   85:    Tuning coarse (signed byte: -120 to +120 semitones, stored as unsigned 0–240, 120=0)
 *   86:    Tuning fine (0–99, representing cents, 50=0)
 *   87–163: Additional params (MIDI note, send levels, etc.) — not extracted
 */

import type { FilterType } from '../types'

export interface MpcPadMapping {
  index: number
  sampleName: string // primary layer filename without extension
  /** Additional layer sample names (layers 2–4, if present) */
  additionalLayers?: string[]
  /** Velocity ranges for layers [layer1max, layer2max, layer3max, layer4max] — only meaningful when multiple layers */
  velocityRanges?: number[]
  /** Choke/mute group (0=off, 1–34 in MPC, clamped to 1–8 for our app) */
  chokeGroup?: number
  /** Pan: -1 (left) to +1 (right) */
  pan?: number
  /** Gain: 0.0–1.0 */
  level?: number
  /** Semitone tuning offset */
  semitones?: number
  /** Fine tuning in cents (-50 to +49) */
  fineCents?: number
  /** Filter type mapped to our FilterType */
  filterType?: FilterType
  /** Filter frequency in Hz (20–20000) */
  filterFreq?: number
  /** Filter resonance as Q (0.7–20) */
  filterQ?: number
  /** Attack time in seconds */
  attack?: number
  /** Decay time in seconds */
  decay?: number
  /** Play mode: 'one-shot' or 'adsr' */
  playMode?: 'one-shot' | 'adsr'
  /** Voice overlap: true=mono (choke self) */
  voiceMono?: boolean
}

export interface MpcPgmResult {
  label: string // derived from .pgm filename
  pads: MpcPadMapping[]
}

const HEADER_SIZE = 24
const RECORD_SIZE = 164
const NAME_SIZE = 16
const PAD_COUNT = 64
const HEADER_MAGIC = 'MPC1000 PGM'

/**
 * Map MPC filter frequency (0–100) to Hz.
 * MPC uses exponential mapping: ~20Hz at 0, ~20kHz at 100.
 */
function mpcFilterFreqToHz(value: number): number {
  // 20 * 1000^(value/100) gives 20Hz → 20kHz
  return 20 * Math.pow(1000, value / 100)
}

/**
 * Map MPC filter resonance (0–100) to Web Audio Q value.
 * MPC resonance 0 = gentle (~0.7), 100 = very resonant (~20).
 */
function mpcResonanceToQ(value: number): number {
  // Exponential mapping: 0.7 at 0, ~20 at 100
  return 0.7 * Math.pow(20 / 0.7, value / 100)
}

/**
 * Map MPC attack/decay value (0–100) to seconds.
 * MPC uses roughly exponential curve: 0=0ms, ~50=~200ms, 100=~5s
 */
function mpcEnvelopeToSeconds(value: number): number {
  if (value === 0) return 0
  // Roughly: 0.001 * exp(value * 0.085) gives ~1ms at 1, ~5s at 100
  return 0.001 * Math.exp(value * 0.085)
}

function readPadName(data: Uint8Array, offset: number): string {
  let nameEnd = 0
  while (nameEnd < NAME_SIZE && data[offset + nameEnd] !== 0) nameEnd++
  if (nameEnd === 0) return ''
  const name = String.fromCharCode(...data.slice(offset, offset + nameEnd))
  return /^[\x20-\x7e]+$/.test(name) ? name : ''
}

export function parseMpcPgm(buffer: ArrayBuffer, filename: string): MpcPgmResult | null {
  const data = new Uint8Array(buffer)

  // Validate minimum size: header + at least 1 pad record
  if (data.length < HEADER_SIZE + RECORD_SIZE) return null

  // Validate header identifier at offset 4
  const headerStr = String.fromCharCode(...data.slice(4, 4 + HEADER_MAGIC.length))
  if (headerStr !== HEADER_MAGIC) return null

  const pads: MpcPadMapping[] = []

  for (let i = 0; i < PAD_COUNT; i++) {
    const offset = HEADER_SIZE + i * RECORD_SIZE
    if (offset + RECORD_SIZE > data.length) break

    // Read 4 layer names
    const layer1 = readPadName(data, offset)
    const layer2 = readPadName(data, offset + 16)
    const layer3 = readPadName(data, offset + 32)
    const layer4 = readPadName(data, offset + 48)

    if (!layer1) continue // empty pad (no primary sample)

    const pad: MpcPadMapping = { index: i, sampleName: layer1 }

    // Additional layers
    const extraLayers = [layer2, layer3, layer4].filter(Boolean)
    if (extraLayers.length > 0) {
      pad.additionalLayers = extraLayers
      // Velocity ranges (bytes 76–79): max velocity for each layer
      pad.velocityRanges = [data[offset + 76], data[offset + 77], data[offset + 78], data[offset + 79]]
    }

    // Play mode
    const playMode = data[offset + 68]
    pad.playMode = playMode === 0 ? 'one-shot' : 'adsr'

    // Voice overlap (mono)
    pad.voiceMono = data[offset + 69] === 1

    // Mute/choke group
    const muteGroup = data[offset + 70]
    if (muteGroup > 0) {
      pad.chokeGroup = Math.min(muteGroup, 8) // clamp to our 1–8 range
    }

    // Attack & Decay
    const attackVal = data[offset + 73]
    const decayVal = data[offset + 74]
    if (attackVal > 0) pad.attack = mpcEnvelopeToSeconds(attackVal)
    if (decayVal > 0) pad.decay = mpcEnvelopeToSeconds(decayVal)

    // Level
    const level = data[offset + 80]
    if (level < 100) pad.level = level / 100

    // Pan
    const pan = data[offset + 81]
    if (pan !== 50) pad.pan = (pan - 50) / 50 // 0→-1, 50→0, 100→+1

    // Filter
    const filterTypeRaw = data[offset + 82]
    if (filterTypeRaw > 0) {
      const filterMap: Record<number, FilterType> = { 1: 'lp12', 2: 'bandpass', 3: 'highpass' }
      pad.filterType = filterMap[filterTypeRaw] || 'off'
      pad.filterFreq = mpcFilterFreqToHz(data[offset + 83])
      pad.filterQ = mpcResonanceToQ(data[offset + 84])
    }

    // Tuning
    const tuningCoarse = data[offset + 85]
    const tuningFine = data[offset + 86]
    const semitones = tuningCoarse - 120 // 120 = center (0 semitones)
    const fineCents = tuningFine - 50 // 50 = center (0 cents)
    if (semitones !== 0) pad.semitones = semitones
    if (fineCents !== 0) pad.fineCents = fineCents

    pads.push(pad)
  }

  // Derive label from .pgm filename (strip extension)
  const label = filename.replace(/\.pgm$/i, '')

  return { label, pads }
}

/**
 * Given a parsed MPC pad mapping and a list of available audio Files,
 * returns files matched to pad indices in pad order.
 * Matching is case-insensitive, tries name with and without .wav extension.
 * For multi-layer pads, returns all matched layer files.
 */
export interface MpcMatchedPad {
  padIndex: number
  file: File
  additionalLayerFiles?: File[]
  mapping: MpcPadMapping
}

export function matchMpcSamplesToFiles(
  pads: MpcPadMapping[],
  files: File[],
): MpcMatchedPad[] {
  // Build lookup: lowercase name (no extension) -> File
  const fileMap = new Map<string, File>()
  for (const f of files) {
    const key = f.name.replace(/\.[^.]+$/, '').toLowerCase()
    fileMap.set(key, f)
  }

  const result: MpcMatchedPad[] = []
  for (const pad of pads) {
    const key = pad.sampleName.toLowerCase()
    const file = fileMap.get(key)
    if (file) {
      const matched: MpcMatchedPad = { padIndex: pad.index, file, mapping: pad }

      // Match additional layer files
      if (pad.additionalLayers && pad.additionalLayers.length > 0) {
        const layerFiles: File[] = []
        for (const layerName of pad.additionalLayers) {
          const layerFile = fileMap.get(layerName.toLowerCase())
          if (layerFile) layerFiles.push(layerFile)
        }
        if (layerFiles.length > 0) matched.additionalLayerFiles = layerFiles
      }

      result.push(matched)
    }
  }

  // Sort by pad index for sequential assignment
  result.sort((a, b) => a.padIndex - b.padIndex)
  return result
}
