import type { FilterType, ImportedPadSettings } from '../types'

export interface LcdkPadMapping {
  index: number
  filename: string
  settings: ImportedPadSettings
  trimStart?: number
}

export interface LcdkPatternStep {
  padIndex: number
  step: number
  velocity: number
}

export interface LcdkPattern {
  index: number
  steps: LcdkPatternStep[]
}

export interface LcdkResult {
  label: string
  pads: LcdkPadMapping[]
  patterns: LcdkPattern[]
}

/**
 * LCDK stores HP cutoff as 0–1 float (0=off, 1=20kHz).
 * Exponential mapping approximating the UI range.
 */
function lcdkHpToHz(value: number): number {
  if (value <= 0) return 20
  return 20 * Math.pow(1000, value)
}

/**
 * LCDK stores LP cutoff as 0–1 float (0=20kHz, 1=off).
 */
function lcdkLpToHz(value: number): number {
  if (value >= 1) return 20000
  return 20000 * Math.pow(0.001, value)
}

/**
 * LCDK stores attack as 0–1 float.
 * 0 = instant, 0.5 ≈ 10ms, 1.0 ≈ 5s
 */
function lcdkAttackToSec(value: number): number {
  if (value <= 0) return 0
  return 5 * Math.pow(value, 3.5)
}

/**
 * LCDK stores decay / release as 0–1 float.
 * 0 = instant, 0.5 ≈ 250ms, 0.778 ≈ 2s, 1.0 = 6s
 */
function lcdkDecayToSec(value: number): number {
  if (value <= 0) return 0
  return 6 * Math.pow(value, 4.56)
}

export function parseLcdk(jsonString: string, filename: string): LcdkResult | null {
  let data: unknown
  try {
    data = JSON.parse(jsonString)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>
  if (!obj.pads || !Array.isArray(obj.pads)) return null

  const label = (obj.kitName as string | undefined) || filename.replace(/\.lcdk$/i, '')
  const pads: LcdkPadMapping[] = []

  for (const rawPad of obj.pads as unknown[]) {
    const pad = rawPad as Record<string, unknown>
    if (!pad.filename) continue

    const settings: ImportedPadSettings = {}

    // Volume → gain. Muted pads are flagged; volume < 1 maps to gain.
    if (pad.mute === true || pad.mute === 1) {
      settings.mute = true
    } else if (pad.volume != null && (pad.volume as number) < 1) {
      settings.level = Math.max(0, Math.min(1, pad.volume as number))
    }

    // Pan: 0.5 = center → map to -1..+1
    if (pad.pan != null && pad.pan !== 0.5) {
      settings.pan = Math.max(-1, Math.min(1, ((pad.pan as number) - 0.5) * 2))
    }

    // Tuning: coarsetune (0–1, 0.5=center, ±24 semitones) takes priority
    if (pad.coarsetune != null && pad.coarsetune !== 0.5) {
      settings.semitones = Math.round(((pad.coarsetune as number) - 0.5) * 48)
    } else if (pad.transposeSemitones != null && pad.transposeSemitones !== 0) {
      settings.semitones = Math.round(pad.transposeSemitones as number)
    }
    if (pad.finetune != null && pad.finetune !== 0.5) {
      settings.fineCents = Math.round(((pad.finetune as number) - 0.5) * 100)
    }

    // Filter: LPHP when both are active, otherwise HP or LP alone
    const hpActive = pad.hpcutoff != null && (pad.hpcutoff as number) > 0
    const lpActive = pad.lpcutoff != null && (pad.lpcutoff as number) < 1
    if (hpActive && lpActive) {
      settings.filterType = 'lphp' as FilterType
      settings.filterFreq = lcdkHpToHz(pad.hpcutoff as number)
      settings.filterFreq2 = lcdkLpToHz(pad.lpcutoff as number)
      settings.filterQ = 0.7
    } else if (hpActive) {
      settings.filterType = 'highpass' as FilterType
      settings.filterFreq = lcdkHpToHz(pad.hpcutoff as number)
      settings.filterQ = 0.7
    } else if (lpActive) {
      settings.filterType = 'lp12' as FilterType
      settings.filterFreq = lcdkLpToHz(pad.lpcutoff as number)
      settings.filterQ = 0.7
    }

    // Envelope: AHR mode when hold or release > 0
    const hasAttack = pad.attack != null && (pad.attack as number) > 0
    const hasHold = pad.hold != null && (pad.hold as number) > 0
    const hasRelease = pad.release != null && (pad.release as number) > 0
    if (hasAttack) {
      settings.attack = lcdkAttackToSec(pad.attack as number)
    }
    if (hasHold || hasRelease) {
      settings.playMode = 'ahr'
      if (hasHold) {
        settings.hold = lcdkAttackToSec(pad.hold as number)
      }
      if (hasRelease) {
        settings.release = lcdkDecayToSec(pad.release as number)
      }
    } else {
      settings.playMode = 'one-shot'
    }

    // Choke group: LCDK stores as 0-1 float (0.25=group1, 0.5=group2, etc.)
    if (pad.chokegroup != null && (pad.chokegroup as number) > 0) {
      settings.chokeGroup = Math.max(1, Math.min(8, Math.round((pad.chokegroup as number) * 8)))
    }

    const mapping: LcdkPadMapping = {
      index: (pad.index as number | undefined) ?? pads.length,
      filename: pad.filename as string,
      settings: Object.keys(settings).length > 1 ? settings : settings, // always include playMode
    }

    // Sample start → trim (only fractional values; 0 and 1 both mean "no trim")
    if (pad.samplestart != null && (pad.samplestart as number) > 0 && (pad.samplestart as number) < 1) {
      mapping.trimStart = pad.samplestart as number
    }

    pads.push(mapping)
  }

  // Parse sequencer patterns
  const patterns: LcdkPattern[] = []
  const sequencer = obj.sequencer as Record<string, unknown> | undefined
  const seqPatterns = sequencer?.patterns as unknown[] | undefined
  if (Array.isArray(seqPatterns)) {
    for (let patIdx = 0; patIdx < seqPatterns.length; patIdx++) {
      const pat = seqPatterns[patIdx] as Record<string, unknown>
      if (!pat.pattern_Note || !pat.pattern_Vel) continue

      const steps: LcdkPatternStep[] = []
      // Layout: 16 pads × 17 slots = 272 (stride 17, slot 16 is unused separator per pad)
      for (let padIdx = 0; padIdx < 16; padIdx++) {
        const offset = padIdx * 17
        const noteArr = pat.pattern_Note as number[]
        const velArr = pat.pattern_Vel as number[]
        for (let step = 0; step < 16; step++) {
          const noteVal = noteArr[offset + step]
          if (noteVal > 0) {
            const velVal = velArr[offset + step]
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
