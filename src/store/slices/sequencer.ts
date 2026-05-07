import { uid, clampSequenceLength } from '../../lib/utils'
import { selectActiveSequence, selectCurrentBankPads, selectVisibleSequence } from '../selectors'
import { showConfirm } from '../confirmDialog'
import { mutableRefs } from '../refs'
import type { Project, SequenceResolution } from '../../types'
import type { StoreContext } from '../context'

const historySnapshotFrom = (state: Project, sequenceId: string | null): import('../types').SequencerHistorySnapshot => ({
  sequences: state.sequences,
  songChain: state.songChain,
  songLoopStart: state.songLoopStart,
  songLoopEnd: state.songLoopEnd,
  activeSequenceId: sequenceId,
})

export const createSequencerActions = (ctx: StoreContext) => ({
  pushSequencerHistory: (state: Project, sequenceId: string | null) => {
    if (ctx.get().historySilenced) return
    ctx.set((s) => {
      const snap = historySnapshotFrom(state, sequenceId)
      s.historyPast = [...s.historyPast, snap].slice(-50)
      s.historyFuture = []
    })
  },

  beginDragHistoryCapture: () => {
    const s = ctx.get()
    if (mutableRefs.dragHistoryCaptured || !s.project) return
    mutableRefs.dragHistoryCaptured = true
    s.pushSequencerHistory(s.project, s.activeSequenceId)
  },

  finishDragHistoryCapture: () => {
    mutableRefs.dragHistoryCaptured = false
  },

  toggleStep: async (step: number, padId: string) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    s.pushSequencerHistory(s.project, activeSeq.id)

    const existing = activeSeq.events.find((e) => e.step === step && e.padId === padId)
    const events = existing
      ? activeSeq.events.filter((e) => e.id !== existing.id)
      : [...activeSeq.events, { id: uid(), step, padId, velocity: 112, gate: 1, semitones: 0 }]

    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, events } : seq,
      ),
    })
  },

  undoSequencer: async () => {
    const s = ctx.get()
    if (!s.project || s.historyPast.length === 0) return

    const previous = s.historyPast[s.historyPast.length - 1]
    const current = historySnapshotFrom(s.project, s.activeSequenceId)
    ctx.set((d) => {
      d.historySilenced = true
      d.historyPast = d.historyPast.slice(0, -1)
      d.historyFuture = [...d.historyFuture, current]
    })
    const proj = ctx.get().project!
    await ctx.get().saveProject({
      ...proj,
      sequences: previous.sequences,
      songChain: previous.songChain,
      songLoopStart: previous.songLoopStart,
      songLoopEnd: previous.songLoopEnd,
    })
    ctx.set((d) => {
      d.activeSequenceId = previous.activeSequenceId
      d.historySilenced = false
    })
    mutableRefs.dragHistoryCaptured = false
  },

  redoSequencer: async () => {
    const s = ctx.get()
    if (!s.project || s.historyFuture.length === 0) return

    const next = s.historyFuture[s.historyFuture.length - 1]
    const current = historySnapshotFrom(s.project, s.activeSequenceId)
    ctx.set((d) => {
      d.historySilenced = true
      d.historyFuture = d.historyFuture.slice(0, -1)
      d.historyPast = [...d.historyPast, current]
    })
    const proj = ctx.get().project!
    await ctx.get().saveProject({
      ...proj,
      sequences: next.sequences,
      songChain: next.songChain,
      songLoopStart: next.songLoopStart,
      songLoopEnd: next.songLoopEnd,
    })
    ctx.set((d) => {
      d.activeSequenceId = next.activeSequenceId
      d.historySilenced = false
    })
    mutableRefs.dragHistoryCaptured = false
  },

  clearLane: async (padId: string) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return
    if (!(await showConfirm('Clear this lane events?'))) return

    s.pushSequencerHistory(s.project, activeSeq.id)
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id
          ? { ...seq, events: seq.events.filter((e) => e.padId !== padId) }
          : seq,
      ),
    })
  },

  duplicateLaneToNext: async (padId: string) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    s.pushSequencerHistory(s.project, activeSeq.id)
    const ordered = selectCurrentBankPads(s).sort((a, b) => a.midiNote - b.midiNote)
    const index = ordered.findIndex((p) => p.id === padId)
    if (index < 0 || index >= ordered.length - 1) return

    const targetPadId = ordered[index + 1].id
    const cloned = activeSeq.events
      .filter((e) => e.padId === padId)
      .map((e) => ({ ...e, id: uid(), padId: targetPadId }))

    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id
          ? { ...seq, events: [...seq.events.filter((e) => e.padId !== targetPadId), ...cloned] }
          : seq,
      ),
    })
  },

  laneToolFill: async (padId: string, interval: number) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    s.pushSequencerHistory(s.project, activeSeq.id)
    const existingMap = new Map(
      activeSeq.events.filter((e) => e.padId === padId).map((e) => [e.step, e]),
    )
    const generated = Array.from({ length: activeSeq.lengthSteps }, (_, step) => step)
      .filter((step) => step % interval === 0)
      .map((step) => existingMap.get(step) ?? { id: uid(), step, padId, velocity: 112, gate: 1, semitones: 0 })

    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id
          ? { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...generated] }
          : seq,
      ),
    })
  },

  laneToolShift: async (padId: string, direction: -1 | 1) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    s.pushSequencerHistory(s.project, activeSeq.id)
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) => {
        if (seq.id !== activeSeq.id) return seq
        const shifted = seq.events
          .filter((e) => e.padId === padId)
          .map((e) => ({ ...e, step: (e.step + direction + seq.lengthSteps) % seq.lengthSteps }))
        return { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...shifted] }
      }),
    })
  },

  laneToolRandom: async (padId: string) => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return

    s.pushSequencerHistory(s.project, activeSeq.id)
    const randomEvents = Array.from({ length: activeSeq.lengthSteps }, (_, step) => step)
      .filter(() => Math.random() > 0.7)
      .map((step) => ({ id: uid(), step, padId, velocity: Math.floor(80 + Math.random() * 47), gate: 1, semitones: 0 }))

    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id
          ? { ...seq, events: [...seq.events.filter((e) => e.padId !== padId), ...randomEvents] }
          : seq,
      ),
    })
  },

  duplicatePatternLength: async (mode: 'double' | 'half') => {
    const s = ctx.get()
    const activeSeq = selectActiveSequence(s)
    if (!s.project || !activeSeq) return
    if (
      !(await showConfirm(
        mode === 'double'
          ? 'Duplicate pattern length and copy events?'
          : 'Halve pattern length and truncate out-of-range events?',
      ))
    )
      return

    s.pushSequencerHistory(s.project, activeSeq.id)
    const nextLength =
      mode === 'double'
        ? clampSequenceLength(Math.min(64, activeSeq.lengthSteps * 2))
        : clampSequenceLength(Math.max(8, Math.floor(activeSeq.lengthSteps / 2)))

    const nextEvents =
      mode === 'double'
        ? [
            ...activeSeq.events,
            ...activeSeq.events
              .map((e) => ({ ...e, id: uid(), step: e.step + activeSeq.lengthSteps }))
              .filter((e) => e.step < nextLength),
          ]
        : activeSeq.events.filter((e) => e.step < nextLength)

    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === activeSeq.id ? { ...seq, lengthSteps: nextLength, events: nextEvents } : seq,
      ),
    })
  },

  toggleLaneMute: (padId: string) => {
    ctx.set((s) => {
      const next = new Set(s.mutedLanePadIds)
      if (next.has(padId)) next.delete(padId)
      else next.add(padId)
      s.mutedLanePadIds = next
    })
  },

  toggleSeqBankCollapsed: (bank: number) => {
    ctx.set((s) => {
      const expanded = new Set(s.seqExpandedBanks)
      const collapsed = new Set(s.seqCollapsedBanks)
      if (collapsed.has(bank)) {
        // User is expanding a collapsed bank
        collapsed.delete(bank)
        expanded.add(bank)
      } else if (expanded.has(bank)) {
        // User is collapsing an expanded bank
        expanded.delete(bank)
        collapsed.add(bank)
      } else {
        // No explicit state — toggle from default
        // Default: collapsed if no events, expanded if has events
        // So toggling means: if it was showing (has events), collapse it; if hidden (no events), expand it
        const state = ctx.get()
        const visibleSeq = selectVisibleSequence(state)
        const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
        const bankPads = state.project?.pads.filter((p) => p.bank === bank) ?? []
        const hasEvents = bankPads.some((p) => activePadIds.has(p.id))
        if (hasEvents) {
          collapsed.add(bank)
        } else {
          expanded.add(bank)
        }
      }
      s.seqExpandedBanks = expanded
      s.seqCollapsedBanks = collapsed
    })
  },

  setSequenceResolution: async (resolution: SequenceResolution) => {
    const s = ctx.get()
    const visible = selectVisibleSequence(s)
    if (!s.project || !visible) return
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === visible.id ? { ...seq, resolution } : seq,
      ),
    })
  },

  setSequenceLength: async (lengthSteps: number) => {
    const s = ctx.get()
    const visible = selectVisibleSequence(s)
    if (!s.project || !visible) return
    const length = clampSequenceLength(lengthSteps)
    await s.saveProject({
      ...s.project,
      sequences: s.project.sequences.map((seq) =>
        seq.id === visible.id
          ? { ...seq, lengthSteps: length, events: seq.events.filter((e) => e.step < length) }
          : seq,
      ),
    })
  },

  commitSequenceLengthDraft: async () => {
    const parsed = Number(ctx.get().sequenceLengthDraft)
    if (!Number.isFinite(parsed)) {
      const visible = selectVisibleSequence(ctx.get())
      if (visible) ctx.set((s) => { s.sequenceLengthDraft = String(visible.lengthSteps) })
      return
    }
    await ctx.get().setSequenceLength(parsed)
  },
})
