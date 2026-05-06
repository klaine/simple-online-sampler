import { audioEngine } from '../../lib/audioEngine'
import { db } from '../../lib/db'
import { midiToName, uid } from '../../lib/utils'
import { encodeWavFromChannels } from '../../lib/wavEncode'
import { PADS_PER_BANK } from '../../lib/constants'
import type { SampleAsset, BusId } from '../../types'
import { showConfirm } from '../confirmDialog'
import { parseMpcPgm, matchMpcSamplesToFiles } from '../../lib/mpcImport'
import { parseLcdk, matchLcdkSamplesToFiles } from '../../lib/lcdkImport'
import { importFileAsSample } from '../importHelpers'
import type { StoreContext } from '../context'

export const createLibraryActions = (ctx: StoreContext) => ({
  previewSample: async (sample: SampleAsset) => {
    // Stop any current preview
    audioEngine.stopPreview()

    // If same sample is already previewing, just stop (toggle off)
    if (ctx.get().previewSampleId === sample.id) {
      ctx.set((s) => { s.previewSampleId = null })
      return
    }

    // Ensure buffer is loaded
    if (!audioEngine.hasSample(sample.id)) {
      await audioEngine.registerSample(sample)
    }

    ctx.set((s) => { s.previewSampleId = sample.id })
    audioEngine.playPreview(sample.id, () => {
      ctx.set((s) => { if (s.previewSampleId === sample.id) s.previewSampleId = null })
    })
  },

  deleteSampleFromLibrary: async (sample: SampleAsset) => {
    const s = ctx.get()
    if (!s.project) return
    const usedByPrimary = s.project.pads.filter((p) => p.settings.sampleId === sample.id)
    const usedByLayer = s.project.pads.filter((p) =>
      p.settings.layers.some((l) => l.sampleId === sample.id),
    )
    const totalUsed = new Set([...usedByPrimary, ...usedByLayer].map((p) => p.id)).size
    const confirmText =
      totalUsed > 0
        ? `Delete ${sample.name}? It is used by ${totalUsed} pad(s) and will be unassigned.`
        : `Delete ${sample.name}?`
    if (!(await showConfirm(confirmText))) return

    await db.deleteSample(sample.id)
    await db.deleteWaveformPeaksBySampleId(sample.id)
    audioEngine.unregisterSample(sample.id)
    ctx.set((d) => {
      d.samples = d.samples.filter((item) => item.id !== sample.id)
      d.sampleMap.delete(sample.id)
      d.favoriteSampleIds.delete(sample.id)
      const nextPeaks = { ...d.libraryWavePeaks }
      delete nextPeaks[sample.id]
      d.libraryWavePeaks = nextPeaks
    })

    const needsSave = s.project.pads.some(
      (p) => p.settings.sampleId === sample.id || p.settings.layers.some((l) => l.sampleId === sample.id),
    )
    if (needsSave) {
      await s.saveProject({
        ...s.project,
        pads: s.project.pads.map((p) => {
          let settings = p.settings
          if (settings.sampleId === sample.id) {
            settings = { ...settings, sampleId: null }
          }
          if (settings.layers.some((l) => l.sampleId === sample.id)) {
            settings = { ...settings, layers: settings.layers.filter((l) => l.sampleId !== sample.id) }
          }
          return settings === p.settings ? p : { ...p, settings }
        }),
      })
    }
  },

  cropSampleToTrim: async (padId: string) => {
    const s = ctx.get()
    if (!s.project) return

    const pad = s.project.pads.find((p) => p.id === padId)
    if (!pad || !pad.settings.sampleId) return

    const sampleId = pad.settings.sampleId
    const { trim } = pad.settings
    if (trim.start === 0 && trim.end === 1) {
      s.addToast('Nothing to crop — trim markers span entire sample', 'info')
      return
    }

    const buffer = audioEngine.getBuffer(sampleId)
    if (!buffer) return

    const startFrame = Math.floor(trim.start * buffer.length)
    const endFrame = Math.ceil(trim.end * buffer.length)
    const cropLength = Math.max(1, endFrame - startFrame)

    // Extract trimmed channel data
    const channels: Float32Array[] = []
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const full = buffer.getChannelData(ch)
      channels.push(full.slice(startFrame, startFrame + cropLength))
    }

    // Encode as WAV blob
    const wavBlob = encodeWavFromChannels(channels, buffer.sampleRate)

    // Update sample in store + DB
    const sample = s.samples.find((sa) => sa.id === sampleId)
    if (!sample) return

    const updatedSample: SampleAsset = {
      ...sample,
      blob: wavBlob,
      size: wavBlob.size,
      // Clear chop points and autosample trim — they're invalid after crop
      chopPoints: undefined,
      autosampleTrim: undefined,
    }
    await db.putSample(updatedSample)
    await db.deleteWaveformPeaksBySampleId(sampleId)
    await audioEngine.registerSample(updatedSample)

    // Update store: replace sample, reset trim to full range
    ctx.set((d) => {
      const idx = d.samples.findIndex((sa) => sa.id === sampleId)
      if (idx !== -1) d.samples[idx] = updatedSample
      d.sampleMap.set(sampleId, updatedSample)
    })

    // Reset trim markers on all pads using this sample (including layers)
    const updatedPads = s.project.pads.map((p) => {
      let settings = p.settings
      if (settings.sampleId === sampleId && (settings.trim.start !== 0 || settings.trim.end !== 1)) {
        settings = { ...settings, trim: { start: 0, end: 1 } }
      }
      const layersChanged = settings.layers.some(
        (l) => l.sampleId === sampleId && l.trim && (l.trim.start !== 0 || l.trim.end !== 1),
      )
      if (layersChanged) {
        settings = {
          ...settings,
          layers: settings.layers.map((l) =>
            l.sampleId === sampleId && l.trim ? { ...l, trim: { start: 0, end: 1 } } : l,
          ),
        }
      }
      return settings === p.settings ? p : { ...p, settings }
    })
    s.saveProjectLight({ ...s.project, pads: updatedPads })
    s.addToast('Sample cropped to trim markers', 'success')
  },

  normalizeSample: async (padId: string) => {
    const s = ctx.get()
    if (!s.project) return

    const pad = s.project.pads.find((p) => p.id === padId)
    if (!pad || !pad.settings.sampleId) return

    const sampleId = pad.settings.sampleId
    const buffer = audioEngine.getBuffer(sampleId)
    if (!buffer) return

    // Find peak across all channels
    let peak = 0
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i])
        if (abs > peak) peak = abs
      }
    }

    if (peak === 0) {
      s.addToast('Sample is silent — nothing to normalize', 'info')
      return
    }

    const targetLinear = Math.pow(10, -0.3 / 20) // -0.3 dBFS
    if (Math.abs(peak - targetLinear) < 0.001) {
      s.addToast('Sample is already normalized', 'info')
      return
    }

    const gain = targetLinear / peak

    // Apply gain to all channels
    const channels: Float32Array[] = []
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch).slice()
      for (let i = 0; i < data.length; i++) data[i] *= gain
      channels.push(data)
    }

    // Re-encode as WAV
    const wavBlob = encodeWavFromChannels(channels, buffer.sampleRate)

    const sample = s.samples.find((sa) => sa.id === sampleId)
    if (!sample) return

    const updatedSample: SampleAsset = {
      ...sample,
      blob: wavBlob,
      size: wavBlob.size,
    }
    await db.putSample(updatedSample)
    await db.deleteWaveformPeaksBySampleId(sampleId)
    await audioEngine.registerSample(updatedSample)

    ctx.set((d) => {
      const idx = d.samples.findIndex((sa) => sa.id === sampleId)
      if (idx !== -1) d.samples[idx] = updatedSample
      d.sampleMap.set(sampleId, updatedSample)
    })

    s.addToast(`Normalized (${gain > 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB)`, 'success')
  },

  removeUnassignedSamples: async () => {
    const s = ctx.get()
    if (!s.project) return
    // Collect all sample IDs referenced by any pad (primary + layers)
    const usedIds = new Set<string>()
    for (const pad of s.project.pads) {
      if (pad.settings.sampleId) usedIds.add(pad.settings.sampleId)
      for (const layer of pad.settings.layers) {
        usedIds.add(layer.sampleId)
      }
    }
    const unassigned = s.samples.filter((sa) => !usedIds.has(sa.id))
    if (unassigned.length === 0) {
      s.addToast('No unassigned samples to remove')
      return
    }
    if (!(await showConfirm(`Remove ${unassigned.length} unassigned sample(s) from the library?`))) return
    for (const sa of unassigned) {
      await db.deleteSample(sa.id)
      await db.deleteWaveformPeaksBySampleId(sa.id)
    }
    const removedIds = new Set(unassigned.map((sa) => sa.id))
    ctx.set((d) => {
      d.samples = d.samples.filter((sa) => !removedIds.has(sa.id))
      for (const id of removedIds) {
        d.sampleMap.delete(id)
        d.favoriteSampleIds.delete(id)
      }
      const nextPeaks = { ...d.libraryWavePeaks }
      for (const id of removedIds) delete nextPeaks[id]
      d.libraryWavePeaks = nextPeaks
    })
    s.addToast(`Removed ${unassigned.length} unassigned sample(s)`)
  },

  compactProject: async () => {
    const s = ctx.get()
    const project = s.project
    if (!project) return

    // 1. Collect all padIds referenced in any sequence event
    const usedPadIds = new Set<string>()
    for (const seq of project.sequences) {
      for (const ev of seq.events) {
        usedPadIds.add(ev.padId)
      }
    }

    if (usedPadIds.size === 0) {
      s.addToast('No pads are used in any sequence — nothing to compact', 'info')
      return
    }

    // 2. Find used pads (preserve bank/slot order)
    const usedPads = project.pads.filter((p) => usedPadIds.has(p.id))
    const totalBanks = Math.ceil(usedPads.length / PADS_PER_BANK)

    // 3. Collect used sampleIds from used pads
    const usedSampleIds = new Set<string>()
    for (const p of usedPads) {
      if (p.settings.sampleId) usedSampleIds.add(p.settings.sampleId)
      for (const layer of (p.settings.layers ?? [])) {
        usedSampleIds.add(layer.sampleId)
      }
    }

    // Count what will be removed
    const allAssignedSampleIds = new Set<string>()
    for (const p of project.pads) {
      if (p.settings.sampleId) allAssignedSampleIds.add(p.settings.sampleId)
      for (const layer of (p.settings.layers ?? [])) {
        allAssignedSampleIds.add(layer.sampleId)
      }
    }
    const samplesToRemove = s.samples.filter((sa) => !usedSampleIds.has(sa.id))
    const padsToRemove = project.pads.filter((p) => p.settings.sampleId && !usedPadIds.has(p.id))

    const msg = [
      `Compact will consolidate ${usedPads.length} sequenced pad(s) into bank${totalBanks > 1 ? 's' : ''} 1${totalBanks > 1 ? `–${totalBanks}` : ''}.`,
      padsToRemove.length > 0 ? `${padsToRemove.length} un-sequenced pad(s) will be cleared.` : '',
      samplesToRemove.length > 0 ? `${samplesToRemove.length} unused sample(s) will be deleted.` : '',
      'This is irreversible.',
    ].filter(Boolean).join('\n')

    if (!(await showConfirm(msg, { confirmLabel: 'Compact' }))) return

    // 4. Build pad ID mapping: old pad ID → target pad's ID
    const padIdMap = new Map<string, string>()
    const newPads = [...project.pads] // clone array (shallow)

    // Reset all pads to default first
    for (let i = 0; i < newPads.length; i++) {
      const pad = newPads[i]
      newPads[i] = {
        ...pad,
        name: `${midiToName(pad.midiNote)} Pad`,
        settings: {
          source: 'sample' as const,
          sampleId: null, gain: 1, semitones: 0, fineCents: 0,
          mode: 'one-shot' as const, trim: { start: 0, end: 1 },
          envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
          layers: [], multiMode: 'single' as const,
          filterType: 'off' as const, filterFreq: 1000, filterQ: 1,
          bus: 'A' as const, chokeGroup: 0,
        },
      }
    }

    // Place used pads into sequential positions
    for (let i = 0; i < usedPads.length; i++) {
      const targetPad = newPads[i]
      const sourcePad = usedPads[i]
      padIdMap.set(sourcePad.id, targetPad.id)
      newPads[i] = {
        ...targetPad,
        name: sourcePad.name,
        settings: { ...sourcePad.settings },
      }
    }

    // 5. Remap sequence events
    const newSequences = project.sequences.map((seq) => ({
      ...seq,
      events: seq.events.map((ev) => ({
        ...ev,
        padId: padIdMap.get(ev.padId) ?? ev.padId,
      })),
    }))

    // 6. Delete unused samples
    for (const sa of samplesToRemove) {
      await db.deleteSample(sa.id)
      await db.deleteWaveformPeaksBySampleId(sa.id)
      audioEngine.unregisterSample(sa.id)
    }
    const removedIds = new Set(samplesToRemove.map((sa) => sa.id))

    // 7. Save
    const compacted = {
      ...project,
      pads: newPads,
      sequences: newSequences,
      updatedAt: Date.now(),
    }
    ctx.set((d) => {
      d.samples = d.samples.filter((sa) => !removedIds.has(sa.id))
      for (const id of removedIds) {
        d.sampleMap.delete(id)
        d.favoriteSampleIds.delete(id)
      }
      const nextPeaks = { ...d.libraryWavePeaks }
      for (const id of removedIds) delete nextPeaks[id]
      d.libraryWavePeaks = nextPeaks
    })
    await ctx.get().saveProject(compacted)
    // Update selectedPadId to first pad if current is cleared
    const currentSelected = ctx.get().selectedPadId
    if (currentSelected && !usedPadIds.has(currentSelected)) {
      ctx.set((d) => { d.selectedPadId = newPads[0]?.id ?? null })
    }
    s.addToast(`Compacted: ${usedPads.length} pad(s), ${samplesToRemove.length} sample(s) removed`, 'success')
  },

  toggleFavoriteSample: (sampleId: string) => {
    ctx.set((s) => {
      if (s.favoriteSampleIds.has(sampleId)) s.favoriteSampleIds.delete(sampleId)
      else s.favoriteSampleIds.add(sampleId)
    })
  },

  addSamplesToLibrary: async (files: File[], padIndexMap?: Map<string, number>, groupLabel?: string) => {
    let added = 0
    const importedSamples: SampleAsset[] = []

    // --- MPC .pgm import: detect program files among dropped files ---
    const pgmFiles = files.filter((f) => f.name.match(/\.pgm$/i))
    if (pgmFiles.length > 0) {
      const audioFiles = files.filter((f) => !f.name.match(/\.pgm$/i) && (f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)))
      const claimedFiles = new Set<File>() // track files consumed by pgms (for remaining handling)
      const kitNames: string[] = []

      for (const pgmFile of pgmFiles) {
        try {
          const pgmResult = parseMpcPgm(await pgmFile.arrayBuffer(), pgmFile.name)
          if (!pgmResult || pgmResult.pads.length === 0) {
            console.warn('Empty or invalid MPC program', pgmFile.name)
            continue
          }
          const matched = matchMpcSamplesToFiles(pgmResult.pads, audioFiles)
          if (matched.length === 0) {
            ctx.get().addToast(`No matching audio files for "${pgmResult.label}"`)
            continue
          }
          const runId = uid()
          const runLabel = pgmResult.label
          let kitAdded = 0
          for (const { padIndex, file, mapping, additionalLayerFiles } of matched) {
            try {
              const sample = await importFileAsSample(file, ctx.get, ctx.set)
              // Build MPC pad settings from parsed mapping
              const mpcSettings: import('../../types').ImportedPadSettings = {}
              if (mapping.pan != null) mpcSettings.pan = mapping.pan
              if (mapping.level != null) mpcSettings.level = mapping.level
              if (mapping.semitones != null) mpcSettings.semitones = mapping.semitones
              if (mapping.fineCents != null) mpcSettings.fineCents = mapping.fineCents
              if (mapping.filterType && mapping.filterType !== 'off') {
                mpcSettings.filterType = mapping.filterType
                if (mapping.filterFreq != null) mpcSettings.filterFreq = mapping.filterFreq
                if (mapping.filterQ != null) mpcSettings.filterQ = mapping.filterQ
              }
              if (mapping.attack != null) mpcSettings.attack = mapping.attack
              if (mapping.decay != null) mpcSettings.decay = mapping.decay
              if (mapping.playMode) mpcSettings.playMode = mapping.playMode
              const hasMpcSettings = Object.keys(mpcSettings).length > 0
              const hasMultiLayers = additionalLayerFiles && additionalLayerFiles.length > 0
              const velocityRanges = mapping.velocityRanges
              const updated: SampleAsset = {
                ...sample,
                autosampleRunId: runId,
                autosampleRunLabel: runLabel,
                autosamplePadIndex: padIndex,
                autosampleMpc: true,
                autosampleChokeGroup: mapping.chokeGroup ?? 0,
                ...(hasMpcSettings ? { autosampleImportedPadSettings: mpcSettings } : {}),
                ...(hasMultiLayers ? { autosampleMpcLayerIndex: 0, autosampleMpcVelocityMax: velocityRanges?.[0] ?? 127 } : {}),
              }
              await db.putSample(updated)
              ctx.set((s) => {
                const idx = s.samples.findIndex((x) => x.id === updated.id)
                if (idx >= 0) s.samples[idx] = updated
                s.sampleMap.set(updated.id, updated)
              })
              kitAdded++
              claimedFiles.add(file)

              // Import additional velocity layers for this pad
              if (hasMultiLayers && additionalLayerFiles) {
                for (let li = 0; li < additionalLayerFiles.length; li++) {
                  try {
                    const layerSample = await importFileAsSample(additionalLayerFiles[li], ctx.get, ctx.set)
                    const layerUpdated: SampleAsset = {
                      ...layerSample,
                      autosampleRunId: runId,
                      autosampleRunLabel: runLabel,
                      autosamplePadIndex: padIndex,
                      autosampleMpc: true,
                      autosampleChokeGroup: mapping.chokeGroup ?? 0,
                      autosampleMpcLayerIndex: li + 1,
                      autosampleMpcVelocityMax: velocityRanges?.[li + 1] ?? 127,
                      ...(hasMpcSettings ? { autosampleImportedPadSettings: mpcSettings } : {}),
                    }
                    await db.putSample(layerUpdated)
                    ctx.set((s) => {
                      const idx = s.samples.findIndex((x) => x.id === layerUpdated.id)
                      if (idx >= 0) s.samples[idx] = layerUpdated
                      s.sampleMap.set(layerUpdated.id, layerUpdated)
                    })
                    kitAdded++
                    claimedFiles.add(additionalLayerFiles[li])
                  } catch (e) {
                    console.warn('Failed to import MPC layer sample', additionalLayerFiles[li].name, e)
                  }
                }
              }
            } catch (e) {
              console.warn('Failed to import MPC sample', file.name, e)
            }
          }
          if (kitAdded > 0) {
            kitNames.push(runLabel)
            added += kitAdded
          }
        } catch (e) {
          console.warn('Failed to parse MPC program', pgmFile.name, e)
        }
      }

      if (kitNames.length > 0) {
        ctx.get().addToast(`Imported ${kitNames.length} MPC kit${kitNames.length > 1 ? 's' : ''}: ${kitNames.join(', ')}`)
      }

      // Process remaining unclaimed audio files through normal import flow
      const remainingAudioFiles = audioFiles.filter((f) => !claimedFiles.has(f))
      if (remainingAudioFiles.length > 0) {
        for (const file of remainingAudioFiles) {
          try {
            const sample = await importFileAsSample(file, ctx.get, ctx.set)
            importedSamples.push(sample)
            added++
          } catch (e) {
            console.warn('Failed to import file', file.name, e)
          }
        }
      }

      // If we had pgm files, skip the normal loop below (all files already processed)
      if (remainingAudioFiles.length === 0) {
        if (added > 0) return
        if (audioFiles.length === 0) ctx.get().addToast('No audio files found in drop')
        return
      }
      // Fall through to auto-grouping logic for remaining samples
    }

    // --- Loopcloud Drum .lcdk import ---
    const lcdkFiles = files.filter((f) => f.name.match(/\.lcdk$/i))
    if (lcdkFiles.length > 0) {
      const audioFiles = files.filter((f) => !f.name.match(/\.(lcdk|pgm)$/i) && (f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)))
      const kitNames: string[] = []

      for (const lcdkFile of lcdkFiles) {
        try {
          const jsonStr = await lcdkFile.text()
          const lcdkResult = parseLcdk(jsonStr, lcdkFile.name)
          if (!lcdkResult || lcdkResult.pads.length === 0) {
            console.warn('Empty or invalid Loopcloud kit', lcdkFile.name)
            continue
          }
          const matched = matchLcdkSamplesToFiles(lcdkResult.pads, audioFiles)
          if (matched.length === 0) {
            ctx.get().addToast(`No matching audio files for "${lcdkResult.label}"`)
            continue
          }
          const runId = uid()
          const runLabel = lcdkResult.label
          let kitAdded = 0
          const hasPatterns = lcdkResult.patterns.length > 0
          for (const { padIndex, file, mapping } of matched) {
            try {
              const sample = await importFileAsSample(file, ctx.get, ctx.set)
              const padSettings = mapping.settings
              const hasPadSettings = Object.keys(padSettings).length > 0
              const isFirst = kitAdded === 0
              const updated: SampleAsset = {
                ...sample,
                autosampleRunId: runId,
                autosampleRunLabel: runLabel,
                autosamplePadIndex: padIndex,
                autosampleChokeGroup: padSettings.chokeGroup ?? 0,
                // LCDK samplestart = end boundary (keep first N%, truncate tail)
                ...(mapping.trimEnd != null ? { autosampleTrim: { start: 0, end: mapping.trimEnd } } : {}),
                ...(hasPadSettings ? { autosampleImportedPadSettings: padSettings } : {}),
                ...(isFirst && hasPatterns ? { autosamplePatterns: JSON.stringify(lcdkResult.patterns) } : {}),
              }
              await db.putSample(updated)
              ctx.set((s) => {
                const idx = s.samples.findIndex((x) => x.id === updated.id)
                if (idx >= 0) s.samples[idx] = updated
                s.sampleMap.set(updated.id, updated)
              })
              kitAdded++
            } catch (e) {
              console.warn('Failed to import Loopcloud sample', file.name, e)
            }
          }
          if (kitAdded > 0) {
            kitNames.push(runLabel)
            added += kitAdded
          }
        } catch (e) {
          console.warn('Failed to parse Loopcloud kit', lcdkFile.name, e)
        }
      }

      if (kitNames.length > 0) {
        ctx.get().addToast(`Imported ${kitNames.length} Loopcloud kit${kitNames.length > 1 ? 's' : ''}: ${kitNames.join(', ')}`)
      }
      if (added > 0) return
      return
    }

    // Normal file import loop (when no pgm files in drop)
    if (pgmFiles.length === 0) {
    for (const file of files) {
      // Handle ZIP files (autosample group import)
      if (file.name.endsWith('.zip') || file.type === 'application/zip') {
        try {
          const JSZip = (await import('jszip')).default
          const zip = await JSZip.loadAsync(await file.arrayBuffer())
          const metaFile = zip.file('metadata.json')
          const meta = metaFile ? JSON.parse(await metaFile.async('text')) as { label?: string; samples?: { name: string; autosampleTrim?: { start: number; end: number } | null; autosampleBus?: BusId | null; autosampleChokeGroup?: number | null; autosamplePadIndex?: number | null; autosampleMpc?: boolean }[] } : null
          const runId = uid()
          const runLabel = meta?.label || file.name.replace(/\.zip$/i, '')
          const metaMap = new Map((meta?.samples || []).map((m) => [m.name, m]))
          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir || path === 'metadata.json') continue
            if (!path.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i)) continue
            const blob = await entry.async('blob')
            const audioFile = new File([blob], entry.name, { type: 'audio/wav' })
            const sample = await importFileAsSample(audioFile, ctx.get, ctx.set)
            const m = metaMap.get(entry.name)
            const updated: SampleAsset = { ...sample, autosampleRunId: runId, autosampleRunLabel: runLabel, autosampleTrim: m?.autosampleTrim ?? undefined, autosampleBus: m?.autosampleBus ?? undefined, autosampleChokeGroup: m?.autosampleChokeGroup ?? undefined, autosamplePadIndex: m?.autosamplePadIndex ?? undefined, autosampleMpc: m?.autosampleMpc || undefined }
            await db.putSample(updated)
            ctx.set((s) => {
              const idx = s.samples.findIndex((x) => x.id === updated.id)
              if (idx >= 0) s.samples[idx] = updated
              s.sampleMap.set(updated.id, updated)
            })
            added++
          }
        } catch (e) {
          console.warn('Failed to import zip', file.name, e)
        }
        continue
      }
      if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|ogg|flac|aiff|aif|m4a|webm)$/i)) continue
      try {
        const sample = await importFileAsSample(file, ctx.get, ctx.set)
        importedSamples.push(sample)
        added++
      } catch (e) {
        console.warn('Failed to import file', file.name, e)
      }
    }
    } // end if pgmFiles.length === 0
    // Auto-group when multiple audio files dropped at once
    if (importedSamples.length >= 2) {
      const runId = uid()
      // Use provided group label, or derive from common prefix of filenames
      let runLabel = groupLabel
      if (!runLabel) {
        const names = importedSamples.map((s) => s.name.replace(/\.[^.]+$/, ''))
        let prefix = names[0]
        for (const n of names) {
          while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1)
        }
        // Trim trailing separators/digits from prefix
        prefix = prefix.replace(/[\s_\-0-9]+$/, '')
        runLabel = prefix || `${names[0]}…${names[names.length - 1]}`
      }
      ctx.set((d) => {
        const idSet = new Set(importedSamples.map((s) => s.id))
        for (const s of d.samples) {
          if (idSet.has(s.id)) {
            s.autosampleRunId = runId
            s.autosampleRunLabel = runLabel
            // Apply kit mapping pad index if provided
            if (padIndexMap) {
              const idx = padIndexMap.get(s.name) ?? padIndexMap.get(s.name.replace(/\.[^.]+$/, ''))
              if (idx != null) s.autosamplePadIndex = idx
            }
          }
        }
      })
      const updated = ctx.get().samples.filter((s) => s.autosampleRunId === runId)
      for (const sample of updated) void db.putSample(sample)
    }
    if (added > 0) ctx.get().addToast(`Added ${added} sample${added > 1 ? 's' : ''} to library`)
    else if (!pgmFiles.length) ctx.get().addToast('No audio files found in drop')
  },
})
