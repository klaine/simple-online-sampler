/* eslint-disable no-var */
// AudioWorklet ambient types (not included in standard DOM lib)
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

/**
 * AudioWorklet processor that captures mono input samples
 * and posts them to the main thread for live waveform display.
 */
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array
  private writeIndex: number

  constructor() {
    super()
    // Accumulate samples and flush every ~2048 samples (~46ms at 44.1kHz)
    this.buffer = new Float32Array(2048)
    this.writeIndex = 0
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channel = input[0]
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i]
      if (this.writeIndex >= this.buffer.length) {
        // Post a copy and reset
        this.port.postMessage({ samples: this.buffer.slice() })
        this.writeIndex = 0
      }
    }
    return true
  }
}

registerProcessor('recorder-worklet', RecorderWorkletProcessor)
