import { memo, useCallback, useMemo, useRef } from 'react'
import { useStore } from '../store'
import type { SequenceEvent } from '../types'

interface PianoRollLaneProps {
  padId: string
  baseNote: number   // synth base note (MIDI)
  octaveOffset: number
  lengthSteps: number
  events: SequenceEvent[]
  playheadStep: number | null
  /** CSS grid-template-columns for step cells, to align with sequencer */
  stepGridColumns: string
  fitSixteen: boolean
}

const NOTE_ROWS = 24 // 2 octaves
const ROW_HEIGHT = 14 // px per note row

/** Returns true if the MIDI note is a black key */
function isBlackKey(note: number): boolean {
  const pc = note % 12
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function noteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

export const PianoRollLane = memo(function PianoRollLane({
  padId,
  baseNote,
  octaveOffset,
  lengthSteps,
  events,
  playheadStep,
  stepGridColumns,
  fitSixteen,
}: PianoRollLaneProps) {
  const toggleNote = useStore.getState().togglePianoRollNote
  const setPianoRollOctaveOffset = useStore.getState().setPianoRollOctaveOffset
  const setPianoRollNoteGate = useStore.getState().setPianoRollNoteGate
  const pushHistory = useStore.getState().beginDragHistoryCapture
  const finishHistory = useStore.getState().finishDragHistoryCapture

  // Compute visible note range: 2 octaves centered around baseNote, shifted by octaveOffset
  const bottomNote = baseNote - 12 + octaveOffset * 12
  const topNote = bottomNote + NOTE_ROWS - 1

  // Build note→step→event lookup from events that have a `note` field
  const noteEventMap = useMemo(() => {
    const map = new Map<number, Map<number, SequenceEvent>>()
    for (const ev of events) {
      if (ev.note == null) continue
      let stepMap = map.get(ev.note)
      if (!stepMap) {
        stepMap = new Map()
        map.set(ev.note, stepMap)
      }
      stepMap.set(ev.step, ev)
    }
    return map
  }, [events])

  // Collect all note events with their start step + gate for rendering as blocks
  const noteBlocks = useMemo(() => {
    const blocks: { ev: SequenceEvent; note: number; start: number; length: number }[] = []
    for (const ev of events) {
      if (ev.note == null) continue
      if (ev.note < bottomNote || ev.note > topNote) continue
      blocks.push({ ev, note: ev.note, start: ev.step, length: Math.max(1, ev.gate) })
    }
    return blocks
  }, [events, bottomNote, topNote])

  // Velocity drag state
  const velDragRef = useRef<{ eventId: string; originY: number; initialVelocity: number } | null>(null)
  // Gate resize drag state
  const gateDragRef = useRef<{
    eventId: string
    edge: 'left' | 'right'
    originX: number
    cellWidth: number
    initialStep: number
    initialGate: number
  } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const handleCellPointerDown = useCallback((e: React.PointerEvent, step: number, note: number) => {
    e.stopPropagation()
    const existing = noteEventMap.get(note)?.get(step)

    if (e.shiftKey && existing) {
      // Start velocity drag
      velDragRef.current = { eventId: existing.id, originY: e.clientY, initialVelocity: existing.velocity }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      pushHistory()
      return
    }

    void toggleNote(step, padId, note)
  }, [noteEventMap, padId, toggleNote, pushHistory])

  const handleCellPointerMove = useCallback((e: React.PointerEvent) => {
    if (!velDragRef.current) return
    const dy = velDragRef.current.originY - e.clientY
    const newVel = Math.max(1, Math.min(127, velDragRef.current.initialVelocity + Math.round(dy * 0.5)))
    void useStore.getState().setPianoRollNoteVelocity(velDragRef.current.eventId, newVel)
  }, [])

  const handleCellPointerUp = useCallback(() => {
    if (velDragRef.current) {
      velDragRef.current = null
      finishHistory()
    }
  }, [finishHistory])

  // Handle click on note body (between edge handles) to remove note
  const handleNoteClick = useCallback((e: React.PointerEvent, ev: SequenceEvent) => {
    e.stopPropagation()
    if (e.shiftKey) {
      // Shift+click on note body: velocity drag
      velDragRef.current = { eventId: ev.id, originY: e.clientY, initialVelocity: ev.velocity }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      pushHistory()
      return
    }
    // Regular click: remove the note
    void toggleNote(ev.step, padId, ev.note!)
  }, [padId, toggleNote, pushHistory])

  // Gate edge drag handlers
  const handleEdgeDragStart = useCallback((e: React.PointerEvent, ev: SequenceEvent, edge: 'left' | 'right') => {
    e.stopPropagation()
    e.preventDefault()
    const grid = gridRef.current
    if (!grid) return
    const cellWidth = grid.offsetWidth / lengthSteps
    gateDragRef.current = {
      eventId: ev.id,
      edge,
      originX: e.clientX,
      cellWidth,
      initialStep: ev.step,
      initialGate: Math.max(1, ev.gate),
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    pushHistory()
  }, [lengthSteps, pushHistory])

  const handleEdgeDragMove = useCallback((e: React.PointerEvent) => {
    const drag = gateDragRef.current
    if (!drag) return
    const dx = e.clientX - drag.originX
    const stepDelta = Math.round(dx / drag.cellWidth)

    if (drag.edge === 'right') {
      const newGate = Math.max(1, Math.min(lengthSteps - drag.initialStep, drag.initialGate + stepDelta))
      if (newGate !== drag.initialGate + Math.round((e.clientX - drag.originX - 1) / drag.cellWidth)) {
        // only update if changed
      }
      void setPianoRollNoteGate(drag.eventId, newGate)
    } else {
      // Left edge: adjust step and gate together
      const newStep = Math.max(0, Math.min(drag.initialStep + drag.initialGate - 1, drag.initialStep + stepDelta))
      const newGate = drag.initialGate - (newStep - drag.initialStep)
      if (newGate >= 1) {
        // Need a combined action — for now update gate; step change requires separate action
        // We'll update both via a combined store call
        void useStore.getState().setPianoRollNoteStartAndGate(drag.eventId, newStep, newGate)
      }
    }
  }, [lengthSteps, setPianoRollNoteGate])

  const handleEdgeDragEnd = useCallback(() => {
    if (gateDragRef.current) {
      gateDragRef.current = null
      finishHistory()
    }
  }, [finishHistory])

  // Render rows from top (highest note) to bottom (lowest note)
  const rows = useMemo(() => {
    const result = []
    for (let n = topNote; n >= bottomNote; n--) {
      result.push(n)
    }
    return result
  }, [topNote, bottomNote])

  return (
    <div className={`piano-roll-lane${fitSixteen ? ' fit-sixteen' : ''}`}>
      <div className="piano-roll-keys">
        <button
          type="button"
          className="piano-roll-octave-btn"
          onClick={() => setPianoRollOctaveOffset(padId, octaveOffset + 1)}
          title="Octave up"
        >&#x25B2;</button>
        {rows.map((note) => (
          <div
            key={note}
            className={`piano-roll-key ${isBlackKey(note) ? 'black' : 'white'} ${note % 12 === 0 ? 'c-note' : ''}`}
            style={{ height: ROW_HEIGHT }}
          >
            <span className="piano-roll-key-label">
              {note % 12 === 0 || note === bottomNote || note === topNote ? noteName(note) : ''}
            </span>
          </div>
        ))}
        <button
          type="button"
          className="piano-roll-octave-btn"
          onClick={() => setPianoRollOctaveOffset(padId, octaveOffset - 1)}
          title="Octave down"
        >&#x25BC;</button>
      </div>
      <div className="piano-roll-grid" ref={gridRef}>
        <div className="piano-roll-grid-inner">
        {/* Background grid rows with click targets */}
        {rows.map((note) => (
          <div
            key={note}
            className={`piano-roll-row ${isBlackKey(note) ? 'black' : 'white'} ${note % 12 === 0 ? 'c-note' : ''}`}
            style={{ height: ROW_HEIGHT, gridTemplateColumns: stepGridColumns }}
          >
            {Array.from({ length: lengthSteps }, (_, step) => {
              const isPlayheadHere = playheadStep === step
              return (
                <div
                  key={step}
                  className={`piano-roll-cell${isPlayheadHere ? ' playhead' : ''}${step % 4 === 0 ? ' bar-start' : ''}`}
                  onPointerDown={(e) => handleCellPointerDown(e, step, note)}
                  onPointerMove={handleCellPointerMove}
                  onPointerUp={handleCellPointerUp}
                />
              )
            })}
          </div>
        ))}
        {/* Note blocks rendered as positioned overlays */}
        {noteBlocks.map((block) => {
          const rowFromTop = topNote - block.note
          const top = rowFromTop * ROW_HEIGHT
          // Account for CSS grid gap (0.2rem) between cells
          // Left edge of step S in a grid of N cells with gap G: S * (100% + G) / N
          // Width spanning L cells: L * (100% + G) / N - G
          const N = lengthSteps
          const leftCalc = `calc(${(block.start / N) * 100}% + ${block.start / N * 0.2}rem)`
          const widthCalc = `calc(${(block.length / N) * 100}% + ${(block.length / N * 0.2) - 0.2}rem)`
          const vel = block.ev.velocity
          return (
            <div
              key={block.ev.id}
              className="piano-roll-note"
              style={{
                top,
                left: leftCalc,
                width: widthCalc,
                height: ROW_HEIGHT - 1,
                opacity: 0.5 + (vel / 127) * 0.5,
              }}
              title={`${noteName(block.note)} vel:${vel} gate:${block.length}`}
              onPointerDown={(e) => handleNoteClick(e, block.ev)}
              onPointerMove={handleCellPointerMove}
              onPointerUp={handleCellPointerUp}
            >
              <div
                className="piano-roll-note-edge left"
                onPointerDown={(e) => handleEdgeDragStart(e, block.ev, 'left')}
                onPointerMove={handleEdgeDragMove}
                onPointerUp={handleEdgeDragEnd}
              />
              <div
                className="piano-roll-note-edge right"
                onPointerDown={(e) => handleEdgeDragStart(e, block.ev, 'right')}
                onPointerMove={handleEdgeDragMove}
                onPointerUp={handleEdgeDragEnd}
              />
            </div>
          )
        })}
        </div>
      </div>
    </div>
  )
})
