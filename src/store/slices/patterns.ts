import { uid } from '../../lib/utils'
import { PATTERN_COLORS_CYCLE } from '../constants'
import type { SequencePattern } from '../../types'
import type { StoreContext } from '../context'

export const createPatternActions = (ctx: StoreContext) => ({
  addSequence: async () => {
    const s = ctx.get()
    if (!s.project) return
    const sequence: SequencePattern = {
      id: uid(),
      name: `Pattern ${s.project.sequences.length + 1}`,
      color: PATTERN_COLORS_CYCLE[s.project.sequences.length % PATTERN_COLORS_CYCLE.length],
      resolution: 16,
      lengthSteps: 16,
      events: [],
    }
    await s.saveProject({ ...s.project, sequences: [...s.project.sequences, sequence] })
    ctx.set((d) => {
      d.activeSequenceId = sequence.id
      d.playingPatternId = sequence.id
    })
  },

  renamePattern: async (patternId: string, name: string) => {
    const s = ctx.get()
    if (!s.project) return
    const nextName = name.trim()
    if (!nextName) return
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === patternId ? { ...seq, name: nextName } : seq,
      ),
    })
  },

  setPatternColor: async (patternId: string, color: string) => {
    const s = ctx.get()
    if (!s.project) return
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === patternId ? { ...seq, color } : seq,
      ),
    })
  },

  duplicatePattern: async (patternId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const source = s.project.sequences.find((seq) => seq.id === patternId)
    if (!source) return
    const clone: SequencePattern = {
      ...source,
      id: uid(),
      name: `${source.name} Copy`,
      color: PATTERN_COLORS_CYCLE[s.project.sequences.length % PATTERN_COLORS_CYCLE.length],
      events: source.events.map((e) => ({ ...e, id: uid() })),
    }
    await s.saveProject({ ...s.project, sequences: [...s.project.sequences, clone] })
    ctx.set((d) => { d.activeSequenceId = clone.id })
  },

  reorderPattern: async (patternId: string, targetPatternId: string) => {
    const s = ctx.get()
    if (!s.project || patternId === targetPatternId) return
    const sequences = [...s.project.sequences]
    const srcIdx = sequences.findIndex((seq) => seq.id === patternId)
    const tgtIdx = sequences.findIndex((seq) => seq.id === targetPatternId)
    if (srcIdx === -1 || tgtIdx === -1) return
    const [moved] = sequences.splice(srcIdx, 1)
    sequences.splice(tgtIdx, 0, moved)
    await s.saveProject({ ...s.project, sequences })
  },

  deletePattern: async (patternId: string) => {
    const s = ctx.get()
    if (!s.project) return
    if (s.project.sequences.length <= 1) return // must keep at least one
    const remaining = s.project.sequences.filter((seq) => seq.id !== patternId)
    // Also remove from song chain
    const chain = s.project.songChain.filter((e) => e.patternId !== patternId)
    const needSwitch = s.activeSequenceId === patternId || s.playingPatternId === patternId
    await s.saveProject({ ...s.project, sequences: remaining, songChain: chain })
    if (needSwitch) {
      ctx.set((d) => {
        d.activeSequenceId = remaining[0].id
        d.playingPatternId = remaining[0].id
      })
    }
  },
})
