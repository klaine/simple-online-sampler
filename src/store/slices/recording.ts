import { audioEngine } from '../../lib/audioEngine'
import { db } from '../../lib/db'
import { arrayBufferToHex, uid } from '../../lib/utils'
import { encodeWavFromChannels } from '../../lib/wavEncode'
import { normalizePcm, computeSilenceTrim } from '../../lib/autotrim'
import type { SampleAsset } from '../../types'
import { mutableRefs, HOLD_REC_WORKLET_SRC, HOLD_REC_SAMPLE_RATE, HOLD_REC_MIN_MS } from '../refs'
import type { StoreContext } from '../context'

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
})
