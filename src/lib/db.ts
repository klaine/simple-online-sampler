import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Project, SampleAsset } from '../types'

interface SamplerDB extends DBSchema {
  projects: {
    key: string
    value: Project
    indexes: { 'by-updated-at': number }
  }
  samples: {
    key: string
    value: SampleAsset
    indexes: { 'by-hash': string }
  }
  waveformPeaks: {
    key: string
    value: {
      key: string
      sampleId: string
      hash: string
      bucketCount: number
      peaks: number[]
      updatedAt: number
    }
    indexes: { 'by-sample-id': string; 'by-hash': string }
  }
}

const DB_NAME = 'online-sampler'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<SamplerDB>> | null = null

const getDb = (): Promise<IDBPDatabase<SamplerDB>> => {
  if (!dbPromise) {
    dbPromise = openDB<SamplerDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' })
          projectStore.createIndex('by-updated-at', 'updatedAt')

          const sampleStore = db.createObjectStore('samples', { keyPath: 'id' })
          sampleStore.createIndex('by-hash', 'hash')
        }

        if (oldVersion < 2) {
          const peakStore = db.createObjectStore('waveformPeaks', { keyPath: 'key' })
          peakStore.createIndex('by-sample-id', 'sampleId')
          peakStore.createIndex('by-hash', 'hash')
        }
      },
    })
  }

  return dbPromise
}

export const db = {
  async putProject(project: Project): Promise<void> {
    const instance = await getDb()
    await instance.put('projects', project)
  },

  async getProject(projectId: string): Promise<Project | undefined> {
    const instance = await getDb()
    return instance.get('projects', projectId)
  },

  async getLatestProject(): Promise<Project | undefined> {
    const instance = await getDb()
    const cursor = await instance
      .transaction('projects')
      .store.index('by-updated-at')
      .openCursor(undefined, 'prev')
    return cursor?.value
  },

  async getAllProjects(): Promise<Project[]> {
    const instance = await getDb()
    return instance.getAll('projects')
  },

  async putSample(sample: SampleAsset): Promise<void> {
    const instance = await getDb()
    await instance.put('samples', sample)
  },

  async getSample(sampleId: string): Promise<SampleAsset | undefined> {
    const instance = await getDb()
    return instance.get('samples', sampleId)
  },

  async deleteSample(sampleId: string): Promise<void> {
    const instance = await getDb()
    await instance.delete('samples', sampleId)
  },

  async putWaveformPeaks(record: {
    key: string
    sampleId: string
    hash: string
    bucketCount: number
    peaks: number[]
    updatedAt: number
  }): Promise<void> {
    const instance = await getDb()
    await instance.put('waveformPeaks', record)
  },

  async getWaveformPeaksByHash(hash: string, bucketCount: number): Promise<number[] | undefined> {
    const instance = await getDb()
    const key = `${hash}:${bucketCount}`
    const record = await instance.get('waveformPeaks', key)
    return record?.peaks
  },

  async deleteWaveformPeaksBySampleId(sampleId: string): Promise<void> {
    const instance = await getDb()
    const tx = instance.transaction('waveformPeaks', 'readwrite')
    const index = tx.store.index('by-sample-id')
    let cursor = await index.openCursor(sampleId)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
    await tx.done
  },

  async getAllSamples(): Promise<SampleAsset[]> {
    const instance = await getDb()
    return instance.getAll('samples')
  },

  async findSampleByHash(hash: string): Promise<SampleAsset | undefined> {
    const instance = await getDb()
    return instance.getFromIndex('samples', 'by-hash', hash)
  },

  async resetAll(): Promise<void> {
    const instance = await getDb()
    const tx = instance.transaction(['projects', 'samples', 'waveformPeaks'], 'readwrite')
    await tx.objectStore('projects').clear()
    await tx.objectStore('samples').clear()
    await tx.objectStore('waveformPeaks').clear()
    await tx.done
  },
}
