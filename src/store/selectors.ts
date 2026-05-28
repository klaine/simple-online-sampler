import type { Pad, SampleAsset, SequenceEvent } from '../types'
import { BANK_COUNT } from '../lib/constants'
import type { AppState, SequencerBankGroup } from './types'
import { memoize } from './helpers'

export const selectSelectedPad = memoize<AppState, Pad | null>(
  (s) => [s.project?.pads, s.selectedPadId],
  (s) => {
    if (!s.project || !s.selectedPadId) return null
    return s.project.pads.find((p) => p.id === s.selectedPadId) ?? null
  },
)

export const selectSelectedSample = memoize<AppState, SampleAsset | null>(
  (s) => [selectSelectedPad(s), s.samples],
  (s) => {
    const pad = selectSelectedPad(s)
    if (!pad?.settings.sampleId) return null
    return s.samples.find((sample) => sample.id === pad.settings.sampleId) ?? null
  },
)

export const selectSelectedLayer = memoize<AppState, import('../types').SampleLayer | null>(
  (s) => [s.selectedLayerId, selectSelectedPad(s)],
  (s) => {
    if (!s.selectedLayerId) return null
    const pad = selectSelectedPad(s)
    if (!pad) return null
    return pad.settings.layers.find((l) => l.id === s.selectedLayerId) ?? null
  },
)

export const selectDisplayedSample = memoize<AppState, SampleAsset | null>(
  (s) => [selectSelectedLayer(s), s.samples, selectSelectedSample(s)],
  (s) => {
    const layer = selectSelectedLayer(s)
    if (layer) {
      return s.samples.find((sample) => sample.id === layer.sampleId) ?? null
    }
    return selectSelectedSample(s)
  },
)

export const selectActiveSequence = memoize<AppState, import('../types').SequencePattern | null>(
  (s) => [s.project?.sequences, s.activeSequenceId],
  (s) => {
    if (!s.project || !s.activeSequenceId) return null
    return s.project.sequences.find((seq) => seq.id === s.activeSequenceId) ?? null
  },
)

export const selectVisibleSequence = memoize<AppState, import('../types').SequencePattern | null>(
  (s) => {
    const active = selectActiveSequence(s)
    return [active, s.playbackScope, s.isPlaying, s.playingPatternId, s.seqFollowPlayback]
  },
  (s) => {
    const active = selectActiveSequence(s)
    if (!s.project || !active) return null
    if (s.playbackScope === 'song' && s.isPlaying && s.playingPatternId && s.seqFollowPlayback) {
      return s.project.sequences.find((seq) => seq.id === s.playingPatternId) ?? active
    }
    return active
  },
)

export const selectCurrentBankPads = memoize<AppState, Pad[]>(
  (s) => [s.project?.pads, s.activeBank],
  (s) => {
    if (!s.project) return []
    return s.project.pads.filter((p) => p.bank === s.activeBank).sort((a, b) => a.slot - b.slot)
  },
)

export const selectDisplayedPads = memoize<AppState, Pad[]>(
  (s) => [s.project?.pads, s.activeBank],
  (s) => {
    const ordered = selectCurrentBankPads(s)
    const rows = [0, 1, 2, 3].map((r) => ordered.slice(r * 4, r * 4 + 4))
    return rows.reverse().flat()
  },
)

export const selectFilteredSamples = memoize<AppState, SampleAsset[]>(
  (s) => [s.samples, s.sampleQuery, s.showFavoritesOnly, s.favoriteSampleIds, s.sampleSort],
  (s) => {
    const query = s.sampleQuery.trim().toLowerCase()
    let next = s.samples.filter((sample) => {
      if (s.showFavoritesOnly && !s.favoriteSampleIds.has(sample.id)) return false
      if (!query) return true
      return sample.name.toLowerCase().includes(query)
    })

    if (s.sampleSort === 'name') {
      next = [...next].sort((a, b) => a.name.localeCompare(b.name))
    } else if (s.sampleSort === 'size') {
      next = [...next].sort((a, b) => b.size - a.size)
    } else {
      next = [...next].sort((a, b) => b.createdAt - a.createdAt)
    }

    return next
  },
)

export const selectAssignedSampleIdsKey = (s: AppState): string => {
  if (!s.project) return ''
  const ids = new Set<string>()
  for (const p of s.project.pads) {
    if (p.settings.sampleId) ids.add(p.settings.sampleId)
    if (p.settings.layers) {
      for (const l of p.settings.layers) {
        if (l.sampleId) ids.add(l.sampleId)
      }
    }
  }
  return Array.from(ids).sort().join('|')
}

