import { uid, midiToName } from '../../lib/utils'
import { db } from '../../lib/db'
import { showConfirm } from '../confirmDialog'
import { createDefaultSequence } from '../../lib/utils'
import type { SampleAsset, SampleLayer, BusId } from '../../types'
import type { StoreContext } from '../context'

export const createSampleGroupActions = (ctx: StoreContext) => ({
  groupSamples: (sampleIds: string[], label?: string) => {
    if (sampleIds.length < 2) return
    const runId = uid()
    const runLabel = label || 'Group'
    ctx.set((d) => {
      const idSet = new Set(sampleIds)
      for (const s of d.samples) {
        if (idSet.has(s.id)) {
          s.autosampleRunId = runId
          s.autosampleRunLabel = runLabel
        }
      }
    })
    const samples = ctx.get().samples.filter((s) => s.autosampleRunId === runId)
    for (const sample of samples) void db.putSample(sample)
    ctx.get().addToast(`Grouped ${samples.length} samples as "${runLabel}"`)
  },

  ungroupSample: (sampleId: string) => {
    ctx.set((d) => {
      const s = d.samples.find((x) => x.id === sampleId)
      if (s) {
        s.autosampleRunId = undefined
        s.autosampleRunLabel = undefined
        s.autosampleTrim = undefined
        s.autosampleBus = undefined
        s.autosampleChokeGroup = undefined
        s.autosamplePadIndex = undefined
        s.autosampleMpc = undefined
      }
    })
    const sample = ctx.get().samples.find((s) => s.id === sampleId)
    if (sample) void db.putSample(sample)
  },

  assignGroupToPads: async (runId: string, startBank?: number) => {
    const s = ctx.get()
    if (!s.project) return
    const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
    if (groupSamples.length === 0) return

    // Always sort by name with numeric comparison for consistent ordering
    // BUT if autosamplePadIndex is set (kit mapping), use that for ordering
    const hasKitMap = groupSamples.some((s) => s.autosamplePadIndex != null)
    if (hasKitMap) {
      groupSamples.sort((a, b) => (a.autosamplePadIndex ?? 999) - (b.autosamplePadIndex ?? 999))
    } else {
      groupSamples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    }

    // Detect velocity layers: MPC multi-layer (by padIndex + layerIndex) OR filename _vNN suffix
    const hasMpcLayers = groupSamples.some((s) => s.autosampleMpcLayerIndex != null)
    const noteGroups: { baseName: string; samples: { sample: SampleAsset; velocity: number }[] }[] = []

    if (hasMpcLayers) {
      // MPC multi-layer grouping: group by autosamplePadIndex
      const padIndexMap = new Map<number, SampleAsset[]>()
      for (const sample of groupSamples) {
        const pi = sample.autosamplePadIndex ?? -1
        let arr = padIndexMap.get(pi)
        if (!arr) { arr = []; padIndexMap.set(pi, arr) }
        arr.push(sample)
      }
      // Sort pad indices
      const sortedPadIndices = [...padIndexMap.keys()].sort((a, b) => a - b)
      for (const pi of sortedPadIndices) {
        const samples = padIndexMap.get(pi)!
        samples.sort((a, b) => (a.autosampleMpcLayerIndex ?? 0) - (b.autosampleMpcLayerIndex ?? 0))
        const primary = samples[0]
        const group = {
          baseName: primary.name,
          samples: samples.map((s) => ({ sample: s, velocity: s.autosampleMpcVelocityMax ?? 127 })),
        }
        noteGroups.push(group)
      }
    } else {
      // Standard velocity detection by _vNN filename suffix
      const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/
      const noteGroupMap = new Map<string, typeof noteGroups[0]>()

      for (const sample of groupSamples) {
        const m = veloRegex.exec(sample.name)
        if (m) {
          const baseKey = m[1] + m[3]  // e.g. "C3.wav"
          let group = noteGroupMap.get(baseKey)
          if (!group) {
            group = { baseName: m[1] + m[3], samples: [] }
            noteGroupMap.set(baseKey, group)
            noteGroups.push(group)
          }
          group.samples.push({ sample, velocity: Number(m[2]) })
        } else {
          // Non-velocity sample — treat as single-layer note
          const group = { baseName: sample.name, samples: [{ sample, velocity: 127 }] }
          noteGroups.push(group)
        }
      }
    }

    // Sort samples within each velocity group by velocity ascending
    for (const group of noteGroups) {
      group.samples.sort((a, b) => a.velocity - b.velocity)
    }

    // Find starting pad: use explicit startBank, selected pad, or first pad in current bank
    const padsSorted = [...s.project.pads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
    let startIdx = -1
    if (startBank != null) {
      startIdx = padsSorted.findIndex((p) => p.bank === startBank && p.slot === 0)
    }
    if (startIdx === -1 && s.selectedPadId) {
      startIdx = padsSorted.findIndex((p) => p.id === s.selectedPadId)
    }
    if (startIdx === -1) {
      startIdx = padsSorted.findIndex((p) => p.bank === s.activeBank)
    }
    if (startIdx === -1) startIdx = 0

    // Build assignment map: padId → note group
    const assignMap = new Map<string, typeof noteGroups[0]>()
    for (let i = 0; i < noteGroups.length; i++) {
      const targetPad = padsSorted[startIdx + i]
      if (!targetPad) break
      assignMap.set(targetPad.id, noteGroups[i])
    }

    if (assignMap.size === 0) return

    // Helper: compute velocity splits for N layers (same logic as AutosampleDialog)
    const computeVelocitySplits = (count: number): Array<{ velocityLow: number; velocityHigh: number }> => {
      if (count <= 1) return [{ velocityLow: 1, velocityHigh: 127 }]
      const splits: Array<{ velocityLow: number; velocityHigh: number }> = []
      for (let i = 0; i < count; i++) {
        const low = i === 0 ? 1 : splits[i - 1].velocityHigh + 1
        const high = i === count - 1 ? 127 : Math.round(((i + 1) / count) * 127)
        splits.push({ velocityLow: low, velocityHigh: high })
      }
      return splits
    }

    // Single atomic update
    const updatedPads = s.project.pads.map((p) => {
      const noteGroup = assignMap.get(p.id)
      if (!noteGroup) return p
      const primarySample = noteGroup.samples[0].sample
      const hasVeloLayers = noteGroup.samples.length > 1

      if (hasVeloLayers) {
        // Build velocity layers — use MPC ranges if available, otherwise compute evenly
        const isMpcLayers = noteGroup.samples[0].sample.autosampleMpcLayerIndex != null
        const splits = isMpcLayers
          ? noteGroup.samples.map((entry, i) => {
              const low = i === 0 ? 1 : (noteGroup.samples[i - 1].velocity + 1)
              const high = i === noteGroup.samples.length - 1 ? 127 : entry.velocity
              return { velocityLow: Math.max(1, low), velocityHigh: Math.min(127, high) }
            })
          : computeVelocitySplits(noteGroup.samples.length)
        const layers: SampleLayer[] = noteGroup.samples.map((entry, i) => ({
          id: uid(),
          sampleId: entry.sample.id,
          velocityLow: splits[i].velocityLow,
          velocityHigh: splits[i].velocityHigh,
          gain: null, semitones: null, fineCents: null, trim: entry.sample.autosampleTrim ?? null,
          envelope: null, filterType: null, filterFreq: null, filterQ: null,
          stackOffsetMs: null,
        }))
        const mpc = primarySample.autosampleImportedPadSettings
        return {
          ...p,
          name: noteGroup.baseName.replace(/\.[^.]+$/, ''),
          settings: {
            ...p.settings,
            sampleId: primarySample.id,
            source: 'sample' as const,
            layers,
            multiMode: 'velocity' as const,
            trim: { start: 0, end: 1 },  // per-layer trim overrides via SampleLayer.trim
            bus: primarySample.autosampleBus ?? p.settings.bus,
            chokeGroup: primarySample.autosampleChokeGroup ?? 0,
            // Apply MPC pad settings if present
            ...(mpc?.pan != null ? { pan: mpc.pan } : {}),
            ...(mpc?.level != null ? { gain: mpc.level } : {}),
            ...(mpc?.semitones != null ? { semitones: mpc.semitones } : {}),
            ...(mpc?.fineCents != null ? { fineCents: mpc.fineCents } : {}),
            ...(mpc?.filterType ? { filterType: mpc.filterType } : {}),
            ...(mpc?.filterFreq != null ? { filterFreq: mpc.filterFreq } : {}),
            ...(mpc?.filterFreq2 != null ? { filterFreq2: mpc.filterFreq2 } : {}),
            ...(mpc?.filterQ != null ? { filterQ: mpc.filterQ } : {}),
            ...(mpc?.playMode ? { mode: mpc.playMode } : {}),
            ...(mpc?.attack != null || mpc?.decay != null || mpc?.hold != null || mpc?.release != null || mpc?.sustain != null ? {
              envelope: {
                ...p.settings.envelope,
                ...(mpc.attack != null ? { attack: mpc.attack } : {}),
                ...(mpc.decay != null ? { decay: mpc.decay } : {}),
                ...(mpc.hold != null ? { hold: mpc.hold } : {}),
                ...(mpc.release != null ? { release: mpc.release } : {}),
                ...(mpc.sustain != null ? { sustain: mpc.sustain } : {}),
              },
            } : {}),
          },
        }
      } else {
        // Single sample per pad
        const mpc = primarySample.autosampleImportedPadSettings
        return {
          ...p,
          name: primarySample.name,
          settings: {
            ...p.settings,
            sampleId: primarySample.id,
            source: 'sample' as const,
            layers: [],
            multiMode: 'single' as const,
            trim: primarySample.autosampleTrim ?? { start: 0, end: 1 },
            bus: primarySample.autosampleBus ?? p.settings.bus,
            chokeGroup: primarySample.autosampleChokeGroup ?? 0,
            // Apply MPC pad settings if present
            ...(mpc?.pan != null ? { pan: mpc.pan } : {}),
            ...(mpc?.level != null ? { gain: mpc.level } : {}),
            ...(mpc?.semitones != null ? { semitones: mpc.semitones } : {}),
            ...(mpc?.fineCents != null ? { fineCents: mpc.fineCents } : {}),
            ...(mpc?.filterType ? { filterType: mpc.filterType } : {}),
            ...(mpc?.filterFreq != null ? { filterFreq: mpc.filterFreq } : {}),
            ...(mpc?.filterFreq2 != null ? { filterFreq2: mpc.filterFreq2 } : {}),
            ...(mpc?.filterQ != null ? { filterQ: mpc.filterQ } : {}),
            ...(mpc?.playMode ? { mode: mpc.playMode } : {}),
            ...(mpc?.attack != null || mpc?.decay != null || mpc?.hold != null || mpc?.release != null || mpc?.sustain != null ? {
              envelope: {
                ...p.settings.envelope,
                ...(mpc.attack != null ? { attack: mpc.attack } : {}),
                ...(mpc.decay != null ? { decay: mpc.decay } : {}),
                ...(mpc.hold != null ? { hold: mpc.hold } : {}),
                ...(mpc.release != null ? { release: mpc.release } : {}),
                ...(mpc.sustain != null ? { sustain: mpc.sustain } : {}),
              },
            } : {}),
          },
        }
      }
    })
    await s.saveProject({ ...s.project, pads: updatedPads })

    // Update autosamplePadIndex on samples for future ordering
    ctx.set((d) => {
      let i = 0
      for (const [, noteGroup] of assignMap) {
        for (const entry of noteGroup.samples) {
          const sam = d.samples.find((x) => x.id === entry.sample.id)
          if (sam) sam.autosamplePadIndex = i
        }
        i++
      }
    })
    const updated = ctx.get().samples.filter((x) => x.autosampleRunId === runId)
    for (const sample of updated) void db.putSample(sample)

    s.addToast(`Assigned ${noteGroups.length} note${noteGroups.length !== 1 ? 's' : ''} from group to ${assignMap.size} pads`)

    // --- Import sequencer patterns from LCDK/imported kit data ---
    const patternSource = groupSamples.find((sam) => sam.autosamplePatterns)
    if (patternSource?.autosamplePatterns) {
      // Build padIndex → padId map (based on assignment order)
      const padIndexToId = new Map<number, string>()
      let assignIdx = 0
      for (const [padId] of assignMap) {
        padIndexToId.set(assignIdx, padId)
        assignIdx++
      }
      await ctx.get().importPatternsForGroup(patternSource.autosamplePatterns, padIndexToId, patternSource.autosampleRunLabel)
    }
  },

  // Import sequencer patterns from JSON (LCDK/imported kit data)
  // padIndexToId maps source pad indices to our pad IDs.
  // Always appends new patterns (never overwrites existing).
  importPatternsForGroup: async (patternsJson: string, padIndexToId?: Map<number, string>, groupLabel?: string) => {
    try {
      const patterns = JSON.parse(patternsJson) as Array<{ index: number; steps: Array<{ padIndex: number; step: number; velocity: number }> }>
      if (patterns.length === 0) return

      const { project } = ctx.get()
      if (!project) return

      const updatedSequences = [...project.sequences]
      const baseName = groupLabel || 'Imported'

      let totalEvents = 0
      let patternsAdded = 0
      for (const pat of patterns) {
        // Build events from imported steps
        const newEvents: import('../../types').SequenceEvent[] = []
        for (const step of pat.steps) {
          const padId = padIndexToId?.get(step.padIndex)
          if (!padId) continue
          newEvents.push({
            id: uid(),
            step: step.step,
            padId,
            velocity: step.velocity,
            gate: 1,
          })
        }
        if (newEvents.length > 0) {
          // Always append as a new pattern
          const newPattern = createDefaultSequence()
          newPattern.name = `${baseName} ${patternsAdded + 1}`
          newPattern.events = newEvents
          updatedSequences.push(newPattern)
          totalEvents += newEvents.length
          patternsAdded++
        }
      }

      if (totalEvents > 0) {
        await ctx.get().saveProject({ ...project, pads: project.pads, sequences: updatedSequences })
        ctx.get().addToast(`Imported ${totalEvents} events into ${patternsAdded} new pattern${patternsAdded !== 1 ? 's' : ''}`, 'success')
      }
    } catch (e) {
      console.warn('Failed to import sequencer patterns', e)
    }
  },

  // Import patterns for a group by runId (looks up assigned pads automatically)
  importPatternsForGroupByRunId: async (runId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
    const patternSource = groupSamples.find((sam) => sam.autosamplePatterns)
    if (!patternSource?.autosamplePatterns) {
      s.addToast('No patterns found for this group')
      return
    }

    // Find pads that have samples from this group assigned
    // Build padIndex → padId based on which pads have group samples
    const sampleIds = new Set(groupSamples.map((sam) => sam.id))
    const padIndexToId = new Map<number, string>()

    // Try to use autosamplePadIndex ordering
    const padsWithGroup = s.project.pads.filter((p) => {
      return p.settings.sampleId && sampleIds.has(p.settings.sampleId)
    })

    if (padsWithGroup.length === 0) {
      s.addToast('Assign group to pads first, then import patterns')
      return
    }

    // Map: find each pad's sample → that sample's padIndex
    for (const pad of padsWithGroup) {
      const sample = groupSamples.find((sam) => sam.id === pad.settings.sampleId)
      if (sample?.autosamplePadIndex != null) {
        padIndexToId.set(sample.autosamplePadIndex, pad.id)
      }
    }

    // Fallback: if no autosamplePadIndex, use sequential order
    if (padIndexToId.size === 0) {
      const sorted = [...padsWithGroup].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
      sorted.forEach((p, i) => padIndexToId.set(i, p.id))
    }

    await ctx.get().importPatternsForGroup(patternSource.autosamplePatterns, padIndexToId, patternSource.autosampleRunLabel)
  },

  renameAutosampleGroup: (runId: string, newLabel: string) => {
    ctx.set((d) => {
      for (const s of d.samples) {
        if (s.autosampleRunId === runId) s.autosampleRunLabel = newLabel
      }
    })
    // Persist updated samples to DB
    const samples = ctx.get().samples.filter((s) => s.autosampleRunId === runId)
    for (const sample of samples) void db.putSample(sample)
  },

  updateAutosampleGroupSettings: (runId: string, patch: { bus?: BusId; chokeGroup?: number }) => {
    // Update metadata on samples
    ctx.set((d) => {
      for (const s of d.samples) {
        if (s.autosampleRunId === runId) {
          if (patch.bus !== undefined) s.autosampleBus = patch.bus
          if (patch.chokeGroup !== undefined) s.autosampleChokeGroup = patch.chokeGroup
        }
      }
    })
    const samples = ctx.get().samples.filter((s) => s.autosampleRunId === runId)
    for (const sample of samples) void db.putSample(sample)
    // Update pads that use these samples
    const s = ctx.get()
    if (!s.project) return
    const sampleIds = new Set(samples.map((x) => x.id))
    const updatedPads = s.project.pads.map((p) => {
      if (!p.settings.sampleId || !sampleIds.has(p.settings.sampleId)) return p
      const padPatch: Record<string, unknown> = {}
      if (patch.bus !== undefined) padPatch.bus = patch.bus
      if (patch.chokeGroup !== undefined) padPatch.chokeGroup = patch.chokeGroup
      if (Object.keys(padPatch).length === 0) return p
      return { ...p, settings: { ...p.settings, ...padPatch } }
    })
    s.saveProjectLight({ ...s.project, pads: updatedPads })
  },

  deleteAutosampleGroup: async (runId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const groupSamples = s.samples.filter((sam) => sam.autosampleRunId === runId)
    if (groupSamples.length === 0) return
    const label = groupSamples[0].autosampleRunLabel || 'this group'
    if (!(await showConfirm(`Delete all ${groupSamples.length} samples in "${label}" and reset assigned pads?`))) return

    const groupIds = new Set(groupSamples.map((sam) => sam.id))

    // Delete from DB
    for (const sam of groupSamples) {
      await db.deleteSample(sam.id)
      await db.deleteWaveformPeaksBySampleId(sam.id)
    }

    // Remove from store
    ctx.set((d) => {
      d.samples = d.samples.filter((sam) => !groupIds.has(sam.id))
      for (const id of groupIds) {
        d.sampleMap.delete(id)
        d.favoriteSampleIds.delete(id)
      }
      const nextPeaks = { ...d.libraryWavePeaks }
      for (const id of groupIds) delete nextPeaks[id]
      d.libraryWavePeaks = nextPeaks
    })

    // Reset pads that reference any sample in the group
    const padsNeedReset = s.project.pads.some(
      (p) => (p.settings.sampleId && groupIds.has(p.settings.sampleId)) ||
        p.settings.layers.some((l) => groupIds.has(l.sampleId)),
    )
    if (padsNeedReset) {
      await s.saveProject({
        ...s.project,
        pads: s.project.pads.map((p) => {
          const hasPrimary = p.settings.sampleId && groupIds.has(p.settings.sampleId)
          const hasLayer = p.settings.layers.some((l) => groupIds.has(l.sampleId))
          if (!hasPrimary && !hasLayer) return p
          return {
            ...p,
            name: `${midiToName(p.midiNote)} Pad`,
            settings: {
              ...p.settings,
              sampleId: hasPrimary ? null : p.settings.sampleId,
              layers: hasLayer ? p.settings.layers.filter((l) => !groupIds.has(l.sampleId)) : p.settings.layers,
              gain: hasPrimary ? 1 : p.settings.gain,
              semitones: hasPrimary ? 0 : p.settings.semitones,
              fineCents: hasPrimary ? 0 : p.settings.fineCents,
              trim: hasPrimary ? { start: 0, end: 1 } : p.settings.trim,
              midiOut: hasPrimary ? undefined : p.settings.midiOut,
            },
          }
        }),
      })
    }
  },

  exportAutosampleGroupZip: async (runId: string) => {
    const samples = ctx.get().samples.filter((s) => s.autosampleRunId === runId)
    if (samples.length === 0) return
    const label = samples[0].autosampleRunLabel || 'autosample'
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    for (const sample of samples) {
      zip.file(sample.name, sample.blob)
    }
    const metadata = {
      label,
      samples: samples.map((s) => ({
        name: s.name,
        autosampleTrim: s.autosampleTrim ?? null,
        autosampleBus: s.autosampleBus ?? null,
        autosampleChokeGroup: s.autosampleChokeGroup ?? null,
        autosamplePadIndex: s.autosamplePadIndex ?? null,
        autosampleMpc: s.autosampleMpc ?? false,
      })),
    }
    zip.file('metadata.json', JSON.stringify(metadata, null, 2))
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${label}.zip`
    a.click()
    URL.revokeObjectURL(url)
  },
})
