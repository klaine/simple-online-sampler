/**
 * Additive sine-wave synthesis engine.
 *
 * Creates a bank of OscillatorNodes (one per non-zero harmonic) routed through
 * a gain envelope, optional filter with filter envelope, and an LFO.
 *
 * Used by audioEngine.playPad when pad.settings.source === 'synth'.
 */

import type { SynthParams, PadSettings, FilterType } from '../types'

export interface SynthVoiceNodes {
  oscillators: OscillatorNode[]
  harmonicGains: GainNode[]
  voiceGain: GainNode
  filters: BiquadFilterNode[]
  lfo: OscillatorNode | null
  lfoGain: GainNode | null
  /** Base filter frequency for filter envelope release (Hz). Set when filter envelope is active. */
  filterBaseFreq?: number
  /** Filter envelope release time in seconds. Set when filter envelope is active. */
  filterRelease?: number
}

/** Map FilterType to Web Audio BiquadFilterType and whether to chain two nodes (24dB) */
function resolveFilterType(ft: FilterType): { biquadType: BiquadFilterType; twoStage: boolean } | null {
  switch (ft) {
    case 'lp12': return { biquadType: 'lowpass', twoStage: false }
    case 'lp24': return { biquadType: 'lowpass', twoStage: true }
    case 'highpass': return { biquadType: 'highpass', twoStage: false }
    case 'bandpass': return { biquadType: 'bandpass', twoStage: false }
    default: return null
  }
}

/**
 * Compute the frequency for the LFO in sync mode.
 * rateSyncDiv: musical division (1=whole, 2=half, 4=quarter, 8=eighth, 16=sixteenth)
 */
function lfoSyncFrequency(bpm: number, rateSyncDiv: number): number {
  const beatsPerSec = bpm / 60
  // 1 whole note = 4 beats
  const wholeNoteHz = beatsPerSec / 4
  return wholeNoteHz * rateSyncDiv
}

/**
 * Build and start a synth voice. Returns the nodes so the caller can manage
 * the voice lifecycle (stop, dispose, etc.).
 *
 * @param ctx         AudioContext
 * @param synthParams Synth parameters (harmonics, envelopes, LFO)
 * @param settings    Merged PadSettings (gain, semitones, fineCents, envelope, filter, mode, bus)
 * @param velocity    0–1 velocity
 * @param startTime   AudioContext time to start
 * @param bpm         Current BPM (for tempo-synced LFO)
 * @param forceDuration  Optional forced note duration in seconds (sequencer step duration)
 * @param semitoneOffset Optional additional semitone offset (sequencer pitch)
 */
