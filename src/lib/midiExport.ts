import type { Pad, SequencePattern, SongChainEntry } from '../types'

let midiModule: typeof import('@tonejs/midi') | null = null
let midiModulePromise: Promise<typeof import('@tonejs/midi')> | null = null

export function warmupMidiModule(): void {
  if (midiModule || midiModulePromise) return
  midiModulePromise = import('@tonejs/midi').then((mod) => {
    midiModule = mod
    return mod
  })
}

export async function ensureMidiModule(): Promise<typeof import('@tonejs/midi')> {
  if (midiModule) return midiModule
  if (midiModulePromise) return midiModulePromise
  midiModulePromise = import('@tonejs/midi').then((mod) => {
    midiModule = mod
    return mod
  })
  return midiModulePromise
}

function buildMidi(
  Midi: typeof import('@tonejs/midi').Midi,
  sequence: SequencePattern,
  pads: Pad[],
  bpm: number,
): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(bpm)
  midi.header.name = sequence.name

  const track = midi.addTrack()
  const stepDurationQuarter = sequence.resolution === 16 ? 0.25 : 0.125

  sequence.events.forEach((event) => {
    const pad = pads.find((item) => item.id === event.padId)
    if (!pad) return

    track.addNote({
      midi: Math.max(0, Math.min(127, pad.midiNote + (event.semitones ?? 0))),
      time: event.step * stepDurationQuarter,
      duration: Math.max(0.01, event.gate * stepDurationQuarter),
      velocity: Math.max(0.05, Math.min(1, event.velocity / 127)),
    })
  })

  return midi.toArray()
}

export const buildMidiForSequence = async (
  sequence: SequencePattern,
  pads: Pad[],
  bpm: number,
): Promise<Uint8Array> => {
  const { Midi } = await ensureMidiModule()
  return buildMidi(Midi, sequence, pads, bpm)
}

export function buildMidiForSequenceSync(
  sequence: SequencePattern,
  pads: Pad[],
  bpm: number,
): Uint8Array | null {
  if (!midiModule) return null
  return buildMidi(midiModule.Midi, sequence, pads, bpm)
}

export const buildMidiForSongChain = async (
  sequences: SequencePattern[],
  pads: Pad[],
  bpm: number,
  songChain: SongChainEntry[],
  swing: number,
): Promise<Uint8Array> => {
  const { Midi } = await ensureMidiModule()
  const midi = new Midi()
  midi.header.setTempo(bpm)
  midi.header.name = 'Song Chain'

  const track = midi.addTrack()
  const sequencesById = new Map(sequences.map((s) => [s.id, s]))

  const stepDurationQuarter16 = 0.25
  const stepDurationQuarter32 = 0.125

  for (const entry of songChain) {
    const seq = sequencesById.get(entry.patternId)
    if (!seq) continue

    const repeats = Math.max(1, entry.repeats)
    const stepDurationQuarter = seq.resolution === 16 ? stepDurationQuarter16 : stepDurationQuarter32
    const swingOffsetQuarter = (swing / 100) * 0.5 * stepDurationQuarter

    for (let rep = 0; rep < repeats; rep++) {
      seq.events.forEach((event) => {
        const pad = pads.find((item) => item.id === event.padId)
        if (!pad) return

        const swingOffset = event.step % 2 === 1 ? swingOffsetQuarter : 0
        const time = track.duration + event.step * stepDurationQuarter + swingOffset

        track.addNote({
          midi: Math.max(0, Math.min(127, pad.midiNote + (event.semitones ?? 0))),
          time,
          duration: Math.max(0.01, event.gate * stepDurationQuarter),
          velocity: Math.max(0.05, Math.min(1, event.velocity / 127)),
        })
      })
    }
  }

  return midi.toArray()
}