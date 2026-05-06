import { uid } from '../../lib/utils'
import { mutableRefs } from '../refs'
import type { ToastType } from '../types'
import type { StoreContext } from '../context'

export const createUiActions = (ctx: StoreContext) => ({
  commitBpmDraft: async () => {
    const s = ctx.get()
    if (!s.project) return
    const parsed = Number(s.bpmDraft)
    if (!Number.isFinite(parsed)) {
      ctx.set((d) => { d.bpmDraft = String(s.project!.bpm) })
      return
    }
    const bpm = Math.max(50, Math.min(200, Math.round(parsed)))
    ctx.set((d) => { d.bpmDraft = String(bpm) })
    await ctx.get().saveProjectLight({ ...s.project, bpm }, true)
  },

  commitSwingDraft: async () => {
    const s = ctx.get()
    if (!s.project) return
    const parsed = Number(s.swingDraft)
    if (!Number.isFinite(parsed)) {
      ctx.set((d) => { d.swingDraft = String(s.project!.swing ?? 0) })
      return
    }
    const swing = Math.max(0, Math.min(100, Math.round(parsed)))
    ctx.set((d) => { d.swingDraft = String(swing) })
    await ctx.get().saveProjectLight({ ...s.project, swing }, true)
  },

  tapTempo: () => {
    const now = performance.now()
    const s = ctx.get()
    if (mutableRefs.tapTimestamps.length > 0 && now - mutableRefs.tapTimestamps[mutableRefs.tapTimestamps.length - 1] > 2000) {
      mutableRefs.tapTimestamps.length = 0
    }
    mutableRefs.tapTimestamps.push(now)
    if (mutableRefs.tapTimestamps.length > 8) mutableRefs.tapTimestamps.splice(0, mutableRefs.tapTimestamps.length - 8)
    if (mutableRefs.tapTimestamps.length < 2) return

    const intervals: number[] = []
    for (let i = 1; i < mutableRefs.tapTimestamps.length; i++) {
      intervals.push(mutableRefs.tapTimestamps[i] - mutableRefs.tapTimestamps[i - 1])
    }
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const bpm = Math.max(50, Math.min(200, Math.round(60000 / avgMs)))
    ctx.set((d) => { d.bpmDraft = String(bpm) })
    if (s.project) {
      void ctx.get().saveProjectLight({ ...s.project, bpm }, true)
    }
  },

  commitProjectNameDraft: async () => {
    const s = ctx.get()
    if (!s.project) return
    const nextName = s.projectNameDraft.trim()
    if (!nextName) {
      ctx.set((d) => { d.projectNameDraft = s.project!.name })
      return
    }
    if (nextName === s.project.name) {
      ctx.set((d) => { d.projectNameDraft = nextName })
      return
    }
    await ctx.get().saveProject({ ...s.project, name: nextName })
    await ctx.get().refreshProjectList()
  },

  addToast: (message: string, type: ToastType = 'info') => {
    const id = uid()
    ctx.set((d) => { d.toasts.push({ id, message, type }) })
    window.setTimeout(() => { ctx.get().removeToast(id) }, 4000)
  },

  removeToast: (id: string) => {
    ctx.set((d) => { d.toasts = d.toasts.filter((t) => t.id !== id) })
  },

  exportAllMidi: () => {},
  exportPack: async () => {},
  exportStandalonePage: async () => {},
  exportAudio: async (_mode: 'pattern' | 'song') => {},
  previewImport: async () => {},
  runImport: async () => {},
})
