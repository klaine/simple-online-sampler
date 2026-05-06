import type { Pad, SequencePattern } from '../types'

export const buildMidiForSequence = async (
  sequence: SequencePattern,
  pads: Pad[],
  bpm: number,
): Promise<Uint8Array> => {
  const { Midi } = await import('@tonejs/midi')
  const midi = new Midi()
  midi.header.setTempo(bpm)
  midi.header.name = sequence.name

  const track = midi.addTrack()
  const stepDurationQuarter = sequence.resolution === 16 ? 0.25 : 0.125

  sequence.events.forEach((event) => {
    const pad = pads.find((item) => item.id === event.padId)
    if (!pad) {
      return
    }

    track.addNote({
      midi: Math.max(0, Math.min(127, pad.midiNote + (event.semitones ?? 0))),
      time: event.step * stepDurationQuarter,
      duration: Math.max(0.01, event.gate * stepDurationQuarter),
      velocity: Math.max(0.05, Math.min(1, event.velocity / 127)),
    })
  })

  return midi.toArray()
}
