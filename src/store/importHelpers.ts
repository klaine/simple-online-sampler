import type { SampleAsset } from '../types'
import type { AppState } from './types'
import { db } from '../lib/db'
import { audioEngine } from '../lib/audioEngine'
import { arrayBufferToHex, uid } from '../lib/utils'

// ---------------------------------------------------------------------------
// Shared helper: import a File as a SampleAsset (dedup by hash)
// Returns the SampleAsset. Callers are responsible for updating store state.
// ---------------------------------------------------------------------------
export async function importFileAsSample(
  file: File,
  _getState: () => AppState,
  setState: (fn: (s: AppState) => void) => void,
): Promise<SampleAsset> {
  const raw = await file.arrayBuffer()
  const hash = await arrayBufferToHex(raw)
  const existing = await db.findSampleByHash(hash)

  const sample: SampleAsset =
    existing ?? {
      id: uid(),
      name: file.name,
      mimeType: file.type || 'audio/wav',
      size: file.size,
      createdAt: Date.now(),
      hash,
      blob: file,
    }

  if (!existing) {
    await db.putSample(sample)
    await audioEngine.registerSample(sample)
    setState((s) => {
      s.samples = [...s.samples, sample]
      s.sampleMap.set(sample.id, sample)
    })
  } else if (!audioEngine.hasSample(sample.id)) {
    await audioEngine.registerSample(sample)
  }

  return sample
}

const PRESET_KITS = ['TR7x7ISH_Kit.zip', 'TR8x8ISH_Kit.zip', 'TR9x9ISH_Kit.zip']

/** Load factory preset drumkit ZIPs from the app's public folder (BASE_URL-relative) on first launch.
 *  Returns array of { runId, bankIndex } for pad assignment. */
export async function loadPresetKits(
  _getState: () => AppState,
  setState: (fn: (s: AppState) => void) => void,
): Promise<{ runId: string; bank: number }[]> {
  const loaded: { runId: string; bank: number }[] = []
  for (let ki = 0; ki < PRESET_KITS.length; ki++) {
    const filename = PRESET_KITS[ki]
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}${filename}`)
      if (!resp.ok) continue
      const buf = await resp.arrayBuffer()
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
      const metaFile = zip.file('metadata.json')
      const meta = metaFile ? JSON.parse(await metaFile.async('text')) as {
        label?: string;
        samples?: { name: string; autosampleTrim?: { start: number; end: number } | null;
          autosampleBus?: import('../types').BusId | null; autosampleChokeGroup?: number | null;
          autosamplePadIndex?: number | null; autosampleMpc?: boolean }[]
      } : null
      const runId = `preset-${filename.replace(/\.zip$/i, '')}`
      const runLabel = meta?.label || filename.replace(/\.zip$/i, '')
      const metaMap = new Map((meta?.samples || []).map((m) => [m.name, m]))
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || path === 'metadata.json') continue
        if (!path.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)) continue
        const blob = await entry.async('blob')
        const file = new File([blob], entry.name, { type: 'audio/wav' })
        const raw = await file.arrayBuffer()
        const hash = await arrayBufferToHex(raw)
        const m = metaMap.get(entry.name)
        const sample: SampleAsset = {
          id: uid(),
          name: file.name,
          mimeType: file.type || 'audio/wav',
          size: file.size,
          createdAt: Date.now(),
          hash,
          blob: file,
          autosampleRunId: runId,
          autosampleRunLabel: runLabel,
          autosampleTrim: m?.autosampleTrim ?? undefined,
          autosampleBus: m?.autosampleBus ?? undefined,
          autosampleChokeGroup: m?.autosampleChokeGroup ?? undefined,
          autosamplePadIndex: m?.autosamplePadIndex ?? undefined,
          autosamplePreset: true,
        }
        await db.putSample(sample)
        await audioEngine.registerSample(sample)
        setState((s) => {
          s.samples.push(sample)
          s.sampleMap.set(sample.id, sample)
        })
      }
      loaded.push({ runId, bank: ki })
    } catch (e) {
      console.warn('Failed to load preset kit', filename, e)
    }
  }
  return loaded
}
