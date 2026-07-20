import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import { encodeWavFromChannels } from '../lib/wavEncode'
import { normalizePcm } from '../lib/autotrim'
import { startPcmCapture, computePeaks, RECORDER_SAMPLE_RATE, type PcmRecorderSession } from '../lib/pcmRecorder'
import { audioEngine } from '../lib/audioEngine'
import { useDialogFocus } from './useDialogFocus'

const MAX_DURATION_SEC = 60

/** Format seconds as mm:ss */
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function RecordDialog() {
  const recordTargetPadId = useStore((s) => s.recordTargetPadId)
  const project = useStore((s) => s.project)
  const { closeRecordDialog, saveRecording } = useStore.getState()
  const dialogRef = useDialogFocus<HTMLElement>(true)

  // --- Local state ---
  const [phase, setPhase] = useState<'ready' | 'recording' | 'review'>('ready')
  const [duration, setDuration] = useState(0)
  const [decodedBuffer, setDecodedBuffer] = useState<AudioBuffer | null>(null)
  const [reviewPeaks, setReviewPeaks] = useState<number[]>([])
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(1)
  const [name, setName] = useState('')
  const [micError, setMicError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [normalize, setNormalize] = useState(true)

  // --- Refs ---
  const sessionRef = useRef<PcmRecorderSession | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const levelCanvasRef = useRef<HTMLCanvasElement>(null)
  const liveWaveformCanvasRef = useRef<HTMLCanvasElement>(null)
  const reviewCanvasRef = useRef<HTMLCanvasElement>(null)
  const levelRafRef = useRef(0)
  const liveRafRef = useRef(0)
  const trimDragRef = useRef<'start' | 'end' | null>(null)
  const reviewWaveformRef = useRef<HTMLDivElement>(null)
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null)

  const targetPadName = project?.pads.find((p) => p.id === recordTargetPadId)?.name

  // --- Cleanup helper ---
  const cleanup = useCallback(() => {
    if (durationTimerRef.current) clearInterval(durationTimerRef.current)
    cancelAnimationFrame(levelRafRef.current)
    cancelAnimationFrame(liveRafRef.current)
    previewSourceRef.current?.stop()
    previewSourceRef.current = null
    recorderRef.current = null
    sessionRef.current?.stop()
    sessionRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup])

  // --- Initialize mic on mount ---
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        const session = await startPcmCapture(null, audioEngine.getContextIfReady() ?? undefined)
        if (cancelled) { session.stop(); return }
        sessionRef.current = session

        // MediaRecorder for blob output (decode to AudioBuffer in review)
        const recorder = new MediaRecorder(session.stream)
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorderRef.current = recorder

        startLevelMeter()
      } catch (err) {
        if (!cancelled) setMicError(err instanceof Error ? err.message : 'Microphone access denied')
      }
    }
    void init()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Level meter rAF loop ---
  const startLevelMeter = useCallback(() => {
    const draw = () => {
      const analyser = sessionRef.current?.analyser
      const canvas = levelCanvasRef.current
      if (!analyser || !canvas) { levelRafRef.current = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      if (!ctx) { levelRafRef.current = requestAnimationFrame(draw); return }

      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128)
        if (v > peak) peak = v
      }

      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#1a1e2a'
      ctx.fillRect(0, 0, w, h)
      const barW = peak * w
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, '#3aad6e')
      gradient.addColorStop(0.6, '#e8b020')
      gradient.addColorStop(1, '#d42848')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, barW, h)

      levelRafRef.current = requestAnimationFrame(draw)
    }
    levelRafRef.current = requestAnimationFrame(draw)
  }, [])

  // --- Live waveform rAF loop (during recording) ---
  const startLiveWaveform = useCallback(() => {
    const draw = () => {
      const canvas = liveWaveformCanvasRef.current
      if (!canvas) { liveRafRef.current = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      if (!ctx) { liveRafRef.current = requestAnimationFrame(draw); return }

      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const samplesNeeded = RECORDER_SAMPLE_RATE * 3
      const chunks = sessionRef.current?.pcmChunks ?? []
      let totalSamples = 0
      for (let i = chunks.length - 1; i >= 0 && totalSamples < samplesNeeded; i--) {
        totalSamples += chunks[i].length
      }

      const recent = new Float32Array(Math.min(totalSamples, samplesNeeded))
      let writePos = recent.length
      for (let i = chunks.length - 1; i >= 0 && writePos > 0; i--) {
        const chunk = chunks[i]
        const copyLen = Math.min(chunk.length, writePos)
        recent.set(chunk.subarray(chunk.length - copyLen), writePos - copyLen)
        writePos -= copyLen
      }

      const gradient = ctx.createLinearGradient(0, 0, 0, h)
      gradient.addColorStop(0, '#7cc5ff')
      gradient.addColorStop(1, '#2f89d8')
      ctx.fillStyle = gradient

      const barCount = w
      const samplesPerBar = Math.max(1, recent.length / barCount)
      const centerY = h / 2
      for (let i = 0; i < barCount; i++) {
        const start = Math.floor(i * samplesPerBar)
        const end = Math.min(recent.length, Math.floor((i + 1) * samplesPerBar))
        let peak = 0
        for (let c = start; c < end; c++) peak = Math.max(peak, Math.abs(recent[c]))
        const halfH = Math.max(1, Math.floor(peak * h * 0.45))
        ctx.fillRect(i, centerY - halfH, 1, halfH * 2)
      }

      liveRafRef.current = requestAnimationFrame(draw)
    }
    liveRafRef.current = requestAnimationFrame(draw)
  }, [])

  // --- Start recording ---
  const handleRecord = useCallback(() => {
    const recorder = recorderRef.current
    const session = sessionRef.current
    if (!recorder || !session) return

    chunksRef.current = []
    session.pcmChunks.length = 0
    startTimeRef.current = performance.now()
    setDuration(0)
    setPhase('recording')

    recorder.start(100)

    durationTimerRef.current = setInterval(() => {
      const elapsed = (performance.now() - startTimeRef.current) / 1000
      setDuration(elapsed)
      if (elapsed >= MAX_DURATION_SEC) {
        handleStop()
      }
    }, 100)

    startLiveWaveform()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLiveWaveform])

  // --- Stop recording ---
  const handleStop = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'recording') return

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    cancelAnimationFrame(liveRafRef.current)

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })

      try {
        const arrBuf = await blob.arrayBuffer()
        // Use OfflineAudioContext for decoding to avoid interfering with the main audio thread
        const tempCtx = new OfflineAudioContext(1, 1, RECORDER_SAMPLE_RATE)
        const decoded = await tempCtx.decodeAudioData(arrBuf)

        setDecodedBuffer(decoded)
        const peaks = computePeaks(decoded.getChannelData(0), 720)
        setReviewPeaks(peaks)
        setTrimStart(0)
        setTrimEnd(1)

        const now = new Date()
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
        setName(`recording-${ts}`)
        setPhase('review')
      } catch {
        setMicError('Failed to decode recorded audio')
      }
    }

    recorder.stop()
  }, [])

  // --- Draw review waveform ---
  useEffect(() => {
    if (phase !== 'review') return
    const canvas = reviewCanvasRef.current
    if (!canvas || reviewPeaks.length === 0) return

    const draw = () => {
      const w = canvas.width
      const h = canvas.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)

      const gradient = ctx.createLinearGradient(0, 0, 0, h)
      gradient.addColorStop(0, '#7cc5ff')
      gradient.addColorStop(1, '#2f89d8')
      ctx.fillStyle = gradient

      const barCount = Math.min(w, reviewPeaks.length)
      const samplesPerBar = reviewPeaks.length / barCount
      const centerY = h / 2
      for (let i = 0; i < barCount; i++) {
        const start = Math.floor(i * samplesPerBar)
        const end = Math.max(start + 1, Math.floor((i + 1) * samplesPerBar))
        let peak = 0
        for (let c = start; c < end; c++) peak = Math.max(peak, reviewPeaks[c] ?? 0)
        const halfH = Math.max(1, Math.floor(peak * h * 0.45))
        ctx.fillRect(i, centerY - halfH, 1, halfH * 2)
      }
    }
    draw()
    const observer = new ResizeObserver(() => draw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [phase, reviewPeaks])

  // --- Trim drag handlers ---
  useEffect(() => {
    if (phase !== 'review') return
    const onMove = (e: PointerEvent) => {
      if (!trimDragRef.current) return
      const waveEl = reviewWaveformRef.current
      if (!waveEl) return
      const rect = waveEl.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      if (trimDragRef.current === 'start') {
        setTrimStart(Math.min(ratio, trimEnd - 0.01))
      } else {
        setTrimEnd(Math.max(ratio, trimStart + 0.01))
      }
    }
    const onUp = () => { trimDragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [phase, trimStart, trimEnd])

  // --- Preview playback ---
  const handlePreview = useCallback(() => {
    const ctx = sessionRef.current?.audioCtx
    if (!decodedBuffer || !ctx) return

    if (previewSourceRef.current) {
      previewSourceRef.current.stop()
      previewSourceRef.current = null
      setIsPreviewPlaying(false)
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = decodedBuffer
    source.connect(ctx.destination)

    const startSample = Math.floor(trimStart * decodedBuffer.length)
    const endSample = Math.floor(trimEnd * decodedBuffer.length)
    const startTime = startSample / decodedBuffer.sampleRate
    const dur = (endSample - startSample) / decodedBuffer.sampleRate

    source.onended = () => { setIsPreviewPlaying(false); previewSourceRef.current = null }
    source.start(0, startTime, dur)
    previewSourceRef.current = source
    setIsPreviewPlaying(true)
  }, [decodedBuffer, trimStart, trimEnd])

  // --- Save ---
  const handleSave = useCallback(async () => {
    if (!decodedBuffer) return
    setIsSaving(true)

    try {
      const startSample = Math.floor(trimStart * decodedBuffer.length)
      const endSample = Math.floor(trimEnd * decodedBuffer.length)
      const channelCount = Math.min(2, decodedBuffer.numberOfChannels)
      const trimmedChannels = Array.from({ length: channelCount }, (_, ch) =>
        decodedBuffer.getChannelData(ch).slice(startSample, endSample),
      )
      if (normalize) {
        // Normalize based on peak of first channel, apply same gain to all
        const gain = normalizePcm(trimmedChannels[0])
        for (let ch = 1; ch < trimmedChannels.length; ch++) {
          for (let i = 0; i < trimmedChannels[ch].length; i++) trimmedChannels[ch][i] *= gain
        }
      }
      const wavBlob = encodeWavFromChannels(trimmedChannels, decodedBuffer.sampleRate)
      const saveName = name.trim() || 'recording'
      await saveRecording(wavBlob, saveName.endsWith('.wav') ? saveName : `${saveName}.wav`)
    } finally {
      setIsSaving(false)
    }
  }, [decodedBuffer, trimStart, trimEnd, name, normalize, saveRecording])

  // --- Re-record ---
  const handleReRecord = useCallback(() => {
    previewSourceRef.current?.stop()
    previewSourceRef.current = null
    setIsPreviewPlaying(false)
    setDecodedBuffer(null)
    setReviewPeaks([])
    setPhase('ready')
  }, [])

  // --- Discard ---
  const handleDiscard = useCallback(() => {
    previewSourceRef.current?.stop()
    cleanup()
    closeRecordDialog()
  }, [cleanup, closeRecordDialog])

  // --- ESC to close ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'recording') handleDiscard()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, handleDiscard])

  return (
    <section ref={dialogRef} className="import-dialog-overlay" role="dialog" aria-modal="true">
      <div className="import-dialog record-dialog">
        <div className="import-dialog-head">
          <h2>
            Record
            {targetPadName && <span className="record-target-label"> &rarr; {targetPadName}</span>}
          </h2>
          <button type="button" onClick={handleDiscard} disabled={isSaving}>Close</button>
        </div>

        {micError && (
          <div className="record-error">
            <p>Microphone error: {micError}</p>
            <button type="button" onClick={handleDiscard}>Close</button>
          </div>
        )}

        {!micError && (
          <>
            {/* Level meter — visible in ready + recording */}
            {(phase === 'ready' || phase === 'recording') && (
              <div className="record-level-meter">
                <canvas ref={levelCanvasRef} width={400} height={12} />
              </div>
            )}

            {/* --- Ready phase --- */}
            {phase === 'ready' && (
              <div className="record-phase-ready">
                <p className="record-hint">Click record to start capturing audio.</p>
                <div className="record-btn-row">
                  <button type="button" className="record-btn-record" onClick={handleRecord} title="Start recording">
                    ●
                  </button>
                </div>
              </div>
            )}

            {/* --- Recording phase --- */}
            {phase === 'recording' && (
              <div className="record-phase-recording">
                <div className="record-live-waveform">
                  <canvas ref={liveWaveformCanvasRef} width={520} height={80} />
                </div>
                <div className="record-timer">{fmtTime(duration)}</div>
                <div className="record-progress">
                  <div className="record-progress-bar" style={{ width: `${Math.min(100, (duration / MAX_DURATION_SEC) * 100)}%` }} />
                </div>
                <div className="record-btn-row">
                  <button type="button" className="record-btn-stop" onClick={handleStop} title="Stop recording">
                    ■
                  </button>
                </div>
              </div>
            )}

            {/* --- Review phase --- */}
            {phase === 'review' && (
              <div className="record-phase-review">
                <div className="record-review-waveform" ref={reviewWaveformRef}>
                  <canvas ref={reviewCanvasRef} width={520} height={100} />
                  <div
                    className="trim-zone"
                    style={{ left: `${trimStart * 100}%`, width: `${(trimEnd - trimStart) * 100}%` }}
                  />
                  <button type="button" className="trim-handle" style={{ left: `${trimStart * 100}%` }} onPointerDown={() => { trimDragRef.current = 'start' }} />
                  <button type="button" className="trim-handle" style={{ left: `${trimEnd * 100}%` }} onPointerDown={() => { trimDragRef.current = 'end' }} />
                </div>
                <div className="record-trim-info">
                  {decodedBuffer && (
                    <span>
                      {(trimStart * decodedBuffer.duration).toFixed(2)}s – {(trimEnd * decodedBuffer.duration).toFixed(2)}s
                      ({((trimEnd - trimStart) * decodedBuffer.duration).toFixed(2)}s)
                    </span>
                  )}
                </div>
                <div className="record-review-controls">
                  <button type="button" className="record-preview-btn" onClick={handlePreview}>
                    {isPreviewPlaying ? '■ Stop' : '▶ Preview'}
                  </button>
                  <input
                    type="text"
                    className="record-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Recording name"
                  />
                </div>
                <div className="record-btn-row record-save-row">
                  <label className="record-normalize-label">
                    <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                    Normalize
                  </label>
                  <button type="button" onClick={handleReRecord}>Re-record</button>
                  <button type="button" onClick={handleDiscard}>Discard</button>
                  <button type="button" className="record-btn-save" onClick={() => void handleSave()} disabled={isSaving}>
                    {isSaving ? 'Saving...' : recordTargetPadId ? 'Save & Assign' : 'Save to Library'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
