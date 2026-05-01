export interface WavLoopPoints {
  startFrame: number
  endFrame: number
}

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV blob.
 * Optionally embeds a `smpl` loop-point chunk.
 */
export const encodeWav = (buffer: AudioBuffer, loopPoints?: WavLoopPoints): Blob => {
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels))
  const sampleRate = buffer.sampleRate
  return encodeWavFromChannels(
    Array.from({ length: channelCount }, (_, i) => buffer.getChannelData(i)),
    sampleRate,
    loopPoints,
  )
}

/**
 * Encode raw Float32 channel data as a 16-bit PCM WAV blob.
 * All channels must have the same length.
 */
export const encodeWavFromChannels = (
  channels: Float32Array[],
  sampleRate: number,
  loopPoints?: WavLoopPoints,
): Blob => {
  const channelCount = Math.min(2, Math.max(1, channels.length))
  const frameCount = channels[0].length
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const dataSize = frameCount * blockAlign
  const hasLoop =
    Boolean(loopPoints) &&
    (loopPoints?.startFrame ?? 0) >= 0 &&
    (loopPoints?.endFrame ?? 0) > (loopPoints?.startFrame ?? 0) &&
    (loopPoints?.endFrame ?? 0) <= frameCount
  const smplChunkSize = hasLoop ? 68 : 0
  const totalSize = 44 + dataSize + smplChunkSize
  const output = new ArrayBuffer(totalSize)
  const view = new DataView(output)

  let offset = 0
  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
    offset += value.length
  }

  writeString('RIFF')
  view.setUint32(offset, totalSize - 8, true)
  offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true)
  offset += 4
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint16(offset, channelCount, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true)
  offset += 4
  view.setUint16(offset, blockAlign, true)
  offset += 2
  view.setUint16(offset, 16, true)
  offset += 2
  writeString('data')
  view.setUint32(offset, dataSize, true)
  offset += 4

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0))
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      offset += 2
    }
  }

  if (hasLoop && loopPoints) {
    const loopStart = Math.max(0, Math.min(frameCount - 1, loopPoints.startFrame))
    const loopEndExclusive = Math.max(loopStart + 1, Math.min(frameCount, loopPoints.endFrame))
    const loopEnd = loopEndExclusive - 1

    writeString('smpl')
    view.setUint32(offset, 36 + 24, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, Math.round(1_000_000_000 / sampleRate), true)
    offset += 4
    view.setUint32(offset, 60, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 1, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4

    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, loopStart, true)
    offset += 4
    view.setUint32(offset, loopEnd, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
  }

  return new Blob([output], { type: 'audio/wav' })
}
