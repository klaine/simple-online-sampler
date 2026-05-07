import type { BusId, EffectSlot, EffectType, MixBus } from '../../types'
import { getDefaultEffectParams } from '../helpers'
import { BANK_COUNT } from '../../lib/constants'
import type { StoreContext } from '../context'

export const createMixerActions = (ctx: StoreContext) => ({
  setBusName: (busId: BusId, name: string) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) =>
        b.id === busId ? { ...b, name } : b,
      ) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBankName: (bankIndex: number, name: string) => {
    const s = ctx.get()
    if (!s.project) return
    const names = [...(s.project.bankNames ?? Array.from({ length: BANK_COUNT }, (_, i) => `Bank ${i + 1}`))]
    names[bankIndex] = name
    ctx.get().saveProjectLight({ ...s.project, bankNames: names })
  },

  setBusGain: (busId: BusId, gain: number) => {
    const s = ctx.get()
    if (!s.project) return
    const clamped = Math.max(0, Math.min(2, gain))
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) =>
        b.id === busId ? { ...b, gain: clamped } : b,
      ) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusPan: (busId: BusId, pan: number) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) =>
        b.id === busId ? { ...b, pan: Math.max(-1, Math.min(1, pan)) } : b,
      ) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusMute: (busId: BusId, mute: boolean) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) =>
        b.id === busId ? { ...b, mute } : b,
      ) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusSolo: (busId: BusId, solo: boolean) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) =>
        b.id === busId ? { ...b, solo } : b,
      ) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusEffectType: (busId: BusId, slotIndex: number, effectType: EffectType) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) => {
        if (b.id !== busId) return b
        const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], type: effectType, params: effectType === 'off' ? {} : getDefaultEffectParams(effectType) }
        return { ...b, effects }
      }) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusEffectEnabled: (busId: BusId, slotIndex: number, enabled: boolean) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) => {
        if (b.id !== busId) return b
        const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], enabled }
        return { ...b, effects }
      }) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusEffectParam: (busId: BusId, slotIndex: number, paramName: string, value: number) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) => {
        if (b.id !== busId) return b
        const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], params: { ...effects[slotIndex].params, [paramName]: value } }
        return { ...b, effects }
      }) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setBusEffectSidechainSource: (busId: BusId, slotIndex: number, source: BusId) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      mixBuses: s.project.mixBuses.map((b) => {
        if (b.id !== busId) return b
        const effects = [...b.effects] as [EffectSlot, EffectSlot, EffectSlot]
        effects[slotIndex] = { ...effects[slotIndex], sidechainSource: source }
        return { ...b, effects }
      }) as [MixBus, MixBus, MixBus, MixBus],
    })
  },

  setMasterGain: (gain: number) => {
    const s = ctx.get()
    if (!s.project) return
    ctx.get().saveProjectLight({
      ...s.project,
      masterBus: { ...s.project.masterBus, gain: Math.max(0, Math.min(2, gain)) },
    })
  },

  setMasterEffectType: (slotIndex: number, effectType: EffectType) => {
    const s = ctx.get()
    if (!s.project) return
    const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
    effects[slotIndex] = { ...effects[slotIndex], type: effectType, params: effectType === 'off' ? {} : getDefaultEffectParams(effectType) }
    ctx.get().saveProjectLight({
      ...s.project,
      masterBus: { ...s.project.masterBus, effects },
    })
  },

  setMasterEffectEnabled: (slotIndex: number, enabled: boolean) => {
    const s = ctx.get()
    if (!s.project) return
    const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
    effects[slotIndex] = { ...effects[slotIndex], enabled }
    ctx.get().saveProjectLight({
      ...s.project,
      masterBus: { ...s.project.masterBus, effects },
    })
  },

  setMasterEffectParam: (slotIndex: number, paramName: string, value: number) => {
    const s = ctx.get()
    if (!s.project) return
    const effects = [...s.project.masterBus.effects] as [EffectSlot, EffectSlot, EffectSlot]
    effects[slotIndex] = { ...effects[slotIndex], params: { ...effects[slotIndex].params, [paramName]: value } }
    ctx.get().saveProjectLight({
      ...s.project,
      masterBus: { ...s.project.masterBus, effects },
    })
  },
})
