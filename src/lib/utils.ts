import {
  BANK_COUNT,
  PADS_PER_BANK,
  START_MIDI_NOTE,
  TOTAL_PADS,
} from './constants'
import type { BusId, EffectSlot, MasterBus, MixBus, Pad, SequencePattern } from '../types'
import { BUS_IDS } from '../types'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const midiToName = (note: number): string => {
  const octave = Math.floor(note / 12) - 1
  const name = NOTE_NAMES[note % 12] ?? 'C'
  return `${name}${octave}`
}

export const noteForPad = (bank: number, slot: number): number => {
  return START_MIDI_NOTE + bank * PADS_PER_BANK + slot
}

export const createDefaultPads = (): Pad[] => {
  const pads: Pad[] = []
  for (let index = 0; index < TOTAL_PADS; index += 1) {
    const bank = Math.floor(index / PADS_PER_BANK)
    const slot = index % PADS_PER_BANK
    const midiNote = noteForPad(bank, slot)
    pads.push({
      id: uid(),
      bank,
      slot,
      midiNote,
      name: `${midiToName(midiNote)} Pad`,
      settings: {
        sampleId: null,
        gain: 1,
        semitones: 0,
        fineCents: 0,
        mode: 'one-shot',
        trim: { start: 0, end: 1 },
        envelope: { attack: 0, decay: 0.2, sustain: 0, release: 0.2 },
        layers: [],
        multiMode: 'single',
        filterType: 'off',
        filterFreq: 1000,
        filterQ: 1,
        bus: 'A',
        chokeGroup: 0,
      },
    })
  }

  return pads
}

export const createDefaultEffectSlot = (): EffectSlot => ({
  id: uid(),
  type: 'off',
  enabled: false,
  params: {},
})

export const createDefaultMixBus = (busId: BusId): MixBus => ({
  id: busId,
  name: `Bus ${busId}`,
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  effects: [createDefaultEffectSlot(), createDefaultEffectSlot(), createDefaultEffectSlot()],
})

export const createDefaultMasterBus = (): MasterBus => ({
  gain: 1,
  effects: [createDefaultEffectSlot(), createDefaultEffectSlot(), createDefaultEffectSlot()],
})

export const createDefaultMixBuses = (): [MixBus, MixBus, MixBus, MixBus] =>
  BUS_IDS.map((id) => createDefaultMixBus(id)) as [MixBus, MixBus, MixBus, MixBus]

export const clampSequenceLength = (length: number): number => {
  return Math.min(128, Math.max(8, Math.round(length)))
}

export const ensureBank = (bank: number): number => {
  return Math.min(BANK_COUNT - 1, Math.max(0, Math.round(bank)))
}

export const createDefaultSequence = (): SequencePattern => {
  return {
    id: uid(),
    name: 'Pattern 1',
    color: '#f2b64a',
    resolution: 16,
    lengthSteps: 16,
    events: [],
  }
}

/** Non-cryptographic 2×53-bit hash (cyrb53 variant) — fallback for dedup when crypto.subtle is missing */
const fallbackHash = (bytes: Uint8Array): string => {
  const run = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      h1 = Math.imul(h1 ^ b, 2654435761)
      h2 = Math.imul(h2 ^ b, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return `fb-${bytes.length.toString(16)}-${run(0)}${run(1)}`
}

export const arrayBufferToHex = async (buffer: ArrayBuffer): Promise<string> => {
  // crypto.subtle only exists in secure contexts (https/localhost); on plain http, fall back
  if (typeof crypto === 'undefined' || !crypto.subtle) return fallbackHash(new Uint8Array(buffer))
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = Array.from(new Uint8Array(digest))
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
