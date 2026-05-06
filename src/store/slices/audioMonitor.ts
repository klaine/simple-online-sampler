import type { BusId } from '../../types'
import type { StoreContext } from '../context'

export const createAudioMonitorActions = (ctx: StoreContext) => ({
  setAudioMonitorEnabled: (enabled: boolean) => {
    ctx.set((d) => { d.audioMonitorEnabled = enabled })
  },
  setAudioMonitorDeviceId: (id: string | null) => {
    ctx.set((d) => { d.audioMonitorDeviceId = id })
  },
  setAudioMonitorBusId: (busId: BusId) => {
    ctx.set((d) => { d.audioMonitorBusId = busId })
  },
})
