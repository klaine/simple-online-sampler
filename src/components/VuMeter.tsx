import { useEffect, useRef } from 'react'
import { audioEngine } from '../lib/audioEngine'

export function VuMeter() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const dataRef = useRef<Uint8Array | null>(null)

  useEffect(() => {
    // Silence gating: once the meter has been silent for a few frames, only sample
    // every ~10th frame (enough to detect audio returning) and skip redraws.
    let silentStreak = 0
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      const analyser = audioEngine.getAnalyser()
      const canvas = canvasRef.current
      if (!analyser || !canvas) return

      if (silentStreak > 12) {
        silentStreak++
        if (silentStreak % 10 !== 0) return
      }

      if (!dataRef.current || dataRef.current.length !== analyser.frequencyBinCount) {
        dataRef.current = new Uint8Array(analyser.frequencyBinCount)
      }

      analyser.getByteTimeDomainData(dataRef.current as Uint8Array<ArrayBuffer>)

      // Compute RMS level
      let sum = 0
      for (let i = 0; i < dataRef.current.length; i++) {
        const v = (dataRef.current[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / dataRef.current.length)
      // Map to 0–1 with a bit of headroom visualization
      const level = Math.min(1, rms * 3)

      const silent = level < 0.004
      silentStreak = silent ? silentStreak + 1 : 0
      if (silent && silentStreak > 12) return // already showing empty meter

      const ctx = canvas.getContext('2d')
      if (ctx) {
        const w = canvas.width
        const h = canvas.height
        ctx.clearRect(0, 0, w, h)

        // Background
        ctx.fillStyle = '#1a1a1a'
        ctx.fillRect(0, 0, w, h)

        // Level bar
        const barH = Math.round(level * h)
        const green = level < 0.6
        const yellow = level >= 0.6 && level < 0.85
        ctx.fillStyle = green ? '#3c3' : yellow ? '#cc3' : '#c33'
        ctx.fillRect(0, h - barH, w, barH)
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="vu-meter"
      width={12}
      height={40}
    />
  )
}
