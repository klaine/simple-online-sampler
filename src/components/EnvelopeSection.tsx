import { useRef, useCallback, memo, useMemo } from 'react'
import { sliderKeyDown, sliderAria } from './sliderKeys'

// ---------------------------------------------------------------------------
// Vertical Fader (MC-909 style)
// ---------------------------------------------------------------------------

interface VerticalFaderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  logScale?: boolean
  logExp?: number
  onChange: (v: number) => void
  formatValue?: (v: number) => string
}

const LOG_EXP = Math.log(5) / Math.log(2) // ≈ 2.322

function logToLinear(norm: number, exp: number = LOG_EXP): number {
  return Math.pow(norm, exp)
}
function linearToLog(norm: number, exp: number = LOG_EXP): number {
  return Math.pow(norm, 1 / exp)
}

function VerticalFader({ label, value, min, max, step, logScale, logExp, onChange, formatValue, disabled }: VerticalFaderProps & { disabled?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const exp = logExp ?? LOG_EXP

  const norm = useMemo(() => {
    const raw = max > min ? (value - min) / (max - min) : 0
    return logScale ? linearToLog(Math.max(0, Math.min(1, raw)), exp) : Math.max(0, Math.min(1, raw))
  }, [value, min, max, logScale, exp])

  const computeValue = useCallback(
    (clientY: number) => {
      const track = trackRef.current
      if (!track) return value
      const rect = track.getBoundingClientRect()
      let ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      if (logScale) ratio = logToLinear(ratio, exp)
      let v = min + ratio * (max - min)
      if (step) v = Math.round(v / step) * step
      return Math.max(min, Math.min(max, v))
    },
    [min, max, value, step, logScale, exp],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      onChange(computeValue(e.clientY))

      const onMove = (ev: PointerEvent) => { onChange(computeValue(ev.clientY)) }
      const onUp = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId)
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
    },
    [computeValue, onChange],
  )

  const pct = norm * 100

  const display = formatValue
    ? formatValue(value)
    : step && step >= 1
      ? String(Math.round(value))
      : value.toFixed(2)

  return (
    <div className={`env-fader-col${disabled ? ' disabled' : ''}`}>
      <span className="env-fader-label">{label}</span>
      <div
        className="env-fader"
        ref={trackRef}
        onPointerDown={disabled ? undefined : onPointerDown}
        onKeyDown={disabled ? undefined : (e) => sliderKeyDown(e, value, min, max, step, onChange)}
        tabIndex={disabled ? undefined : 0}
        {...(disabled ? { 'aria-disabled': true } : sliderAria(`Envelope ${label}`, value, min, max, display))}
      >
        <div className="env-fader-track">
          {[0, 25, 50, 75, 100].map((t) => (
            <div key={t} className="env-fader-tick" style={{ bottom: `${t}%` }} />
          ))}
        </div>
        <div className="env-fader-fill" style={{ height: `${pct}%` }} />
        <div className="env-fader-thumb" style={{ bottom: `${pct}%` }} />
      </div>
      <span className="env-fader-value">{display}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ADSR Curve Visualization (mini SVG)
// ---------------------------------------------------------------------------

const EnvelopeCurve = memo(function EnvelopeCurve({ attack, decay, sustain, release }: { attack: number; decay: number; sustain: number; release: number }) {
  const total = Math.max(0.001, attack + decay + release)
  const w = 120
  const h = 28
  const pad = 2

  const aX = pad + (attack / total) * (w - 2 * pad)
  const dX = aX + (decay / total) * (w - 2 * pad)
  const susY = pad + (1 - sustain) * (h - 2 * pad)
  const baseY = h - pad
  const endX = w - pad
  const rStartX = endX - (release / total) * (w - 2 * pad)

  const linePath = `M ${pad},${baseY} L ${aX},${pad} L ${dX},${susY} L ${rStartX},${susY} L ${endX},${baseY}`
  const fillPath = `${linePath} L ${endX},${baseY} L ${pad},${baseY} Z`

  return (
    <svg className="env-curve" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={fillPath} fill="rgba(255,255,255,0.04)" stroke="none" />
      <path d={linePath} fill="none" stroke="var(--muted-light)" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
})

// ---------------------------------------------------------------------------
// AHR Curve Visualization (mini SVG)
// ---------------------------------------------------------------------------

const AhrCurve = memo(function AhrCurve({ attack, hold, release }: { attack: number; hold: number; release: number }) {
  const total = Math.max(0.001, attack + hold + release)
  const w = 120
  const h = 28
  const pad = 2

  const aX = pad + (attack / total) * (w - 2 * pad)
  const hX = aX + (hold / total) * (w - 2 * pad)
  const endX = w - pad
  const baseY = h - pad

  const linePath = `M ${pad},${baseY} L ${aX},${pad} L ${hX},${pad} L ${endX},${baseY}`
  const fillPath = `${linePath} L ${endX},${baseY} L ${pad},${baseY} Z`

  return (
    <svg className="env-curve" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={fillPath} fill="rgba(255,255,255,0.04)" stroke="none" />
      <path d={linePath} fill="none" stroke="var(--muted-light)" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
})

// ---------------------------------------------------------------------------
// Envelope Section (MC-909 style container)
// ---------------------------------------------------------------------------

function formatTime(v: number): string {
  if (v < 1) return `${Math.round(v * 1000)}ms`
  return `${v.toFixed(1)}s`
}

interface EnvelopeSectionProps {
  title: string
  levelLabel: string
  levelValue: number
  levelMin: number
  levelMax: number
  levelStep?: number
  onLevelChange: (v: number) => void
  formatLevel?: (v: number) => string
  attack: number
  decay: number
  sustain: number
  release: number
  hold?: number
  onAttackChange: (v: number) => void
  onDecayChange: (v: number) => void
  onSustainChange: (v: number) => void
  onReleaseChange: (v: number) => void
  onHoldChange?: (v: number) => void
  adsrDisabled?: boolean
  mode?: 'adsr' | 'ahr'
}

export const EnvelopeSection = memo(function EnvelopeSection(props: EnvelopeSectionProps) {
  const {
    title, levelLabel, levelValue, levelMin, levelMax, levelStep,
    onLevelChange, formatLevel,
    attack, decay, sustain, release, hold,
    onAttackChange, onDecayChange, onSustainChange, onReleaseChange, onHoldChange,
    adsrDisabled, mode,
  } = props

  const isAhr = mode === 'ahr'

  return (
    <div className={title ? 'envelope-section' : 'envelope-section-inner'}>
      {title && <div className="envelope-section-header">{title}</div>}
      {isAhr
        ? <AhrCurve attack={attack} hold={hold ?? 0} release={release} />
        : <EnvelopeCurve attack={attack} decay={decay} sustain={sustain} release={release} />
      }
      <div className="envelope-faders">
        <VerticalFader label={levelLabel} value={levelValue} min={levelMin} max={levelMax} step={levelStep} onChange={onLevelChange} formatValue={formatLevel} />
        <div className="env-fader-separator" />
        <VerticalFader label="A" value={attack} min={0} max={isAhr ? 4 : 5} step={0.001} logScale logExp={isAhr ? 4.43 : undefined} onChange={onAttackChange} formatValue={formatTime} disabled={adsrDisabled} />
        {isAhr ? (
          <VerticalFader label="H" value={hold ?? 0} min={0} max={4} step={0.001} logScale logExp={4.43} onChange={onHoldChange ?? (() => {})} formatValue={formatTime} disabled={adsrDisabled} />
        ) : (
          <VerticalFader label="D" value={decay} min={0} max={5} step={0.001} logScale onChange={onDecayChange} formatValue={formatTime} disabled={adsrDisabled} />
        )}
        {!isAhr && (
          <VerticalFader label="S" value={sustain} min={0} max={1} step={0.01} onChange={onSustainChange} formatValue={(v) => `${Math.round(v * 100)}%`} disabled={adsrDisabled} />
        )}
        <VerticalFader label="R" value={release} min={0} max={isAhr ? 6 : 5} step={0.001} logScale logExp={isAhr ? 4.74 : undefined} onChange={onReleaseChange} formatValue={formatTime} disabled={adsrDisabled} />
      </div>
    </div>
  )
})
