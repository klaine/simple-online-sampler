import { memo, useSyncExternalStore } from 'react'
import type { SequenceEvent } from '../types'
import { useStore, transportVisualStore } from '../store'

interface SequencerStepProps {
  padId: string
  step: number
  exactEvent: SequenceEvent | undefined
  spanningEvent: SequenceEvent | undefined
  isGateMode: boolean
  fitSixteen: boolean
  showGateResizeTip: boolean
  patternId: string
}

export const SequencerStep = memo(function SequencerStep({
  padId,
  step,
  exactEvent,
  spanningEvent,
  isGateMode,
  fitSixteen,
  showGateResizeTip,
  patternId,
}: SequencerStepProps) {
  const store = useStore
  // Per-cell boolean playhead subscription — only this cell re-renders when its flag flips
  const isPlayhead = useSyncExternalStore(
    transportVisualStore.subscribe,
    () => transportVisualStore.getPlayheadStep() === step,
  )

  const isOn = Boolean(spanningEvent)
  const isTail = Boolean(spanningEvent && step > spanningEvent.step && step <= spanningEvent.step + spanningEvent.gate - 1)

  return (
    <div className={`step-wrap ${fitSixteen ? 'fit-sixteen' : ''}`}>
      <button
        type="button"
        className={`step ${isOn ? 'on' : ''} ${isTail ? 'tail' : ''} ${isPlayhead ? 'playhead' : ''} ${
          Math.floor(step / 4) % 2 === 0 ? 'group-even' : 'group-odd'
        } ${step > 0 && step % 16 === 0 ? 'bar-divider' : ''}`}
        onPointerDown={(event) => {
          event.preventDefault()
          const s = store.getState()
          if (s.selectedPadId !== padId) store.setState({ selectedPadId: padId })
          store.setState({
            selectedGateNote: exactEvent ? { padId, eventId: exactEvent.id } : null,
          })
          if (event.altKey && event.shiftKey && exactEvent) {
            s.beginDragHistoryCapture()
            store.setState({
              pitchDrag: {
                padId,
                eventId: exactEvent.id,
                originY: event.clientY,
                initialSemitones: exactEvent.semitones ?? 0,
                patternId,
              },
            })
            return
          }
          if (event.shiftKey && exactEvent) {
            s.beginDragHistoryCapture()
            store.setState({
              velocityDrag: {
                padId,
                eventId: exactEvent.id,
                originY: event.clientY,
                initialVelocity: exactEvent.velocity,
                patternId,
              },
            })
            return
          }
          void s.toggleStep(step, padId)
        }}
        onClick={(event) => {
          event.preventDefault()
          if (event.detail !== 0) return
          const s = store.getState()
          if (s.selectedPadId !== padId) store.setState({ selectedPadId: padId })
          store.setState({ selectedGateNote: exactEvent ? { padId, eventId: exactEvent.id } : null })
          void s.toggleStep(step, padId)
        }}
        style={exactEvent ? { opacity: 0.45 + exactEvent.velocity / 180 } : undefined}
        title={
          exactEvent
            ? `Velocity ${exactEvent.velocity} (Shift+drag) | Pitch ${exactEvent.semitones ?? 0} st (Alt+Shift+drag)`
            : 'Click to toggle step'
        }
      />
      {exactEvent && <span className="step-velocity-label">{exactEvent.velocity}</span>}
      {exactEvent && (exactEvent.semitones ?? 0) !== 0 && (
        <span className="step-pitch-label">
          {(exactEvent.semitones ?? 0) > 0 ? '+' : ''}
          {exactEvent.semitones ?? 0}
        </span>
      )}
      {isGateMode && exactEvent && (
        <>
          <button
            type="button"
            className="gate-handle left"
            onPointerDown={(event) => {
              event.preventDefault()
              const s = store.getState()
              s.beginDragHistoryCapture()
              const stepWidth = (event.currentTarget.parentElement?.getBoundingClientRect().width ?? 24)
              store.setState({
                selectedGateNote: { padId, eventId: exactEvent.id },
                gateResize: {
                  padId,
                  eventId: exactEvent.id,
                  side: 'left',
                  originX: event.clientX,
                  stepPitch: stepWidth,
                  initialStart: exactEvent.step,
                  initialEnd: exactEvent.step + Math.max(1, exactEvent.gate) - 1,
                },
              })
              if (showGateResizeTip) {
                store.setState({ showGateResizeTip: false })
                window.localStorage.setItem('online-sampler-hide-gate-tip', '1')
              }
            }}
          />
          <button
            type="button"
            className="gate-handle right"
            style={exactEvent.gate > 1 ? { right: `calc(-${(exactEvent.gate - 1) * 100}% - ${(exactEvent.gate - 1) * 0.2}rem)` } : undefined}
            onPointerDown={(event) => {
              event.preventDefault()
              const s = store.getState()
              s.beginDragHistoryCapture()
              const stepWidth = (event.currentTarget.parentElement?.getBoundingClientRect().width ?? 24)
              store.setState({
                selectedGateNote: { padId, eventId: exactEvent.id },
                gateResize: {
                  padId,
                  eventId: exactEvent.id,
                  side: 'right',
                  originX: event.clientX,
                  stepPitch: stepWidth,
                  initialStart: exactEvent.step,
                  initialEnd: exactEvent.step + Math.max(1, exactEvent.gate) - 1,
                },
              })
              if (showGateResizeTip) {
                store.setState({ showGateResizeTip: false })
                window.localStorage.setItem('online-sampler-hide-gate-tip', '1')
              }
            }}
          />
        </>
      )}
    </div>
  )
})
