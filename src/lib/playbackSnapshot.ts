import type { Pad, Project, SequenceResolution } from '../types'

export interface PlaybackEvent {
  padId: string
  velocity: number
  gate: number
  semitoneOffset: number
  /** Absolute MIDI note for piano roll events — overrides semitoneOffset at playback time */
  note?: number
}

export interface PlaybackPreparedSequence {
  id: string
  lengthSteps: number
  resolution: SequenceResolution
  eventsByStep: Map<number, PlaybackEvent[]>
}

export interface PlaybackSnapshot {
  version: number
  bpm: number
  swing: number
  padById: Map<string, Pad>
  sequenceById: Map<string, PlaybackPreparedSequence>
  songChain: Array<{ patternId: string; repeats: number }>
  songLoopStart: number | null
  songLoopEnd: number | null
}

export const buildPlaybackSnapshot = (project: Project, version: number): PlaybackSnapshot => {
  const padById = new Map(project.pads.map((pad) => [pad.id, pad]))
  const sequenceById = new Map<string, PlaybackPreparedSequence>()

  project.sequences.forEach((sequence) => {
    const eventsByStep = new Map<number, PlaybackEvent[]>()
    sequence.events.forEach((event) => {
      const events = eventsByStep.get(event.step) ?? []
      events.push({
        padId: event.padId,
        velocity: event.velocity,
        gate: event.gate,
        semitoneOffset: event.semitones ?? 0,
        note: event.note,
      })
      eventsByStep.set(event.step, events)
    })

    sequenceById.set(sequence.id, {
      id: sequence.id,
      lengthSteps: sequence.lengthSteps,
      resolution: sequence.resolution,
      eventsByStep,
    })
  })

  return {
    version,
    bpm: project.bpm,
    swing: project.swing ?? 0,
    padById,
    sequenceById,
    songChain: project.songChain.map((entry) => ({
      patternId: entry.patternId,
      repeats: Math.max(1, entry.repeats),
    })),
    songLoopStart: project.songLoopStart,
    songLoopEnd: project.songLoopEnd,
  }
}
