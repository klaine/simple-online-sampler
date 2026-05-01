import { useEffect, useRef, memo } from 'react'

interface MiniWaveformProps {
  peaks: number[]
}

export const MiniWaveform = memo(function MiniWaveform({ peaks }: MiniWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const cssWidth = Math.max(1, Math.floor(canvas.clientWidth || 112))
    const cssHeight = Math.max(1, Math.floor(canvas.clientHeight || 13))
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.floor(cssWidth * pixelRatio)
    canvas.height = Math.floor(cssHeight * pixelRatio)

    const context = canvas.getContext('2d')
    if (!context) return

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, cssWidth, cssHeight)
    if (peaks.length === 0) return

    const gradient = context.createLinearGradient(0, 0, 0, cssHeight)
    gradient.addColorStop(0, '#7cc5ff')
    gradient.addColorStop(1, '#2f89d8')
    context.fillStyle = gradient

    const barCount = Math.min(cssWidth, peaks.length)
    const samplesPerBar = peaks.length / barCount
    const centerY = cssHeight / 2
    for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
      const start = Math.floor(barIndex * samplesPerBar)
      const end = Math.max(start + 1, Math.floor((barIndex + 1) * samplesPerBar))
      let peak = 0
      for (let cursor = start; cursor < end; cursor += 1) {
        peak = Math.max(peak, peaks[cursor] ?? 0)
      }
      const halfHeight = Math.max(1, Math.floor(peak * cssHeight * 0.5))
      const barHeight = Math.max(2, halfHeight * 2)
      context.fillRect(barIndex, centerY - halfHeight, 1, barHeight)
    }
  }, [peaks])

  return <canvas ref={canvasRef} className="sample-wave-canvas" />
})
