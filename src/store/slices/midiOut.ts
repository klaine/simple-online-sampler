import type { MidiOutConfig } from '../../types'
import type { StoreContext } from '../context'

export const createMidiOutActions = (ctx: StoreContext) => ({
  updatePadMidiOut: async (padId: string, patch: Partial<MidiOutConfig>) => {
    const s = ctx.get()
    if (!s.project) return
    const existing = s.project.pads.find((p) => p.id === padId)
    if (!existing) return
    const currentMidiOut: MidiOutConfig = existing.settings.midiOut ?? {
      enabled: false,
      deviceId: null,
      channel: 1,
      note: existing.midiNote,
      velocity: -1,
    }
    s.saveProjectLight({
      ...s.project,
      pads: s.project.pads.map((p) =>
        p.id === padId
          ? { ...p, settings: { ...p.settings, midiOut: { ...currentMidiOut, ...patch } } }
          : p,
      ),
    })
  },
})
