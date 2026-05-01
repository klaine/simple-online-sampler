import { useRef } from 'react'

interface KnobControlProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  precision?: number
  /** When true, knob uses power-curve mapping (good for time knobs: 50%→~20% of range) */
  logScale?: boolean
  /** When true, knob uses exponential (log-frequency) mapping — equal knob travel per octave */
  freqScale?: boolean
}

// Power curve exponent: maps 50% knob position to 20% of range (e.g. 1000ms of 5000ms)
const LOG_EXP = Math.log(0.2) / Math.log(0.5) // ≈ 2.322

/** Convert linear 0-1 knob position to value using power curve */
function logToValue(n: number, min: number, max: number): number {
  if (n <= 0) return min
  return min + (max - min) * Math.pow(n, LOG_EXP)
}

/** Convert value back to linear 0-1 knob position */
function valueToLog(v: number, min: number, max: number): number {
  const ratio = (v - min) / (max - min)
  if (ratio <= 0) return 0
  return Math.pow(ratio, 1 / LOG_EXP)
}

/** Convert linear 0-1 knob position to value using exponential (log-frequency) mapping */
function freqToValue(n: number, min: number, max: number): number {
  if (n <= 0) return min
  if (n >= 1) return max
  // Exponential: min * (max/min)^n — equal travel per octave
  return min * Math.pow(max / min, n)
}

/** Convert frequency value back to linear 0-1 knob position */
function valueToFreq(v: number, min: number, max: number): number {
  if (v <= min) return 0
  if (v >= max) return 1
  return Math.log(v / min) / Math.log(max / min)
}

export function KnobControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  precision = 2,
  logScale = false,
  freqScale = false,
}: KnobControlProps) {
  const startRef = useRef<{ y: number; normalized: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)
  const range = max - min
  const normalized = freqScale
    ? valueToFreq(value, min, max)
    : logScale ? valueToLog(value, min, max) : (value - min) / range
  const angle = -130 + normalized * 260

  const clamp = (nextValue: number): number => {
    const clipped = Math.max(min, Math.min(max, nextValue))
    return Math.round(clipped / step) * step
  }

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    startRef.current = { y: event.clientY, normalized }

    const onMove = (pointerEvent: PointerEvent) => {
      if (!startRef.current) return
      const delta = startRef.current.y - pointerEvent.clientY
      const nextNorm = Math.max(0, Math.min(1, startRef.current.normalized + delta / 140))
      const nextValue = freqScale
        ? freqToValue(nextNorm, min, max)
        : logScale ? logToValue(nextNorm, min, max) : min + nextNorm * range
      const next = clamp(nextValue)
      pendingRef.current = next
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null
          if (pendingRef.current !== null) {
            onChange(pendingRef.current)
            pendingRef.current = null
          }
        })
      }
    }

    const onUp = () => {
      startRef.current = null
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (pendingRef.current !== null) {
        onChange(pendingRef.current)
        pendingRef.current = null
      }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Format display value */
  const displayValue = freqScale
    ? value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`
    : logScale
    ? value < 0.001 ? '0ms' : value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`
    : value.toFixed(precision)

  return (
    <div className="knob-control">
      <button type="button" className="knob" onPointerDown={startDrag}>
        <span className="knob-indicator" style={{ transform: `translateX(-50%) rotate(${angle}deg)` }} />
      </button>
      <span className="knob-label">{label}</span>
      <strong className="knob-value">{displayValue}</strong>
    </div>
  )
}
