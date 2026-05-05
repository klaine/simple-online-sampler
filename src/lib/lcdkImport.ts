/**
 * Loopcloud Drum (.lcdk) kit file parser
 *
 * Format: JSON file containing pad definitions (up to 16 pads) with per-pad
 * parameters (volume, pan, filter, envelope, choke group, tuning) plus
 * sequencer patterns (8 patterns × 16 pads × 16 steps).
 *
 * Each kit has a sibling folder (same name minus .lcdk extension) containing
 * the referenced WAV files.
 */

import type { FilterType, ImportedPadSettings } from '../types'

export interface LcdkPadMapping {
  index: number
  filename: string       // WAV filename (without path)
  settings: ImportedPadSettings
  trimStart?: number     // fractional sample start (0–1)
}

export interface LcdkPatternStep {
  padIndex: number       // 0–15
  step: number           // 0–15
  velocity: number       // 1–127 (MIDI velocity)
}

export interface LcdkPattern {
  index: number          // pattern index (0–7)
  steps: LcdkPatternStep[]
}

export interface LcdkResult {
  label: string          // kit name
  pads: LcdkPadMapping[]
  patterns: LcdkPattern[]
}

/**
 * Map Loopcloud HP cutoff (0–1) to Hz.
 * 0 = off (20Hz), 1 = fully open (20kHz)
 */
function lcdkHpToHz(value: number): number {
  return 20 * Math.pow(1000, value)
}

/**
 * Map Loopcloud LP cutoff (0–1) to Hz.
 * 0 = fully closed (20Hz), 1 = fully open/off (20kHz)
 */
function lcdkLpToHz(value: number): number {
  return 20 * Math.pow(1000, value)
}

/**
 * Map Loopcloud envelope time (0–1) to seconds.
 * 0 = instant, 1 = max (~5s)
 */
function lcdkEnvToSec(value: number): number {
  if (value <= 0) return 0
  return 5 * Math.pow(value, 2) // quadratic for musical feel
}

export function parseLcdk(jsonString: string, filename: string): LcdkResult | null {
  let data: any
  try {
    data = JSON.parse(jsonString)
  } catch {
    return null
  }

  if (!data.pads || !Array.isArray(data.pads)) return null

  const label = data.kitName || filename.replace(/\.lcdk$/i, '')
  const pads: LcdkPadMapping[] = []

  for (const pad of data.pads) {
    if (!pad.filename) continue

    const settings: ImportedPadSettings = {}

    // Volume → gain (direct 0–1)
    if (pad.volume != null && pad.volume < 1) {
      settings.level = Math.max(0, Math.min(1, pad.volume))
    }

    // Pan: 0.5 = center → map to -1..+1
    if (pad.pan != null && pad.pan !== 0.5) {
      settings.pan = Math.max(-1, Math.min(1, (pad.pan - 0.5) * 2))
    }

    // Tuning
    if (pad.transposeSemitones != null && pad.transposeSemitones !== 0) {
      settings.semitones = Math.round(pad.transposeSemitones)
    }
    if (pad.finetune != null && pad.finetune !== 0.5) {
      settings.fineCents = Math.round((pad.finetune - 0.5) * 100)
    }

    // Filter: HP takes priority over LP when both are active
    const hpActive = pad.hpcutoff != null && pad.hpcutoff > 0
    const lpActive = pad.lpcutoff != null && pad.lpcutoff < 1
    if (hpActive) {
      settings.filterType = 'highpass' as FilterType
      settings.filterFreq = lcdkHpToHz(pad.hpcutoff)
      settings.filterQ = 0.7 // default Q
    } else if (lpActive) {
      settings.filterType = 'lp12' as FilterType
      settings.filterFreq = lcdkLpToHz(pad.lpcutoff)
      settings.filterQ = 0.7
    }

    // Envelope
    if (pad.attack != null && pad.attack > 0) {
      settings.attack = lcdkEnvToSec(pad.attack)
    }
    // LCDK has 'release' but our ImportedPadSettings has 'decay' — map release to decay
    // since LCDK pads are one-shot drum samples, release = tail behavior
    // Actually, let's not map release as decay — it's a different concept.
    // We'll leave release unmapped for now since our one-shot mode ignores decay.

    // Choke group
    if (pad.chokegroup != null && pad.chokegroup > 0) {
      settings.chokeGroup = Math.min(pad.chokegroup, 8)
    }

    // Play mode: LCDK is always one-shot for drum pads
    settings.playMode = 'one-shot'

    const mapping: LcdkPadMapping = {
      index: pad.index ?? pads.length,
      filename: pad.filename,
      settings: Object.keys(settings).length > 1 ? settings : settings, // always include playMode
    }

    // Sample start → trim
    if (pad.samplestart != null && pad.samplestart > 0) {
      mapping.trimStart = pad.samplestart
    }

    pads.push(mapping)
  }

  // Parse sequencer patterns
  const patterns: LcdkPattern[] = []
  const seqPatterns = data.sequencer?.patterns
  if (Array.isArray(seqPatterns)) {
    for (let patIdx = 0; patIdx < seqPatterns.length; patIdx++) {
      const pat = seqPatterns[patIdx]
      if (!pat.pattern_Note || !pat.pattern_Vel) continue

      const steps: LcdkPatternStep[] = []
      // Layout: 16 pads × 17 slots = 272 (stride 17, slot 16 is unused separator per pad)
      for (let padIdx = 0; padIdx < 16; padIdx++) {
        const offset = padIdx * 17
        for (let step = 0; step < 16; step++) {
          const noteVal = pat.pattern_Note[offset + step]
          if (noteVal > 0) {
            const velVal = pat.pattern_Vel[offset + step]
            steps.push({
              padIndex: padIdx,
              step,
              velocity: Math.max(1, Math.min(127, velVal || noteVal)),
            })
          }
        }
      }

      if (steps.length > 0) {
        patterns.push({ index: patIdx, steps })
      }
    }
  }

  return { label, pads, patterns }
}

/**
 * Match LCDK pad filenames to available Files.
 * Returns matched pads in order.
 */
export interface LcdkMatchedPad {
  padIndex: number
  file: File
  mapping: LcdkPadMapping
}

export function matchLcdkSamplesToFiles(
  pads: LcdkPadMapping[],
  files: File[],
): LcdkMatchedPad[] {
  // Build lookup: lowercase filename → File
  const fileMap = new Map<string, File>()
  for (const f of files) {
    fileMap.set(f.name.toLowerCase(), f)
  }

  const result: LcdkMatchedPad[] = []
  for (const pad of pads) {
    const file = fileMap.get(pad.filename.toLowerCase())
    if (file) {
      result.push({ padIndex: pad.index, file, mapping: pad })
    }
  }

  result.sort((a, b) => a.padIndex - b.padIndex)
  return result
}
