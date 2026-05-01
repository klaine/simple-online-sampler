/**
 * Drum category classifier and standard 16-pad layout mapper.
 *
 * Standard MPC-style layout (bottom row = pads 1-4, top row = pads 13-16):
 *   Pad 1: Kick
 *   Pad 2: Snare
 *   Pad 3: Clap
 *   Pad 4: Closed Hi-Hat
 *   Pad 5: Open Hi-Hat
 *   Pad 6: Perc / Rimshot
 *   Pad 7: Tom Low
 *   Pad 8: Tom Mid
 *   Pad 9: Tom High
 *   Pad 10: Crash
 *   Pad 11: Ride
 *   Pad 12: Shaker / Tambourine
 *   Pad 13: Cowbell
 *   Pad 14: Conga / Bongo
 *   Pad 15: Snap / FX
 *   Pad 16: Other
 */

export type DrumCategory =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'closed-hat'
  | 'open-hat'
  | 'perc'
  | 'tom-low'
  | 'tom-mid'
  | 'tom-high'
  | 'crash'
  | 'ride'
  | 'shaker'
  | 'cowbell'
  | 'conga'
  | 'snap'
  | 'other'

/** Ordered pad slots — index 0 = pad position 0 (bottom-left), etc. */
const SLOT_ORDER: DrumCategory[] = [
  'kick',
  'snare',
  'clap',
  'closed-hat',
  'open-hat',
  'perc',
  'tom-low',
  'tom-mid',
  'tom-high',
  'crash',
  'ride',
  'shaker',
  'cowbell',
  'conga',
  'snap',
  'other',
]

interface CategoryPattern {
  category: DrumCategory
  patterns: RegExp[]
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  { category: 'kick', patterns: [/\bkick\b/i, /\bkik\b/i, /\bbd\b/i, /\bbass\s*drum\b/i, /\b808\b.*\bkick\b/i] },
  { category: 'snare', patterns: [/\bsnare\b/i, /\bsnr\b/i, /\bsd\b/i] },
  { category: 'clap', patterns: [/\bclap\b/i, /\bclp\b/i, /\bcp\b/i] },
  { category: 'closed-hat', patterns: [/\bclosed\s*h/i, /\bch\b/i, /\bchi?hat\b/i, /\bhh\b/i, /\bhi[\s-]?hat\b/i] },
  { category: 'open-hat', patterns: [/\bopen\s*h/i, /\boh\b/i, /\bopen[\s-]?hat\b/i] },
  { category: 'crash', patterns: [/\bcrash\b/i, /\bcym\b/i] },
  { category: 'ride', patterns: [/\bride\b/i] },
  { category: 'cowbell', patterns: [/\bcowb/i, /\bcow\s*bell\b/i] },
  { category: 'conga', patterns: [/\bconga\b/i, /\bbongo\b/i] },
  { category: 'shaker', patterns: [/\bshaker\b/i, /\btamb/i, /\bmarac/i] },
  { category: 'snap', patterns: [/\bsnap\b/i, /\bfx\b/i, /\beffect\b/i] },
  { category: 'perc', patterns: [/\bperc\b/i, /\brim\b/i, /\brimshot\b/i, /\bwood\s*block\b/i, /\bblock\b/i, /\bclave\b/i, /\bguiro\b/i, /\btriangle\b/i, /\bbell\b/i] },
  { category: 'tom-low', patterns: [/\btom\b.*\blow\b/i, /\blo\s*tom\b/i, /\bfloor\s*tom\b/i] },
  { category: 'tom-high', patterns: [/\btom\b.*\bhi(gh)?\b/i, /\bhi\s*tom\b/i] },
  { category: 'tom-mid', patterns: [/\btom\b/i] }, // generic tom fallback = mid
]

/** Classify a filename into a drum category. */
export function classifyDrumSample(filename: string): DrumCategory {
  const name = filename.replace(/\.[^.]+$/, '') // strip extension
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    for (const pat of patterns) {
      if (pat.test(name)) return category
    }
  }
  return 'other'
}

/** Returns true if a reasonable proportion of files match known drum categories. */
export function looksLikeDrumKit(filenames: string[]): boolean {
  if (filenames.length < 3) return false
  let recognized = 0
  for (const f of filenames) {
    if (classifyDrumSample(f) !== 'other') recognized++
  }
  return recognized / filenames.length >= 0.4
}

export interface KitMappingResult {
  /** Ordered array of files mapped to pad positions 0–15. null = empty slot. */
  slots: (string | null)[]
  /** Files that didn't fit in 16 pads. */
  overflow: string[]
}

/**
 * Map filenames to a standard 16-pad layout.
 * Multiple files of the same category fill adjacent empty slots after their primary slot.
 */
export function mapToStandardKit(filenames: string[]): KitMappingResult {
  const slots: (string | null)[] = Array(16).fill(null)
  const overflow: string[] = []

  // Group files by category
  const groups = new Map<DrumCategory, string[]>()
  for (const f of filenames) {
    const cat = classifyDrumSample(f)
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(f)
  }

  // Assign each category's files starting at its primary slot
  for (const cat of SLOT_ORDER) {
    const files = groups.get(cat)
    if (!files || files.length === 0) continue

    const primaryIdx = SLOT_ORDER.indexOf(cat)

    // Place first file at primary slot if available
    let placed = 0
    if (slots[primaryIdx] === null) {
      slots[primaryIdx] = files[placed++]
    }

    // Place remaining files in next available slots
    for (; placed < files.length; placed++) {
      const emptyIdx = slots.indexOf(null)
      if (emptyIdx >= 0) {
        slots[emptyIdx] = files[placed]
      } else {
        overflow.push(files[placed])
      }
    }
  }

  return { slots, overflow }
}
