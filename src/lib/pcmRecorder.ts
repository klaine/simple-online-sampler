// ---------------------------------------------------------------------------
// Shared PCM capture pipeline (AudioWorklet-based)
// Refactored out of RecordDialog.tsx so AutosampleDialog can reuse it.
// ---------------------------------------------------------------------------

/** Sample rate used by the recorder AudioContext — matches system default for zero-resampling */
export let RECORDER_SAMPLE_RATE = 44_100

// AudioWorklet processor source — inlined as a Blob URL to avoid build/CORS issues
const WORKLET_SRC = `
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.writeIndex = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i];
      if (this.writeIndex >= this.buffer.length) {
        this.port.postMessage({ samples: this.buffer.slice() });
        this.writeIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor('recorder-worklet', RecorderWorkletProcessor);
`
const workletBlob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
export const recorderWorkletUrl = URL.createObjectURL(workletBlob)

export interface PcmRecorderSession {
  stream: MediaStream
  audioCtx: AudioContext
  analyser: AnalyserNode
  workletNode: AudioWorkletNode
  /** Accumulated PCM chunks (appended as recording progresses) */
  pcmChunks: Float32Array[]
  /** Flush the collected chunks into a single flat Float32Array */
  flush: () => Float32Array
  /** Stop the capture and release resources */
  stop: () => void
}

/**
 * Open microphone and set up PCM capture pipeline.
 * Returns a session object; call session.stop() when done.
 * Optionally pass a specific deviceId from enumerateDevices().
 * If existingCtx is provided, reuse it instead of creating a new AudioContext
 * (avoids Chrome audio thread degradation from multiple contexts).
 */
export async function startPcmCapture(deviceId?: string | null, existingCtx?: AudioContext): Promise<PcmRecorderSession> {
  const audioConstraints: MediaTrackConstraints & Record<string, unknown> = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }
  if (deviceId) audioConstraints.deviceId = { exact: deviceId }

  const constraints: MediaStreamConstraints = { audio: audioConstraints }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)

  const ownCtx = !existingCtx
  const bufferSize = Number(localStorage.getItem('audioBufferSize')) || 512
  const audioCtx = existingCtx ?? new AudioContext({ latencyHint: bufferSize / 48000 })
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  // Expose actual sample rate to callers (e.g. for WAV encoding)
  RECORDER_SAMPLE_RATE = audioCtx.sampleRate
  const source = audioCtx.createMediaStreamSource(stream)

  // Analyser for live level metering (shared with callers)
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.85
  source.connect(analyser)

  // AudioWorklet for low-latency PCM accumulation
  await audioCtx.audioWorklet.addModule(recorderWorkletUrl)
  const workletNode = new AudioWorkletNode(audioCtx, 'recorder-worklet')
  const pcmChunks: Float32Array[] = []
  workletNode.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
    pcmChunks.push(e.data.samples)
  }
  source.connect(workletNode)

  const flush = (): Float32Array => {
    const totalLen = pcmChunks.reduce((acc, c) => acc + c.length, 0)
    const out = new Float32Array(totalLen)
    let offset = 0
    for (const chunk of pcmChunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  const stop = () => {
    try { workletNode.disconnect() } catch { /* */ }
    try { source.disconnect() } catch { /* */ }
    try { analyser.disconnect() } catch { /* */ }
    stream.getTracks().forEach((t) => t.stop())
    // Only close the context if we created it (don't close the shared main context)
    if (ownCtx && audioCtx.state !== 'closed') {
      void audioCtx.suspend().then(() => audioCtx.close()).catch(() => {})
    }
  }

  return { stream, audioCtx, analyser, workletNode, pcmChunks, flush, stop }
}

/** Compute waveform peaks from Float32 PCM data for canvas rendering */
export function computePeaks(data: Float32Array, buckets: number): number[] {
  const bucketSize = Math.max(1, Math.floor(data.length / buckets))
  return Array.from({ length: buckets }, (_, i) => {
    const start = i * bucketSize
    const end = Math.min(data.length, start + bucketSize)
    let max = 0
    for (let c = start; c < end; c++) max = Math.max(max, Math.abs(data[c]))
    return max
  })
}
