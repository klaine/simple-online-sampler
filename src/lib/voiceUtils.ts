import type { FilterType, Pad, PadSettings, SampleLayer } from '../types'

/** Merge a layer's non-null overrides onto pad settings */
export function mergeLayerSettings(settings: PadSettings, layer: SampleLayer | null): PadSettings {
  if (!layer) return settings
  return {
    ...settings,
    gain: layer.gain ?? settings.gain,
    semitones: layer.semitones ?? settings.semitones,
    fineCents: layer.fineCents ?? settings.fineCents,
    trim: layer.trim ?? settings.trim,
    envelope: layer.envelope ?? settings.envelope,
    filterType: layer.filterType ?? settings.filterType,
    filterFreq: layer.filterFreq ?? settings.filterFreq,
    filterQ: layer.filterQ ?? settings.filterQ,
  }
}

/** Map FilterType to Web Audio BiquadFilterType and whether to chain two nodes (24dB) */
export function resolveFilterType(ft: FilterType): { biquadType: BiquadFilterType; twoStage: boolean } | null {
  switch (ft) {
    case 'lp12': return { biquadType: 'lowpass', twoStage: false }
    case 'lp24': return { biquadType: 'lowpass', twoStage: true }
    case 'highpass': return { biquadType: 'highpass', twoStage: false }
    case 'bandpass': return { biquadType: 'bandpass', twoStage: false }
    default: return null
  }
}

/** Resolve which sample/layer to play for a pad (round-robin, random, velocity) */
export function resolveLayer(
  pad: Pad,
  velocity127: number,
  rrCounter: { get: (padId: string) => number; set: (padId: string, val: number) => void },
): { sampleId: string; layer: SampleLayer | null } | null {
  const { layers, multiMode, sampleId } = pad.settings
  if (!layers || layers.length === 0 || multiMode === 'single') {
    return sampleId ? { sampleId, layer: null } : null
  }
  switch (multiMode) {
    case 'round-robin': {
      const idx = rrCounter.get(pad.id) ?? 0
      rrCounter.set(pad.id, (idx + 1) % layers.length)
      const layer = layers[idx % layers.length]
      return { sampleId: layer.sampleId, layer }
    }
    case 'random': {
      const idx = Math.floor(Math.random() * layers.length)
      const layer = layers[idx]
      return { sampleId: layer.sampleId, layer }
    }
    case 'velocity': {
      const layer = layers.find((l) => velocity127 >= l.velocityLow && velocity127 <= l.velocityHigh)
        ?? layers[layers.length - 1]
      return { sampleId: layer.sampleId, layer }
    }
    default:
      return sampleId ? { sampleId, layer: null } : null
  }
}

/** Build a per-pad filter chain and return the nodes plus input/output for wiring */
export function createFilterChain(
  ctx: BaseAudioContext,
  settings: PadSettings,
): { nodes: BiquadFilterNode[]; input: AudioNode; output: AudioNode } | null {
  if (settings.filterType === 'lphp') {
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = settings.filterFreq ?? 20
    hp.Q.value = settings.filterQ ?? 0.7
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = settings.filterFreq2 ?? 20000
    lp.Q.value = settings.filterQ ?? 0.7
    hp.connect(lp)
    return { nodes: [hp, lp], input: hp, output: lp }
  }
  const resolved = resolveFilterType(settings.filterType)
  if (!resolved) return null
  const f1 = ctx.createBiquadFilter()
  f1.type = resolved.biquadType
  f1.frequency.value = settings.filterFreq ?? 1000
  f1.Q.value = settings.filterQ ?? 1
  const nodes: BiquadFilterNode[] = [f1]
  if (resolved.twoStage) {
    const f2 = ctx.createBiquadFilter()
    f2.type = resolved.biquadType
    f2.frequency.value = settings.filterFreq ?? 1000
    f2.Q.value = settings.filterQ ?? 1
    f1.connect(f2)
    nodes.push(f2)
  }
  return { nodes, input: nodes[0], output: nodes[nodes.length - 1] }
}

