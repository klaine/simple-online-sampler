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
 * Map Loopcloud attack/hold time (0–1) to seconds.
 * 0 = instant, 0.5 ≈ 185ms, 1.0 = 4s
 */
function lcdkAttackToSec(value: number): number {
  if (value <= 0) return 0
  return 4 * Math.pow(value, 4.43)
}

/**
 * Map Loopcloud decay/release time (0–1) to seconds.
 * 0 = instant, 0.5 ≈ 225ms, 1.0 = 6s
 */
function lcdkDecayToSec(value: number): number {
  if (value <= 0) return 0
  return 6 * Math.pow(value, 4.74)
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

    // Volume → gain. Muted pads get gain 0.
    if (pad.mute === true || pad.mute === 1) {
      settings.level = 0
    } else if (pad.volume != null && pad.volume < 1) {
      settings.level = Math.max(0, Math.min(1, pad.volume))
    }

    // Pan: 0.5 = center → map to -1..+1
    if (pad.pan != null && pad.pan !== 0.5) {
      settings.pan = Math.max(-1, Math.min(1, (pad.pan - 0.5) * 2))
    }

    // Tuning: coarsetune (0–1, 0.5=center, ±24 semitones) takes priority
    if (pad.coarsetune != null && pad.coarsetune !== 0.5) {
      settings.semitones = Math.round((pad.coarsetune - 0.5) * 48)
    } else if (pad.transposeSemitones != null && pad.transposeSemitones !== 0) {
      settings.semitones = Math.round(pad.transposeSemitones)
    }
    if (pad.finetune != null && pad.finetune !== 0.5) {
      settings.fineCents = Math.round((pad.finetune - 0.5) * 100)
    }

    // Filter: LPHP when both are active, otherwise HP or LP alone
    const hpActive = pad.hpcutoff != null && pad.hpcutoff > 0
    const lpActive = pad.lpcutoff != null && pad.lpcutoff < 1
    if (hpActive && lpActive) {
      settings.filterType = 'lphp' as FilterType
      settings.filterFreq = lcdkHpToHz(pad.hpcutoff)
      settings.filterFreq2 = lcdkLpToHz(pad.lpcutoff)
      settings.filterQ = 0.7
    } else if (hpActive) {
      settings.filterType = 'highpass' as FilterType
      settings.filterFreq = lcdkHpToHz(pad.hpcutoff)
      settings.filterQ = 0.7
    } else if (lpActive) {
      settings.filterType = 'lp12' as FilterType
      settings.filterFreq = lcdkLpToHz(pad.lpcutoff)
      settings.filterQ = 0.7
    }

    // Envelope: AHR mode when hold or release > 0
    const hasAttack = pad.attack != null && pad.attack > 0
    const hasHold = pad.hold != null && pad.hold > 0
    const hasRelease = pad.release != null && pad.release > 0
    if (hasAttack) {
      settings.attack = lcdkAttackToSec(pad.attack)
    }
    if (hasHold || hasRelease) {
      settings.playMode = 'ahr'
      if (hasHold) {
        settings.hold = lcdkAttackToSec(pad.hold)
      }
      if (hasRelease) {
        settings.release = lcdkDecayToSec(pad.release)
      }
    } else {
      settings.playMode = 'one-shot'
    }

    // Choke group: LCDK stores as 0-1 float (0.25=group1, 0.5=group2, etc.)
    if (pad.chokegroup != null && pad.chokegroup > 0) {
      settings.chokeGroup = Math.max(1, Math.min(8, Math.round(pad.chokegroup * 8)))
    }

    const mapping: LcdkPadMapping = {
      index: pad.index ?? pads.length,
      filename: pad.filename,
      settings: Object.keys(settings).length > 1 ? settings : settings, // always include playMode
    }

    // Sample start → trim (only fractional values; 0 and 1 both mean "no trim")
    if (pad.samplestart != null && pad.samplestart > 0 && pad.samplestart < 1) {
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

/** Extract numeric prefix like "evn_13" from "EVN_13_Rhodes_01.wav" for fuzzy matching */
function extractPrefix(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, '')
  const parts = base.split('_')
  if (parts.length >= 2 && /\d/.test(parts[1])) {
    return (parts[0] + '_' + parts[1]).toLowerCase()
  }
  return null
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
    // Exact match first
    let file = fileMap.get(pad.filename.toLowerCase())

    // Fuzzy fallback: match by numeric prefix (e.g. "EVN_13")
    if (!file) {
      const prefix = extractPrefix(pad.filename)
      if (prefix) {
        for (const f of files) {
          if (extractPrefix(f.name) === prefix) {
            file = f
            break
          }
        }
      }
    }

    if (file) {
      result.push({ padIndex: pad.index, file, mapping: pad })
    }
  }

  result.sort((a, b) => a.padIndex - b.padIndex)
  return result
}
