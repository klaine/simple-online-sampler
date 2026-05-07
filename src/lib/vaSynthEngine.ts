/**
 * Virtual Analog (VA) synth engine — dual oscillator + hard sync + PWM.
 *
 * Live path: uses AudioWorkletNode ('va-dual-osc') for oscillator generation.
 * Offline path: uses CPU-side DSP via renderVASynthToBuffer().
 */

import type { SynthParams, PadSettings, VAOscWaveform } from '../types'
import { resolveFilterType } from './voiceUtils'
import type { SynthVoiceNodes } from './synthEngine'

function midiToFreq(note: number, cents: number): number {
  return 440 * Math.pow(2, (note + cents / 100 - 69) / 12)
}

function lfoSyncFrequency(bpm: number, rateSyncDiv: number): number {
  const beatsPerSec = bpm / 60
  const wholeNoteHz = beatsPerSec / 4
  return wholeNoteHz * rateSyncDiv
}

function waveTypeNum(w: VAOscWaveform): number {
  switch (w) {
    case 'saw': return 0
    case 'square': return 1
    case 'triangle': return 2
    case 'sine': return 3
  }
}

/**
 * Create a VA synth voice using AudioWorkletNode.
 */
export function createVASynthVoice(
  ctx: AudioContext | OfflineAudioContext,
  synthParams: SynthParams,
  settings: PadSettings,
  velocity: number,
  startTime: number,
  bpm: number,
  forceDuration?: number,
  semitoneOffset?: number,
): SynthVoiceNodes {
  const va = synthParams.va!
  const baseNote = synthParams.baseNote + (settings.semitones ?? 0) + (semitoneOffset ?? 0)
  const fineShift = (settings.fineCents ?? 0) / 100

  const osc1Freq = midiToFreq(baseNote + va.osc1.semitones, fineShift * 100 + va.osc1.fineCents)
  const osc2Freq = midiToFreq(baseNote + va.osc2.semitones, fineShift * 100 + va.osc2.fineCents)

  const linearGain = Math.max(0.001, settings.gain * velocity)
  const attack = settings.envelope.attack
  const decay = settings.envelope.decay
  const sustain = settings.envelope.sustain ?? 0
  const release = settings.envelope.release

  // --- VA oscillator AudioWorkletNode ---
  let vaWorklet: AudioWorkletNode | undefined
  try {
    vaWorklet = new AudioWorkletNode(ctx, 'va-dual-osc', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {},
    })
  } catch {
    // Fallback: create a silent gain node so the graph still works
  }

  // Set static config via port
  if (vaWorklet) {
    vaWorklet.port.postMessage({
      type: 'config',
      osc1Wave: waveTypeNum(va.osc1.waveform),
      osc2Wave: waveTypeNum(va.osc2.waveform),
      syncEnabled: va.oscSync,
    })
  }

  // --- Voice gain (amplitude envelope) ---
  const voiceGain = ctx.createGain()
  voiceGain.gain.setValueAtTime(0, startTime)

  // Connect worklet → voice gain
  if (vaWorklet) {
    vaWorklet.connect(voiceGain)
  }

  // --- Set worklet AudioParams ---
  const setWorkletParam = (param: AudioParam | undefined, value: number) => {
    if (param) param.setValueAtTime(value, startTime)
  }
  if (vaWorklet) {
    const params = vaWorklet.parameters as Map<string, AudioParam>
    setWorkletParam(params.get('osc1Freq'), osc1Freq)
    setWorkletParam(params.get('osc2Freq'), osc2Freq)
    setWorkletParam(params.get('osc1Pw'), va.osc1.pulseWidth)
    setWorkletParam(params.get('osc2Pw'), va.osc2.pulseWidth)
    setWorkletParam(params.get('oscMix'), va.oscMix)
  }

  // --- Amplitude envelope (same logic as additive synth) ---
  const mode = settings.mode
  const sustainGain = linearGain * sustain

  if (mode === 'adsr') {
    if (forceDuration != null && forceDuration > 0) {
      const noteEnd = startTime + forceDuration
      const actualAttack = Math.min(attack, forceDuration)
      if (actualAttack > 0) {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + actualAttack)
      } else {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + 0.0015)
      }
      const remainAfterAttack = forceDuration - actualAttack
      const actualDecay = Math.min(decay, remainAfterAttack)
      if (actualDecay > 0) {
        voiceGain.gain.linearRampToValueAtTime(sustainGain, startTime + actualAttack + actualDecay)
      }
      let gainAtNoteEnd: number
      if (forceDuration <= actualAttack) {
        gainAtNoteEnd = actualAttack > 0 ? linearGain * (forceDuration / actualAttack) : linearGain
      } else if (actualDecay > 0 && forceDuration < actualAttack + actualDecay) {
        const decayProgress = (forceDuration - actualAttack) / actualDecay
        gainAtNoteEnd = linearGain + (sustainGain - linearGain) * decayProgress
      } else {
        gainAtNoteEnd = sustainGain
      }
      if (gainAtNoteEnd > 0.0001 && release > 0) {
        voiceGain.gain.setValueAtTime(gainAtNoteEnd, noteEnd)
        voiceGain.gain.linearRampToValueAtTime(0, noteEnd + release)
      } else {
        voiceGain.gain.setValueAtTime(0, noteEnd)
      }
    } else {
      voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + attack)
      voiceGain.gain.linearRampToValueAtTime(sustainGain, startTime + attack + decay)
    }
  } else if (mode === 'ahr') {
    const holdTime = settings.envelope.hold ?? 0
    if (forceDuration != null && forceDuration > 0) {
      const actualAttack = Math.min(attack, forceDuration)
      if (actualAttack > 0) {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + actualAttack)
      } else {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + 0.0015)
      }
      const holdEnd = startTime + actualAttack + holdTime
      if (holdTime > 0) {
        voiceGain.gain.setValueAtTime(linearGain, holdEnd)
      }
      if (release > 0) {
        voiceGain.gain.linearRampToValueAtTime(0, holdEnd + release)
      } else {
        voiceGain.gain.setValueAtTime(0, holdEnd)
      }
    } else {
      if (attack > 0) {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + attack)
      } else {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + 0.0015)
      }
    }
  } else {
    voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + attack)
    voiceGain.gain.setValueAtTime(linearGain, startTime + attack)
    voiceGain.gain.linearRampToValueAtTime(0, startTime + attack + decay)
  }

  // --- Filter ---
  const filters: BiquadFilterNode[] = []
  let filterBaseFreq: number | undefined
  let filterReleaseSec: number | undefined
  const resolvedFt = resolveFilterType(settings.filterType)
  if (settings.filterType === 'lphp') {
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = settings.filterFreq ?? 20
    hp.Q.value = settings.filterQ ?? 0.7
    filters.push(hp)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = settings.filterFreq2 ?? 20000
    lp.Q.value = settings.filterQ ?? 0.7
    filters.push(lp)
  } else if (resolvedFt) {
    const keyTrack = (settings.filterKeyTrack ?? 0) / 100
    const keyTrackSemitones = (semitoneOffset ?? 0) * keyTrack
    const nominalFreq = settings.filterFreq ?? 1000
    const trackedFreq = Math.max(20, Math.min(20000, nominalFreq * Math.pow(2, keyTrackSemitones / 12)))

    const f1 = ctx.createBiquadFilter()
    f1.type = resolvedFt.biquadType
    f1.frequency.value = trackedFreq
    f1.Q.value = settings.filterQ ?? 1
    filters.push(f1)
    if (resolvedFt.twoStage) {
      const f2 = ctx.createBiquadFilter()
      f2.type = resolvedFt.biquadType
      f2.frequency.value = trackedFreq
      f2.Q.value = settings.filterQ ?? 1
      filters.push(f2)
    }

    // --- Filter envelope ---
    const fEnv = synthParams.filterEnvelope
    if (fEnv.depth > 0) {
      const baseFreqHz = trackedFreq
      const peakFreqHz = Math.min(20000, baseFreqHz * Math.pow(2, fEnv.depth / 12))
      const sustainFreq = baseFreqHz + (peakFreqHz - baseFreqHz) * fEnv.sustain

      if (forceDuration != null) {
        const noteEnd = startTime + forceDuration
        const fActualAttack = Math.min(fEnv.attack, forceDuration)
        const fRemain = forceDuration - fActualAttack
        const fActualDecay = Math.min(fEnv.decay, fRemain)
        let freqAtNoteEnd: number
        if (forceDuration <= fActualAttack) {
          freqAtNoteEnd = fActualAttack > 0 ? baseFreqHz + (peakFreqHz - baseFreqHz) * (forceDuration / fActualAttack) : peakFreqHz
        } else if (fActualDecay > 0 && forceDuration < fActualAttack + fActualDecay) {
          const decayProgress = (forceDuration - fActualAttack) / fActualDecay
          freqAtNoteEnd = peakFreqHz + (sustainFreq - peakFreqHz) * decayProgress
        } else {
          freqAtNoteEnd = sustainFreq
        }
        for (const f of filters) {
          f.frequency.setValueAtTime(baseFreqHz, startTime)
          f.frequency.linearRampToValueAtTime(peakFreqHz, startTime + Math.max(fActualAttack, 0.001))
          if (fActualDecay > 0) {
            f.frequency.linearRampToValueAtTime(sustainFreq, startTime + fActualAttack + fActualDecay)
          }
          f.frequency.setValueAtTime(freqAtNoteEnd, noteEnd)
          f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
        }
      } else {
        for (const f of filters) {
          f.frequency.setValueAtTime(baseFreqHz, startTime)
          f.frequency.linearRampToValueAtTime(peakFreqHz, startTime + fEnv.attack)
          f.frequency.linearRampToValueAtTime(sustainFreq, startTime + fEnv.attack + fEnv.decay)
        }
        if (mode === 'one-shot') {
          const noteEnd = startTime + attack + decay
          for (const f of filters) {
            f.frequency.setValueAtTime(sustainFreq, noteEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
          }
        } else if (mode === 'ahr') {
          const holdTime = settings.envelope.hold ?? 0
          const noteEnd = startTime + attack + holdTime
          for (const f of filters) {
            f.frequency.setValueAtTime(sustainFreq, noteEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
          }
        }
      }
      filterBaseFreq = baseFreqHz
      filterReleaseSec = fEnv.release
    }

    voiceGain.connect(filters[0])
    for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i])
  }

  // --- LFO ---
  let lfo: OscillatorNode | null = null
  let lfoGain: GainNode | null = null
  let pwGain: GainNode | null = null
  const lfoSettings = synthParams.lfo
  const hasLfoDepth = (lfoSettings.pitchDepth ?? 0) > 0 || (lfoSettings.filterDepth ?? 0) > 0 || (lfoSettings.gainDepth ?? 0) > 0 || (lfoSettings.pwDepth ?? 0) > 0
  if (hasLfoDepth && ctx instanceof AudioContext) {
    // Note: LFO only works in AudioContext (live), not OfflineAudioContext
    // For offline, the LFO effect is not rendered (consistent with additive offline behavior)
    lfo = ctx.createOscillator()

    switch (lfoSettings.waveform) {
      case 'sine': lfo.type = 'sine'; break
      case 'square': lfo.type = 'square'; break
      case 'ramp-up': lfo.type = 'sawtooth'; break
      case 'ramp-down': lfo.type = 'sawtooth'; break
    }

    const lfoFreq = lfoSettings.rateMode === 'sync'
      ? lfoSyncFrequency(bpm, lfoSettings.rateSyncDiv)
      : lfoSettings.rateHz
    lfo.frequency.value = lfoFreq

    // Trigger mode: start LFO at startTime
    if (lfoSettings.triggerMode === 'trigger') {
      try { lfo.start(startTime) } catch { /* ignore */ }
    } else {
      lfo.start()
    }

    const isInverted = lfoSettings.waveform === 'ramp-down'

    // Pitch modulation (on worklet's osc1Freq + osc2Freq AudioParams)
    if ((lfoSettings.pitchDepth ?? 0) > 0 && vaWorklet) {
      const g = ctx.createGain()
      const depthCents = lfoSettings.pitchDepth * 200
      g.gain.value = isInverted ? -depthCents : depthCents
      lfo.connect(g)
      const wParams = vaWorklet.parameters as Map<string, AudioParam>
      const osc1FreqParam = wParams.get('osc1Freq')
      const osc2FreqParam = wParams.get('osc2Freq')
      if (osc1FreqParam) g.connect(osc1FreqParam)
      if (osc2FreqParam) g.connect(osc2FreqParam)
      lfoGain = g
    }

    // Filter modulation
    if ((lfoSettings.filterDepth ?? 0) > 0 && filters.length > 0) {
      const g = ctx.createGain()
      const depthHz = lfoSettings.filterDepth * 4000
      g.gain.value = isInverted ? -depthHz : depthHz
      lfo.connect(g)
      for (const f of filters) g.connect(f.frequency)
      if (!lfoGain) lfoGain = g
    }

    // Gain modulation (tremolo)
    if ((lfoSettings.gainDepth ?? 0) > 0) {
      const g = ctx.createGain()
      const depthGain = lfoSettings.gainDepth * 0.5
      g.gain.value = isInverted ? -depthGain : depthGain
      lfo.connect(g)
      g.connect(voiceGain.gain)
      if (!lfoGain) lfoGain = g
    }

    // PWM modulation
    const pwDepthVal = lfoSettings.pwDepth ?? 0
    if (pwDepthVal > 0 && vaWorklet) {
      const g = ctx.createGain()
      const depthPw = pwDepthVal * 0.4
      g.gain.value = isInverted ? -depthPw : depthPw
      lfo.connect(g)
      const wParams = vaWorklet.parameters as Map<string, AudioParam>
      const pw1Param = wParams.get('osc1Pw')
      const pw2Param = wParams.get('osc2Pw')
      if (pw1Param) g.connect(pw1Param)
      if (pw2Param) g.connect(pw2Param)
      pwGain = g
    }
  }

  // Schedule stop for finite modes
  let stopTime: number | undefined
  if (mode === 'adsr') {
    if (forceDuration != null) {
      stopTime = startTime + forceDuration + release + 0.05
    }
  } else if (mode === 'one-shot') {
    stopTime = startTime + attack + decay + 0.05
  }

  if (stopTime != null && vaWorklet && ctx instanceof AudioContext) {
    // Schedule param ramps to zero at stop time
    // (worklet keeps running, but gain ramp silences it)
  }

  return {
    oscillators: [],
    harmonicGains: [],
    voiceGain,
    filters,
    lfo,
    lfoGain,
    vaWorklet,
    pwGain,
    filterBaseFreq,
    filterRelease: filterReleaseSec,
  }
}