/** Schedule an amplitude envelope on a GainNode and return the computed note/source durations */
export function scheduleAmplitudeEnvelope(
  gainParam: AudioParam,
  startTime: number,
  baseGain: number,
  settings: PadSettings,
  playbackDurationSec: number,
  forceDurationSec?: number,
  hold?: boolean,
): { noteDurationSec: number; sourceStopSec: number } {
  const mode = settings.mode
  const attack = settings.envelope.attack
  const decay = settings.envelope.decay
  const sustain = settings.envelope.sustain ?? 0
  const release = settings.envelope.release
  const sustainGain = baseGain * sustain

  if (mode === 'one-shot') {
    const actualAttack = attack > 0 ? Math.min(attack, playbackDurationSec) : 0.0015
    gainParam.setValueAtTime(0, startTime)
    gainParam.linearRampToValueAtTime(baseGain, startTime + actualAttack)
    return { noteDurationSec: playbackDurationSec, sourceStopSec: playbackDurationSec }
  }

  if (mode === 'ahr') {
    const holdTime = settings.envelope.hold ?? 0
    const ahrDuration = Math.max(0.05, attack + holdTime + release)
    const noteDurationSec = Math.min(playbackDurationSec, ahrDuration)
    const sourceStopSec = noteDurationSec

    gainParam.setValueAtTime(0, startTime)
    const actualAttack = Math.min(attack, noteDurationSec)
    if (actualAttack > 0) {
      gainParam.linearRampToValueAtTime(baseGain, startTime + actualAttack)
    } else {
      gainParam.linearRampToValueAtTime(baseGain, startTime + 0.0015)
    }
    const holdEnd = startTime + actualAttack + holdTime
    if (holdTime > 0) {
      gainParam.setValueAtTime(baseGain, holdEnd)
    }
    const actualRelease = Math.min(release, noteDurationSec - actualAttack - holdTime)
    if (actualRelease > 0) {
      gainParam.linearRampToValueAtTime(0, holdEnd + actualRelease)
    }
    return { noteDurationSec, sourceStopSec }
  }

  // ADSR
  if (forceDurationSec != null && forceDurationSec > 0) {
    // Gate-clamped ADSR (sequencer step)
    const noteDurationSec = Math.min(playbackDurationSec, forceDurationSec)
    const sourceStopSec = Math.min(playbackDurationSec, noteDurationSec + release)

    gainParam.setValueAtTime(0, startTime)
    const actualAttack = Math.min(attack, noteDurationSec)
    if (actualAttack > 0) {
      gainParam.linearRampToValueAtTime(baseGain, startTime + actualAttack)
    } else {
      gainParam.linearRampToValueAtTime(baseGain, startTime + 0.0015)
    }
    const remainAfterAttack = noteDurationSec - actualAttack
    const actualDecay = Math.min(decay, remainAfterAttack)
    if (actualDecay > 0) {
      gainParam.linearRampToValueAtTime(sustainGain, startTime + actualAttack + actualDecay)
    }
    if (release > 0 && sourceStopSec > noteDurationSec) {
      gainParam.setValueAtTime(sustainGain, startTime + noteDurationSec)
      gainParam.linearRampToValueAtTime(0, startTime + sourceStopSec)
    }

    return { noteDurationSec, sourceStopSec }
  }

  // ADSR without forced duration
  if (hold) {
    // Live hold: A→D→S, no release; source plays full sample
    gainParam.setValueAtTime(0, startTime)
    const actualAttack = Math.min(attack, playbackDurationSec)
    if (actualAttack > 0) {
      gainParam.linearRampToValueAtTime(baseGain, startTime + actualAttack)
    } else {
      gainParam.linearRampToValueAtTime(baseGain, startTime + 0.0015)
    }
    const actualDecay = Math.min(decay, playbackDurationSec - actualAttack)
    if (actualDecay > 0) {
      gainParam.linearRampToValueAtTime(sustainGain, startTime + actualAttack + actualDecay)
    }
    return { noteDurationSec: playbackDurationSec, sourceStopSec: playbackDurationSec }
  }

  // Self-terminating ADSR
  const adsrDuration = Math.max(0.05, attack + decay + release)
  const noteDurationSec = Math.min(playbackDurationSec, adsrDuration)
  const sourceStopSec = noteDurationSec

  gainParam.setValueAtTime(0, startTime)
  const actualAttack = Math.min(attack, noteDurationSec)
  if (actualAttack > 0) {
    gainParam.linearRampToValueAtTime(baseGain, startTime + actualAttack)
  } else {
    gainParam.linearRampToValueAtTime(baseGain, startTime + 0.0015)
  }
  const remainAfterAttack = noteDurationSec - actualAttack
  const actualDecay = Math.min(decay, remainAfterAttack)
  if (actualDecay > 0) {
    gainParam.linearRampToValueAtTime(sustainGain, startTime + actualAttack + actualDecay)
  }
  const remainAfterDecay = remainAfterAttack - actualDecay
  const actualRelease = Math.min(release, remainAfterDecay)
  if (actualRelease > 0) {
    gainParam.setValueAtTime(sustainGain, startTime + actualAttack + actualDecay)
    gainParam.linearRampToValueAtTime(0, startTime + actualAttack + actualDecay + actualRelease)
  }

  return { noteDurationSec, sourceStopSec }
}

/** Create a StereoPannerNode for a pad */
export function createPanNode(ctx: BaseAudioContext, settings: PadSettings): StereoPannerNode {
  const panNode = ctx.createStereoPanner()
  const panValue = settings.pan ?? 0
  panNode.pan.value = settings.randomPan ? (Math.random() * 2 - 1) * panValue : panValue
  return panNode
}


