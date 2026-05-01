// AudioWorklet ambient types (not included in standard DOM lib)
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, ctor: { new (): AudioWorkletProcessor; parameterDescriptors?: AudioParamDescriptor[] }): void
declare const sampleRate: number
interface AudioParamDescriptor {
  name: string
  defaultValue?: number
  minValue?: number
  maxValue?: number
  automationRate?: 'a-rate' | 'k-rate'
}

/**
 * Sidechain Compressor AudioWorklet Processor
 *
 * Input 0: audio signal to compress
 * Input 1: sidechain key signal (from another bus)
 *
 * Parameters (AudioParam):
 *   threshold  – dBFS, default -18
 *   ratio      – compression ratio, default 4
 *   attack     – envelope attack in seconds, default 0.003
 *   release    – envelope release in seconds, default 0.25
 *   knee       – knee width in dB, default 10
 */

class SidechainCompressorProcessor extends AudioWorkletProcessor {
  private envelope = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.003, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.25, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 10, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const audioInput = inputs[0]
    const scInput = inputs[1]
    const output = outputs[0]

    if (!audioInput || audioInput.length === 0 || !output || output.length === 0) {
      return true
    }

    const threshold = parameters.threshold[0]
    const ratio = parameters.ratio[0]
    const attack = parameters.attack[0]
    const release = parameters.release[0]
    const knee = parameters.knee[0]

    const sr = sampleRate
    const attackCoeff = attack > 0 ? Math.exp(-1 / (sr * attack)) : 0
    const releaseCoeff = release > 0 ? Math.exp(-1 / (sr * release)) : 0

    const blockSize = audioInput[0].length

    for (let i = 0; i < blockSize; i++) {
      // Compute sidechain RMS from key input (mono sum)
      let scSample = 0
      if (scInput && scInput.length > 0) {
        for (let ch = 0; ch < scInput.length; ch++) {
          scSample += scInput[ch]?.[i] ?? 0
        }
        scSample /= scInput.length
      }

      // Envelope follower on absolute value of sidechain signal
      const scAbs = Math.abs(scSample)
      if (scAbs > this.envelope) {
        this.envelope = attackCoeff * this.envelope + (1 - attackCoeff) * scAbs
      } else {
        this.envelope = releaseCoeff * this.envelope + (1 - releaseCoeff) * scAbs
      }

      // Convert envelope to dB
      const envDb = this.envelope > 1e-8 ? 20 * Math.log10(this.envelope) : -160

      // Compute gain reduction (soft knee)
      let gainReductionDb = 0
      if (knee > 0) {
        const halfKnee = knee / 2
        if (envDb > threshold + halfKnee) {
          // Above knee — full compression
          gainReductionDb = (envDb - threshold) * (1 - 1 / ratio)
        } else if (envDb > threshold - halfKnee) {
          // Within knee — interpolate
          const x = envDb - threshold + halfKnee
          gainReductionDb = (x * x) / (4 * knee) * (1 - 1 / ratio)
        }
        // Below knee — no reduction
      } else {
        if (envDb > threshold) {
          gainReductionDb = (envDb - threshold) * (1 - 1 / ratio)
        }
      }

      const gainLinear = Math.pow(10, -gainReductionDb / 20)

      // Apply gain to audio input, copy to output
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = audioInput[Math.min(ch, audioInput.length - 1)]
        output[ch][i] = (inCh?.[i] ?? 0) * gainLinear
      }
    }

    return true
  }
}

registerProcessor('sidechain-compressor', SidechainCompressorProcessor)
