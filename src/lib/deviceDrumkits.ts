/** Extensible device drumkit mapping system */

export interface DrumkitPadMapping {
  pad: number         // 1-indexed pad number
  note: number        // MIDI note
  name: string        // Human-readable drum name
  chokeGroup?: number // Optional choke group (pads sharing a number choke each other)
}

export interface DeviceDrumkit {
  id: string
  label: string
  pads: DrumkitPadMapping[]
}

export const MC707_DRUMKIT: DeviceDrumkit = {
  id: 'mc707',
  label: 'MC-707 Drumkit',
  pads: [
    { pad: 1,  note: 36, name: 'Kick' },
    { pad: 2,  note: 37, name: 'Rimshot' },
    { pad: 3,  note: 38, name: 'Snare' },
    { pad: 4,  note: 39, name: 'Clap' },
    { pad: 5,  note: 49, name: 'Crash' },
    { pad: 6,  note: 41, name: 'Low Tom' },
    { pad: 7,  note: 42, name: 'Closed HiHat', chokeGroup: 1 },
    { pad: 8,  note: 51, name: 'Ride' },
    { pad: 9,  note: 54, name: 'Tambourine' },
    { pad: 10, note: 45, name: 'Mid Tom' },
    { pad: 11, note: 46, name: 'Open HiHat', chokeGroup: 1 },
    { pad: 12, note: 48, name: 'High Tom' },
    { pad: 13, note: 56, name: 'Cowbell' },
    { pad: 14, note: 62, name: 'Conga Hi' },
    { pad: 15, note: 63, name: 'Conga Mid' },
    { pad: 16, note: 64, name: 'Conga Lo' },
  ],
}

export const DEVICE_DRUMKITS: DeviceDrumkit[] = [MC707_DRUMKIT]

/** Get drumkit by id */
export function getDeviceDrumkit(id: string): DeviceDrumkit | undefined {
  return DEVICE_DRUMKITS.find((dk) => dk.id === id)
}

/** Get drum name for a MIDI note in a given drumkit */
export function getDrumName(kit: DeviceDrumkit, note: number): string | undefined {
  return kit.pads.find((p) => p.note === note)?.name
}

/** Get choke group for a MIDI note in a given drumkit */
export function getDrumChokeGroup(kit: DeviceDrumkit, note: number): number | undefined {
  return kit.pads.find((p) => p.note === note)?.chokeGroup
}

/** Get pad index (0-based) for a MIDI note in a given drumkit */
export function getDrumPadIndex(kit: DeviceDrumkit, note: number): number {
  return kit.pads.findIndex((p) => p.note === note)
}
