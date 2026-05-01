import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { audioEngine } from '../lib/audioEngine'
import { BANK_COUNT, PADS_PER_BANK } from '../lib/constants'

export function ChopModal() {
  const chopModalSampleId = useStore((s) => s.chopModalSampleId)
  const sampleMap = useStore((s) => s.sampleMap)
  const { closeChopModal, updateChopPoints, assignChopsToPads } = useStore.getState()

  const [startBank, setStartBank] = useState(0)
  const [startSlot, setStartSlot] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null)

  const sample = chopModalSampleId ? sampleMap.get(chopModalSampleId) : null
  const chopPoints = sample?.chopPoints ?? []

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !chopModalSampleId) return
    const buffer = audioEngine.getBuffer(chopModalSampleId)
    if (!buffer) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    const data = buffer.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / w))

    ctx.clearRect(0, 0, w, h)

    // Draw waveform
    ctx.fillStyle = '#4af'
    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * data.length / w)
      let min = 0, max = 0
      for (let j = 0; j < step; j++) {
        const val = data[start + j] ?? 0
        if (val < min) min = val
        if (val > max) max = val
      }
      const yTop = ((1 - max) / 2) * h
      const yBot = ((1 - min) / 2) * h
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop))
    }

    // Draw chop markers
    ctx.strokeStyle = '#f44'
    ctx.lineWidth = 2
    for (const pt of chopPoints) {
      const x = pt * w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }

    // Draw chop region labels
    const boundaries = [0, ...chopPoints, 1]
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    for (let i = 0; i < boundaries.length - 1; i++) {
      const cx = ((boundaries[i] + boundaries[i + 1]) / 2) * w
      ctx.fillText(`${i + 1}`, cx, 14)
    }
  }, [chopModalSampleId, chopPoints])

  useEffect(() => {
    drawWaveform()
  }, [drawWaveform])

  // Resize canvas to container
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth
      canvas.height = 120
      drawWaveform()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [drawWaveform])

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !chopModalSampleId) return
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width

    // Check if clicking near an existing marker — remove it
    const THRESHOLD = 0.02
    const nearIdx = chopPoints.findIndex((pt) => Math.abs(pt - x) < THRESHOLD)
    if (nearIdx >= 0) {
      const next = chopPoints.filter((_, i) => i !== nearIdx)
      void updateChopPoints(chopModalSampleId, next)
    } else {
      // Add new chop point
      void updateChopPoints(chopModalSampleId, [...chopPoints, x])
    }
  }, [chopModalSampleId, chopPoints, updateChopPoints])

  const quickDivide = useCallback((n: number) => {
    if (!chopModalSampleId) return
    const pts: number[] = []
    for (let i = 1; i < n; i++) pts.push(i / n)
    void updateChopPoints(chopModalSampleId, pts)
  }, [chopModalSampleId, updateChopPoints])

  const handlePreviewChop = useCallback((index: number) => {
    if (!chopModalSampleId) return
    const buffer = audioEngine.getBuffer(chopModalSampleId)
    if (!buffer) return
    const boundaries = [0, ...chopPoints, 1]
    const start = boundaries[index]
    const end = boundaries[index + 1]
    if (start === undefined || end === undefined) return

    // Play preview using the main AudioContext (avoid leaking contexts)
    const ctx = audioEngine.getContextIfReady()
    if (!ctx) return
    // Stop previous preview if still playing
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop() } catch { /* */ }
      previewSourceRef.current = null
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startSec = start * buffer.duration
    const durSec = (end - start) * buffer.duration
    source.start(0, startSec, durSec)
    previewSourceRef.current = source
    source.onended = () => { if (previewSourceRef.current === source) previewSourceRef.current = null }
  }, [chopModalSampleId, chopPoints])

  if (!chopModalSampleId || !sample) return null

  const boundaries = [0, ...chopPoints, 1]
  const chopCount = boundaries.length - 1

  return (
    <div className="modal-overlay" onClick={closeChopModal}>
      <div className="chop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chop-modal-header">
          <h3>Chop: {sample.name}</h3>
          <button type="button" onClick={closeChopModal}>×</button>
        </div>

        <div className="chop-waveform-container" ref={containerRef}>
          <canvas ref={canvasRef} onClick={handleCanvasClick} />
        </div>

        <div className="chop-quick-divide">
          <span>Quick divide:</span>
          <button type="button" onClick={() => quickDivide(2)}>÷2</button>
          <button type="button" onClick={() => quickDivide(4)}>÷4</button>
          <button type="button" onClick={() => quickDivide(8)}>÷8</button>
          <button type="button" onClick={() => quickDivide(16)}>÷16</button>
          <button type="button" onClick={() => void updateChopPoints(chopModalSampleId, [])}>Clear</button>
        </div>

        <div className="chop-list">
          {Array.from({ length: chopCount }, (_, i) => (
            <div key={i} className="chop-item">
              <span>Chop {i + 1}</span>
              <small>{(boundaries[i] * 100).toFixed(1)}% – {(boundaries[i + 1] * 100).toFixed(1)}%</small>
              <button type="button" onClick={() => handlePreviewChop(i)}>▶</button>
            </div>
          ))}
        </div>

        <div className="chop-assign">
          <label>
            Bank
            <select value={startBank} onChange={(e) => setStartBank(Number(e.target.value))}>
              {Array.from({ length: BANK_COUNT }, (_, i) => (
                <option key={i} value={i}>Bank {i + 1}</option>
              ))}
            </select>
          </label>
          <label>
            Start Pad
            <select value={startSlot} onChange={(e) => setStartSlot(Number(e.target.value))}>
              {Array.from({ length: PADS_PER_BANK }, (_, i) => (
                <option key={i} value={i}>Pad {i + 1}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chop-assign-btn"
            onClick={() => void assignChopsToPads(chopModalSampleId, startBank, startSlot)}
          >
            Assign {chopCount} Chop{chopCount > 1 ? 's' : ''} to Pads
          </button>
        </div>
      </div>
    </div>
  )
}