/**
 * Stop a VA synth voice gracefully (note-off).
 */
export function stopVASynthVoice(
  ctx: AudioContext | OfflineAudioContext,
  nodes: SynthVoiceNodes,
  release: number,
): void {
  const now = ctx.currentTime
  nodes.voiceGain.gain.cancelScheduledValues(now)
  nodes.voiceGain.gain.setValueAtTime(nodes.voiceGain.gain.value, now)
  nodes.voiceGain.gain.linearRampToValueAtTime(0, now + release)

  if (nodes.filters.length > 0 && nodes.filterBaseFreq != null && nodes.filterRelease != null) {
    for (const f of nodes.filters) {
      f.frequency.cancelScheduledValues(now)
      f.frequency.setValueAtTime(f.frequency.value, now)
      f.frequency.linearRampToValueAtTime(nodes.filterBaseFreq, now + nodes.filterRelease)
    }
  }

  // Stop LFO
  if (nodes.lfo) {
    try { nodes.lfo.stop(now + release + 0.05) } catch { /* ignore */ }
  }

  // Stop worklet
  if (nodes.vaWorklet && ctx instanceof AudioContext) {
    try { nodes.vaWorklet.port.postMessage({ type: 'stop' }) } catch { /* ignore */ }
  }
}

/**
 * Disconnect and clean up VA synth voice nodes.
 */
