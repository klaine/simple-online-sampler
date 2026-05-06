import type { Pad, SynthPatch } from '../../types'
import { uid } from '../../lib/utils'
import { saveSynthPatches } from '../helpers'
import { showConfirm } from '../confirmDialog'
import type { StoreContext } from '../context'

export const createSynthPatchActions = (ctx: StoreContext) => ({
  saveSynthPatch: (name: string, pad: Pad) => {
    const s = pad.settings
    const patch: SynthPatch = {
      id: uid(),
      name,
      createdAt: Date.now(),
      params: s.synthParams ?? { harmonics: [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], baseNote: 60, filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3, depth: 48 }, lfo: { waveform: 'sine', rateMode: 'free', rateHz: 4, rateSyncDiv: 4, pitchDepth: 0, filterDepth: 0, gainDepth: 0 } },
      padSettings: {
        mode: s.mode,
        envelope: { ...s.envelope },
        filterType: s.filterType,
        filterFreq: s.filterFreq,
        filterQ: s.filterQ,
        gain: s.gain,
        semitones: s.semitones,
        fineCents: s.fineCents,
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
      pad.settings.synthParams = { ...patch.params }
      pad.settings.mode = patch.padSettings.mode
      pad.settings.envelope = { ...patch.padSettings.envelope, sustain: (patch.padSettings.envelope as any).sustain ?? 0 }
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