export const selectSampleToPadMap = memoize<AppState, Map<string, Pad[]>>(
  (s) => [s.project?.pads],
  (s) => {
    const map = new Map<string, Pad[]>()
    if (!s.project) return map
    for (const pad of s.project.pads) {
      if (pad.settings.sampleId) {
        let arr = map.get(pad.settings.sampleId)
        if (!arr) { arr = []; map.set(pad.settings.sampleId, arr) }
        arr.push(pad)
      }
      if (pad.settings.layers) {
        for (const l of pad.settings.layers) {
          if (l.sampleId && l.sampleId !== pad.settings.sampleId) {
            let arr = map.get(l.sampleId)
            if (!arr) { arr = []; map.set(l.sampleId, arr) }
            if (!arr.some((p) => p.id === pad.id)) arr.push(pad)
          }
        }
      }
    }
    return map
  },
)

// Pre-computed event lookup for sequencer rendering perf
export const selectEventsByPadAndStep = memoize<AppState, Map<string, Map<number, SequenceEvent>>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events, seq?.id]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, Map<number, SequenceEvent>>()
    for (const event of seq.events) {
      let padMap = map.get(event.padId)
      if (!padMap) {
        padMap = new Map()
        map.set(event.padId, padMap)
      }
      padMap.set(event.step, event)
    }
    return map
  },
)

// Events grouped by padId for lane iteration
export const selectEventsByPad = memoize<AppState, Map<string, SequenceEvent[]>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events, seq?.id]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, SequenceEvent[]>()
    for (const event of seq.events) {
      let arr = map.get(event.padId)
      if (!arr) {
        arr = []
        map.set(event.padId, arr)
      }
      arr.push(event)
    }
    return map
  },
)

// Pre-computed spanning event lookup: for each (padId, step), which event spans that step?
export const selectSpanningByPadAndStep = memoize<AppState, Map<string, Map<number, SequenceEvent>>>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [seq?.events, seq?.id]
  },
  (s) => {
    const seq = selectVisibleSequence(s)
    if (!seq) return new Map()
    const map = new Map<string, Map<number, SequenceEvent>>()
    for (const event of seq.events) {
      let padMap = map.get(event.padId)
      if (!padMap) {
        padMap = new Map()
        map.set(event.padId, padMap)
      }
      const end = event.step + Math.max(1, event.gate) - 1
      for (let step = event.step; step <= end; step++) {
        padMap.set(step, event)
      }
    }
    return map
  },
)

export const selectSequenceLanes = memoize<AppState, Pad[]>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [s.project?.pads, s.activeBank, s.hideEmptyLanes, seq?.id, seq?.events]
  },
  (s) => {
    const bankPads = selectCurrentBankPads(s)
    if (!s.hideEmptyLanes) return bankPads.sort((a, b) => b.midiNote - a.midiNote)
    const visibleSeq = selectVisibleSequence(s)
    const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
    return bankPads
      .filter((pad) => activePadIds.has(pad.id))
      .sort((a, b) => b.midiNote - a.midiNote)
  },
)

export const selectSequencerBankGroups = memoize<AppState, SequencerBankGroup[]>(
  (s) => {
    const seq = selectVisibleSequence(s)
    return [s.project?.pads, s.project?.bankNames, s.hideEmptyLanes, s.seqExpandedBanks, s.seqCollapsedBanks, seq?.id, seq?.events]
  },
  (s) => {
    if (!s.project) return []
    const visibleSeq = selectVisibleSequence(s)
    const activePadIds = visibleSeq ? new Set(visibleSeq.events.map((e) => e.padId)) : new Set<string>()
    const bankNames = s.project.bankNames ?? Array.from({ length: BANK_COUNT }, (_, i) => `Bank ${i + 1}`)

    const groups: SequencerBankGroup[] = []
    for (let bank = 0; bank < BANK_COUNT; bank++) {
      const bankPads = s.project.pads.filter((p) => p.bank === bank).sort((a, b) => a.slot - b.slot)
      const hasPadContent = bankPads.some((p) => p.settings.sampleId || p.settings.midiOut?.enabled)
      if (!hasPadContent) continue
      const hasEvents = bankPads.some((p) => activePadIds.has(p.id))

      let collapsed: boolean
      if (s.seqCollapsedBanks.has(bank)) {
        collapsed = true
      } else if (s.seqExpandedBanks.has(bank)) {
        collapsed = false
      } else {
        collapsed = !hasEvents
      }

      let visiblePads: Pad[]
      if (s.hideEmptyLanes) {
        visiblePads = bankPads.filter((pad) => activePadIds.has(pad.id))
      } else {
        visiblePads = bankPads
      }

      groups.push({
        bank,
        name: bankNames[bank] ?? `Bank ${bank + 1}`,
        pads: visiblePads.sort((a, b) => b.midiNote - a.midiNote),
        hasEvents,
        collapsed,
      })
    }
    return groups
  },
)