export function createSynthVoice(
  ctx: AudioContext | OfflineAudioContext,
  synthParams: SynthParams,
  settings: PadSettings,
  velocity: number,
  startTime: number,
  bpm: number,
  forceDuration?: number,
  semitoneOffset?: number,
): SynthVoiceNodes {
  const baseNote = synthParams.baseNote + (settings.semitones ?? 0) + (semitoneOffset ?? 0)
  const fineShift = (settings.fineCents ?? 0) / 100
  const baseFreq = 440 * Math.pow(2, (baseNote + fineShift - 69) / 12)

  const linearGain = Math.max(0.001, settings.gain * velocity)
  const attack = settings.envelope.attack
  const decay = settings.envelope.decay
  const sustain = settings.envelope.sustain ?? 0
  const release = settings.envelope.release

  // --- Create oscillators for each non-zero harmonic ---
  const oscillators: OscillatorNode[] = []
  const harmonicGains: GainNode[] = []

  for (let i = 0; i < synthParams.harmonics.length; i++) {
    const amp = synthParams.harmonics[i]
    if (amp <= 0) continue
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = baseFreq * (i + 1)
    const hGain = ctx.createGain()
    hGain.gain.value = amp
    osc.connect(hGain)
    oscillators.push(osc)
    harmonicGains.push(hGain)
  }

  // --- Voice gain (amplitude envelope) ---
  const voiceGain = ctx.createGain()
  voiceGain.gain.setValueAtTime(0, startTime)

  // Connect all harmonic gains → voice gain
  for (const hg of harmonicGains) {
    hg.connect(voiceGain)
  }

  // --- Amplitude envelope ---
  const mode = settings.mode
  const sustainGain = linearGain * sustain

  if (mode === 'adsr') {
    // ADSR envelope: attack→peak, decay→sustain level, hold sustain, release→zero
    if (forceDuration != null && forceDuration > 0) {
      // Sequencer: play A→D envelope, hold at sustain until noteEnd, then release from current level
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

      // Hold at sustain until noteEnd (if decay finished before noteEnd)
      // Then release from current level to zero
      // Compute gain at noteEnd to release from there
      let gainAtNoteEnd: number
      if (forceDuration <= actualAttack) {
        // Still in attack phase at noteEnd
        gainAtNoteEnd = actualAttack > 0 ? linearGain * (forceDuration / actualAttack) : linearGain
      } else if (actualDecay > 0 && forceDuration < actualAttack + actualDecay) {
        // Still in decay phase at noteEnd — interpolate between peak and sustain
        const decayProgress = (forceDuration - actualAttack) / actualDecay
        gainAtNoteEnd = linearGain + (sustainGain - linearGain) * decayProgress
      } else {
        // Decay finished, at sustain level
        gainAtNoteEnd = sustainGain
      }

      if (gainAtNoteEnd > 0.0001 && release > 0) {
        voiceGain.gain.setValueAtTime(gainAtNoteEnd, noteEnd)
        voiceGain.gain.linearRampToValueAtTime(0, noteEnd + release)
      } else {
        voiceGain.gain.setValueAtTime(0, noteEnd)
      }
    } else {
      // Live hold mode: schedule A→D→sustain hold only; release handled by stopSynthVoice on key-up
      voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + attack)
      voiceGain.gain.linearRampToValueAtTime(sustainGain, startTime + attack + decay)
      // Hold at sustain indefinitely (no release scheduled)
    }
    // If no forceDuration, voice is self-terminating (A+D+R) or held for live key release via stopSynthVoice
  } else if (mode === 'ahr') {
    // AHR envelope: attack→peak, hold at peak, release→zero
    const holdTime = settings.envelope.hold ?? 0
    if (forceDuration != null && forceDuration > 0) {
      // Sequencer: self-terminating AHR (ignores gate)
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
      // Live hold: attack→peak, hold indefinitely until stopSynthVoice
      if (attack > 0) {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + attack)
      } else {
        voiceGain.gain.linearRampToValueAtTime(linearGain, startTime + 0.0015)
      }
    }
  } else {
    // One-shot mode: attack ramp, then decay to zero
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
    // Apply key tracking: offset filter freq by semitoneOffset scaled by keyTrack amount
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

    // --- Filter envelope (applied to all filter stages) ---
    const fEnv = synthParams.filterEnvelope
    if (fEnv.depth > 0) {
      const baseFreqHz = trackedFreq
      // Depth is in semitones — convert to target frequency
      const peakFreqHz = Math.min(20000, baseFreqHz * Math.pow(2, fEnv.depth / 12))
      const sustainFreq = baseFreqHz + (peakFreqHz - baseFreqHz) * fEnv.sustain

      if (forceDuration != null) {
        // Fit filter A→D into forceDuration, then release from current level
        const noteEnd = startTime + forceDuration
        const fActualAttack = Math.min(fEnv.attack, forceDuration)
        const fRemain = forceDuration - fActualAttack
        const fActualDecay = Math.min(fEnv.decay, fRemain)

        // Compute filter freq at noteEnd
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
        // Full filter envelope A→D
        for (const f of filters) {
          f.frequency.setValueAtTime(baseFreqHz, startTime)
          f.frequency.linearRampToValueAtTime(peakFreqHz, startTime + fEnv.attack)
          f.frequency.linearRampToValueAtTime(sustainFreq, startTime + fEnv.attack + fEnv.decay)
        }

        if (mode === 'one-shot') {
          // one-shot: note duration is attack + decay
          const noteEnd = startTime + attack + decay
          for (const f of filters) {
            f.frequency.setValueAtTime(sustainFreq, noteEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
          }
        } else if (mode === 'ahr') {
          // AHR: note duration is attack + hold + release (self-terminating filter release at hold end)
          const holdTime = settings.envelope.hold ?? 0
          const noteEnd = startTime + attack + holdTime
          for (const f of filters) {
            f.frequency.setValueAtTime(sustainFreq, noteEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
          }
        }
        // else: ADSR without forceDuration — release handled by stopSynthVoice
      }

      // Store filter envelope info for stopSynthVoice
      filterBaseFreq = baseFreqHz
      filterReleaseSec = fEnv.release
    }

    voiceGain.connect(filters[0])
    for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i])
  }

  // --- LFO ---
  let lfo: OscillatorNode | null = null
  let lfoGain: GainNode | null = null
  const lfoSettings = synthParams.lfo
  const hasLfoDepth = (lfoSettings.pitchDepth ?? 0) > 0 || (lfoSettings.filterDepth ?? 0) > 0 || (lfoSettings.gainDepth ?? 0) > 0
  if (hasLfoDepth) {
    lfo = ctx.createOscillator()

    // Set LFO waveform
    switch (lfoSettings.waveform) {
      case 'sine': lfo.type = 'sine'; break
      case 'square': lfo.type = 'square'; break
      case 'ramp-up': lfo.type = 'sawtooth'; break
      case 'ramp-down':
        lfo.type = 'sawtooth'
        break
    }

    // Set LFO rate
    const lfoFreq = lfoSettings.rateMode === 'sync'
      ? lfoSyncFrequency(bpm, lfoSettings.rateSyncDiv)
      : lfoSettings.rateHz
    lfo.frequency.value = lfoFreq

    const isInverted = lfoSettings.waveform === 'ramp-down'

    // Pitch modulation
    if ((lfoSettings.pitchDepth ?? 0) > 0) {
      const g = ctx.createGain()
      const depthCents = lfoSettings.pitchDepth * 200
      g.gain.value = isInverted ? -depthCents : depthCents
      lfo.connect(g)
      for (const osc of oscillators) {
        g.connect(osc.detune)
      }
      lfoGain = g // keep reference for disposal
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

    lfo.start(startTime)
  }

  // Start all oscillators
  for (const osc of oscillators) {
    osc.start(startTime)
  }

  // Schedule stop for finite modes (not for ADSR hold — stopSynthVoice handles that)
  let stopTime: number | undefined
  if (mode === 'adsr') {
    if (forceDuration != null) {
      stopTime = startTime + forceDuration + release + 0.05
    }
    // else: hold mode — no pre-scheduled stop, stopSynthVoice will call osc.stop()
  } else if (mode === 'one-shot') {
    stopTime = startTime + attack + decay + 0.05
  }

  if (stopTime != null) {
    for (const osc of oscillators) {
      osc.stop(stopTime)
    }
    if (lfo) lfo.stop(stopTime)
  }

  return { oscillators, harmonicGains, voiceGain, filters, lfo, lfoGain, filterBaseFreq, filterRelease: filterReleaseSec }
}