export function disposeVASynthVoice(nodes: SynthVoiceNodes): void {
  if (nodes.vaWorklet) {
    try { nodes.vaWorklet.disconnect() } catch { /* ignore */ }
  }
  try { nodes.voiceGain.disconnect() } catch { /* ignore */ }
  for (const f of nodes.filters) { try { f.disconnect() } catch { /* ignore */ } }
  if (nodes.lfo) try { nodes.lfo.disconnect() } catch { /* ignore */ }
  if (nodes.lfoGain) try { nodes.lfoGain.disconnect() } catch { /* ignore */ }
  if (nodes.pwGain) try { nodes.pwGain.disconnect() } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// CPU-side oscillator generation (for offline render)
// ---------------------------------------------------------------------------

function generateVAOscSample(
  phase: number,
  waveType: number,
  pw: number,
): number {
  // waveType: 0=saw, 1=square, 2=triangle, 3=sine
  const p = phase - Math.floor(phase)
  switch (waveType) {
    case 0: return 2 * p - 1
    case 1: return p < pw ? 1 : -1
    case 2: return 4 * Math.abs(p - 0.5) - 1
    case 3: return Math.sin(2 * Math.PI * p)
    default: return 0
  }
}

/**
 * Render a VA synth voice to AudioBuffer using CPU DSP (for WAV export and offline rendering).
 * Generates the oscillator output with AMP envelope applied.
 */
export function renderVASynthToBuffer(
  synthParams: SynthParams,
  settings: PadSettings,
  velocity: number,
  durationSec: number,
  _bpm: number,
  semitoneOffset?: number,
  sampleRate: number = 44100,
): { buffer: AudioBuffer; loopStart: number; loopEnd: number } {
  const va = synthParams.va!
  const baseNote = synthParams.baseNote + (settings.semitones ?? 0) + (semitoneOffset ?? 0)
  const fineShift = (settings.fineCents ?? 0) / 100
  const baseFreq = midiToFreq(baseNote, fineShift * 100)

  const osc1Freq = midiToFreq(baseNote + va.osc1.semitones, fineShift * 100 + va.osc1.fineCents)
  const osc2Freq = midiToFreq(baseNote + va.osc2.semitones, fineShift * 100 + va.osc2.fineCents)

  const totalSamples = Math.ceil(sampleRate * durationSec)
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: totalSamples, sampleRate })
  const data = buffer.getChannelData(0)

  const linearGain = Math.max(0.001, settings.gain * velocity)
  const attack = settings.envelope.attack
  const decay = settings.envelope.decay
  const sustain = settings.envelope.sustain ?? 0
  const release = settings.envelope.release
  const mode = settings.mode
  const sustainGain = linearGain * sustain

  const osc1WaveNum = waveTypeNum(va.osc1.waveform)
  const osc2WaveNum = waveTypeNum(va.osc2.waveform)
  const pw1 = va.osc1.pulseWidth
  const pw2 = va.osc2.pulseWidth
  const sync = va.oscSync
  const mixVal = va.oscMix
  const m2 = (mixVal + 1) / 2
  const m1 = 1 - m2

  let osc1Phase = 0
  let osc2Phase = 0
  let syncTriggered = false

  let attackSamples: number
  let decaySamples: number
  let releaseSamples: number
  let sustainSamples: number

  if (mode === 'one-shot') {
    attackSamples = Math.ceil(attack * sampleRate)
    decaySamples = Math.ceil(decay * sampleRate)
    releaseSamples = 0
    sustainSamples = 0
  } else if (mode === 'adsr') {
    attackSamples = Math.ceil(attack * sampleRate)
    decaySamples = Math.ceil(decay * sampleRate)
    releaseSamples = Math.ceil(release * sampleRate)
    const adsrLen = attackSamples + decaySamples + releaseSamples
    const totalLen = Math.min(adsrLen, totalSamples)
    sustainSamples = Math.max(0, totalLen - attackSamples - decaySamples - releaseSamples)
  } else {
    // AHR
    const holdTime = settings.envelope.hold ?? 0
    attackSamples = Math.ceil(attack * sampleRate)
    const holdSamples = Math.ceil(holdTime * sampleRate)
    releaseSamples = Math.ceil(release * sampleRate)
    const ahrLen = attackSamples + holdSamples + releaseSamples
    const totalLen = Math.min(ahrLen, totalSamples)
    sustainSamples = Math.max(0, totalLen - attackSamples - releaseSamples)
    decaySamples = 0
  }

  for (let s = 0; s < totalSamples; s++) {
    // Oscillator generation
    osc1Phase += osc1Freq / sampleRate
    if (osc1Phase >= 1.0) { osc1Phase -= 1.0; syncTriggered = true }
    if (sync && syncTriggered) osc2Phase = 0
    syncTriggered = false
    osc2Phase += osc2Freq / sampleRate
    if (osc2Phase >= 1.0) osc2Phase -= 1.0

    const s1 = generateVAOscSample(osc1Phase, osc1WaveNum, pw1)
    const s2 = generateVAOscSample(osc2Phase, osc2WaveNum, pw2)
    const oscOut = s1 * m1 + s2 * m2

    // Envelope
    let env = 0
    if (mode === 'one-shot') {
      if (s < attackSamples) {
        env = linearGain * (s / attackSamples)
      } else if (s < attackSamples + decaySamples) {
        env = linearGain * (1 - (s - attackSamples) / decaySamples)
      }
    } else if (mode === 'adsr') {
      if (s < attackSamples) {
        env = linearGain * (s / attackSamples)
      } else if (s < attackSamples + decaySamples) {
        const t = (s - attackSamples) / decaySamples
        env = linearGain + (sustainGain - linearGain) * t
      } else if (s < attackSamples + decaySamples + sustainSamples) {
        env = sustainGain
      } else if (s < attackSamples + decaySamples + sustainSamples + releaseSamples) {
        const t = (s - attackSamples - decaySamples - sustainSamples) / releaseSamples
        env = sustainGain * (1 - t)
      }
    } else {
      // AHR
      if (s < attackSamples) {
        env = linearGain * (s / attackSamples)
      } else if (s < attackSamples + sustainSamples) {
        env = linearGain
      } else if (s < attackSamples + sustainSamples + releaseSamples) {
        const t = (s - attackSamples - sustainSamples) / releaseSamples
        env = linearGain * (1 - t)
      }
    }

    data[s] = oscOut * env
  }

  const cycleSamples = Math.round(sampleRate / baseFreq)
  return { buffer, loopStart: 0, loopEnd: cycleSamples }
}
