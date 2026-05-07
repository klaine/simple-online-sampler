import type { DrumCategory } from './drumKitMap'

const MTD_MARKER = '/\\ NI FC MTD  /\\'
const TOC_MARKER = '/\\ NI FC TOC  /\\'
const ENTRY_SIZE = 0x280
const COUNT_OFFSET = 0x110
const RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46])
const WAVE = new Uint8Array([0x57, 0x41, 0x56, 0x45])

const DSIN_TAG = 0x4E495344 // "DSIN" LE

export interface BatteryMonolithEntry {
  index: number
  filename: string
  wavOffset: number
  wavSize: number
}

export interface BatteryCellInfo {
  name: string
  categoryCode: number
  hasVelocityLayers: boolean
  padIndex: number
}

export interface BatteryPatchData {
  kitName: string
  cells: BatteryCellInfo[]
  sampleFilenames: string[]
}

export interface BatteryMonolithResult {
  label: string
  sampleCount: number
  entries: BatteryMonolithEntry[]
  patchData?: BatteryPatchData
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

function readU32(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)
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

// --- FastLZ Level 2 decompressor (NI variant) ---

function fastLzDecompress(src: Uint8Array, maxOut = 10 * 1024 * 1024): Uint8Array | null {
  let outLen = Math.min(maxOut, Math.max(src.length * 4, 65536))
  let out = new Uint8Array(outLen)
  let outPos = 0
  let p = 0

  function ensureCapacity(need: number) {
    if (outPos + need <= out.length) return
    const newLen = Math.min(maxOut, Math.max(out.length * 2, outPos + need))
    if (newLen <= out.length || outPos >= maxOut) throw new Error('overflow')
    const newArr = new Uint8Array(newLen)
    newArr.set(out.subarray(0, outPos))
    out = newArr
  }

  try {
    while (p < src.length && outPos < maxOut) {
      const b = src[p++]
      const op = b >>> 5

      if (op === 0) {
        const cnt = (b & 0x1F) + 1
        ensureCapacity(cnt)
        for (let i = 0; i < cnt; i++) out[outPos++] = src[p++]
      } else if (op < 7) {
        const ln = op + 2
        const off = ((b & 0x1F) << 8) + src[p++] + 1
        ensureCapacity(ln)
        for (let i = 0; i < ln; i++) {
          out[outPos] = out[outPos - off]
          outPos++
        }
      } else {
        let ln = b & 0x1F
        if (ln === 31) {
          while (src[p] === 255) { ln += 255; p++ }
          ln += src[p++]
        }
        ln += 9
        const off = (src[p] << 8) + src[p + 1] + 1
        p += 2
        ensureCapacity(ln)
        for (let i = 0; i < ln; i++) {
          out[outPos] = out[outPos - off]
          outPos++
        }
      }
    }
  } catch {
    return null
  }

  return out.subarray(0, outPos)
}

// --- DSIN / hsin / 4KIN container parsing ---

interface DsinContainer {
  offset: number
  type: number
  size: number
  contentOffset: number
}

function readDsin(data: Uint8Array, offset: number): DsinContainer | null {
  if (offset + 12 > data.length) return null
  const tag = readU32(data, offset)
  if (tag !== DSIN_TAG) return null
  const type = readU32(data, offset + 4)
  const size = readU32(data, offset + 8)
  return { offset, type, size, contentOffset: offset + 12 }
}

// --- Trailing patch data parsing ---

function findTrailingDataOffset(data: Uint8Array): number {
  // Scan backwards from end to find last RIFF/WAVE, then compute end of WAV data
  // The trailing patch data starts after the last WAV chunk
  let lastRiff = -1
  for (let i = data.length - 12; i >= 0; i--) {
    if (data[i] === 0x52 && isRiffWave(data, i)) {
      lastRiff = i
      break
    }
  }
  if (lastRiff < 0) return -1

  const riffSize = readU32(data, lastRiff + 4)
  let wavEnd = lastRiff + 8 + riffSize
  // Align to even boundary
  if (wavEnd % 2 !== 0) wavEnd++

  return wavEnd < data.length ? wavEnd : -1
}

function parseTrailingPatch(data: Uint8Array): BatteryPatchData | null {
  const trailOff = findTrailingDataOffset(data)
  if (trailOff < 0) return null

  const trailSize = data.length - trailOff
  if (trailSize < 0xCB) return null // minimum: header + 4KIN(v3) tag

  // Verify trailing data structure: self-size at +0x00, hsin at +0x0C
  const selfSize = readU32(data, trailOff)
  if (selfSize !== trailSize && selfSize !== trailSize - 4) return null

  if (trailOff + 0x0C + 4 > data.length) return null
  const hsinTag = String.fromCharCode(data[trailOff + 0x0C], data[trailOff + 0x0D], data[trailOff + 0x0E], data[trailOff + 0x0F])
  if (hsinTag !== 'hsin') return null

  // Find 4KIN(v3) — main data container
  // Search for "4KIN" in trailing data
  let kin4v3Off = -1
  for (let i = trailOff; i < trailOff + Math.min(trailSize, 0x200); i++) {
    if (data[i] === 0x34 && data[i + 1] === 0x4B && data[i + 2] === 0x49 && data[i + 3] === 0x4E) {
      kin4v3Off = i
      break
    }
  }
  if (kin4v3Off < 0) return null

  // Find all DSIN containers within 4KIN(v3) content
  // The DSIN 't' blob contains all cell data
  // First, find DSIN 't' by scanning from the 4KIN content area

  // Read 4KIN header: "4KIN" + uint32 version + uint32 totalSize
  const kin4Version = readU32(data, kin4v3Off + 4)
  if (kin4Version !== 3) return null
  const kin4TotalSize = readU32(data, kin4v3Off + 8)

  // Scan for DSIN markers within 4KIN content area
  // DSIN 't' is the largest one
  const contentStart = kin4v3Off + 12
  const contentEnd = Math.min(contentStart + kin4TotalSize, data.length)

  let dsinT: DsinContainer | null = null
  let largestDsin = 0

  let scanPos = contentStart
  while (scanPos < contentEnd - 12) {
    const dsin = readDsin(data, scanPos)
    if (!dsin) { scanPos++; continue }
    if (dsin.type === 0x74) { // 't'
      if (dsin.size > largestDsin) {
        largestDsin = dsin.size
        dsinT = dsin
      }
    }
    scanPos += 12 + dsin.size
  }

  let kitName = ''
  const cells: BatteryCellInfo[] = []
  const sampleFilenames: string[] = []

  // Extract kit name by scanning trailing data for the charCount+UTF16LE pattern
  // The kit name appears in the nested DSIN structure, not inside DSIN 'e' content (which is just a marker)
  kitName = extractKitNameFromTrailingData(data, trailOff, trailSize)

  // Try to decompress and parse DSIN 't'
  if (dsinT) {
    const content = data.subarray(dsinT.contentOffset, dsinT.contentOffset + dsinT.size)
    // Compressed data starts at content + 0x71
    if (content.length > 0x71) {
      const compressed = content.subarray(0x71)
      const decompressed = fastLzDecompress(compressed)
      if (decompressed && decompressed.length > 0x200) {
        const parsed = parseDecompressedPatch(decompressed)
        if (parsed) {
          if (!kitName) kitName = parsed.kitName
          cells.push(...parsed.cells)
          sampleFilenames.push(...parsed.sampleFilenames)
        }
      }
    }
  }

  if (cells.length === 0 && sampleFilenames.length === 0 && !kitName) return null

  return { kitName, cells, sampleFilenames }
}

function extractKitNameFromTrailingData(data: Uint8Array, trailOff: number, trailSize: number): string {
  // Search for the kit name pattern: uint32 charCount followed by UTF-16LE text
  // The name appears in the nested DSIN structure between 0x100-0x300 from the start
  const searchStart = trailOff + 0xE0
  const searchEnd = trailOff + Math.min(trailSize, 0x300)

  for (let off = searchStart; off < searchEnd - 8; off++) {
    const charCount = readU32(data, off)
    if (charCount < 2 || charCount > 80) continue
    const nameStart = off + 4
    if (nameStart + charCount * 2 > data.length) continue
    // Read UTF-16LE string (null-terminated, read up to charCount*2 bytes)
    const name = readUtf16Le(data, nameStart, charCount * 2)
    if (!name || name.length < 3) continue
    if (!/^[\x20-\x7E]+$/.test(name)) continue
    if (name === '(null)' || name.includes('Kontakt') || name.includes('Native')) continue
    if (/^\d[\d.]*$/.test(name)) continue
    // Skip very short all-digit or version-like strings
    if (name.length < 3) continue
    return name
  }
  return ''
}

function parseDecompressedPatch(data: Uint8Array): { kitName: string; cells: BatteryCellInfo[]; sampleFilenames: string[] } | null {
  let kitName = ''

  // Search for the instrument name in the header area
  // The name follows a char count field, typically around offset 0x13E
  for (let off = 0x80; off < Math.min(data.length - 8, 0x200); off++) {
    const charCount = readU32(data, off)
    if (charCount < 2 || charCount > 60) continue
    const nameStart = off + 4
    if (nameStart + charCount * 2 > data.length) continue
    const name = readUtf16Le(data, nameStart, charCount * 2)
    if (!name || name.length < 2) continue
    if (!/^[\x20-\x7E]+$/.test(name)) continue
    if (name === '(null)' || name.includes('Kontakt') || name.includes('Native')) continue
    if (/^\d[\d.]*$/.test(name)) continue
    // Verify: name length should be charCount - 1 (null terminator)
    if (name.length === charCount - 1) {
      kitName = name
      break
    }
  }

  // Extract cell blocks by scanning for FFFFFFFF markers
  const cells: BatteryCellInfo[] = []
  let cellIdx = 0
  let pos = 0x100 // skip header and parameter tables

  while (pos < data.length - 12) {
    if (data[pos] !== 0xFF || data[pos + 1] !== 0xFF || data[pos + 2] !== 0xFF || data[pos + 3] !== 0xFF) {
      pos++
      continue
    }

    const byteSize = readU32(data, pos + 4)
    const charCount = readU32(data, pos + 8)

    // Validate: byteSize = charCount(4) + name_bytes(charCount*2), must be reasonable
    const expectedByteSize = 4 + charCount * 2
    if (charCount < 1 || charCount > 80 || byteSize < expectedByteSize || byteSize > expectedByteSize + 16) {
      pos += 4
      continue
    }

    const nameStart = pos + 12
    if (nameStart + charCount * 2 > data.length) {
      pos += 4
      continue
    }

    const name = readUtf16Le(data, nameStart, charCount * 2).replace(/\0/g, '').trim()
    if (!name || name === '(null)') {
      // Still count as a cell slot for padIndex, but skip unnamed
      cellIdx++
      pos += 4 + 4 + byteSize
      continue
    }

    // Content starts after name header: 4(marker) + 4(byteSize) + byteSize
    const contentOff = pos + 4 + 4 + byteSize
    if (contentOff + 3018 > data.length) {
      pos += 4
      continue
    }

    // Read per-cell data at known offsets within content
    const categoryCode = readU32(data, contentOff + 3006)
    const zoneId = readU32(data, contentOff + 584)
    const hasVelocityLayers = (zoneId & 0x100) !== 0

    cells.push({
      name,
      categoryCode,
      hasVelocityLayers,
      padIndex: cellIdx,
    })

    cellIdx++
    // Advance past this cell block: header + content
    // Content is ~3743 bytes but can vary; advance by header and scan for next marker
    pos += 4 + 4 + byteSize
  }

  // Extract sample filename table from the last portion of the data
  const sampleFilenames: string[] = []
  // The filename table uses fixed-width slots with prefix 01 00 00 00 04
  // Search backwards from end for .wav filenames
  const searchStart = Math.max(0, data.length - 0x20000)
  let tablePos = searchStart
  const seenNames = new Set<string>()

  while (tablePos < data.length - 10) {
    if (data[tablePos] !== 0x01 || data[tablePos + 1] !== 0x00 || data[tablePos + 2] !== 0x00 || data[tablePos + 3] !== 0x00) {
      tablePos++
      continue
    }
    if (data[tablePos + 4] !== 0x04) {
      tablePos++
      continue
    }

    const charCount = readU32(data, tablePos + 5)
    if (charCount < 3 || charCount > 120) {
      tablePos++
      continue
    }

    const nameOff = tablePos + 9
    if (nameOff + charCount * 2 > data.length) {
      tablePos++
      continue
    }

    const fname = readUtf16Le(data, nameOff, charCount * 2).replace(/\0/g, '').trim()
    if (!fname || fname.length < 3) {
      tablePos++
      continue
    }

    const lower = fname.toLowerCase()
    if ((lower.endsWith('.wav') || lower.endsWith('.nbkt')) && !seenNames.has(fname)) {
      seenNames.add(fname)
      sampleFilenames.push(fname)
      // Advance past this entry: conservative jump
      tablePos += 9 + charCount * 2
    } else {
      tablePos++
    }
  }

  if (cells.length === 0 && !kitName && sampleFilenames.length === 0) return null
  return { kitName, cells, sampleFilenames }
}

// --- NI Battery category code mapping ---

const BATTERY_CATEGORY_MAP: Record<number, { category: DrumCategory; chokeGroup: number }> = {
  0:  { category: 'other', chokeGroup: 0 },
  16: { category: 'other', chokeGroup: 0 },    // header/base zone only
  17: { category: 'kick', chokeGroup: 0 },      // kick, sidestick, lowtom, shaker
  19: { category: 'clap', chokeGroup: 2 },      // clap, tambourine
  23: { category: 'closed-hat', chokeGroup: 1 }, // closed-hat, open-hat
  24: { category: 'tom-mid', chokeGroup: 0 },   // hitom, ride
  31: { category: 'snare', chokeGroup: 3 },
}

function categoryCodeToDrumCategory(code: number, cellName: string): { category: DrumCategory; chokeGroup: number } {
  const mapped = BATTERY_CATEGORY_MAP[code]
  if (mapped) {
    // Refine ambiguous category codes using cell name
    if (code === 17) {
      const lower = cellName.toLowerCase()
      if (/\bsnare\b|\bsidestick\b/i.test(lower)) return { category: 'perc', chokeGroup: 0 }
      if (/\btom\b/i.test(lower)) {
        if (/\blow\b|\bfl?o/i.test(lower)) return { category: 'tom-low', chokeGroup: 0 }
        if (/\bhi/i.test(lower)) return { category: 'tom-high', chokeGroup: 0 }
        return { category: 'tom-mid', chokeGroup: 0 }
      }
      if (/\bshaker\b/i.test(lower)) return { category: 'shaker', chokeGroup: 0 }
      return { category: 'kick', chokeGroup: 0 }
    }
    if (code === 19) {
      if (/\btamb/i.test(cellName)) return { category: 'shaker', chokeGroup: 0 }
      return { category: 'clap', chokeGroup: mapped.chokeGroup }
    }
    if (code === 23) {
      if (/\bopen/i.test(cellName)) return { category: 'open-hat', chokeGroup: mapped.chokeGroup }
      return { category: 'closed-hat', chokeGroup: mapped.chokeGroup }
    }
    if (code === 24) {
      if (/\bride\b/i.test(cellName)) return { category: 'ride', chokeGroup: mapped.chokeGroup }
      if (/\bhi/i.test(cellName)) return { category: 'tom-high', chokeGroup: 0 }
      return { category: 'tom-mid', chokeGroup: mapped.chokeGroup }
    }
    if (code === 0 || code === 16) {
      // Fall through to name-based classification
    } else {
      return mapped
    }
  }

  // Fallback: classify by cell name
  return classifyByCellName(cellName)
}

function classifyByCellName(name: string): { category: DrumCategory; chokeGroup: number } {
  const lower = name.toLowerCase()
  if (/\bkick\b/i.test(lower)) return { category: 'kick', chokeGroup: 0 }
  if (/\bsnare\b/i.test(lower)) return { category: 'snare', chokeGroup: 3 }
  if (/\bclap\b/i.test(lower)) return { category: 'clap', chokeGroup: 2 }
  if (/\bclosed/i.test(lower) && /\bhh?\b/i.test(lower)) return { category: 'closed-hat', chokeGroup: 1 }
  if (/\bopen/i.test(lower) && /\bhh?\b/i.test(lower)) return { category: 'open-hat', chokeGroup: 1 }
  if (/\bcrash\b/i.test(lower)) return { category: 'crash', chokeGroup: 0 }
  if (/\bride\b/i.test(lower)) return { category: 'ride', chokeGroup: 0 }
  if (/\btom\b/i.test(lower)) {
    if (/\blow\b|\bfl?o/i.test(lower)) return { category: 'tom-low', chokeGroup: 0 }
    if (/\bhi/i.test(lower)) return { category: 'tom-high', chokeGroup: 0 }
    return { category: 'tom-mid', chokeGroup: 0 }
  }
  if (/\bshaker\b/i.test(lower)) return { category: 'shaker', chokeGroup: 0 }
  if (/\btamb/i.test(lower)) return { category: 'shaker', chokeGroup: 0 }
  if (/\bsidestick\b/i.test(lower)) return { category: 'perc', chokeGroup: 0 }
  if (/\bperc\b/i.test(lower)) return { category: 'perc', chokeGroup: 0 }
  if (/\bbd\b/i.test(lower)) return { category: 'kick', chokeGroup: 0 }
  if (/\bhh\b/i.test(lower) && !/\bopen\b/i.test(lower)) return { category: 'closed-hat', chokeGroup: 1 }
  if (/\bhh\b/i.test(lower)) return { category: 'open-hat', chokeGroup: 1 }
  return { category: 'other', chokeGroup: 0 }
}

// --- Main parser ---

export function parseBatteryMonolith(buffer: ArrayBuffer): BatteryMonolithResult | null {
  const data = new Uint8Array(buffer)
  if (data.length < 0x130) return null

  if (findMarker(data, MTD_MARKER, 0) !== 0) return null

  const count = new DataView(buffer).getUint32(COUNT_OFFSET, true)
  if (count < 2 || count > 512) return null

  const tocPos = findMarker(data, TOC_MARKER, 0)
  if (tocPos < 0) return null

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

  const wavOffsets: number[] = []
  let currentEnd = -1
  for (let i = 0; i < candidates.length; i++) {
    const pos = candidates[i]
    const nextPos = i + 1 < candidates.length ? candidates[i + 1] : data.length
    if (pos < currentEnd) continue
    wavOffsets.push(pos)
    currentEnd = nextPos
  }

  if (wavOffsets.length === 0) return null

  for (let i = 0; i < Math.min(entries.length, wavOffsets.length); i++) {
    const off = wavOffsets[i]
    const nextOff = i + 1 < wavOffsets.length ? wavOffsets[i + 1] : data.length
    const declaredSize = new DataView(buffer).getUint32(off + 4, true)
    const actualSize = Math.min(declaredSize, nextOff - off - 8)
    entries[i].wavOffset = off
    entries[i].wavSize = 8 + actualSize
  }

  const firstName = entries[0].filename.replace(/\.wav$/i, '')
  const label = firstName.replace(/\s+V\d+$/, '').replace(/\s+\d+$/, '').trim()

  // Try to parse trailing patch data for cell info and kit name
  let patchData: BatteryPatchData | undefined
  try {
    const patch = parseTrailingPatch(data)
    if (patch) patchData = patch
  } catch {
    // Factory kits are encrypted; ignore patch parsing failures gracefully
  }

  return {
    label: patchData?.kitName || label,
    sampleCount: entries.length,
    entries,
    patchData,
  }
}

export function extractWavFromMonolith(
  buffer: ArrayBuffer,
  entry: BatteryMonolithEntry,
): Blob {
  const slice = buffer.slice(entry.wavOffset, entry.wavOffset + entry.wavSize)
  return new Blob([slice], { type: 'audio/wav' })
}

export function detectVelocityLayers(
  entries: BatteryMonolithEntry[],
  patchData?: BatteryPatchData,
): Map<string, { entries: BatteryMonolithEntry[]; velocityRanges: [number, number][]; hasVelocityLayers?: boolean }> {
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

  const groups = new Map<string, { entries: BatteryMonolithEntry[]; velocityRanges: [number, number][]; hasVelocityLayers?: boolean }>()

  // Build cell name → info map from patch data
  const cellInfoMap = new Map<string, BatteryCellInfo>()
  if (patchData) {
    for (const cell of patchData.cells) {
      cellInfoMap.set(cell.name, cell)
    }
  }

  for (const [base, groupEntries] of rawGroups) {
    const count = groupEntries.length
    const hasLayers = groupEntries[0].filename.match(/^(.+?)\s+V(\d+)\.wav$/i)

    if (hasLayers && count > 1) {
      groupEntries.sort((a, b) => {
        const na = parseInt(a.filename.match(/V(\d+)\.wav$/i)![1], 10)
        const nb = parseInt(b.filename.match(/V(\d+)\.wav$/i)![1], 10)
        return na - nb
      })
    }

    const ranges: [number, number][] = []
    let cellHasVelocityLayers: boolean | undefined

    // Check if patch data confirms velocity layers for this cell
    if (patchData) {
      const cell = cellInfoMap.get(base)
      if (cell) {
        cellHasVelocityLayers = cell.hasVelocityLayers
      }
    }

    if (count === 2) {
      ranges.push([0, 99])
      ranges.push([100, 127])
    } else if (count > 2) {
      const rangeSize = 128 / count
      for (let i = 0; i < count; i++) {
        const low = Math.round(i * rangeSize)
        const high = Math.round((i + 1) * rangeSize) - 1
        ranges.push([low, high])
      }
    } else {
      ranges.push([0, 127])
    }

    groups.set(base, { entries: groupEntries, velocityRanges: ranges, hasVelocityLayers: cellHasVelocityLayers })
  }

  return groups
}

export function matchCellsToSamples(
  entries: BatteryMonolithEntry[],
  patchData: BatteryPatchData,
): Map<string, string[]> {
  // Maps each cell name to ALL matching sample filenames (including velocity layers)
  // e.g. cell "ClosedHH DMX" → ["ClosedHH DMX V1.wav", "ClosedHH DMX V2.wav"]
  const cellToFilenames = new Map<string, string[]>()

  for (const cell of patchData.cells) {
    if (!cell.name || cell.name === '(null)') continue
    const matches: string[] = []
    for (const entry of entries) {
      const entryBase = entry.filename.replace(/\.wav$/i, '')
      // Strip velocity suffix for comparison
      const veloMatch = entryBase.match(/^(.+?)\s+V\d+$/)
      const entryBaseNoVelo = veloMatch ? veloMatch[1] : entryBase
      if (cell.name === entryBaseNoVelo) {
        matches.push(entry.filename)
      }
    }
    if (matches.length > 0) {
      cellToFilenames.set(cell.name, matches)
    }
  }

  return cellToFilenames
}

export function getChokeGroupForCell(cell: BatteryCellInfo): number {
  return categoryCodeToDrumCategory(cell.categoryCode, cell.name).chokeGroup
}

export function getCategoryForCell(cell: BatteryCellInfo): DrumCategory {
  return categoryCodeToDrumCategory(cell.categoryCode, cell.name).category
}

export function parseWavListChunks(buffer: ArrayBuffer): Record<string, string> {
  const data = new Uint8Array(buffer)
  const tags: Record<string, string> = {}
  if (data.length < 36) return tags

  const view = new DataView(buffer)
  let offset = 12
  const end = data.length

  while (offset + 8 <= end) {
    const chunkId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    const chunkSize = view.getUint32(offset + 4, true)
    if (chunkId === 'LIST') {
      const listType = String.fromCharCode(data[offset + 8], data[offset + 9], data[offset + 10], data[offset + 11])
      if (listType === 'INFO') {
        let infoOff = offset + 12
        const infoEnd = offset + 8 + chunkSize
        while (infoOff + 8 <= infoEnd) {
          const tagId = String.fromCharCode(data[infoOff], data[infoOff + 1], data[infoOff + 2], data[infoOff + 3])
          const tagSize = view.getUint32(infoOff + 4, true)
          if (tagSize > 0 && infoOff + 8 + tagSize <= infoEnd) {
            const raw = new Uint8Array(buffer, infoOff + 8, tagSize)
            let len = tagSize
            while (len > 0 && raw[len - 1] === 0) len--
            try {
              const value = new TextDecoder('utf-8').decode(raw.subarray(0, len))
              if (value) tags[tagId] = value
            } catch { /* ignore decode errors */ }
          }
          infoOff += 8 + tagSize + (tagSize % 2)
        }
      }
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }

  return tags
}

export function classifyBatterySample(filename: string): {
  category: string
  confidence: number
} {
  const result = classifyByCellName(filename)
  return { category: result.category, confidence: result.chokeGroup > 0 ? 0.9 : 0.5 }
}