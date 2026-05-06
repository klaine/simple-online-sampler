import { PADS_PER_BANK } from '../../lib/constants'
import { midiToName } from '../../lib/utils'
import { db } from '../../lib/db'
import type { StoreContext } from '../context'

export const createChopSpreadDragActions = (ctx: StoreContext) => ({
  openChopModal: (sampleId: string) => {
    ctx.set((s) => { s.chopModalSampleId = sampleId })
  },

  closeChopModal: () => {
    ctx.set((s) => { s.chopModalSampleId = null })
  },

  updateChopPoints: async (sampleId: string, points: number[]) => {
    const sorted = [...points].sort((a, b) => a - b)
    const sample = ctx.get().sampleMap.get(sampleId)
    if (!sample) return
    const updated = { ...sample, chopPoints: sorted }
    await db.putSample(updated)
    ctx.set((s) => {
      s.sampleMap.set(sampleId, updated)
      s.samples = s.samples.map((sa) => sa.id === sampleId ? updated : sa)
    })
  },

  assignChopsToPads: async (sampleId: string, startBank: number, startSlot: number) => {
    const s = ctx.get()
    const sample = s.sampleMap.get(sampleId)
    if (!sample || !s.project) return

    const chopPts = sample.chopPoints ?? []
    // N chop points => N+1 chops; boundaries: [0, ...chopPts, 1]
    const boundaries = [0, ...chopPts, 1]
    const chopCount = boundaries.length - 1
    if (chopCount < 1) return

    // Find first unused choke group (1–8), fallback to 1
    const usedGroups = new Set(
      s.project.pads
        .filter((p) => p.settings.chokeGroup > 0)
        .map((p) => p.settings.chokeGroup),
    )
    let chokeGroup = 1
    for (let g = 1; g <= 8; g++) {
      if (!usedGroups.has(g)) { chokeGroup = g; break }
    }

    const pads = [...s.project.pads]
    let padIndex = startBank * PADS_PER_BANK + startSlot
    let assigned = 0

    for (let i = 0; i < chopCount && padIndex < pads.length; i++, padIndex++) {
      const pad = pads[padIndex]
      pads[padIndex] = {
        ...pad,
        name: `${sample.name.replace(/\.[^.]+$/, '')} chop ${i + 1}`,
        settings: {
          ...pad.settings,
          sampleId: sample.id,
          trim: { start: boundaries[i], end: boundaries[i + 1] },
          chokeGroup,
        },
      }
      assigned++
    }

    await s.saveProject({ ...s.project, pads })
    ctx.set((d) => { d.chopModalSampleId = null })
    ctx.get().addToast(`Assigned ${assigned} chop${assigned > 1 ? 's' : ''} to pads (choke group ${chokeGroup})`)
  },

  openChromaticSpread: (sampleId: string) => {
    ctx.set((s) => { s.chromaticSpreadSampleId = sampleId })
  },

  closeChromaticSpread: () => {
    ctx.set((s) => { s.chromaticSpreadSampleId = null })
  },

  spreadSampleChromatically: async (sampleId: string, startBank: number, startSlot: number, count: number, chokeGroup: number) => {
    const s = ctx.get()
    const sample = s.sampleMap.get(sampleId)
    if (!sample || !s.project) return

    const pads = [...s.project.pads]
    let padIndex = startBank * PADS_PER_BANK + startSlot
    let assigned = 0
    const baseName = sample.name.replace(/\.[^.]+$/, '')

    for (let i = 0; i < count && padIndex < pads.length; i++, padIndex++) {
      const pad = pads[padIndex]
      pads[padIndex] = {
        ...pad,
        name: i === 0 ? baseName : `${baseName} +${i}st`,
        settings: {
          ...pad.settings,
          sampleId: sample.id,
          semitones: i,
          trim: { start: 0, end: 1 },
          chokeGroup,
        },
      }
      assigned++
    }

    await s.saveProject({ ...s.project, pads })
    ctx.set((d) => { d.chromaticSpreadSampleId = null })
    const msg = chokeGroup > 0
      ? `Spread ${assigned} pad${assigned > 1 ? 's' : ''} chromatically (choke group ${chokeGroup})`
      : `Spread ${assigned} pad${assigned > 1 ? 's' : ''} chromatically`
    ctx.get().addToast(msg)
  },

  // --- F3: Pad Drag (Move/Copy) ---

  showPadDragPrompt: (sourcePadId: string, targetPadId: string) => {
    if (sourcePadId === targetPadId) return
    ctx.set((s) => { s.padDragPrompt = { sourcePadId, targetPadId } })
  },

  executePadMove: async (sourcePadId: string, targetPadId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const src = s.project.pads.find((p) => p.id === sourcePadId)
    const tgt = s.project.pads.find((p) => p.id === targetPadId)
    if (!src || !tgt) return

    const pads = s.project.pads.map((p) => {
      if (p.id === targetPadId) {
        return { ...p, name: src.name, settings: { ...src.settings } }
      }
      if (p.id === sourcePadId) {
        return {
          ...p,
          name: `${midiToName(p.midiNote)} Pad`,
          settings: {
            source: 'sample' as const,
            sampleId: null, gain: 1, semitones: 0, fineCents: 0, mode: 'one-shot' as const,
            trim: { start: 0, end: 1 }, envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
            layers: [], multiMode: 'single' as const,
            filterType: 'off' as const, filterFreq: 1000, filterQ: 1, bus: 'A' as const, chokeGroup: 0,
          },
        }
      }
      return p
    })

    // Also move sequencer events
    const sequences = s.project.sequences.map((seq) => ({
      ...seq,
      events: seq.events.map((ev) =>
        ev.padId === sourcePadId ? { ...ev, padId: targetPadId } : ev,
      ),
    }))

    await s.saveProject({ ...s.project, pads, sequences })
    ctx.set((d) => { d.padDragPrompt = null })
    ctx.get().addToast(`Moved pad to ${tgt.bank + 1}-${tgt.slot + 1}`)
  },

  executePadCopy: async (sourcePadId: string, targetPadId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const src = s.project.pads.find((p) => p.id === sourcePadId)
    const tgt = s.project.pads.find((p) => p.id === targetPadId)
    if (!src || !tgt) return

    const pads = s.project.pads.map((p) => {
      if (p.id === targetPadId) {
        return { ...p, name: src.name, settings: { ...src.settings } }
      }
      return p
    })

    await s.saveProject({ ...s.project, pads })
    ctx.set((d) => { d.padDragPrompt = null })
    ctx.get().addToast(`Copied pad to ${tgt.bank + 1}-${tgt.slot + 1}`)
  },

  executePadSwap: async (sourcePadId: string, targetPadId: string) => {
    const s = ctx.get()
    if (!s.project) return
    const src = s.project.pads.find((p) => p.id === sourcePadId)
    const tgt = s.project.pads.find((p) => p.id === targetPadId)
    if (!src || !tgt) return

    const pads = s.project.pads.map((p) => {
      if (p.id === targetPadId) {
        return { ...p, name: src.name, settings: { ...src.settings } }
      }
      if (p.id === sourcePadId) {
        return { ...p, name: tgt.name, settings: { ...tgt.settings } }
      }
      return p
    })

    // Swap sequencer events
    const sequences = s.project.sequences.map((seq) => ({
      ...seq,
      events: seq.events.map((ev) => {
        if (ev.padId === sourcePadId) return { ...ev, padId: targetPadId }
        if (ev.padId === targetPadId) return { ...ev, padId: sourcePadId }
        return ev
      }),
    }))

    await s.saveProject({ ...s.project, pads, sequences })
    ctx.set((d) => { d.padDragPrompt = null })
    ctx.get().addToast(`Swapped pads ${src.bank + 1}-${src.slot + 1} ↔ ${tgt.bank + 1}-${tgt.slot + 1}`)
  },

  cancelPadDragPrompt: () => {
    ctx.set((d) => { d.padDragPrompt = null })
  },
})
