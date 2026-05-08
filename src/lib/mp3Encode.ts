export async function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  bitrate: number = 320,
): Promise<Blob> {
  const { Mp3Encoder } = await import('lamejs')

  const numChannels = channels.length
  const encoder = new Mp3Encoder(numChannels, sampleRate, bitrate)

  const left = float32ToInt16(channels[0])
  const right = numChannels > 1 ? float32ToInt16(channels[1]) : undefined

  const mp3Chunks: ArrayBuffer[] = []
  const blockSize = 1152

  let offset = 0
  while (offset < left.length) {
    const leftBlock = left.subarray(offset, offset + blockSize)
    const rightBlock = right ? right.subarray(offset, offset + blockSize) : undefined

    let mp3buf: Int8Array
    if (rightBlock) {
      mp3buf = encoder.encodeBuffer(leftBlock, rightBlock)
    } else {
      mp3buf = encoder.encodeBuffer(leftBlock)
    }

    if (mp3buf.length > 0) {
      mp3Chunks.push(mp3buf.slice().buffer as ArrayBuffer)
    }

    offset += blockSize
  }

  const tail = encoder.flush()
  if (tail.length > 0) {
    mp3Chunks.push(tail.slice().buffer as ArrayBuffer)
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' })
}

export function audioBufferToChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch))
  }
  return channels
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return int16
}