import JSZip from 'jszip'
import { db } from './db'
import { buildMidiForSequence } from './midiExport'
import { touchProject } from './project'
import { arrayBufferToHex, uid } from './utils'
import type {
  ImportMode,
  PackageManifest,
  Pad,
  Project,
  SampleAsset,
  SequenceEvent,
  SynthPatch,
} from '../types'

interface ImportPreview {
  overlaps: number
  additions: number
  unchanged: number
}

export interface ImportConflictReport {
  padOverlaps: string[]
  padAdditions: string[]
  sequenceNameCollisions: string[]
  incomingOnlySequences: string[]
}

const cloneProject = (project: Project): Project => {
  return JSON.parse(JSON.stringify(project)) as Project
}

const dedupeSampleByHash = async (sample: SampleAsset): Promise<SampleAsset> => {
  const existing = await db.findSampleByHash(sample.hash)
  if (existing) {
    return existing
  }

  await db.putSample(sample)
  return sample
}

export const exportProjectPackage = async (project: Project, allSamples?: SampleAsset[], synthPatches?: SynthPatch[]): Promise<Blob> => {
  const zip = new JSZip()

  const usedSampleIds = Array.from(
    new Set(project.pads.flatMap((pad) => {
      const ids: string[] = []
      if (pad.settings.sampleId) ids.push(pad.settings.sampleId)
      for (const layer of pad.settings.layers ?? []) {
        if (layer.sampleId) ids.push(layer.sampleId)
      }
      return ids
    })),
  )

  // Include all library samples (not just pad-referenced) for full state preservation
  const samples: SampleAsset[] = []
  if (allSamples) {
    samples.push(...allSamples)
  } else {
    for (const sampleId of usedSampleIds) {
      const sample = await db.getSample(sampleId)
      if (sample) {
        samples.push(sample)
      }
    }
  }

  samples.forEach((sample) => {
    // Always append .wav extension for the zip entry filename;
    // mark whether the extension was added so import can strip it
    const hasExt = sample.name.includes('.')
    const ext = hasExt ? '' : '.wav'
    // Prefix filename with + if extension was added, - if original had one
    const marker = hasExt ? '-' : '+'
    zip.file(`samples/${sample.id}${marker}${sample.name}${ext}`, sample.blob)
  })

  project.sequences.forEach((sequence) => {
    const midi = buildMidiForSequence(sequence, project.pads, project.bpm)
    zip.file(`midi/${sequence.id}.mid`, midi)
  })

  const manifest: PackageManifest = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    project,
    usedSampleIds,
    sampleMeta: samples.map((s) => ({
      id: s.id,
      name: s.name,
      chopPoints: s.chopPoints,
      autosampleRunId: s.autosampleRunId,
      autosampleRunLabel: s.autosampleRunLabel,
      autosamplePadIndex: s.autosamplePadIndex,
      autosampleTrim: s.autosampleTrim,
      autosampleBus: s.autosampleBus,
      autosampleChokeGroup: s.autosampleChokeGroup,
      autosampleMpc: s.autosampleMpc,
    })),
    synthPatches: synthPatches ?? [],
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  return zip.generateAsync({ type: 'blob' })
}

const buildPadKey = (pad: Pad): string => `${pad.bank}:${pad.slot}`

const replacePadEvents = (target: Project, sourcePadId: string, destinationPadId: string): void => {
  target.sequences = target.sequences.map((sequence) => ({
    ...sequence,
    events: sequence.events.filter((event) => event.padId !== destinationPadId && event.padId !== sourcePadId),
  }))
}

