import type { Pad, SynthPatch } from '../../types'
import { uid } from '../../lib/utils'
import { saveSynthPatches } from '../helpers'
import { showConfirm } from '../confirmDialog'
import type { StoreContext } from '../context'

export const createSynthPatchActions = (ctx: StoreContext) => ({
  saveSynthPatch: (name: string, pad: Pad) => {
    const s = pad.settings
    const defaultSynth = { harmonics: [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], baseNote: 60, filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3, depth: 48 }, lfo: { waveform: 'sine' as const, rateMode: 'free' as const, rateHz: 4, rateSyncDiv: 4, pitchDepth: 0, filterDepth: 0, gainDepth: 0, pwDepth: 0, triggerMode: 'free' as const } }
    const patch: SynthPatch = {
      id: uid(),
      name,
      createdAt: Date.now(),
      params: s.synthParams ?? defaultSynth,
      padSettings: {
        mode: s.mode,
        envelope: { ...s.envelope },
        filterType: s.filterType,
        filterFreq: s.filterFreq,
        filterQ: s.filterQ,
        gain: s.gain,
        semitones: s.semitones,
        fineCents: s.fineCents,
        synthMode: s.synthParams?.synthMode ?? 'additive',
        polyMode: s.synthParams?.polyMode ?? 'poly',
        glide: s.synthParams?.va?.glide ?? 0,
      },
    }
    ctx.set((d) => {
      d.synthPatches = [...d.synthPatches, patch]
    })
    saveSynthPatches([...ctx.get().synthPatches])
    ctx.get().addToast(`Saved patch "${name}"`, 'success')
  },

  deleteSynthPatch: async (patchId: string) => {
    const patch = ctx.get().synthPatches.find((p) => p.id === patchId)
    if (!patch) return
    if (!(await showConfirm(`Delete synth patch "${patch.name}"?`))) return
    ctx.set((d) => {
      d.synthPatches = d.synthPatches.filter((p) => p.id !== patchId)
    })
    saveSynthPatches(ctx.get().synthPatches)
  },

  applySynthPatchToPad: (patch: SynthPatch, padId: string) => {
    const project = ctx.get().project
    if (!project) return
    ctx.set((d) => {
      const pad = d.project!.pads.find((p) => p.id === padId)
      if (!pad) return
      pad.settings.source = 'synth'
      pad.settings.synthParams = {
        ...patch.params,
        synthMode: patch.padSettings.synthMode ?? patch.params.synthMode ?? 'additive',
        polyMode: patch.padSettings.polyMode ?? patch.params.polyMode ?? 'poly',
        va: patch.params.va ?? (patch.padSettings.synthMode === 'va' ? {
          osc1: { waveform: 'saw', pulseWidth: 0.5, semitones: 0, fineCents: 0, level: 0.8 },
          osc2: { waveform: 'square', pulseWidth: 0.5, semitones: 0, fineCents: 0, level: 0.6 },
          oscSync: false, oscMix: 0, glide: patch.padSettings.glide ?? 0,
        } : undefined),
      }
      pad.settings.mode = patch.padSettings.mode
      pad.settings.envelope = { ...patch.padSettings.envelope, sustain: ((patch.padSettings.envelope as unknown) as Record<string, unknown>).sustain as number | undefined ?? 0 }
      pad.settings.filterType = patch.padSettings.filterType
      pad.settings.filterFreq = patch.padSettings.filterFreq
      pad.settings.filterQ = patch.padSettings.filterQ
      pad.settings.gain = patch.padSettings.gain
      pad.settings.semitones = patch.padSettings.semitones
      pad.settings.fineCents = patch.padSettings.fineCents
    })
    void ctx.get().saveProjectLight(ctx.get().project!)
  },
})
