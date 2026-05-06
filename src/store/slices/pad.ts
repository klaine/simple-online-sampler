import { audioEngine } from '../../lib/audioEngine'
import { db } from '../../lib/db'
import { arrayBufferToHex, midiToName, uid } from '../../lib/utils'
import type { Pad, SampleAsset, SampleLayer, BusId } from '../../types'
import { sendMidiNote, registerActiveNote } from '../../lib/midiOut'
import { notifyPadTriggered as notifyLaunchpad } from '../../lib/launchpadProMk3'
import { selectSelectedPad, selectSelectedLayer } from '../selectors'
import { createLayer } from '../helpers'
import { showConfirm } from '../confirmDialog'
import type { StoreContext } from '../context'

export const createPadActions = (ctx: StoreContext) => ({
  triggerPad: (pad: Pad, velocity = 1) => {
    if (pad.settings.mute) return
    // Collect all sample IDs that might be needed (primary + layers)
    const neededSampleIds: string[] = []
    if (pad.settings.sampleId) neededSampleIds.push(pad.settings.sampleId)
    for (const layer of pad.settings.layers ?? []) {
      if (layer.sampleId) neededSampleIds.push(layer.sampleId)
    }

    // Start unlock synchronously in the user gesture callstack (critical for iOS)
    const unlockP = audioEngine.unlockAndPrepare()

    const audioCtx = audioEngine.getContextIfReady()
    if (!audioCtx || audioCtx.state !== 'running') {
      // No context yet or suspended — use async path to unlock + decode + play
      void (async () => {
        await unlockP
        for (const sid of neededSampleIds) {
          if (!audioEngine.hasSample(sid)) {
            const sample = ctx.get().sampleMap.get(sid)
            if (sample) await audioEngine.registerSample(sample)
          }
        }
        audioEngine.playPad(pad, velocity, { bpm: ctx.get().project?.bpm })
      })()
    } else {
      // Hot path: check if all needed samples are loaded
      const missing = neededSampleIds.filter((sid) => !audioEngine.hasSample(sid))
      if (missing.length > 0) {
        // Must go async to decode missing buffers
        void (async () => {
          await unlockP
          for (const sid of missing) {
            const sample = ctx.get().sampleMap.get(sid)
            if (sample) await audioEngine.registerSample(sample)
          }
          audioEngine.playPad(pad, velocity, { bpm: ctx.get().project?.bpm })
        })()
      } else {
        audioEngine.playPad(pad, velocity, { bpm: ctx.get().project?.bpm })
      }
    }

    // Sequencer live recording
    const st = ctx.get()
    if (st.seqRecordArmed && st.isPlaying) {
      st.recordPadHit(pad.id, Math.round(velocity * 127))
    }

    // MIDI out
    const midiOut = pad.settings.midiOut
    if (midiOut?.enabled) {
      const note = midiOut.note
      const vel = midiOut.velocity < 0
        ? Math.max(1, Math.min(127, Math.round(velocity * 127)))
        : midiOut.velocity
      // Always: note-on now, note-off fired by releaseMidiNote when pad is released
      // (works for trigger, gate, and adsr modes — MIDI note held as long as pad is held)
      sendMidiNote(midiOut.deviceId, midiOut.channel, note, vel, null)
      registerActiveNote(pad.id, midiOut.deviceId, midiOut.channel, note)
    }

    // Notify Launchpad Pro MK3 (if connected)
    notifyLaunchpad(pad.id)
  },

  updatePadSettings: (patch: Partial<Pad['settings']>) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return

    // If a layer is selected, route overridable fields to the layer
    const layer = selectSelectedLayer(s)
    if (layer) {
      const layerPatch: Partial<SampleLayer> = {}
      let hasPadPatch = false
      const padPatch: Partial<Pad['settings']> = {}

      const LAYER_FIELDS = ['gain', 'semitones', 'fineCents', 'trim', 'envelope', 'filterType', 'filterFreq', 'filterQ', 'stackOffsetMs'] as const
      for (const key of LAYER_FIELDS) {
        if (key in patch) {
          (layerPatch as any)[key] = (patch as any)[key]
        }
      }
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (!(LAYER_FIELDS as readonly string[]).includes(key)) {
          (padPatch as any)[key] = (patch as any)[key]
          hasPadPatch = true
        }
      }

      if (Object.keys(layerPatch).length > 0) {
        ctx.get().updateLayerSettings(layer.id, layerPatch)
      }
      if (hasPadPatch) {
        s.saveProjectLight({
          ...s.project,
          pads: s.project.pads.map((p) =>
            p.id === pad.id ? { ...p, settings: { ...p.settings, ...padPatch } } : p,
          ),
        })
      }
      return
    }

    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === pad.id ? { ...p, settings: { ...p.settings, ...patch } } : p,
      ),
    })

    // Live-update filter params on active voices
    if ('filterType' in patch || 'filterFreq' in patch || 'filterQ' in patch || 'filterFreq2' in patch) {
      const merged = { ...pad.settings, ...patch }
      audioEngine.updateActiveFilters(pad.id, merged.filterType, merged.filterFreq, merged.filterQ, merged.filterFreq2)
    }
  },

  assignFileToPad: async (pad: Pad, file: File) => {
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
      ctx.set((s) => {
        s.samples = [...s.samples, sample]
        s.sampleMap.set(sample.id, sample)
      })
    } else if (!audioEngine.hasSample(sample.id)) {
      await audioEngine.registerSample(sample)
    }

    const { project } = ctx.get()
    if (!project) return

    // If pad already has a sample assigned, show replace-or-layer prompt
    if (pad.settings.sampleId && pad.settings.sampleId !== sample.id) {
      ctx.set((d) => { d.sampleAssignPrompt = { padId: pad.id, sample } })
      return
    }

    await ctx.get().saveProject({
      ...project,
      pads: project.pads.map((item) =>
        item.id === pad.id
          ? {
              ...item,
              name: file.name.replace(/\.[^/.]+$/, ''),
              settings: { ...item.settings, sampleId: sample.id },
            }
          : item,
      ),
    })
  },

  assignSampleToPad: async (sample: SampleAsset, padId: string) => {
    const { project } = ctx.get()
    if (!project) return
    const pad = project.pads.find((p) => p.id === padId)
    if (pad?.settings.sampleId && pad.settings.sampleId !== sample.id) {
      ctx.set((d) => { d.sampleAssignPrompt = { padId, sample } })
      return
    }
    await ctx.get().saveProject({
      ...project,
      pads: project.pads.map((p) =>
        p.id === padId
          ? { ...p, name: sample.name, settings: { ...p.settings, sampleId: sample.id } }
          : p,
      ),
    })
  },

  assignSampleToSelectedPad: async (sample: SampleAsset) => {
    const pad = selectSelectedPad(ctx.get())
    if (!pad) return
    await ctx.get().assignSampleToPad(sample, pad.id)
  },

  addLayerFile: async (file: File) => {
    const pad = selectSelectedPad(ctx.get())
    if (!pad) return

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
      ctx.set((s) => {
        s.samples = [...s.samples, sample]
        s.sampleMap.set(sample.id, sample)
      })
    } else if (!audioEngine.hasSample(sample.id)) {
      await audioEngine.registerSample(sample)
    }

    ctx.get().addLayerSample(sample)
  },

  addLayerSample: (sample: SampleAsset) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return

    const newLayer = createLayer(sample.id)

    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === pad.id
          ? { ...p, settings: { ...p.settings, layers: [...p.settings.layers, newLayer] } }
          : p,
      ),
    })
  },

  removeLayer: (layerId: string) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return

    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === pad.id
          ? { ...p, settings: { ...p.settings, layers: p.settings.layers.filter((l) => l.id !== layerId) } }
          : p,
      ),
    })
  },

  updateLayerVelocity: (layerId: string, low: number, high: number) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return

    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === pad.id
          ? {
              ...p,
              settings: {
                ...p.settings,
                layers: p.settings.layers.map((l) =>
                  l.id === layerId ? { ...l, velocityLow: low, velocityHigh: high } : l,
                ),
              },
            }
          : p,
      ),
    })
  },

  selectLayer: (layerId: string | null) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) {
      ctx.set((d) => { d.selectedLayerId = null })
      return
    }

    if (layerId === null) {
      ctx.set((d) => { d.selectedLayerId = null })
      return
    }

    const layer = pad.settings.layers.find((l) => l.id === layerId)
    if (!layer) return

    // Make the selected layer's sample the pad's primary sampleId
    ctx.set((d) => { d.selectedLayerId = layerId })
    if (pad.settings.sampleId !== layer.sampleId) {
      s.saveProjectLight({
        ...s.project!,
        pads: s.project!.pads.map((p) =>
          p.id === pad.id
            ? { ...p, settings: { ...p.settings, sampleId: layer.sampleId } }
            : p,
        ),
      })
    }
  },

  updateLayerSettings: (layerId: string, patch: Partial<SampleLayer>) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return

    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === pad.id
          ? {
              ...p,
              settings: {
                ...p.settings,
                layers: p.settings.layers.map((l) =>
                  l.id === layerId ? { ...l, ...patch } : l,
                ),
              },
            }
          : p,
      ),
    })
  },

  renamePad: async (name: string) => {
    const s = ctx.get()
    const pad = selectSelectedPad(s)
    if (!pad || !s.project) return
    const nextName = name.trim()
    if (!nextName) return
    await s.saveProject({
      ...s.project,
      pads: s.project.pads.map((p) => (p.id === pad.id ? { ...p, name: nextName } : p)),
    })
  },

  resetSelectedPadName: async () => {
    const pad = selectSelectedPad(ctx.get())
    if (!pad) return
    await ctx.get().renamePad(`${midiToName(pad.midiNote)} Pad`)
  },

  resetPad: async (padId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const pad = s.project.pads.find((p) => p.id === padId)
    if (!pad) return
    if (pad.settings.sampleId || pad.settings.source === 'synth') {
      if (!(await showConfirm(`Reset pad "${pad.name}" to defaults? This will clear its sample/synth and sequencer events.`))) return
    }
    const updatedPads = s.project.pads.map((p) => {
      if (p.id !== padId) return p
      return {
        ...p,
        name: `${midiToName(p.midiNote)} Pad`,
        settings: {
          source: 'sample' as const,
          sampleId: null,
          gain: 1,
          semitones: 0,
          fineCents: 0,
          mode: 'one-shot' as const,
          trim: { start: 0, end: 1 },
          envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
          layers: [],
          multiMode: 'single' as const,
          filterType: 'off' as const,
          filterFreq: 1000,
          filterQ: 1,
          bus: 'A' as BusId,
          chokeGroup: 0,
        },
      }
    })
    // Also clear sequencer events for this pad
    const updatedSequences = s.project.sequences.map((seq) => {
      const filtered = seq.events.filter((e) => e.padId !== padId)
      return filtered.length === seq.events.length ? seq : { ...seq, events: filtered }
    })
    await s.saveProject({ ...s.project, pads: updatedPads, sequences: updatedSequences })
    s.addToast(`Pad reset to defaults`)
  },

  resetBank: async (bank: number) => {
    const s = ctx.get()
    if (!s.project) return
    const bankPads = s.project.pads.filter((p) => p.bank === bank)
    const hasContent = bankPads.some((p) => p.settings.sampleId || p.settings.source === 'synth')
    if (hasContent) {
      if (!(await showConfirm(`Reset all 16 pads in Bank ${bank + 1} to defaults? This will clear all samples/synths and sequencer events.`))) return
    }
    const bankPadIds = new Set(bankPads.map((p) => p.id))
    const updatedPads = s.project.pads.map((p) => {
      if (!bankPadIds.has(p.id)) return p
      return {
        ...p,
        name: `${midiToName(p.midiNote)} Pad`,
        settings: {
          source: 'sample' as const,
          sampleId: null,
          gain: 1,
          semitones: 0,
          fineCents: 0,
          mode: 'one-shot' as const,
          trim: { start: 0, end: 1 },
          envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
          layers: [],
          multiMode: 'single' as const,
          filterType: 'off' as const,
          filterFreq: 1000,
          filterQ: 1,
          bus: 'A' as BusId,
          chokeGroup: 0,
        },
      }
    })
    const updatedSequences = s.project.sequences.map((seq) => {
      const filtered = seq.events.filter((e) => !bankPadIds.has(e.padId))
      return filtered.length === seq.events.length ? seq : { ...seq, events: filtered }
    })
    await s.saveProject({ ...s.project, pads: updatedPads, sequences: updatedSequences })
    s.addToast(`Bank ${bank + 1} reset to defaults`)
  },
})
