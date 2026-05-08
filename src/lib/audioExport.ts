import type { BusId, EffectSlot, Pad, PadSettings, Project, SampleAsset, SequenceEvent, SequencePattern } from '../types'
import { BUS_IDS } from '../types'
import { db } from './db'
import { buildEffectChain, getSCWorkletUrl } from './audioEngine'
import { encodeWav } from './wavEncode'
import type { WavLoopPoints } from './wavEncode'
import { audioBufferToChannels, encodeMp3 } from './mp3Encode'
import {
  mergeLayerSettings,
  resolveLayer,
  createFilterChain,
  scheduleAmplitudeEnvelope,
  createPanNode,
} from './voiceUtils'

export type ExportMode = 'pattern' | 'song'
export type ExportFormat = 'wav' | 'mp3'

interface ScheduledEvent {
  pad: Pad
  event: SequenceEvent
  atSec: number
  stepDurationSec: number
}

export interface RenderOptions {
  mode: ExportMode
  activeSequenceId: string
  format?: ExportFormat
}

const DEFAULT_SAMPLE_RATE = 44_100
const MIN_FORCE_DURATION_SEC = 0.04
const EXPORT_TAIL_SEC = 1.5

// Round-robin counters for export (reset per render call)
const exportRrCounters = new Map<string, number>()
const exportRrCounter = {
  get: (padId: string) => exportRrCounters.get(padId) ?? 0,
  set: (padId: string, val: number) => exportRrCounters.set(padId, val),
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
      if (!pad || !pad.settings.sampleId) {
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

export const renderPadAudio = async (
  project: Project,
  pad: Pad,
  decodedBuffers?: Map<string, AudioBuffer>,
): Promise<Blob> => {
  // Build a synthetic single-note event
  const syntheticEvent: SequenceEvent = {
    id: 'synthetic-pad-export',
    padId: pad.id,
    step: 0,
    velocity: 127,
    gate: 64,
  }

  const scheduled: ScheduledEvent[] = [{
    pad,
    event: syntheticEvent,
    atSec: 0,
    stepDurationSec: stepDurationSec(project.bpm, 16),
  }]

  const sampleIds = collectAllSampleIds(pad)
  const decodeContext = new AudioContext()
  const decodedBySampleId = new Map<string, AudioBuffer>()
  
  try {
    for (const sampleId of sampleIds) {
      const cached = decodedBuffers?.get(sampleId)
      if (cached) {
        decodedBySampleId.set(sampleId, cached)
        continue
      }
      const sample = await db.getSample(sampleId)
      if (!sample) continue
      const audioBuffer = await decodeContext.decodeAudioData(await sample.blob.arrayBuffer())
      decodedBySampleId.set(sampleId, audioBuffer)
    }
  } finally {
    await decodeContext.close()
  }

  exportRrCounters.clear()
  let maxNoteEndSec = 0

  const buildNoteEntry = (
    entry: ScheduledEvent,
    ms: PadSettings,
    sourceBuffer: AudioBuffer,
    atSecOverride?: number,
  ) => {
    const atSec = atSecOverride ?? entry.atSec
    const trimStartSec = Math.max(0, Math.min(sourceBuffer.duration, ms.trim.start * sourceBuffer.duration))
    const trimEndSec = Math.max(trimStartSec, Math.min(sourceBuffer.duration, ms.trim.end * sourceBuffer.duration))
    
    // Account for pitch shifting in duration calculation
    const pitchRatio = Math.pow(2, ((ms.semitones ?? 0) + (ms.fineCents ?? 0) / 100) / 12)
    const playbackDurationSec = Math.max(0.01, (trimEndSec - trimStartSec) / pitchRatio)
    
    const gate = Math.max(1, entry.event.gate)
    const forceDurationSec = Math.max(MIN_FORCE_DURATION_SEC, gate * entry.stepDurationSec)
    const releaseSec = Math.max(0, ms.envelope.release)

    let noteDurationSec: number
    let sourceStopSec: number

    if (ms.mode === 'adsr') {
      noteDurationSec = Math.min(playbackDurationSec, forceDurationSec)
      sourceStopSec = Math.min(playbackDurationSec, noteDurationSec + releaseSec)
    } else if (ms.mode === 'ahr') {
      const holdSec = ms.envelope.hold ?? 0
      const ahrDuration = ms.envelope.attack + holdSec + releaseSec
      noteDurationSec = Math.min(playbackDurationSec, ahrDuration)
      sourceStopSec = noteDurationSec
    } else {
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
      chokeGroup: 0,
    }
  }

  const notes = [{ pad, sampleId: pad.settings.sampleId! }].flatMap(() => {
    if (pad.settings.multiMode === 'stacked' && pad.settings.layers?.length > 0) {
      return pad.settings.layers.map(layer => {
        const sourceBuffer = decodedBySampleId.get(layer.sampleId)
        if (!sourceBuffer) return null
        const ms = mergeLayerSettings(pad.settings, layer)
        const offsetSec = (layer.stackOffsetMs ?? 0) / 1000
        return buildNoteEntry(scheduled[0], ms, sourceBuffer, offsetSec)
      }).filter(Boolean) as any[]
    }
    const resolved = resolveLayer(pad, 127, exportRrCounter)
    if (!resolved) return []
    const sourceBuffer = decodedBySampleId.get(resolved.sampleId)
    if (!sourceBuffer) return []
    const ms = mergeLayerSettings(pad.settings, resolved.layer)
    return [buildNoteEntry(scheduled[0], ms, sourceBuffer)]
  })

  if (notes.length === 0) throw new Error('No audio to render')

  const totalDurationSec = Math.max(0.1, maxNoteEndSec + 0.1)
  const offline = new OfflineAudioContext(2, Math.ceil(totalDurationSec * DEFAULT_SAMPLE_RATE), DEFAULT_SAMPLE_RATE)

  // Sidechain worklet (if needed by master)
  const masterNeedsSC = project.masterBus?.effects.some(s => s.type === 'sidechain-compressor' && s.enabled)
  if (masterNeedsSC && 'audioWorklet' in offline) {
    try { await offline.audioWorklet.addModule(getSCWorkletUrl()) } catch {}
  }

  const masterGain = offline.createGain()
  masterGain.gain.value = (project.masterBus?.gain ?? 1) * 0.9
  const masterEffects = buildEffectChain(offline, project.masterBus?.effects ?? [])
  masterGain.connect(masterEffects.input)
  masterEffects.output.connect(offline.destination)

  const busGainNodes = new Map<BusId, GainNode>()
  for (const busId of BUS_IDS) {
    const bus = project.mixBuses?.find((b) => b.id === busId)
    const gainNode = offline.createGain()
    gainNode.gain.value = bus?.gain ?? 1
    const panNode = offline.createStereoPanner()
    panNode.pan.value = bus?.pan ?? 0
    gainNode.connect(panNode)
    const busEffects = buildEffectChain(offline, bus?.effects ?? [])
    panNode.connect(busEffects.input)
    busEffects.output.connect(masterGain)
    busGainNodes.set(busId, gainNode)
  }

  notes.forEach(({ entry, ms, sourceBuffer, trimStartSec, playbackDurationSec, noteDurationSec, busId }) => {
    const source = offline.createBufferSource()
    source.buffer = sourceBuffer
    const semitoneShift = (ms.semitones ?? 0) + (entry.event.semitones ?? 0)
    const fineShift = (ms.fineCents ?? 0) / 100
    source.playbackRate.value = Math.pow(2, (semitoneShift + fineShift) / 12)
    const gainNode = offline.createGain()
    const baseGain = ms.gain * (entry.event.velocity / 127)
    const noteStart = entry.atSec

    scheduleAmplitudeEnvelope(gainNode.gain, noteStart, baseGain, ms, playbackDurationSec, noteDurationSec, false)
    source.connect(gainNode)
    const padPanNode = createPanNode(offline, ms)
    const filterChain = createFilterChain(offline, ms)
    if (filterChain) {
      gainNode.connect(filterChain.input)
      filterChain.output.connect(padPanNode)
    } else {
      gainNode.connect(padPanNode)
    }
    padPanNode.connect(busGainNodes.get(busId)!)
    source.start(noteStart, trimStartSec, sourceBuffer.duration - trimStartSec)
  })

  const rendered = await offline.startRendering()
  return encodeWav(rendered)
}

export const renderProjectAudio = async (
  project: Project,
  samplesById: Map<string, SampleAsset>,
  options: RenderOptions,
): Promise<Blob> => {
  const sequencesById = new Map(project.sequences.map((sequence) => [sequence.id, sequence]))
  const scheduled = buildScheduledEvents(project, options).filter((e) => !e.pad.settings.mute)
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

  const notes = scheduled
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
      const resolved = resolveLayer(entry.pad, entry.event.velocity, exportRrCounter)
      if (!resolved) return []
      const sourceBuffer = decodedBySampleId.get(resolved.sampleId)
      if (!sourceBuffer) return []
      const ms = mergeLayerSettings(entry.pad.settings, resolved.layer)
      return [buildNoteEntry(entry, ms, sourceBuffer)]
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))

  if (notes.length === 0) {
    throw new Error('No assigned samples found for notes in the selected scope.')
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

  notes.forEach(({ entry, ms, sourceBuffer, trimStartSec, playbackDurationSec, noteDurationSec, busId, chokeGroup }) => {
    const source = offline.createBufferSource()
    source.buffer = sourceBuffer

    let eventSemitones = entry.event.semitones ?? 0
    if (entry.event.note != null) {
      eventSemitones = entry.event.note - ((ms.baseNote ?? 60) + (ms.semitones ?? 0))
    }
    const semitoneShift = (ms.semitones ?? 0) + eventSemitones
    const fineShift = (ms.fineCents ?? 0) / 100
    source.playbackRate.value = Math.pow(2, (semitoneShift + fineShift) / 12)

    const gainNode = offline.createGain()
    const baseGain = Math.max(0.001, ms.gain * Math.min(1, entry.event.velocity / 127))
    const noteStart = entry.atSec

    // --- Amplitude envelope ---
    const envResult = scheduleAmplitudeEnvelope(
      gainNode.gain,
      noteStart,
      baseGain,
      ms,
      playbackDurationSec,
      noteDurationSec,
      false,
    )

    source.connect(gainNode)

    // Per-pad pan
    const busDestination = busGainNodes.get(busId) ?? busGainNodes.get('A')!
    const padPanNode = createPanNode(offline, ms)
    padPanNode.connect(busDestination)

    // Per-pad filter
    const filterChain = createFilterChain(offline, ms)
    if (filterChain) {
      gainNode.connect(filterChain.input)
      filterChain.output.connect(padPanNode)
    } else {
      gainNode.connect(padPanNode)
    }

    source.start(noteStart, trimStartSec, playbackDurationSec)
    source.stop(noteStart + envResult.sourceStopSec)

    // Choke group: cut earlier voices in the same group
    if (chokeGroup > 0) {
      const activeInGroup = chokeActiveGains.get(chokeGroup) ?? []
      for (const prev of activeInGroup) {
        if (prev.endSec > noteStart) {
          prev.gainNode.gain.setValueAtTime(prev.gainNode.gain.value, noteStart)
          prev.gainNode.gain.linearRampToValueAtTime(0, noteStart + 0.005)
        }
      }
      // Register this voice
      const voiceEnd = noteStart + envResult.sourceStopSec
      activeInGroup.push({ gainNode, endSec: voiceEnd })
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
        const trimmedBuf = new AudioBuffer({
          numberOfChannels: rendered.numberOfChannels,
          length: loopEndFrame,
          sampleRate: rendered.sampleRate,
        })
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
          trimmedBuf.copyToChannel(rendered.getChannelData(ch).subarray(0, loopEndFrame), ch)
        }
        finalBuffer = trimmedBuf
      }
    }
  }

  const format = options.format ?? 'wav'

  if (format === 'mp3') {
    return await encodeMp3(audioBufferToChannels(finalBuffer), finalBuffer.sampleRate)
  }

  return encodeWav(finalBuffer, loopPoints)
}
