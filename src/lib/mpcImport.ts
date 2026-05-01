/**
 * MPC1000/MPC2500 .pgm file parser
 *
 * Binary format (MPC1000 PGM 1.00):
 *   Header: 24 bytes (4 magic + 16 identifier + 4 padding)
 *   64 pad records × 164 bytes each
 *     - bytes 0–15: layer 1 sample name (null-padded, no .wav extension)
 *     - bytes 16–163: layer params, pad params (velocity, level, tuning, etc.)
 *   Footer: ~236 bytes (MIDI note map, etc.)
 */

export interface MpcPadMapping {
  index: number
  sampleName: string // filename without extension
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
    if (offset + NAME_SIZE > data.length) break

    // Read 16-byte null-padded sample name
    let nameEnd = 0
    while (nameEnd < NAME_SIZE && data[offset + nameEnd] !== 0) nameEnd++
    if (nameEnd === 0) continue // empty pad

    const name = String.fromCharCode(...data.slice(offset, offset + nameEnd))
    // Sanity check: name should be printable ASCII
    if (!/^[\x20-\x7e]+$/.test(name)) continue

    pads.push({ index: i, sampleName: name })
  }

  // Derive label from .pgm filename (strip extension)
  const label = filename.replace(/\.pgm$/i, '')

  return { label, pads }
}

/**
 * Given a parsed MPC pad mapping and a list of available audio Files,
 * returns files matched to pad indices in pad order.
 * Matching is case-insensitive, tries name with and without .wav extension.
 */
export function matchMpcSamplesToFiles(
  pads: MpcPadMapping[],
  files: File[],
): { padIndex: number; file: File }[] {
  // Build lookup: lowercase name (no extension) -> File
  const fileMap = new Map<string, File>()
  for (const f of files) {
    const key = f.name.replace(/\.[^.]+$/, '').toLowerCase()
    fileMap.set(key, f)
  }

  const result: { padIndex: number; file: File }[] = []
  for (const pad of pads) {
    const key = pad.sampleName.toLowerCase()
    const file = fileMap.get(key)
    if (file) {
      result.push({ padIndex: pad.index, file })
    }
  }

  // Sort by pad index for sequential assignment
  result.sort((a, b) => a.padIndex - b.padIndex)
  return result
}
