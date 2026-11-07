import { useState, useEffect, useMemo, useCallback, memo } from 'react'
import type { Pad, SequenceEvent } from '../types'
import type { SequencerBankGroup } from '../store/types'
import { useStore } from '../store'
import { SequencerStep } from './SequencerStep'
import { PianoRollLane } from './PianoRollLane'
import { padDisplayName } from '../lib/padDisplay'

const BANK_HEADER_HEIGHT = 28
const LANE_HEIGHT = 32
const PIANO_ROLL_HEIGHT = 240
const BUFFER_COUNT = 2

function getGroupHeight(group: SequencerBankGroup, expandedPads: Set<string>): number {
  if (group.collapsed) return BANK_HEADER_HEIGHT
  let h = BANK_HEADER_HEIGHT
  for (const pad of group.pads) {
    h += LANE_HEIGHT
    if (expandedPads.has(pad.id)) {
      h += PIANO_ROLL_HEIGHT
    }
  }
  return h
}

interface VirtualizedSequencerLanesProps {
  bankGroups: SequencerBankGroup[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  sequenceGridColumns: string
  stepGridColumns: string
  fitSteps: boolean
  visibleSequence: { id: string; lengthSteps: number }
  stepIndices: number[]
  eventsByPadAndStep: Map<string, Map<number, SequenceEvent>>
  spanningByPadAndStep: Map<string, Map<number, SequenceEvent>>
  eventsByPad: Map<string, SequenceEvent[]>
  selectedPadId: string | null
  mutedLanePadIds: Set<string>
  expandedPianoRollPads: Set<string>
  pianoRollOctaveOffset: Record<string, number>
  showGateResizeTip: boolean
  triggerPad: (pad: Pad, velocity?: number) => void
  toggleLaneMute: (padId: string) => void
  clearLane: (padId: string) => void
  togglePianoRollExpanded: (padId: string) => void
  toggleSeqBankCollapsed: (bank: number) => void
}

export const VirtualizedSequencerLanes = memo(function VirtualizedSequencerLanes({
  bankGroups,
  scrollContainerRef,
  sequenceGridColumns,
  stepGridColumns,
  fitSteps,
  visibleSequence,
  stepIndices,
  eventsByPadAndStep,
  spanningByPadAndStep,
  eventsByPad,
  selectedPadId,
  mutedLanePadIds,
  expandedPianoRollPads,
  pianoRollOctaveOffset,
  showGateResizeTip,
  triggerPad,
  toggleLaneMute,
  clearLane,
  togglePianoRollExpanded,
  toggleSeqBankCollapsed,
}: VirtualizedSequencerLanesProps) {
  const sampleMap = useStore((s) => s.sampleMap)
  const [startIndex, setStartIndex] = useState(0)
  const [endIndex, setEndIndex] = useState(Math.max(0, bankGroups.length - 1))

  const { offsets, totalHeight } = useMemo(() => {
    const offsets: number[] = []
    let acc = 0
    for (const group of bankGroups) {
      offsets.push(acc)
      acc += getGroupHeight(group, expandedPianoRollPads)
    }
    return { offsets, totalHeight: acc }
  }, [bankGroups, expandedPianoRollPads])

  const updateRange = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const scrollTop = container.scrollTop
    const clientHeight = container.clientHeight

    // Binary search for first visible group
    let lo = 0
    let hi = bankGroups.length - 1
    let firstVisible = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const groupBottom = offsets[mid + 1] ?? totalHeight
      if (groupBottom < scrollTop) {
        lo = mid + 1
      } else {
        firstVisible = mid
        hi = mid - 1
      }
    }

    // Binary search for last visible group
    lo = firstVisible
    hi = bankGroups.length - 1
    let lastVisible = bankGroups.length - 1
    const scrollBottom = scrollTop + clientHeight
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] > scrollBottom) {
        hi = mid - 1
      } else {
        lastVisible = mid
        lo = mid + 1
      }
    }

    const start = Math.max(0, firstVisible - BUFFER_COUNT)
    const end = Math.min(bankGroups.length - 1, lastVisible + BUFFER_COUNT)

    // Always include groups with expanded piano rolls
    let actualStart = start
    let actualEnd = end
    for (let i = 0; i < bankGroups.length; i++) {
      const group = bankGroups[i]
      const hasExpanded = group.pads.some(
        (p) => expandedPianoRollPads.has(p.id),
      )
      if (hasExpanded) {
        actualStart = Math.min(actualStart, i)
        actualEnd = Math.max(actualEnd, i)
      }
    }

    setStartIndex(actualStart)
    setEndIndex(actualEnd)
  }, [bankGroups, offsets, totalHeight, expandedPianoRollPads, scrollContainerRef])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.addEventListener('scroll', updateRange, { passive: true })
    const raf = requestAnimationFrame(updateRange)
    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('scroll', updateRange)
    }
  }, [updateRange, scrollContainerRef])

  useEffect(() => {
    const raf = requestAnimationFrame(updateRange)
    return () => cancelAnimationFrame(raf)
  }, [bankGroups, offsets, totalHeight, updateRange])

  const topPadding = offsets[startIndex] ?? 0
  const bottomPadding = totalHeight - (offsets[endIndex + 1] ?? totalHeight)

  return (
    <div style={{ paddingTop: topPadding, paddingBottom: bottomPadding }}>
      {bankGroups.slice(startIndex, endIndex + 1).map((group) => (
        <div key={group.bank} className="seq-bank-group">
          <button
            type="button"
            className={`seq-bank-header ${group.collapsed ? 'collapsed' : ''} ${group.hasEvents ? 'has-events' : ''}`}
            onClick={() => toggleSeqBankCollapsed(group.bank)}
          >
            <span className="seq-bank-chevron">{group.collapsed ? '\u25B8' : '\u25BE'}</span>
            <span className="seq-bank-name">{group.name}</span>
            {group.collapsed && group.pads.length > 0 && (
              <span className="seq-bank-count">{group.pads.length}</span>
            )}
          </button>
          {!group.collapsed && group.pads.map((pad) => {
            const selectedLane = selectedPadId === pad.id
            const padExactMap = eventsByPadAndStep.get(pad.id)
            const padSpanMap = spanningByPadAndStep.get(pad.id)
        const isPianoRollExpanded = expandedPianoRollPads.has(pad.id)
            return (
              <div key={pad.id} className={isPianoRollExpanded ? 'sequencer-lane-group' : undefined}>
                <div
                  className={`sequencer-row ${selectedLane ? 'selected-lane' : ''} ${fitSteps ? 'fit-sixteen' : ''}`}
                  style={{ gridTemplateColumns: sequenceGridColumns }}
                >
                  <button
                    type="button"
                    className="lane-label"
                    title={pad.name}
                    onClick={() => {
                      useStore.setState({ selectedPadId: pad.id })
                      void triggerPad(pad, 0.9)
                    }}
                  >
                    {pad.slot + 1} · {padDisplayName(pad.name, pad.settings.sampleId ? sampleMap.get(pad.settings.sampleId) : undefined)}
                  </button>
                  <button
                    type="button"
                    className={`lane-action ${mutedLanePadIds.has(pad.id) ? 'active' : ''}`}
                    onClick={() => toggleLaneMute(pad.id)}
                  >M</button>
                  <button type="button" className="lane-action" onClick={() => void clearLane(pad.id)}>C</button>
                  <button
                    type="button"
                    className={`lane-action ${isPianoRollExpanded ? 'active' : ''}`}
                    onClick={() => togglePianoRollExpanded(pad.id)}
                    title={isPianoRollExpanded ? 'Collapse piano roll' : 'Expand piano roll'}
                  >&#x266B;</button>
                  {stepIndices.map((step) => {
                    const exactEvent = padExactMap?.get(step)
                    const spanningEvent = padSpanMap?.get(step)
                    return (
                      <SequencerStep
                        key={`${pad.id}-${step}`}
                        padId={pad.id}
                        step={step}
                        exactEvent={exactEvent}
                        spanningEvent={spanningEvent}
                        isGateMode={pad.settings.mode === 'adsr'}
                        fitSixteen={fitSteps}
                        showGateResizeTip={showGateResizeTip}
                        patternId={visibleSequence.id}
                      />
                    )
                  })}
                </div>
                {isPianoRollExpanded && (
                   <PianoRollLane
                    padId={pad.id}
                    baseNote={pad.settings.baseNote ?? 60}
                    octaveOffset={pianoRollOctaveOffset[pad.id] ?? 0}
                    lengthSteps={visibleSequence.lengthSteps}
                    events={eventsByPad.get(pad.id) ?? []}
                    stepGridColumns={stepGridColumns}
                    fitSixteen={fitSteps}
                  />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
})
