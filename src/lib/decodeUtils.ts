/** Shared helpers for decoding sample blobs for display purposes (waveforms, inspector).
 *  Playback/export paths decode through audioEngine / audioExport; these exist so the UI
 *  doesn't spin up (and tear down) a full realtime AudioContext for every decode. */

let _decodeCtx: OfflineAudioContext | null = null

/** Decode a blob with a single shared OfflineAudioContext (cheap, no audio device).
 *  Note: decodeAudioData resamples to the context rate (44.1 kHz) — fine for peaks/info,
 *  do not use for playback buffers. */
export async function decodeBlobForDisplay(blob: Blob): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer()
  _decodeCtx ??= new OfflineAudioContext(1, 1, 44100)
  return _decodeCtx.decodeAudioData(data)
}

/** Read the file's native sample rate from a RIFF/WAVE `fmt ` chunk. Returns null for non-WAV or malformed data. */
export function readWavSampleRate(data: ArrayBuffer): number | null {
  if (data.byteLength < 28) return null
  const view = new DataView(data)
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let pos = 12
  while (pos + 8 <= view.byteLength) {
    const size = view.getUint32(pos + 4, true)
    if (tag(pos) === 'fmt ') {
      return pos + 16 <= view.byteLength ? view.getUint32(pos + 12, true) : null
    }
    pos += 8 + size + (size & 1) // chunks are word-aligned
  }
  return null
}

export interface AudioInfo { duration: number; sampleRate: number; channels: number }

/** Duration / channels from a decode, sample rate from the file header when available
 *  (decodeAudioData reports the context rate, not the file's). */
export async function readAudioInfo(blob: Blob): Promise<AudioInfo> {
  const data = await blob.arrayBuffer()
  const nativeRate = readWavSampleRate(data)
  _decodeCtx ??= new OfflineAudioContext(1, 1, 44100)
  const buffer = await _decodeCtx.decodeAudioData(data)
  return {
    duration: buffer.duration,
    sampleRate: nativeRate ?? buffer.sampleRate,
    channels: buffer.numberOfChannels,
  }
}
