import { audioEngine } from '../../lib/audioEngine'
import { db } from '../../lib/db'
import { arrayBufferToHex, uid } from '../../lib/utils'
import { encodeWavFromChannels } from '../../lib/wavEncode'
import { normalizePcm, computeSilenceTrim } from '../../lib/autotrim'
import { PATTERN_COLORS_CYCLE } from '../constants'
import type { SampleAsset, SequenceEvent } from '../../types'
import { mutableRefs, HOLD_REC_WORKLET_SRC, HOLD_REC_SAMPLE_RATE, HOLD_REC_MIN_MS } from '../refs'
import type { StoreContext } from '../context'

// Hard cap on the capture buffer — plenty of headroom for a 4-bar capture window
const CAPTURE_BUFFER_MAX_EVENTS = 1024

export const createRecordingActions = (ctx: StoreContext) => ({
  openRecordDialog: (targetPadId?: string) => {
    ctx.set((d) => {
      d.showRecordDialog = true
      d.recordTargetPadId = targetPadId ?? null
    })
  },

  closeRecordDialog: () => {
    ctx.set((d) => {
      d.showRecordDialog = false
      d.recordTargetPadId = null
    })
  },

  saveRecording: async (blob: Blob, name: string) => {
    const s = ctx.get()
    const raw = await blob.arrayBuffer()
    const hash = await arrayBufferToHex(raw)
    const sample: SampleAsset = {
      id: uid(),
      name,
      mimeType: blob.type,
      size: blob.size,
      createdAt: Date.now(),
      hash,
      blob,
    }
    await db.putSample(sample)
    await audioEngine.registerSample(sample)
    ctx.set((d) => {
      d.samples = [...d.samples, sample]
      d.sampleMap.set(sample.id, sample)
    })
    // Assign to target pad if set
    const targetPadId = s.recordTargetPadId
    if (targetPadId) {
      await ctx.get().assignSampleToPad(sample, targetPadId)
    }
    ctx.set((d) => {
      d.showRecordDialog = false
      d.recordTargetPadId = null
    })
  },

  togglePadHoldRecord: () => {
    const next = !ctx.get().padHoldRecordEnabled
    ctx.set((d) => { d.padHoldRecordEnabled = next })
    // Release mic stream when disabling
    if (!next) {
      if (mutableRefs.holdRecWorklet) { try { mutableRefs.holdRecWorklet.disconnect() } catch { /* */ }; mutableRefs.holdRecWorklet = null }
      if (mutableRefs.holdRecSource) { try { mutableRefs.holdRecSource.disconnect() } catch { /* */ }; mutableRefs.holdRecSource = null }
      if (mutableRefs.holdRecStream) { mutableRefs.holdRecStream.getTracks().forEach((t) => t.stop()); mutableRefs.holdRecStream = null }
    }
  },

  startPadHoldRecord: (padId: string) => {
    if (ctx.get().padHoldRecordingPadId) return // already recording
    ctx.set((d) => { d.padHoldRecordingPadId = padId })
    mutableRefs.holdRecChunks = []
    mutableRefs.holdRecStartTime = Date.now()

    const setup = async () => {
      try {
        // Get mic stream (reuse if already acquired)
        if (!mutableRefs.holdRecStream) {
          mutableRefs.holdRecStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          })
        }
        // Guard: recording may have been stopped while awaiting getUserMedia
        if (!ctx.get().padHoldRecordingPadId) {
          mutableRefs.holdRecStream?.getTracks().forEach(t => t.stop())
          mutableRefs.holdRecStream = null
          return
        }
        // Use the main AudioContext (avoid creating a second one — Chrome audio thread degrades)
        const audioCtx = audioEngine.getContextIfReady()
        if (!audioCtx) { ctx.set((d) => { d.padHoldRecordingPadId = null }); return }

        // Register worklet on main context once
        if (!mutableRefs.holdRecWorkletRegistered) {
          const url = 'data:application/javascript,' + encodeURIComponent(HOLD_REC_WORKLET_SRC)
          await audioCtx.audioWorklet.addModule(url)
          mutableRefs.holdRecWorkletRegistered = true
        }
        // Guard: recording may have been stopped while awaiting addModule
        if (!ctx.get().padHoldRecordingPadId) {
          return
        }

        mutableRefs.holdRecSource = audioCtx.createMediaStreamSource(mutableRefs.holdRecStream)
        mutableRefs.holdRecWorklet = new AudioWorkletNode(audioCtx, 'hold-recorder-worklet')
        mutableRefs.holdRecWorklet.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
          mutableRefs.holdRecChunks.push(e.data.samples)
        }
        mutableRefs.holdRecSource.connect(mutableRefs.holdRecWorklet)
        // Connect to destination so process() runs (output is silent)
        mutableRefs.holdRecWorklet.connect(audioCtx.destination)
      } catch {
        ctx.set((d) => { d.padHoldRecordingPadId = null })
        ctx.get().addToast('Mic access denied', 'error')
      }
    }
    void setup()
  },

  stopPadHoldRecord: () => {
    const padId = ctx.get().padHoldRecordingPadId
    if (!padId) return
    ctx.set((d) => { d.padHoldRecordingPadId = null })

    // Stop worklet + source
    if (mutableRefs.holdRecWorklet) {
      try { mutableRefs.holdRecWorklet.disconnect() } catch { /* */ }
      mutableRefs.holdRecWorklet = null
    }
    if (mutableRefs.holdRecSource) {
      try { mutableRefs.holdRecSource.disconnect() } catch { /* */ }
      mutableRefs.holdRecSource = null
    }
    if (mutableRefs.holdRecStream) {
      mutableRefs.holdRecStream.getTracks().forEach((t) => t.stop())
      mutableRefs.holdRecStream = null
    }

    const elapsed = Date.now() - mutableRefs.holdRecStartTime
    if (elapsed < HOLD_REC_MIN_MS || mutableRefs.holdRecChunks.length === 0) {
      ctx.get().addToast('Hold longer to record', 'info')
      return
    }

    // Concatenate PCM chunks
    const totalSamples = mutableRefs.holdRecChunks.reduce((n, c) => n + c.length, 0)
    const pcm = new Float32Array(totalSamples)
    let offset = 0
    for (const chunk of mutableRefs.holdRecChunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    mutableRefs.holdRecChunks = []

    // Normalize to -0.3 dBFS (peak)
    normalizePcm(pcm)

    // Auto-trim silence from start/end
    const sampleRate = audioEngine.getContextIfReady()?.sampleRate ?? HOLD_REC_SAMPLE_RATE
    const autoTrim = computeSilenceTrim(pcm, sampleRate)

    // Encode WAV + save
    const finalize = async () => {
      const wavBlob = encodeWavFromChannels([pcm], sampleRate)
      const raw = await wavBlob.arrayBuffer()
      const hash = await arrayBufferToHex(raw)
      const s = ctx.get()
      const pad = s.project?.pads.find((p) => p.id === padId)
      const name = `Rec ${pad ? `${pad.bank + 1}-${pad.slot + 1}` : 'pad'}`
      const sample: SampleAsset = {
        id: uid(),
        name,
        mimeType: 'audio/wav',
        size: wavBlob.size,
        createdAt: Date.now(),
        hash,
        blob: wavBlob,
      }
      await db.putSample(sample)
      await audioEngine.registerSample(sample)
      ctx.set((d) => {
        d.samples = [...d.samples, sample]
        d.sampleMap.set(sample.id, sample)
      })
      await ctx.get().assignSampleToPad(sample, padId)
      // Apply auto-trim to the pad
      if (autoTrim.start > 0 || autoTrim.end < 1) {
        ctx.set((d) => {
          const p = d.project?.pads.find((pp) => pp.id === padId)
          if (p) p.settings.trim = autoTrim
        })
        const proj = ctx.get().project
        if (proj) ctx.get().saveProjectLight(proj)
      }
      ctx.get().addToast(`Recorded to ${name}`, 'success')
    }
    void finalize()
  },

  feedCaptureBuffer: (padId: string, velocity: number, type: 'on' | 'off', note?: number) => {
    const now = performance.now()
    const buf = mutableRefs.captureBuffer
    buf.push({
      padId,
      velocity,
      note,
      type,
      timestamp: now,
    })
    // Cap buffer growth — drop oldest events (plenty of headroom for a 4-bar capture window)
    if (buf.length > CAPTURE_BUFFER_MAX_EVENTS) {
      const overflow = buf.length - CAPTURE_BUFFER_MAX_EVENTS
      let droppedOns = 0
      for (let i = 0; i < overflow; i++) if (buf[i].type === 'on') droppedOns++
      buf.splice(0, overflow)
      mutableRefs.captureNoteOnCount = Math.max(0, mutableRefs.captureNoteOnCount - droppedOns)
    }
    if (type !== 'on') return
    mutableRefs.captureNoteOnCount += 1
    if (mutableRefs.captureFirstNoteTimeMs === null) {
      mutableRefs.captureFirstNoteTimeMs = now
    }
    // Update reactive count for UI (only when it actually changed — no immer produce per note-off)
    const count = mutableRefs.captureNoteOnCount
    if (ctx.get().captureBufferCount !== count) {
      ctx.set((d) => { d.captureBufferCount = count })
    }
  },

  captureMidi: async () => {
    const buf = mutableRefs.captureBuffer
    if (buf.length === 0) return
    const s = ctx.get()
    if (!s.project) return

    const bpm = s.project.bpm
    const stepDurationMs = 60_000 / bpm / 4
    const maxBars = 4
    const maxSteps = maxBars * 16
    const now = performance.now()
    const windowMs = maxSteps * stepDurationMs

    // Filter to last 4 bars from now (or from last event if transport stopped)
    const cutoff = now - windowMs
    const events = buf.filter((e) => e.timestamp >= cutoff)
    if (events.length === 0) {
      mutableRefs.captureBuffer = []
      mutableRefs.captureTransportStartMs = null
      mutableRefs.captureFirstNoteTimeMs = null
      mutableRefs.captureNoteOnCount = 0
      ctx.set((d) => { d.captureBufferCount = 0 })
      return
    }

    // Determine step positions
    const wasPlaying = mutableRefs.captureTransportStartMs !== null
    let patternLength: number

    if (wasPlaying) {
      const playingPatternId = s.playingPatternId ?? s.activeSequenceId
      const playingSeq = s.project.sequences.find((seq) => seq.id === playingPatternId)
      patternLength = playingSeq?.lengthSteps ?? 16
    } else {
      // Age out stale captureFirstNoteTimeMs if it fell outside the window
      if (mutableRefs.captureFirstNoteTimeMs !== null && mutableRefs.captureFirstNoteTimeMs < cutoff) {
        mutableRefs.captureFirstNoteTimeMs = null
      }
      const t0 = mutableRefs.captureFirstNoteTimeMs ?? events[0].timestamp
      const noteOns = events.filter((e) => e.type === 'on')
      if (noteOns.length === 0) {
        mutableRefs.captureBuffer = []
        mutableRefs.captureTransportStartMs = null
        mutableRefs.captureFirstNoteTimeMs = null
        mutableRefs.captureNoteOnCount = 0
        ctx.set((d) => { d.captureBufferCount = 0 })
        return
      }

      let maxStep = 0
      for (const onEvent of noteOns) {
        const relativeStep = (onEvent.timestamp - t0) / stepDurationMs
        const step = Math.round(relativeStep)
        if (step > maxStep) maxStep = step
      }

      patternLength = Math.min(64, Math.max(16, Math.ceil((maxStep + 1) / 16) * 16))
    }

    // Build sequence events from note-on/note-off pairs
    const noteOnEvents = events.filter((e) => e.type === 'on')
    const noteOffEvents = events.filter((e) => e.type === 'off')
    const finalEvents: SequenceEvent[] = []
    const dedup = new Set<string>()

    for (const onEv of noteOnEvents) {
      if (onEv.timestamp < cutoff) continue

      let step: number
      if (wasPlaying) {
        const absoluteStep = (onEv.timestamp - mutableRefs.captureTransportStartMs!) / stepDurationMs
        step = Math.round(absoluteStep) % patternLength
      } else {
        const t0 = mutableRefs.captureFirstNoteTimeMs ?? events[0].timestamp
        const relativeStep = (onEv.timestamp - t0) / stepDurationMs
        step = Math.round(relativeStep) % patternLength
      }
      if (step < 0) continue

      const dedupKey = `${onEv.padId}:${step}:${onEv.note ?? ''}`
      if (dedup.has(dedupKey)) continue

      const matchingOff = noteOffEvents.find((off) =>
        off.padId === onEv.padId &&
        off.timestamp > onEv.timestamp &&
        (onEv.note != null ? off.note === onEv.note : off.note == null)
      )

      let gate = 1
      if (matchingOff) {
        const elapsedMs = matchingOff.timestamp - onEv.timestamp
        gate = Math.round(elapsedMs / stepDurationMs)
        gate = Math.max(1, Math.min(patternLength, gate))
      }

      dedup.add(dedupKey)
      finalEvents.push({
        id: uid(),
        step,
        padId: onEv.padId,
        velocity: Math.max(1, Math.min(127, onEv.velocity)),
        gate,
        semitones: 0,
        ...(onEv.note != null ? { note: onEv.note } : {}),
      })
    }

    if (finalEvents.length === 0) {
      mutableRefs.captureBuffer = []
      mutableRefs.captureTransportStartMs = null
      mutableRefs.captureFirstNoteTimeMs = null
      mutableRefs.captureNoteOnCount = 0
      ctx.set((d) => { d.captureBufferCount = 0 })
      return
    }

    // Create new pattern with auto-sized length
    const newPattern = {
      id: uid(),
      name: `Captured ${s.project.sequences.length + 1}`,
      color: PATTERN_COLORS_CYCLE[s.project.sequences.length % PATTERN_COLORS_CYCLE.length],
      resolution: 16 as const,
      lengthSteps: patternLength,
      events: finalEvents,
    }

    await s.saveProject({
      ...s.project,
      sequences: [...s.project.sequences, newPattern],
    })

    ctx.set((d) => {
      d.activeSequenceId = newPattern.id
    })

    // Clear buffer
    mutableRefs.captureBuffer = []
    mutableRefs.captureTransportStartMs = null
    mutableRefs.captureFirstNoteTimeMs = null
    mutableRefs.captureNoteOnCount = 0
    ctx.set((d) => { d.captureBufferCount = 0 })

    ctx.get().addToast(`Captured ${finalEvents.length} events into new pattern`, 'success')
  },

  clearCaptureBuffer: () => {
    mutableRefs.captureBuffer = []
    mutableRefs.captureTransportStartMs = null
    mutableRefs.captureFirstNoteTimeMs = null
    mutableRefs.captureNoteOnCount = 0
    ctx.set((d) => { d.captureBufferCount = 0 })
  },
})
