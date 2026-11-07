import type { SampleAsset } from '../types'
import { classifyDrumSample, type DrumCategory } from './drumKitMap'

export type PadColorFamily = 'kick' | 'snare' | 'hat' | 'cymbal' | 'tom' | 'perc' | 'other'

/** Colour family per drum category — drives the pad's tint, top stripe and hit glow */
const CATEGORY_COLOR: Record<DrumCategory, PadColorFamily> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'snare',
  snap: 'snare',
  'closed-hat': 'hat',
  'open-hat': 'hat',
  shaker: 'hat',
  crash: 'cymbal',
  ride: 'cymbal',
  'tom-low': 'tom',
  'tom-mid': 'tom',
  'tom-high': 'tom',
  perc: 'perc',
  cowbell: 'perc',
  conga: 'perc',
  other: 'other',
}

/** Classify a sample filename, treating `_`/`-` as word separators ("Kit_Kick.wav" → kick) */
export function classifyPadSample(filename: string): DrumCategory {
  return classifyDrumSample(filename.replace(/[_-]+/g, ' '))
}

export function padColorFamily(filename: string): PadColorFamily {
  return CATEGORY_COLOR[classifyPadSample(filename)]
}

/** Readable pad label: drop the file extension and a shared kit prefix ("TR7x7ISH_Kit_Kick.wav" → "Kick") */
export function padDisplayName(name: string, sample: SampleAsset | undefined): string {
  let label = name.replace(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i, '')
  const prefix = sample?.autosampleRunLabel
  if (prefix && label.length > prefix.length && label.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = label.slice(prefix.length).replace(/^[\s_\-.]+/, '')
    if (rest) label = rest
  }
  return label.replace(/_/g, ' ').trim() || name
}