/**
 * Stop a synth voice gracefully (for ADSR mode note-off during live playing).
 */
export function stopSynthVoice(
  ctx: AudioContext | OfflineAudioContext,
  nodes: SynthVoiceNodes,
  release: number,
): void {
  const now = ctx.currentTime
  nodes.voiceGain.gain.cancelScheduledValues(now)
  nodes.voiceGain.gain.setValueAtTime(nodes.voiceGain.gain.value, now)
  nodes.voiceGain.gain.linearRampToValueAtTime(0, now + release)

  // Release filter envelope back to base frequency
  if (nodes.filters.length > 0 && nodes.filterBaseFreq != null && nodes.filterRelease != null) {
    for (const f of nodes.filters) {
      f.frequency.cancelScheduledValues(now)
      f.frequency.setValueAtTime(f.frequency.value, now)
      f.frequency.linearRampToValueAtTime(nodes.filterBaseFreq, now + nodes.filterRelease)
    }
  }

  const stopAt = now + release + 0.05
  for (const osc of nodes.oscillators) {
    try { osc.stop(stopAt) } catch { /* ignore */ }
  }
  if (nodes.lfo) {
    try { nodes.lfo.stop(stopAt) } catch { /* ignore */ }
  }
}

/**
 * Disconnect and clean up a synth voice's nodes.
 */
export function disposeSynthVoice(nodes: SynthVoiceNodes): void {
  for (const osc of nodes.oscillators) {
    try { osc.disconnect() } catch { /* ignore */ }
  }
  for (const hg of nodes.harmonicGains) {
    try { hg.disconnect() } catch { /* ignore */ }
  }
  try { nodes.voiceGain.disconnect() } catch { /* ignore */ }
  for (const f of nodes.filters) { try { f.disconnect() } catch { /* ignore */ } }
  if (nodes.lfo) try { nodes.lfo.disconnect() } catch { /* ignore */ }
  if (nodes.lfoGain) try { nodes.lfoGain.disconnect() } catch { /* ignore */ }
}

/**
 * Render a synth pad to an AudioBuffer (for WAV export with loop points).
 * Renders exactly 2 cycles of the base frequency, with loop points at cycle 2.
 */
export function renderSynthToBuffer(
  synthParams: SynthParams,
  settings: PadSettings,
  sampleRate: number = 44100,
  durationSec: number = 2,
): { buffer: AudioBuffer; loopStart: number; loopEnd: number } {
  const baseNote = synthParams.baseNote + (settings.semitones ?? 0)
  const fineShift = (settings.fineCents ?? 0) / 100
  const baseFreq = 440 * Math.pow(2, (baseNote + fineShift - 69) / 12)

  // Render enough for durationSec
  const totalSamples = Math.ceil(sampleRate * durationSec)
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: totalSamples, sampleRate })
  const data = buffer.getChannelData(0)

  // Additive synthesis
  for (let i = 0; i < synthParams.harmonics.length; i++) {
    const amp = synthParams.harmonics[i]
    if (amp <= 0) continue
    const freq = baseFreq * (i + 1)
    const omega = 2 * Math.PI * freq / sampleRate
    for (let s = 0; s < totalSamples; s++) {
      data[s] += amp * Math.sin(omega * s)
    }
  }

  // Normalize to -3 dBFS
  let peak = 0
  for (let s = 0; s < totalSamples; s++) {
    peak = Math.max(peak, Math.abs(data[s]))
  }
  if (peak > 0) {
    const targetPeak = Math.pow(10, -3 / 20) // -3 dBFS
    const scale = targetPeak / peak
    for (let s = 0; s < totalSamples; s++) {
      data[s] *= scale
    }
  }

  // Loop points: one full cycle of the fundamental
  const cycleSamples = Math.round(sampleRate / baseFreq)
  const loopStart = 0
  const loopEnd = cycleSamples

  return { buffer, loopStart, loopEnd }
}