const normalizeImportedSamples = async (zip: JSZip, manifest: PackageManifest): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  const sampleFiles = Object.values(zip.files).filter((entry) => entry.name.startsWith('samples/'))
  // Build metadata lookup from manifest (by original sample id)
  const metaById = new Map((manifest.sampleMeta ?? []).map((m) => [m.id, m]))

  for (const fileEntry of sampleFiles) {
    const buffer = await fileEntry.async('arraybuffer')
    const blob = new Blob([buffer], { type: 'audio/wav' })
    const hash = await arrayBufferToHex(buffer)
    const existing = await db.findSampleByHash(hash)

    // Parse filename: samples/{id}{marker}{name}
    // New format: marker is + (extension was added, strip it) or - (original had extension)
    // Legacy format: {id}-{name} (no marker distinction)
    // Note: UUIDs contain dashes, so we must detect UUID format before splitting on '-'
    const basename = fileEntry.name.split('/')[1] ?? ''
    let importedId: string
    let name: string

    const plusIdx = basename.indexOf('+')
    if (plusIdx !== -1) {
      // + marker: extension was added during export, strip it
      importedId = basename.substring(0, plusIdx)
      const rawName = basename.substring(plusIdx + 1)
      // Strip the trailing .wav/.mp3 etc that was added
      name = rawName.replace(/\.\w+$/, '')
    } else {
      // - marker or legacy format. UUIDs are 36 chars (8-4-4-4-12).
      // Check if basename starts with a UUID followed by '-'
      const uuidMatch = basename.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/)
      if (uuidMatch) {
        importedId = uuidMatch[1]
        name = uuidMatch[2]
      } else {
        // Fallback legacy format: first dash separates id from name
        const dashIdx = basename.indexOf('-')
        if (dashIdx !== -1) {
          importedId = basename.substring(0, dashIdx)
          name = basename.substring(dashIdx + 1)
        } else {
          importedId = basename
          name = basename
        }
      }
    }

    const meta = metaById.get(importedId)

    if (existing) {
      // Apply group metadata from manifest if not already set
      if (meta) {
        let updated = false
        if (!existing.autosampleRunId && meta.autosampleRunId) {
          existing.autosampleRunId = meta.autosampleRunId
          existing.autosampleRunLabel = meta.autosampleRunLabel
          existing.autosamplePadIndex = meta.autosamplePadIndex
          existing.autosampleTrim = meta.autosampleTrim
          existing.autosampleBus = meta.autosampleBus
          existing.autosampleChokeGroup = meta.autosampleChokeGroup
          existing.autosampleMpc = meta.autosampleMpc
          updated = true
        }
        if (!existing.chopPoints && meta.chopPoints) {
          existing.chopPoints = meta.chopPoints
          updated = true
        }
        if (updated) await db.putSample(existing)
      }
      map.set(importedId, existing.id)
      continue
    }

    const sample: SampleAsset = {
      id: uid(),
      name,
      mimeType: blob.type,
      size: blob.size,
      createdAt: Date.now(),
      hash,
      blob,
      ...(meta?.chopPoints && { chopPoints: meta.chopPoints }),
      ...(meta?.autosampleRunId && {
        autosampleRunId: meta.autosampleRunId,
        autosampleRunLabel: meta.autosampleRunLabel,
        autosamplePadIndex: meta.autosamplePadIndex,
        autosampleTrim: meta.autosampleTrim,
        autosampleBus: meta.autosampleBus,
        autosampleChokeGroup: meta.autosampleChokeGroup,
        autosampleMpc: meta.autosampleMpc,
      }),
    }
    const persisted = await dedupeSampleByHash(sample)
    map.set(importedId, persisted.id)
  }

  return map
}

const attachSampleMap = (project: Project, sampleMap: Map<string, string>): Project => {
  return {
    ...project,
    pads: project.pads.map((pad) => {
      const sampleId = pad.settings.sampleId
      const mappedSampleId = sampleId ? (sampleMap.get(sampleId) ?? sampleId) : null
      const mappedLayers = (pad.settings.layers ?? []).map((layer) => ({
        ...layer,
        sampleId: sampleMap.get(layer.sampleId) ?? layer.sampleId,
      }))

      return {
        ...pad,
        settings: {
          ...pad.settings,
          sampleId: mappedSampleId,
          layers: mappedLayers,
        },
      }
    }),
  }
}

