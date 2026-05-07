import type { Project, SampleLayer, SequencePattern, SynthPatch } from '../types'
import { uid } from '../lib/utils'
import { createDefaultMixBuses, createDefaultMasterBus } from '../lib/utils'
import { PATTERN_COLORS_CYCLE } from './constants'

/** Default parameter values for each effect type */
export const getDefaultEffectParams = (type: string): Record<string, number> => {
  switch (type) {
    case 'compressor': return { threshold: -18, ratio: 4, knee: 10, attack: 0.003, release: 0.25 }
    case 'sidechain-compressor': return { threshold: -18, ratio: 4, knee: 10, attack: 0.003, release: 0.25 }
    case 'eq3': return { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1000 }
    case 'delay': return { time: 0.3, feedback: 0.35, mix: 0.3 }
    case 'reverb': return { decay: 1.5, mix: 0.25 }
    case 'chorus': return { rate: 1.5, depth: 5, mix: 0.3 }
    default: return {}
  }
}

export function loadSynthPatches(): SynthPatch[] {
  try {
    const raw = localStorage.getItem('synthPatches')
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

export function saveSynthPatches(patches: SynthPatch[]): void {
  try {
    localStorage.setItem('synthPatches', JSON.stringify(patches))
  } catch { /* ignore */ }
}

export const createLayer = (sampleId: string, overrides?: Partial<SampleLayer>): SampleLayer => ({
  id: uid(),
  sampleId,
  velocityLow: 1,
  velocityHigh: 127,
  gain: null,
  semitones: null,
  fineCents: null,
  trim: null,
  envelope: null,
  filterType: null,
  filterFreq: null,
  filterQ: null,
  stackOffsetMs: null,
  ...overrides,
})

export const normalizeProject = (incoming: Project): Project => {
  const normalizedChain = (incoming.songChain ?? []).map((entry) => ({
    ...entry,
    repeats: Math.max(1, entry.repeats ?? 1),
  }))

  const maxIndex = Math.max(0, normalizedChain.length - 1)
  const clampLoop = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) {
      return null
    }
    return Math.max(0, Math.min(maxIndex, value))
  }

  const loopStart = clampLoop(incoming.songLoopStart)
  const loopEnd = clampLoop(incoming.songLoopEnd)

  return {
    ...incoming,
    swing: incoming.swing ?? 0,
    pads: incoming.pads.map((pad) => ({
      ...pad,
      settings: {
        ...pad.settings,
        mode: ((m: string) => m === 'adr' || m === 'gate' ? 'adsr' as const : m === 'trigger' ? 'one-shot' as const : pad.settings.mode)(pad.settings.mode as string),
        envelope: { ...pad.settings.envelope, sustain: pad.settings.envelope.sustain ?? 0 },
        filterType: (pad.settings.filterType as string) === 'lowpass' ? 'lp12' as const : pad.settings.filterType ?? 'off',
        layers: (pad.settings.layers ?? []).map((layer) => ({
          ...layer,
          gain: layer.gain ?? null,
          semitones: layer.semitones ?? null,
          fineCents: layer.fineCents ?? null,
          trim: layer.trim ?? null,
          envelope: layer.envelope ? { ...layer.envelope, sustain: layer.envelope.sustain ?? 0 } : null,
          filterType: (layer.filterType as string | null) === 'lowpass' ? 'lp12' : (layer.filterType ?? null),
          filterFreq: layer.filterFreq ?? null,
          filterQ: layer.filterQ ?? null,
        })),
        multiMode: pad.settings.multiMode ?? 'single',
        filterFreq: pad.settings.filterFreq ?? 1000,
        filterQ: pad.settings.filterQ ?? 1,
        bus: pad.settings.bus ?? 'A',
        chokeGroup: pad.settings.chokeGroup ?? 0,
        source: pad.settings.source ?? 'sample',
        ...(pad.settings.synthParams?.lfo && 'target' in ((pad.settings.synthParams!.lfo as unknown) as Record<string, unknown>) ? {
          synthParams: {
            ...pad.settings.synthParams,
            synthMode: pad.settings.synthParams.synthMode ?? 'additive',
            lfo: (() => {
              const old = (pad.settings.synthParams!.lfo as unknown) as Record<string, unknown>
              const target = old.target as string | undefined
              const depth = old.depth as number | undefined
              return {
                ...(old as unknown as import('../types').LfoSettings),
                pitchDepth: target === 'pitch' ? (depth ?? 0) : 0,
                filterDepth: target === 'filter' ? (depth ?? 0) : 0,
                gainDepth: target === 'gain' ? (depth ?? 0) : 0,
                pwDepth: (old as Record<string, unknown>).pwDepth as number ?? 0,
                triggerMode: (old as Record<string, unknown>).triggerMode as (import('../types').LfoTriggerMode | undefined) ?? 'free',
              }
            })(),
          },
        } : pad.settings.synthParams ? {
          synthParams: {
            ...pad.settings.synthParams,
            synthMode: pad.settings.synthParams.synthMode ?? 'additive',
          },
        } : {}),
      },
    })),
    sequences: incoming.sequences.map((sequence, index) => ({
      ...sequence,
      color: sequence.color ?? PATTERN_COLORS_CYCLE[index % PATTERN_COLORS_CYCLE.length],
    })),
    songChain: normalizedChain,
    songLoopStart: normalizedChain.length === 0 ? null : loopStart,
    songLoopEnd: normalizedChain.length === 0 ? null : loopEnd,
    mixBuses: incoming.mixBuses ?? createDefaultMixBuses(),
    masterBus: incoming.masterBus ?? createDefaultMasterBus(),
  }
}

