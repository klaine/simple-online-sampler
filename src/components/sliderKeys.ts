/**
 * Shared keyboard interaction for custom slider-like controls (knobs, faders).
 * Arrow keys = fine step (Shift = coarse ×10), PageUp/Down = ±10% of range,
 * Home/End = min/max.
 */
export function sliderKeyDown(
  e: React.KeyboardEvent,
  value: number,
  min: number,
  max: number,
  step: number | undefined,
  onChange: (v: number) => void,
): void {
  const range = max - min
  const fine = step && step > 0 ? step : range / 100
  const coarse = fine * 10
  let next: number | null = null
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      next = value + (e.shiftKey ? coarse : fine)
      break
    case 'ArrowDown':
    case 'ArrowLeft':
      next = value - (e.shiftKey ? coarse : fine)
      break
    case 'PageUp':
      next = value + range / 10
      break
    case 'PageDown':
      next = value - range / 10
      break
    case 'Home':
      next = min
      break
    case 'End':
      next = max
      break
    default:
      return
  }
  e.preventDefault()
  onChange(Math.max(min, Math.min(max, next)))
}

/** ARIA attributes for custom slider controls (spread onto the interactive element). */
export function sliderAria(label: string, value: number, min: number, max: number, valueText?: string) {
  return {
    role: 'slider' as const,
    'aria-label': label,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': Math.round(value * 1000) / 1000,
    ...(valueText !== undefined ? { 'aria-valuetext': valueText } : {}),
  }
}
