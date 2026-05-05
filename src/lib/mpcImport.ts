/**
 * MPC1000/MPC2500 .pgm file parser
 *
 * Binary format (MPC1000 PGM 1.00):
 *   Header: 24 bytes (2 bytes size + 2 unknown + 16 identifier "MPC1000 PGM 1.00" + 4 padding)
 *   64 pad records × 164 bytes each
 *   Footer: ~236 bytes (MIDI note map, etc.)
 *
 * Pad record layout (164 bytes) — verified against real .pgm files:
 *   0–15:   Layer 1 sample name (null-padded, no extension)
 *   16–31:  Layer 2 sample name
 *   32–47:  Layer 3 sample name
 *   48–63:  Layer 4 sample name
 *   64–87:  Layer 1 params (24 bytes):
 *     [0]:   unknown (seems to contain pointer/address data)
 *     [1]:   Layer level (0–100, default 100)
 *     [2]:   Velocity range lower (0–127, default 0)
 *     [3]:   Velocity range upper (0–127, default 127)
 *     [4–7]: Tuning (likely 4 bytes: coarse + fine)
 *     [8]:   Attack (0–100)
 *     [9]:   Decay (0–127? default 127 seen for one-shot)
 *     [10–23]: Additional layer params (filter, etc.)
 *   88–111: Layer 2 params (24 bytes, same structure)
 *   112–135: Layer 3 params (24 bytes)
 *   136–159: Layer 4 params (24 bytes) -- NOTE: last part overlaps with pad-level
 *   -- Pad-level settings (verified): --
 *   99:    Mute group / choke group (0=off, 1–34)
 *   134:   Pad active? (always 1 for pads with samples)
 *   143:   Pad level (0–100, default 100)
 *   144:   Pad pan (0–100, 50=center)
 *   145:   Filter type? (0=off — needs further verification with a kit that uses filters)
 *   146:   Play mode (0=note-on/ADSR, 1=one-shot)
 *
 * NOTE: Some offsets (filter, tuning, attack/decay) are tentative and only
 * applied when values fall within clearly valid ranges. The format varies
 * between MPC firmware versions; these offsets are verified with MPC1000 PGM 1.00.
 */

import type { FilterType } from '../types'

export interface MpcPadMapping {
  index: number
  sampleName: string // primary layer filename without extension
  /** Additional layer sample names (layers 2–4, if present) */
  additionalLayers?: string[]
  /** Velocity ranges for layers [low1, high1, low2, high2, ...] */
  velocityRanges?: number[]
  /** Choke/mute group (0=off, clamped to 1–8 for our app) */
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

// Per-layer block size within the pad record (after the 4×16 name area)
const LAYER_BLOCK_SIZE = 24
// Offsets within each 24-byte layer block:
const LB_VEL_LOW = 2     // 0–127
const LB_VEL_HIGH = 3    // 0–127
// const LB_TUNING_COARSE = 4  // tentative
// const LB_ATTACK = 8     // tentative
// const LB_DECAY = 9      // tentative

// Pad-level offsets (from start of pad record, i.e., absolute within 164-byte record)
const PAD_MUTE_GROUP = 99
const PAD_LEVEL = 143
const PAD_PAN = 144
// const PAD_FILTER_TYPE = 145  // tentative — 0 in all test files
const PAD_PLAY_MODE = 146

function readPadName(data: Uint8Array, offset: number): string {
  let nameEnd = 0
  while (nameEnd < NAME_SIZE && data[offset + nameEnd] !== 0) nameEnd++
  if (nameEnd === 0) return ''
  // Require at least 3 chars for a valid sample name (avoids garbage data)
  if (nameEnd < 3) return ''
  const name = String.fromCharCode(...data.slice(offset, offset + nameEnd))
  // Must be printable ASCII and contain at least one letter
  if (!/^[\x20-\x7e]+$/.test(name)) return ''
  if (!/[a-zA-Z]/.test(name)) return ''
  return name
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
      // Read velocity ranges from layer blocks
      const ranges: number[] = []
      for (let l = 0; l < 4; l++) {
        const lb = offset + 64 + l * LAYER_BLOCK_SIZE
        ranges.push(data[lb + LB_VEL_LOW], data[lb + LB_VEL_HIGH])
      }
      pad.velocityRanges = ranges
    }

    // --- Pad-level settings (verified offsets) ---

    // Mute/choke group
    const muteGroup = data[offset + PAD_MUTE_GROUP]
    if (muteGroup > 0 && muteGroup <= 34) {
      pad.chokeGroup = Math.min(muteGroup, 8)
    }

    // Level (0–100, default 100 = full)
    const level = data[offset + PAD_LEVEL]
    if (level <= 100 && level !== 100) {
      pad.level = level / 100
    }

    // Pan (0–100, 50=center)
    const pan = data[offset + PAD_PAN]
    if (pan <= 100 && pan !== 50) {
      pad.pan = (pan - 50) / 50 // maps 0→-1, 50→0, 100→+1
    }

    // Play mode (0=note-on/ADSR, 1=one-shot)
    const playMode = data[offset + PAD_PLAY_MODE]
    if (playMode === 0) {
      pad.playMode = 'adsr'
    } else if (playMode === 1) {
      pad.playMode = 'one-shot'
    }

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