const remapSequenceEvents = (events: SequenceEvent[], padIdMap: Map<string, string>): SequenceEvent[] => {
  return events.map((event) => ({
    ...event,
    id: uid(),
    padId: padIdMap.get(event.padId) ?? event.padId,
  }))
}

export const importPreview = (target: Project, incoming: Project): ImportPreview => {
  const targetMap = new Map(target.pads.map((pad) => [buildPadKey(pad), pad]))
  let overlaps = 0
  let additions = 0

  incoming.pads.forEach((pad) => {
    const existing = targetMap.get(buildPadKey(pad))
    if (existing?.settings.sampleId && pad.settings.sampleId) {
      overlaps += 1
    } else if (!existing?.settings.sampleId && pad.settings.sampleId) {
      additions += 1
    }
  })

  const unchanged = incoming.pads.length - overlaps - additions
  return { overlaps, additions, unchanged }
}

export const buildImportConflictReport = (
  target: Project,
  incoming: Project,
): ImportConflictReport => {
  const targetMap = new Map(target.pads.map((pad) => [buildPadKey(pad), pad]))

  const padOverlaps: string[] = []
  const padAdditions: string[] = []
  incoming.pads.forEach((pad) => {
    if (!pad.settings.sampleId) {
      return
    }

    const key = buildPadKey(pad)
    const existing = targetMap.get(key)
    if (existing?.settings.sampleId) {
      padOverlaps.push(`Bank ${pad.bank + 1} Pad ${pad.slot + 1}`)
      return
    }

    padAdditions.push(`Bank ${pad.bank + 1} Pad ${pad.slot + 1}`)
  })

  const targetNames = new Set(target.sequences.map((sequence) => sequence.name))
  const sequenceNameCollisions = incoming.sequences
    .filter((sequence) => targetNames.has(sequence.name))
    .map((sequence) => sequence.name)

  const incomingOnlySequences = incoming.sequences
    .filter((sequence) => !targetNames.has(sequence.name))
    .map((sequence) => sequence.name)

  return {
    padOverlaps,
    padAdditions,
    sequenceNameCollisions,
    incomingOnlySequences,
  }
}

