import { uid } from '../../lib/utils'
import { selectActiveSequence } from '../selectors'
import type { StoreContext } from '../context'

export const createPianoRollActions = (ctx: StoreContext) => ({
  togglePianoRollExpanded: (padId: string) => {
    ctx.set((d) => {
      const next = new Set(d.expandedPianoRollPads)
      if (next.has(padId)) next.delete(padId)
      else next.add(padId)
      d.expandedPianoRollPads = next
    })
  },

  togglePianoRollNote: async (step: number, padId: string, note: number) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    ctx.get().pushSequencerHistory(s.project, activeSeq.id)

    const existing = activeSeq.events.find((e) => e.step === step && e.padId === padId && e.note === note)
    const events = existing
      ? activeSeq.events.filter((e) => e.id !== existing.id)
      : [...activeSeq.events, { id: uid(), step, padId, velocity: 100, gate: 1, note }]

    await ctx.get().saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, events } : seq,
      ),
    })
  },

  setPianoRollNoteVelocity: async (eventId: string, velocity: number) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return
    const events = activeSeq.events.map((e) =>
      e.id === eventId ? { ...e, velocity: Math.max(1, Math.min(127, velocity)) } : e,
    )
    await ctx.get().saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, events } : seq,
      ),
    })
  },

  setPianoRollNoteGate: async (eventId: string, gate: number) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return
    const events = activeSeq.events.map((e) =>
      e.id === eventId ? { ...e, gate: Math.max(1, gate) } : e,
    )
    await ctx.get().saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, events } : seq,
      ),
    })
  },

  setPianoRollNoteStartAndGate: async (eventId: string, step: number, gate: number) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return
    const events = activeSeq.events.map((e) =>
      e.id === eventId ? { ...e, step: Math.max(0, step), gate: Math.max(1, gate) } : e,
    )
    await ctx.get().saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, events } : seq,
      ),
    })
  },

  setPianoRollOctaveOffset: (padId: string, offset: number) => {
    ctx.set((d) => {
      d.pianoRollOctaveOffset = { ...d.pianoRollOctaveOffset, [padId]: offset }
    })
  },
})
