import { uid } from '../../lib/utils'
import type { SongChainEntry } from '../../types'
import type { StoreContext } from '../context'

export const createSongChainActions = (ctx: StoreContext) => ({
  addChainEntry: async (patternId: string) => {
    const s = ctx.get()
    if (!s.project) return
    s.pushUndo('Add to chain')
    ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    const entry: SongChainEntry = { id: uid(), patternId, repeats: 1 }
    await s.saveProject({ ...s.project, songChain: [...s.project.songChain, entry] })
  },

  addChainEntryAt: async (patternId: string, targetIndex: number) => {
    const s = ctx.get()
    if (!s.project) return
    s.pushUndo('Add to chain')
    ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    const entry: SongChainEntry = { id: uid(), patternId, repeats: 1 }
    const next = [...s.project.songChain]
    next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, entry)
    await s.saveProject({ ...s.project, songChain: next })
  },

  removeChainEntry: async (entryId: string) => {
    const s = ctx.get()
    if (!s.project) return
    s.pushUndo('Remove from chain')
    ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    await s.saveProject({ ...s.project, songChain: s.project.songChain.filter((e) => e.id !== entryId) })
    ctx.set((d) => { if (d.selectedChainEntryId === entryId) d.selectedChainEntryId = null })
  },

  moveChainEntry: async (dragId: string, targetId: string) => {
    const s = ctx.get()
    if (!s.project || dragId === targetId) return
    ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    const srcIdx = s.project.songChain.findIndex((e) => e.id === dragId)
    const tgtIdx = s.project.songChain.findIndex((e) => e.id === targetId)
    if (srcIdx < 0 || tgtIdx < 0) return
    const reordered = [...s.project.songChain]
    const [moved] = reordered.splice(srcIdx, 1)
    reordered.splice(tgtIdx, 0, moved)
    await s.saveProject({ ...s.project, songChain: reordered })
  },

  updateChainRepeats: async (entryId: string, repeats: number) => {
    const s = ctx.get()
    if (!s.project) return
    const nextRepeats = Math.max(1, Math.min(32, Math.round(repeats)))
    await s.saveProject({
      ...s.project,
      songChain: s.project.songChain.map((e) =>
        e.id === entryId ? { ...e, repeats: nextRepeats } : e,
      ),
    })
  },

  setSongLoopStart: async (index: number | null, skipHistory = false) => {
    const s = ctx.get()
    if (!s.project) return
    if (!skipHistory) ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    const maxIdx = Math.max(0, s.project.songChain.length - 1)
    const nextStart = index === null ? null : Math.max(0, Math.min(maxIdx, index))
    const nextEnd =
      s.project.songLoopEnd !== null && nextStart !== null && s.project.songLoopEnd < nextStart
        ? nextStart
        : s.project.songLoopEnd
    await s.saveProject({ ...s.project, songLoopStart: nextStart, songLoopEnd: nextEnd })
  },

  setSongLoopEnd: async (index: number | null, skipHistory = false) => {
    const s = ctx.get()
    if (!s.project) return
    if (!skipHistory) ctx.get().pushSequencerHistory(s.project, s.activeSequenceId)
    const maxIdx = Math.max(0, s.project.songChain.length - 1)
    const nextEnd = index === null ? null : Math.max(0, Math.min(maxIdx, index))
    const nextStart =
      s.project.songLoopStart !== null && nextEnd !== null && s.project.songLoopStart > nextEnd
        ? nextEnd
        : s.project.songLoopStart
    await s.saveProject({ ...s.project, songLoopStart: nextStart, songLoopEnd: nextEnd })
  },

  copySelectedChainEntry: () => {
    const s = ctx.get()
    if (!s.project || !s.selectedChainEntryId) return
    const entry = s.project.songChain.find((e) => e.id === s.selectedChainEntryId)
    if (!entry) return
    ctx.set((d) => { d.copiedChainPatternId = entry.patternId })
  },

  pasteChainEntry: async () => {
    const pid = ctx.get().copiedChainPatternId
    if (!pid) return
    await ctx.get().addChainEntry(pid)
  },
})