// ---------------------------------------------------------------------------
// Memoization helper: caches result when deps haven't changed (by reference)
// ---------------------------------------------------------------------------
export function memoize<S, R>(deps: (s: S) => unknown[], fn: (s: S) => R): (s: S) => R {
  let cachedDeps: unknown[] | null = null
  let cachedResult: R
  return (s: S) => {
    const nextDeps = deps(s)
    if (cachedDeps && cachedDeps.length === nextDeps.length && cachedDeps.every((d, i) => d === nextDeps[i])) {
      return cachedResult
    }
    cachedDeps = nextDeps
    cachedResult = fn(s)
    return cachedResult
  }
}

export function getLaneBoundsForEvent(
  pattern: SequencePattern,
  padId: string,
  eventId: string,
): { minStart: number; maxEnd: number } {
  const target = pattern.events.find((e) => e.id === eventId)
  if (!target) return { minStart: 0, maxEnd: pattern.lengthSteps - 1 }

  const laneEvents = pattern.events
    .filter((e) => e.padId === padId && e.id !== eventId)
    .map((e) => ({ start: e.step, end: e.step + Math.max(1, e.gate) - 1 }))
    .sort((a, b) => a.start - b.start)

  const targetStart = target.step
  const targetEnd = target.step + Math.max(1, target.gate) - 1
  let minStart = 0
  let maxEnd = pattern.lengthSteps - 1
  laneEvents.forEach((e) => {
    if (e.end < targetStart) minStart = Math.max(minStart, e.end + 1)
    if (e.start > targetEnd) maxEnd = Math.min(maxEnd, e.start - 1)
  })
  return { minStart, maxEnd }
}

export function updateGateEventRange(
  projectState: Project,
  patternId: string,
  padId: string,
  eventId: string,
  start: number,
  end: number,
): Project {
  return {
    ...projectState,
    sequences: projectState.sequences.map((seq) => {
      if (seq.id !== patternId) return seq
      return {
        ...seq,
        events: seq.events.map((e) =>
          e.id === eventId && e.padId === padId
            ? { ...e, step: start, gate: Math.max(1, end - start + 1) }
            : e,
        ),
      }
    }),
  }
}
