const MTD_MARKER = '/\\ NI FC MTD  /\\'
const TOC_MARKER = '/\\ NI FC TOC  /\\'
const ENTRY_SIZE = 0x280 // 640 bytes per slot
const COUNT_OFFSET = 0x110
const RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46])
const WAVE = new Uint8Array([0x57, 0x41, 0x56, 0x45])

export interface BatteryMonolithEntry {
  index: number
  filename: string
  wavOffset: number
  wavSize: number
}

export interface BatteryMonolithResult {
  /** Kit name derived from first filename */
  label: string
  /** Number of WAV samples extracted */
  sampleCount: number
  /** Extracted sample entries */
  entries: BatteryMonolithEntry[]
}

function readUtf16Le(data: Uint8Array, offset: number, maxLen: number): string {
  const bytes: number[] = []
  for (let i = 0; i < maxLen && offset + i + 1 < data.length; i += 2) {
    const lo = data[offset + i]
    const hi = data[offset + i + 1]
    if (lo === 0 && hi === 0) break
    bytes.push(lo | (hi << 8))
  }
  try {
    return String.fromCharCode(...bytes)
  } catch {
    return ''
  }
}

function findMarker(data: Uint8Array, marker: string, startOffset = 0): number {
  const needle = new TextEncoder().encode(marker)
  outer: for (let i = startOffset; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function isRiffWave(data: Uint8Array, offset: number): boolean {
  if (offset + 12 > data.length) return false
  for (let i = 0; i < 4; i++) if (data[offset + i] !== RIFF[i]) return false
  for (let i = 0; i < 4; i++) if (data[offset + 8 + i] !== WAVE[i]) return false
  return true
}

/**
 * Parse a Battery 4 monolith .nbkt file.
 * Monoliths embed WAV samples directly; patch-only .nbkt files are rejected.
 */
export function parseBatteryMonolith(buffer: ArrayBuffer): BatteryMonolithResult | null {
  const data = new Uint8Array(buffer)
  if (data.length < 0x130) return null

  // Verify MTD marker at offset 0
  if (findMarker(data, MTD_MARKER, 0) !== 0) return null

  // Read entry count from offset 0x110
  const count = new DataView(buffer).getUint32(COUNT_OFFSET, true)
  if (count < 2 || count > 512) return null

  // Find TOC marker
  const tocPos = findMarker(data, TOC_MARKER, 0)
  if (tocPos < 0) return null

  // Sample filenames start at slot 1 (slot 0 is the TOC marker itself)
  const filenameStart = tocPos + ENTRY_SIZE

  const entries: BatteryMonolithEntry[] = []
  for (let i = 1; i < count; i++) {
    const off = filenameStart + (i - 1) * ENTRY_SIZE
    if (off >= data.length) break
    const filename = readUtf16Le(data, off, 256)
    if (!filename || !filename.endsWith('.wav')) continue
    entries.push({ index: entries.length, filename, wavOffset: 0, wavSize: 0 })
  }

  if (entries.length === 0) return null

  // Scan for concatenated WAV files after the filename table
  const tableEnd = tocPos + count * ENTRY_SIZE
  const candidates: number[] = []
  let scan = tableEnd
  while (scan <= data.length - 12) {
    if (data[scan] === 0x52 && isRiffWave(data, scan)) {
      candidates.push(scan)
    }
    scan++
  }

  if (candidates.length === 0) return null

  // Each candidate's actual end is the next candidate's start (or EOF).
  // This handles WAVs whose declared RIFF size is slightly wrong.
  const wavOffsets: number[] = []
  let currentEnd = -1
  for (let i = 0; i < candidates.length; i++) {
    const pos = candidates[i]
    const nextPos = i + 1 < candidates.length ? candidates[i + 1] : data.length
    if (pos < currentEnd) continue // inside previous chunk
    wavOffsets.push(pos)
    currentEnd = nextPos
  }

  if (wavOffsets.length === 0) return null

  // Map entries to WAVs (same order)
  for (let i = 0; i < Math.min(entries.length, wavOffsets.length); i++) {
    const off = wavOffsets[i]
    const nextOff = i + 1 < wavOffsets.length ? wavOffsets[i + 1] : data.length
    const declaredSize = new DataView(buffer).getUint32(off + 4, true)
    const actualSize = Math.min(declaredSize, nextOff - off - 8)
    entries[i].wavOffset = off
    entries[i].wavSize = 8 + actualSize
  }

  // Derive label from first filename
  const firstName = entries[0].filename.replace(/\.wav$/i, '')
  const label = firstName.replace(/\s+V\d+$/, '').replace(/\s+\d+$/, '').trim()

  return { label, sampleCount: entries.length, entries }
}

/**
 * Extract a single WAV sample from the monolith as a Blob.
 */
export function extractWavFromMonolith(
  buffer: ArrayBuffer,
  entry: BatteryMonolithEntry,
): Blob {
  const slice = buffer.slice(entry.wavOffset, entry.wavOffset + entry.wavSize)
  return new Blob([slice], { type: 'audio/wav' })
}

/**
 * Detect velocity-layer groups (V1/V2/V3… suffix) and compute equal-spread ranges.
 * Returns a map: baseName → { entries: BatteryMonolithEntry[], velocityRanges: [low, high][] }
 *
 * Velocity split logic:
 *   2 layers → [0-99, 100-127]  (Battery 4 default)
 *   N>2 layers → equal spread: each gets 128/N range
 */
export function detectVelocityLayers(
  entries: BatteryMonolithEntry[],
): Map<string, { entries: BatteryMonolithEntry[]; velocityRanges: [number, number][] }> {
  // First pass: collect all entries by base name
  const rawGroups = new Map<string, BatteryMonolithEntry[]>()

  for (const entry of entries) {
    const m = entry.filename.match(/^(.+?)\s+V(\d+)\.wav$/i)
    if (m) {
      const base = m[1]
      if (!rawGroups.has(base)) rawGroups.set(base, [])
      rawGroups.get(base)!.push(entry)
    } else {
      const base = entry.filename.replace(/\.wav$/i, '')
      rawGroups.set(base, [entry])
    }
  }

  // Second pass: compute velocity ranges per group
  const groups = new Map<string, { entries: BatteryMonolithEntry[]; velocityRanges: [number, number][] }>()

  for (const [base, groupEntries] of rawGroups) {
    const count = groupEntries.length

    // Sort by V number if velocity layers
    const hasLayers = groupEntries[0].filename.match(/^(.+?)\s+V(\d+)\.wav$/i)
    if (hasLayers && count > 1) {
      groupEntries.sort((a, b) => {
        const na = parseInt(a.filename.match(/V(\d+)\.wav$/i)![1], 10)
        const nb = parseInt(b.filename.match(/V(\d+)\.wav$/i)![1], 10)
        return na - nb
      })
    }

    const ranges: [number, number][] = []

    if (count === 2) {
      // Battery 4 default: V1=0-99, V2=100-127
      ranges.push([0, 99])
      ranges.push([100, 127])
    } else if (count > 2) {
      // Equal spread across 0-127
      const rangeSize = 128 / count
      for (let i = 0; i < count; i++) {
        const low = Math.round(i * rangeSize)
        const high = Math.round((i + 1) * rangeSize) - 1
        ranges.push([low, high])
      }
    } else {
      ranges.push([0, 127])
    }

    groups.set(base, { entries: groupEntries, velocityRanges: ranges })
  }

  return groups
}

/**
 * Suggest a drum category from a Battery sample filename + optional NI tag.
 */
export function classifyBatterySample(filename: string): {
  category: string
  confidence: number
} {
  const lower = filename.toLowerCase()
  // Primary keywords (high confidence)
  if (/\bkick\b/.test(lower)) return { category: 'kick', confidence: 1.0 }
  if (/\bsnare\b/.test(lower)) return { category: 'snare', confidence: 1.0 }
  if (/\bclosedhh\b|\bclosed\b.*\bhat\b/.test(lower)) return { category: 'closed-hat', confidence: 1.0 }
  if (/\bopenhh\b|\bopen\b.*\bhat\b/.test(lower)) return { category: 'open-hat', confidence: 1.0 }
  if (/\bclap\b/.test(lower)) return { category: 'clap', confidence: 1.0 }
  if (/\btom\b/.test(lower)) return { category: 'tom', confidence: 0.9 }
  if (/\bcrash\b/.test(lower)) return { category: 'crash', confidence: 0.9 }
  if (/\bride\b/.test(lower)) return { category: 'ride', confidence: 0.9 }
  if (/\bshaker\b/.test(lower)) return { category: 'shaker', confidence: 0.9 }
  if (/\btamb\b/.test(lower)) return { category: 'tambourine', confidence: 0.8 }
  if (/\bperc\b/.test(lower)) return { category: 'percussion', confidence: 0.7 }
  if (/\bconga\b/.test(lower)) return { category: 'conga', confidence: 0.8 }
  if (/\bvox\b/.test(lower)) return { category: 'vox', confidence: 0.6 }
  if (/\bnoise\b/.test(lower)) return { category: 'noise', confidence: 0.6 }
  if (/\bsfx\b/.test(lower)) return { category: 'sfx', confidence: 0.6 }
  if (/\bsnap\b/.test(lower)) return { category: 'snap', confidence: 0.7 }
  if (/\bsidestick\b/.test(lower)) return { category: 'sidestick', confidence: 0.8 }

  return { category: 'other', confidence: 0.3 }
}