export const importProjectPackage = async (
  payload: Blob,
  mode: ImportMode,
  activeProject: Project,
): Promise<{ project: Project; preview: ImportPreview; synthPatches?: SynthPatch[] }> => {
  const zip = await JSZip.loadAsync(payload)
  const manifestRaw = await zip.file('manifest.json')?.async('string')
  if (!manifestRaw) {
    throw new Error('Package is missing manifest.json')
  }

  const manifest = JSON.parse(manifestRaw) as PackageManifest
  const normalizedIncoming = attachSampleMap(manifest.project, await normalizeImportedSamples(zip, manifest))
  const preview = importPreview(activeProject, normalizedIncoming)

  if (mode === 'new') {
    const fresh = cloneProject(normalizedIncoming)
    fresh.id = uid()
    fresh.createdAt = Date.now()
    fresh.updatedAt = Date.now()
    // Build padId mapping (old → new) so sequence events can be remapped
    const padIdMap = new Map<string, string>()
    fresh.pads = fresh.pads.map((pad) => {
      const newId = uid()
      padIdMap.set(pad.id, newId)
      return { ...pad, id: newId }
    })
    const seqIdMap = new Map<string, string>()
    fresh.sequences = fresh.sequences.map((sequence) => {
      const newId = uid()
      seqIdMap.set(sequence.id, newId)
      return {
        ...sequence,
        id: newId,
        events: sequence.events.map((event) => ({
          ...event,
          id: uid(),
          padId: padIdMap.get(event.padId) ?? event.padId,
        })),
      }
    })
    // Remap song chain pattern references
    fresh.songChain = (fresh.songChain ?? []).map((entry) => ({
      ...entry,
      patternId: seqIdMap.get(entry.patternId) ?? entry.patternId,
    }))
    await db.putProject(fresh)
    return { project: fresh, preview, synthPatches: manifest.synthPatches }
  }

  const merged = cloneProject(activeProject)
  const targetMap = new Map(merged.pads.map((pad) => [buildPadKey(pad), pad]))
  const importedMap = new Map(normalizedIncoming.pads.map((pad) => [buildPadKey(pad), pad]))
  const padIdMap = new Map<string, string>()

  merged.pads = merged.pads.map((targetPad) => {
    const importedPad = importedMap.get(buildPadKey(targetPad))
    if (!importedPad?.settings.sampleId) {
      return targetPad
    }

    if (mode === 'overwrite') {
      padIdMap.set(importedPad.id, targetPad.id)
      replacePadEvents(merged, importedPad.id, targetPad.id)
      return {
        ...targetPad,
        name: importedPad.name,
        settings: importedPad.settings,
      }
    }

    if (!targetPad.settings.sampleId) {
      padIdMap.set(importedPad.id, targetPad.id)
      return {
        ...targetPad,
        name: importedPad.name,
        settings: importedPad.settings,
      }
    }

    return targetPad
  })

  if (mode === 'merge') {
    const seqIdMap = new Map<string, string>()
    const importedSequences = normalizedIncoming.sequences.map((sequence) => {
      const newId = uid()
      seqIdMap.set(sequence.id, newId)
      return {
        ...sequence,
        id: newId,
        name: merged.sequences.some((existing) => existing.name === sequence.name)
          ? `${sequence.name} (imported)`
          : sequence.name,
        events: remapSequenceEvents(sequence.events, padIdMap),
      }
    })
    merged.sequences = [...merged.sequences, ...importedSequences]
    // Remap and append incoming song chain entries
    const incomingChain = (normalizedIncoming.songChain ?? []).map((entry) => ({
      ...entry,
      patternId: seqIdMap.get(entry.patternId) ?? entry.patternId,
    }))
    merged.songChain = [...(merged.songChain ?? []), ...incomingChain]
  }

  if (mode === 'overwrite') {
    const overlapPadIds = new Set(Array.from(padIdMap.values()))
    const sequenceByName = new Map(merged.sequences.map((sequence) => [sequence.name, sequence]))
    const seqIdMap = new Map<string, string>()

    normalizedIncoming.sequences.forEach((incomingSequence) => {
      const target = sequenceByName.get(incomingSequence.name)
      const incomingEvents = incomingSequence.events
        .map((event) => ({
          ...event,
          id: uid(),
          padId: padIdMap.get(event.padId) ?? event.padId,
        }))
        .filter((event) => overlapPadIds.has(event.padId))

      if (!target) {
        if (incomingEvents.length === 0) {
          return
        }

        const newId = uid()
        seqIdMap.set(incomingSequence.id, newId)
        merged.sequences.push({
          ...incomingSequence,
          id: newId,
          events: incomingEvents,
        })
        return
      }

      // Existing sequence keeps its ID — map incoming to target
      seqIdMap.set(incomingSequence.id, target.id)
      target.events = [
        ...target.events.filter((event) => !overlapPadIds.has(event.padId)),
        ...incomingEvents,
      ]
    })

    // Replace song chain with incoming chain (remapped to new sequence IDs)
    merged.songChain = (normalizedIncoming.songChain ?? []).map((entry) => ({
      ...entry,
      patternId: seqIdMap.get(entry.patternId) ?? entry.patternId,
    }))
  }

  const finalized = touchProject(merged)
  await db.putProject(finalized)

  void targetMap
  return { project: finalized, preview, synthPatches: manifest.synthPatches }
}

export const readProjectFromPackage = async (payload: Blob): Promise<Project> => {
  const zip = await JSZip.loadAsync(payload)
  const manifestRaw = await zip.file('manifest.json')?.async('string')
  if (!manifestRaw) {
    throw new Error('Package is missing manifest.json')
  }

  const manifest = JSON.parse(manifestRaw) as PackageManifest
  return manifest.project
}
