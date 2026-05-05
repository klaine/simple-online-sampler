import type { BusId, EffectSlot, FilterType, Pad, PadSettings, Project, SampleAsset, SampleLayer, SequenceEvent, SequencePattern } from '../types'
import { BUS_IDS } from '../types'
import { buildEffectChain, getSCWorkletUrl } from './audioEngine'
import { createSynthVoice } from './synthEngine'
import { encodeWav } from './wavEncode'
import type { WavLoopPoints } from './wavEncode'

type ExportMode = 'pattern' | 'song'

interface ScheduledEvent {
  pad: Pad
  event: SequenceEvent
  atSec: number
  stepDurationSec: number
}

interface RenderOptions {
  mode: ExportMode
  activeSequenceId: string
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

const DEFAULT_SAMPLE_RATE = 44_100
const MIN_FORCE_DURATION_SEC = 0.04
const EXPORT_TAIL_SEC = 1.5

// Round-robin counters for export (reset per render call)
const exportRrCounters = new Map<string, number>()

/** Merge a layer's non-null overrides onto pad settings */
function mergeLayerSettings(settings: PadSettings, layer: SampleLayer | null): PadSettings {
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

const resolveExportLayer = (pad: Pad, velocity127: number): { sampleId: string; layer: SampleLayer | null } | null => {
  const { layers, multiMode, sampleId } = pad.settings
  if (!layers || layers.length === 0 || multiMode === 'single') {
    return sampleId ? { sampleId, layer: null } : null
  }
  switch (multiMode) {
    case 'round-robin': {
      const idx = exportRrCounters.get(pad.id) ?? 0
      exportRrCounters.set(pad.id, (idx + 1) % layers.length)
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

const collectAllSampleIds = (pad: Pad): string[] => {
  const ids: string[] = []
  if (pad.settings.sampleId) ids.push(pad.settings.sampleId)
  for (const layer of pad.settings.layers ?? []) {
    if (layer.sampleId) ids.push(layer.sampleId)
  }
  return ids
}

const stepDurationSec = (bpm: number, resolution: 16 | 32): number => {
  return resolution === 16 ? 60 / bpm / 4 : 60 / bpm / 8
}

const scheduleSequenceEvents = (
  sequence: SequencePattern,
  padsById: Map<string, Pad>,
  atSec: number,
  bpm: number,
  swing: number,
): ScheduledEvent[] => {
  const noteStepDurationSec = stepDurationSec(bpm, sequence.resolution)
  const swingOffsetSec = (swing / 100) * 0.5 * noteStepDurationSec
  const scheduled: ScheduledEvent[] = []

  sequence.events.forEach((event) => {
    const pad = padsById.get(event.padId)
    if (!pad || (!pad.settings.sampleId && pad.settings.source !== 'synth')) {
      return
    }

    const offset = event.step % 2 === 1 ? swingOffsetSec : 0
    scheduled.push({
      pad,
      event,
      atSec: atSec + event.step * noteStepDurationSec + offset,
      stepDurationSec: noteStepDurationSec,
    })
  })

  return scheduled
}

const buildScheduledEvents = (project: Project, options: RenderOptions): ScheduledEvent[] => {
  const padsById = new Map(project.pads.map((pad) => [pad.id, pad]))
  const sequencesById = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))

  if (options.mode === 'pattern') {
    const sequence = sequencesById.get(options.activeSequenceId)
    if (!sequence) {
      return []
    }
    const swing = project.swing ?? 0
    const cycleDurationSec = sequence.lengthSteps * stepDurationSec(project.bpm, sequence.resolution)
    return [
      ...scheduleSequenceEvents(sequence, padsById, 0, project.bpm, swing),
      ...scheduleSequenceEvents(sequence, padsById, cycleDurationSec, project.bpm, swing),
    ]
  }

  let cursorSec = 0
  const scheduled: ScheduledEvent[] = []
  const swing = project.swing ?? 0
  project.songChain.forEach((entry) => {
    const sequence = sequencesById.get(entry.patternId)
    if (!sequence) {
      return
    }

    const patternDurationSec = sequence.lengthSteps * stepDurationSec(project.bpm, sequence.resolution)
    const repeats = Math.max(1, entry.repeats)
    for (let index = 0; index < repeats; index += 1) {
      scheduled.push(...scheduleSequenceEvents(sequence, padsById, cursorSec, project.bpm, swing))
      cursorSec += patternDurationSec
    }
  })

  return scheduled
}

export const renderProjectAudioWav = async (
  project: Project,
  samplesById: Map<string, SampleAsset>,
  options: RenderOptions,
): Promise<Blob> => {
  const sequencesById = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))
  const scheduled = buildScheduledEvents(project, options)
  if (scheduled.length === 0) {
    throw new Error('No notes to export in the selected scope.')
  }

  const sampleIds = Array.from(
    new Set(scheduled.flatMap((entry) => collectAllSampleIds(entry.pad))),
  )

  const decodeContext = new AudioContext()
  const decodedBySampleId = new Map<string, AudioBuffer>()
  try {
    for (const sampleId of sampleIds) {
      const sample = samplesById.get(sampleId)
      if (!sample) {
        continue
      }

      const audioBuffer = await decodeContext.decodeAudioData(await sample.blob.arrayBuffer())
      decodedBySampleId.set(sampleId, audioBuffer)
    }
  } finally {
    await decodeContext.close()
  }

  exportRrCounters.clear()

  let maxNoteEndSec = 0

  // Helper to build a note render entry from resolved settings + buffer
  const buildNoteEntry = (
    entry: ScheduledEvent & { atSec: number; stepDurationSec: number },
    ms: PadSettings,
    sourceBuffer: AudioBuffer,
    atSecOverride?: number,
  ) => {
    const atSec = atSecOverride ?? entry.atSec
    const trimStartSec = Math.max(0, Math.min(sourceBuffer.duration, ms.trim.start * sourceBuffer.duration))
    const trimEndSec = Math.max(trimStartSec, Math.min(sourceBuffer.duration, ms.trim.end * sourceBuffer.duration))
    const playbackDurationSec = Math.max(0.01, trimEndSec - trimStartSec)
    const gate = Math.max(1, entry.event.gate)
    const forceDurationSec = Math.max(MIN_FORCE_DURATION_SEC, gate * entry.stepDurationSec)
    const releaseSec = Math.max(0, ms.envelope.release)

    let noteDurationSec: number
    let sourceStopSec: number

    if (ms.mode === 'adsr') {
      // ADSR uses step gate duration, clamped by playback duration
      noteDurationSec = Math.min(playbackDurationSec, forceDurationSec)
      sourceStopSec = Math.min(playbackDurationSec, noteDurationSec + releaseSec)
    } else if (ms.mode === 'ahr') {
      // AHR: self-terminating (attack + hold + release), ignores gate
      const holdSec = ms.envelope.hold ?? 0
      const ahrDuration = ms.envelope.attack + holdSec + releaseSec
      noteDurationSec = Math.min(playbackDurationSec, ahrDuration)
      sourceStopSec = noteDurationSec
    } else {
      // one-shot: play full sample
      noteDurationSec = playbackDurationSec
      sourceStopSec = playbackDurationSec
    }

    const noteEndSec = atSec + sourceStopSec
    maxNoteEndSec = Math.max(maxNoteEndSec, noteEndSec)

    return {
      entry: { ...entry, atSec },
      ms,
      sourceBuffer,
      trimStartSec,
      playbackDurationSec,
      noteDurationSec,
      sourceStopSec,
      busId: (ms.bus ?? 'A') as BusId,
      chokeGroup: entry.pad.settings.chokeGroup ?? 0,
    }
  }

  // Separate synth events from sample events
  const synthEvents = scheduled.filter((e) => e.pad.settings.source === 'synth' && e.pad.settings.synthParams)
  const sampleScheduled = scheduled.filter((e) => e.pad.settings.source !== 'synth')

  const notes = sampleScheduled
    .flatMap((entry) => {
      // --- Stacked mode: expand into one note per layer ---
      if (entry.pad.settings.multiMode === 'stacked' && entry.pad.settings.layers && entry.pad.settings.layers.length > 0) {
        const results: NonNullable<ReturnType<typeof buildNoteEntry>>[] = []
        for (const layer of entry.pad.settings.layers) {
          const sourceBuffer = decodedBySampleId.get(layer.sampleId)
          if (!sourceBuffer) continue
          const ms = mergeLayerSettings(entry.pad.settings, layer)
          const offsetSec = (layer.stackOffsetMs ?? 0) / 1000
          results.push(buildNoteEntry(entry, ms, sourceBuffer, entry.atSec + offsetSec))
        }
        return results
      }

      // --- Single-layer modes ---
      const resolved = resolveExportLayer(entry.pad, entry.event.velocity)
      if (!resolved) return []
      const sourceBuffer = decodedBySampleId.get(resolved.sampleId)
      if (!sourceBuffer) return []
      const ms = mergeLayerSettings(entry.pad.settings, resolved.layer)
      return [buildNoteEntry(entry, ms, sourceBuffer)]
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))

  if (notes.length === 0 && synthEvents.length === 0) {
    throw new Error('No assigned samples or synths found for notes in the selected scope.')
  }

  // Account for synth event durations
  for (const entry of synthEvents) {
    const s = entry.pad.settings
    const release = s.envelope.release
    const gate = Math.max(1, entry.event.gate)
    const forceDurationSec = s.mode === 'one-shot'
      ? s.envelope.attack + s.envelope.decay
      : Math.max(0.04, gate * entry.stepDurationSec)
    const endSec = entry.atSec + forceDurationSec + release
    maxNoteEndSec = Math.max(maxNoteEndSec, endSec)
  }

  const totalDurationSec = Math.max(1, maxNoteEndSec + EXPORT_TAIL_SEC)
  const offline = new OfflineAudioContext(2, Math.ceil(totalDurationSec * DEFAULT_SAMPLE_RATE), DEFAULT_SAMPLE_RATE)

  // Register sidechain compressor worklet if any bus uses it
  const allEffectSlots = [
    ...(project.mixBuses?.flatMap((b) => b.effects) ?? []),
    ...(project.masterBus?.effects ?? []),
  ]
  const needsSCWorklet = allEffectSlots.some((s) => s.type === 'sidechain-compressor' && s.enabled)
  if (needsSCWorklet && 'audioWorklet' in offline) {
    try {
      await offline.audioWorklet.addModule(getSCWorkletUrl())
    } catch {
      console.warn('[audioExport] Failed to register sidechain worklet on OfflineAudioContext — falling back to regular compressor')
    }
  }

  // --- Build bus routing in offline context ---
  const masterGain = offline.createGain()
  masterGain.gain.value = (project.masterBus?.gain ?? 1) * 0.9

  // Master effect chain
  const masterEffects = buildEffectChain(offline, project.masterBus?.effects ?? [])
  masterGain.connect(masterEffects.input)
  masterEffects.output.connect(offline.destination)

  // Build bus nodes
  const anySoloed = project.mixBuses?.some((b) => b.solo) ?? false
  const busGainNodes = new Map<BusId, GainNode>()

  // First pass: create gain + pan nodes for all buses (needed for sidechain references)
  const busPanNodes = new Map<BusId, StereoPannerNode>()
  for (const busId of BUS_IDS) {
    const bus = project.mixBuses?.find((b) => b.id === busId)
    const gainNode = offline.createGain()
    const effectiveGain = bus
      ? (bus.mute ? 0 : (anySoloed && !bus.solo ? 0 : bus.gain))
      : 1
    gainNode.gain.value = effectiveGain

    const panNode = offline.createStereoPanner()
    panNode.pan.value = bus?.pan ?? 0

    busGainNodes.set(busId, gainNode)
    busPanNodes.set(busId, panNode)

    gainNode.connect(panNode)
  }

  // Second pass: build effect chains with sidechain source resolution, then connect
  for (const busId of BUS_IDS) {
    const bus = project.mixBuses?.find((b) => b.id === busId)
    const panNode = busPanNodes.get(busId)!

    const getSidechainSource = (slot: EffectSlot): AudioNode | null => {
      if (slot.type !== 'sidechain-compressor' || !slot.sidechainSource) return null
      if (slot.sidechainSource === busId) return null
      return busGainNodes.get(slot.sidechainSource) ?? null
    }

    // Sidechain compressor worklet is registered on the OfflineAudioContext above;
    // if registration failed, buildEffectNode falls back to regular DynamicsCompressor
    const busEffects = buildEffectChain(offline, bus?.effects ?? [], getSidechainSource)

    panNode.connect(busEffects.input)
    busEffects.output.connect(masterGain)
  }

  // Sort notes by start time for choke group processing
  notes.sort((a, b) => a.entry.atSec - b.entry.atSec)

  // Track active choke group voices for cut-off
  const chokeActiveGains = new Map<number, { gainNode: GainNode; endSec: number }[]>()

  notes.forEach(({ entry, ms, sourceBuffer, trimStartSec, playbackDurationSec, noteDurationSec, sourceStopSec, busId, chokeGroup }) => {
    const source = offline.createBufferSource()
    source.buffer = sourceBuffer

    const semitoneShift = (ms.semitones ?? 0) + (entry.event.semitones ?? 0)
    const fineShift = (ms.fineCents ?? 0) / 100
    source.playbackRate.value = Math.pow(2, (semitoneShift + fineShift) / 12)

    const gainNode = offline.createGain()
    const baseGain = Math.max(0.001, ms.gain * Math.min(1, entry.event.velocity / 127))
    const attackSec = Math.max(0, ms.envelope.attack)
    const sustainLevel = ms.envelope.sustain ?? 0
    const releaseSec = Math.max(0, ms.envelope.release)
    const noteStart = entry.atSec

    if (ms.mode === 'adsr') {
      // ADSR envelope: attack→peak, decay→sustain, hold, release→zero
      const sustainGain = baseGain * sustainLevel
      const actualAttack = Math.min(attackSec, noteDurationSec)
      gainNode.gain.setValueAtTime(0, noteStart)
      if (actualAttack > 0) {
        gainNode.gain.linearRampToValueAtTime(baseGain, noteStart + actualAttack)
      } else {
        gainNode.gain.linearRampToValueAtTime(baseGain, noteStart + 0.0015)
      }
      const remainAfterAttack = noteDurationSec - actualAttack
      const decaySec = Math.max(0, ms.envelope.decay)
      const actualDecay = Math.min(decaySec, remainAfterAttack)
      if (actualDecay > 0) {
        gainNode.gain.linearRampToValueAtTime(sustainGain, noteStart + actualAttack + actualDecay)
      }
      // Hold at sustain until note-off, then release
      if (releaseSec > 0 && sourceStopSec > noteDurationSec) {
        gainNode.gain.setValueAtTime(sustainGain, noteStart + noteDurationSec)
        gainNode.gain.linearRampToValueAtTime(0, noteStart + sourceStopSec)
      }
    } else if (ms.mode === 'ahr') {
      // AHR envelope: attack→peak, hold at peak, release→zero
      const holdSec = ms.envelope.hold ?? 0
      const actualAttack = Math.min(attackSec, noteDurationSec)
      gainNode.gain.setValueAtTime(0, noteStart)
      if (actualAttack > 0) {
        gainNode.gain.linearRampToValueAtTime(baseGain, noteStart + actualAttack)
      } else {
        gainNode.gain.linearRampToValueAtTime(baseGain, noteStart + 0.0015)
      }
      const holdEnd = noteStart + actualAttack + holdSec
      if (holdSec > 0) {
        gainNode.gain.setValueAtTime(baseGain, holdEnd)
      }
      const actualRelease = Math.min(releaseSec, noteDurationSec - actualAttack - holdSec)
      if (actualRelease > 0) {
        gainNode.gain.linearRampToValueAtTime(0, holdEnd + actualRelease)
      }
    } else {
      // One-shot: attack ramp, hold at peak for full sample
      gainNode.gain.setValueAtTime(0, noteStart)
      gainNode.gain.linearRampToValueAtTime(baseGain, noteStart + Math.max(attackSec > 0 ? Math.min(attackSec, noteDurationSec) : 0.0015, 0.0015))
    }

    source.connect(gainNode)

    // Per-pad pan
    const busDestination = busGainNodes.get(busId) ?? busGainNodes.get('A')!
    const padPanNode = offline.createStereoPanner()
    const padPanVal = ms.pan ?? 0
    padPanNode.pan.value = ms.randomPan ? (Math.random() * 2 - 1) * padPanVal : padPanVal
    padPanNode.connect(busDestination)

    // Per-pad filter (with layer overrides)
    const resolvedFt = resolveFilterType(ms.filterType)
    if (ms.filterType === 'lphp') {
      const hp = offline.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = ms.filterFreq ?? 20
      hp.Q.value = ms.filterQ ?? 0.7
      const lp = offline.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = ms.filterFreq2 ?? 20000
      lp.Q.value = ms.filterQ ?? 0.7
      gainNode.connect(hp)
      hp.connect(lp)
      lp.connect(padPanNode)
    } else if (resolvedFt) {
      const filterChain: BiquadFilterNode[] = []
      const f1 = offline.createBiquadFilter()
      f1.type = resolvedFt.biquadType
      f1.frequency.value = ms.filterFreq ?? 1000
      f1.Q.value = ms.filterQ ?? 1
      filterChain.push(f1)
      if (resolvedFt.twoStage) {
        const f2 = offline.createBiquadFilter()
        f2.type = resolvedFt.biquadType
        f2.frequency.value = ms.filterFreq ?? 1000
        f2.Q.value = ms.filterQ ?? 1
        filterChain.push(f2)
      }
      gainNode.connect(filterChain[0])
      for (let i = 1; i < filterChain.length; i++) filterChain[i - 1].connect(filterChain[i])
      filterChain[filterChain.length - 1].connect(padPanNode)

      // --- Sample pad filter envelope ---
      const fEnv = ms.filterEnvelope
      if (fEnv && fEnv.depth > 0) {
        const baseFreqHz = ms.filterFreq ?? 1000
        const peakFreqHz = Math.min(20000, baseFreqHz * Math.pow(2, fEnv.depth / 12))
        const sustainFreqHz = baseFreqHz + (peakFreqHz - baseFreqHz) * fEnv.sustain
        for (const f of filterChain) {
          f.frequency.setValueAtTime(baseFreqHz, noteStart)
          f.frequency.linearRampToValueAtTime(peakFreqHz, noteStart + fEnv.attack)
          f.frequency.linearRampToValueAtTime(sustainFreqHz, noteStart + fEnv.attack + fEnv.decay)
        }
        // Release: schedule based on mode
        if (ms.mode === 'adsr') {
          const noteEnd = noteStart + noteDurationSec
          for (const f of filterChain) {
            f.frequency.setValueAtTime(sustainFreqHz, noteEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, noteEnd + fEnv.release)
          }
        } else if (ms.mode === 'ahr') {
          // AHR: release at end of hold phase
          const holdSec = ms.envelope.hold ?? 0
          const fEnd = noteStart + attackSec + holdSec
          for (const f of filterChain) {
            f.frequency.setValueAtTime(sustainFreqHz, fEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, fEnd + fEnv.release)
          }
        } else {
          // One-shot: release at end of filter attack+decay
          const fEnd = noteStart + fEnv.attack + fEnv.decay
          for (const f of filterChain) {
            f.frequency.setValueAtTime(sustainFreqHz, fEnd)
            f.frequency.linearRampToValueAtTime(baseFreqHz, fEnd + fEnv.release)
          }
        }
      }
    } else {
      gainNode.connect(padPanNode)
    }
    source.start(noteStart, trimStartSec, playbackDurationSec)
    source.stop(noteStart + sourceStopSec)

    // Choke group: cut earlier voices in the same group
    if (chokeGroup > 0) {
      const activeInGroup = chokeActiveGains.get(chokeGroup) ?? []
      for (const prev of activeInGroup) {
        if (prev.endSec > noteStart) {
          // Rapid fade-out at the start of this note
          prev.gainNode.gain.setValueAtTime(prev.gainNode.gain.value, noteStart)
          prev.gainNode.gain.linearRampToValueAtTime(0, noteStart + 0.005)
        }
      }
      // Register this voice
      const voiceEnd = noteStart + sourceStopSec
      activeInGroup.push({ gainNode, endSec: voiceEnd })
      chokeActiveGains.set(chokeGroup, activeInGroup)
    }
  })

  // --- Build per-pad effect chains for synth pads ---
  const padEffectInputs = new Map<string, AudioNode>()
  synthEvents.forEach((entry) => {
    const padId = entry.pad.id
    if (padEffectInputs.has(padId)) return
    const settings = entry.pad.settings
    const padEffects = settings.padEffects
    if (padEffects && padEffects.some((s) => s.type !== 'off' && s.enabled)) {
      const busDestination = busGainNodes.get((settings.bus ?? 'A') as BusId) ?? busGainNodes.get('A')!
      const chain = buildEffectChain(offline, padEffects)
      chain.output.connect(busDestination)
      padEffectInputs.set(padId, chain.input)
    }
  })

  // --- Schedule synth voices ---
  synthEvents.forEach((entry) => {
    const pad = entry.pad
    const settings = pad.settings
    const synthParams = settings.synthParams!
    const busId = (settings.bus ?? 'A') as BusId
    const busDestination = busGainNodes.get(busId) ?? busGainNodes.get('A')!
    const noteStart = entry.atSec
    const chokeGroup = settings.chokeGroup ?? 0

    const noteDurationSec = settings.mode === 'one-shot'
      ? undefined
      : settings.mode === 'ahr'
        ? (settings.envelope.attack + (settings.envelope.hold ?? 0) + settings.envelope.release)
        : Math.max(0.04, entry.event.gate * entry.stepDurationSec)

    // For piano roll events with absolute note, compute semitone offset from synth base
    let semitoneOffset = entry.event.semitones
    if (entry.event.note != null) {
      semitoneOffset = entry.event.note - (synthParams.baseNote + (settings.semitones ?? 0))
    }

    const synthVoice = createSynthVoice(
      offline, synthParams, settings,
      entry.event.velocity / 127,
      noteStart, project.bpm,
      noteDurationSec, semitoneOffset,
    )

    // Connect to bus (via pan → pad effects if active)
    const output = synthVoice.filters.length > 0 ? synthVoice.filters[synthVoice.filters.length - 1] : synthVoice.voiceGain
    const synthExpPan = offline.createStereoPanner()
    const synthExpPanVal = settings.pan ?? 0
    synthExpPan.pan.value = settings.randomPan ? (Math.random() * 2 - 1) * synthExpPanVal : synthExpPanVal
    output.connect(synthExpPan)
    const padFxInput = padEffectInputs.get(pad.id)
    synthExpPan.connect(padFxInput ?? busDestination)

    // Choke group
    if (chokeGroup > 0) {
      const activeInGroup = chokeActiveGains.get(chokeGroup) ?? []
      for (const prev of activeInGroup) {
        if (prev.endSec > noteStart) {
          prev.gainNode.gain.setValueAtTime(prev.gainNode.gain.value, noteStart)
          prev.gainNode.gain.linearRampToValueAtTime(0, noteStart + 0.005)
        }
      }
      const attack = settings.envelope.attack
      const decay = settings.envelope.decay
      const release = settings.envelope.release
      const voiceEnd = noteDurationSec != null
        ? noteStart + noteDurationSec + release
        : noteStart + attack + decay
      activeInGroup.push({ gainNode: synthVoice.voiceGain, endSec: voiceEnd })
      chokeActiveGains.set(chokeGroup, activeInGroup)
    }
  })

  const rendered = await offline.startRendering()

  let loopPoints: WavLoopPoints | undefined
  let finalBuffer = rendered
  if (options.mode === 'pattern') {
    const sequence = sequencesById.get(options.activeSequenceId)
    if (sequence) {
      const cycleDurationSec = sequence.lengthSteps * stepDurationSec(project.bpm, sequence.resolution)
      const loopStartFrame = Math.floor(cycleDurationSec * rendered.sampleRate)
      const loopEndFrame = Math.floor(cycleDurationSec * rendered.sampleRate * 2)
      loopPoints = { startFrame: loopStartFrame, endFrame: loopEndFrame }

      // Trim rendered buffer to exactly 2 cycles so the last note's release tail
      // doesn't ring out past the loop end (matches live looped playback behavior)
      if (loopEndFrame < rendered.length) {
        const trimmed = new OfflineAudioContext(rendered.numberOfChannels, loopEndFrame, rendered.sampleRate)
        // We just need to copy the channel data, not re-render
        const trimmedBuf = trimmed.createBuffer(rendered.numberOfChannels, loopEndFrame, rendered.sampleRate)
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
          trimmedBuf.copyToChannel(rendered.getChannelData(ch).subarray(0, loopEndFrame), ch)
        }
        finalBuffer = trimmedBuf
      }
    }
  }

  return encodeWav(finalBuffer, loopPoints)
}
