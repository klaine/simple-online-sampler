import type { TrimSettings } from '../types'

/**
 * Compute leading/trailing silence trim positions as fractional values (0–1).
 *
 * Uses two-pass detection: first finds peak level, then sets threshold relative
 * to peak (peakRelativeDb below peak). This adapts to each sample's dynamics.
 *
 * @param pcm             Mono or first-channel Float32 PCM data
 * @param sampleRate      Sample rate in Hz (used to compute pre-roll)
 * @param thresholdDb     Absolute silence threshold in dBFS (e.g. -60), used as floor
 * @param preRollMs       Pre-roll in ms to preserve before the first loud sample (default 5)
 * @param peakRelativeDb  Threshold relative to peak in dB (default -30, i.e. onset must be within 30dB of peak)
 * @returns               TrimSettings with start/end as fractions 0–1
 */
export function computeSilenceTrim(
  pcm: Float32Array,
  sampleRate: number,
  thresholdDb = -60,
  preRollMs = 5,
  peakRelativeDb = -30,
): TrimSettings {
  const len = pcm.length
  if (len === 0) return { start: 0, end: 1 }

  // Pass 1: find peak level
  let peak = 0
  for (let i = 0; i < len; i++) {
    const abs = Math.abs(pcm[i])
    if (abs > peak) peak = abs
  }

  // If silence, return full range
  const absThreshold = Math.pow(10, thresholdDb / 20)
  if (peak <= absThreshold) return { start: 0, end: 1 }

  // Pass 2: use the higher of absolute threshold and peak-relative threshold
  const peakRelThreshold = peak * Math.pow(10, peakRelativeDb / 20)
  const threshold = Math.max(absThreshold, peakRelThreshold)
  const preRollSamples = Math.round((preRollMs / 1000) * sampleRate)

  // Find first sample above threshold (leading silence trim)
  let firstLoud = 0
  for (let i = 0; i < len; i++) {
    if (Math.abs(pcm[i]) > threshold) {
      firstLoud = i
      break
    }
  }

  // Find last sample above threshold (trailing silence trim)
  let lastLoud = len - 1
  for (let i = len - 1; i >= 0; i--) {
    if (Math.abs(pcm[i]) > threshold) {
      lastLoud = i
      break
    }
  }

  // Apply pre-roll
  const trimStart = Math.max(0, firstLoud - preRollSamples) / len
  const trimEnd = Math.min(len - 1, lastLoud + preRollSamples) / len

  return {
    start: Math.max(0, Math.min(1, trimStart)),
    end: Math.max(trimStart, Math.min(1, trimEnd)),
  }
}

/**
 * Peak-normalize PCM data in-place so the loudest sample reaches targetDb.
 * Returns the gain factor applied (useful for multi-channel: apply same factor).
 */
export function normalizePcm(pcm: Float32Array, targetDb = -0.3): number {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i])
    if (abs > peak) peak = abs
  }
  if (peak === 0) return 1
  const targetLinear = Math.pow(10, targetDb / 20)
  const gain = targetLinear / peak
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain
  return gain
}
