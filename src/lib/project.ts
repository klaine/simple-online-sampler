import { DEFAULT_BPM, DEFAULT_POLYPHONY } from './constants'
import { createDefaultMasterBus, createDefaultMixBuses, createDefaultPads, createDefaultSequence, uid } from './utils'
import type { Project } from '../types'

export const createDefaultProject = (name = 'New Project'): Project => {
  const now = Date.now()
  return {
    id: uid(),
    name,
    bpm: DEFAULT_BPM,
    swing: 0,
    polyphony: DEFAULT_POLYPHONY,
    pads: createDefaultPads(),
    sequences: [createDefaultSequence()],
    songChain: [],
    songLoopStart: null,
    songLoopEnd: null,
    mixBuses: createDefaultMixBuses(),
    masterBus: createDefaultMasterBus(),
    createdAt: now,
    updatedAt: now,
  }
}

export const touchProject = (project: Project): Project => {
  return {
    ...project,
    updatedAt: Date.now(),
  }
}
