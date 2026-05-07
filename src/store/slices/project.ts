import { db } from '../../lib/db'
import { uid } from '../../lib/utils'
import { createDefaultProject } from '../../lib/project'
import { normalizeProject } from '../helpers'
import { showConfirm } from '../confirmDialog'
import { mutableRefs } from '../refs'
import { loadPresetKits } from '../importHelpers'
import { audioEngine } from '../../lib/audioEngine'
import { buildPlaybackSnapshot } from '../../lib/playbackSnapshot'
import type { Project } from '../../types'
import type { StoreContext } from '../context'

const rebuildPlaybackSnapshot = (proj: Project) => {
  mutableRefs.playbackVersion += 1
  mutableRefs.playbackSnapshot = buildPlaybackSnapshot(proj, mutableRefs.playbackVersion)
}

export const createProjectActions = (ctx: StoreContext) => ({
  hydrate: async () => {
    // Guard against double-invoke (React Strict Mode)
    if (mutableRefs.hydratePromise) return mutableRefs.hydratePromise
    mutableRefs.hydratePromise = (async () => {
      const existing = await db.getLatestProject()
      const loadedProject = normalizeProject(existing ?? createDefaultProject('Sketch 01'))
      if (!existing) {
        await db.putProject(loadedProject)
      }

      const allSamples = await db.getAllSamples()
      ctx.set((s) => {
        s.project = loadedProject
        s.projectNameDraft = loadedProject.name
        s.bpmDraft = String(loadedProject.bpm)
        s.swingDraft = String(loadedProject.swing ?? 0)
        s.selectedPadId = loadedProject.pads[0]?.id ?? null
        s.activeSequenceId = loadedProject.sequences[0]?.id ?? null
        s.samples = allSamples
        s.sampleMap = new Map(allSamples.map((sample) => [sample.id, sample]))
      })
      audioEngine.setBpm(loadedProject.bpm)
      audioEngine.setPolyphony(loadedProject.polyphony)
      rebuildPlaybackSnapshot(loadedProject)

      // Load factory preset kits on first launch (no samples in DB)
      if (allSamples.length === 0) {
        const loaded = await loadPresetKits(ctx.get, ctx.set)
        for (const { runId, bank } of loaded) {
          await ctx.get().assignGroupToPads(runId, bank, true)
        }
      }
      await ctx.get().refreshProjectList()
    })()
    return mutableRefs.hydratePromise
  },

  initializeCurrentProject: async () => {
    const ok = await showConfirm(
      'Initialize project to fresh start? This clears this app local data (projects, samples, settings).',
    )
    if (!ok) return

    ctx.get().stopTransport()
    await db.resetAll()

    const next = createDefaultProject('Sketch 01')
    await ctx.get().saveProject(next)
    ctx.set((s) => {
      s.samples = []
      s.sampleMap = new Map()
      s.selectedPadId = next.pads[0]?.id ?? null
      s.activeSequenceId = next.sequences[0]?.id ?? null
      s.activeBank = 0
      s.mutedLanePadIds = new Set()
      s.playbackScope = 'pattern'
      s.playingPatternId = null
      s.playingChainIndex = null
      s.playingChainRepeat = 1
      s.historyPast = []
      s.historyFuture = []
      s.selectedChainEntryId = null
      s.copiedChainPatternId = null
      s.sampleQuery = ''
      s.sampleSort = 'recent'
      s.showFavoritesOnly = false
      s.favoriteSampleIds = new Set()
      s.showGateResizeTip = true
    })
    await ctx.get().refreshProjectList()
  },

  refreshProjectList: async () => {
    const all = await db.getAllProjects()
    const list = all
      .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    ctx.set((s) => {
      s.projectList = list
    })
  },

  switchProject: async (projectId: string) => {
    const current = ctx.get().project
    if (current && current.id === projectId) return

    ctx.get().stopTransport()
    ctx.get().flushPendingProjectSave()

    const proj = await db.getProject(projectId)
    if (!proj) return
    const loaded = normalizeProject(proj)

    const allSamples = await db.getAllSamples()
    ctx.set((s) => {
      s.project = loaded
      s.projectNameDraft = loaded.name
      s.bpmDraft = String(loaded.bpm)
      s.swingDraft = String(loaded.swing ?? 0)
      s.selectedPadId = loaded.pads[0]?.id ?? null
      s.activeSequenceId = loaded.sequences[0]?.id ?? null
      s.activeBank = 0
      s.mutedLanePadIds = new Set()
      s.playbackScope = 'pattern'
      s.playingPatternId = null
      s.playingChainIndex = null
      s.playingChainRepeat = 1
      s.historyPast = []
      s.historyFuture = []
      s.selectedChainEntryId = null
      s.copiedChainPatternId = null
      s.samples = allSamples
      s.sampleMap = new Map(allSamples.map((sample) => [sample.id, sample]))
      s.libraryWavePeaks = {}
      s.waveformPeaks = []
    })
    audioEngine.setBpm(loaded.bpm)
    audioEngine.setPolyphony(loaded.polyphony)
    rebuildPlaybackSnapshot(loaded)
  },

  createNewProject: async () => {
    ctx.get().stopTransport()
    ctx.get().flushPendingProjectSave()

    // Generate a name like "Sketch 02", "Sketch 03", etc.
    const all = await db.getAllProjects()
    const existingNames = new Set(all.map((p) => p.name))
    let num = all.length + 1
    let name = `Sketch ${String(num).padStart(2, '0')}`
    while (existingNames.has(name)) {
      num++
      name = `Sketch ${String(num).padStart(2, '0')}`
    }

    const next = createDefaultProject(name)
    await db.putProject(next)

    ctx.set((s) => {
      s.project = next
      s.projectNameDraft = next.name
      s.bpmDraft = String(next.bpm)
      s.swingDraft = String(next.swing ?? 0)
      s.selectedPadId = next.pads[0]?.id ?? null
      s.activeSequenceId = next.sequences[0]?.id ?? null
      s.activeBank = 0
      s.mutedLanePadIds = new Set()
      s.playbackScope = 'pattern'
      s.playingPatternId = null
      s.playingChainIndex = null
      s.playingChainRepeat = 1
      s.historyPast = []
      s.historyFuture = []
      s.selectedChainEntryId = null
      s.copiedChainPatternId = null
    })
    audioEngine.setBpm(next.bpm)
    audioEngine.setPolyphony(next.polyphony)
    rebuildPlaybackSnapshot(next)
    await ctx.get().refreshProjectList()
  },

  deleteProject: async (projectId: string) => {
    const current = ctx.get().project
    if (!current) return

    const all = await db.getAllProjects()
    if (all.length <= 1) {
      ctx.get().addToast('Cannot delete the only project', 'error')
      return
    }

    const target = all.find((p) => p.id === projectId)
    const ok = await showConfirm(`Delete project "${target?.name ?? 'Untitled'}"?`)
    if (!ok) return

    await db.deleteProject(projectId)

    // If deleting the current project, switch to the most recent remaining
    if (current.id === projectId) {
      const remaining = all.filter((p) => p.id !== projectId)
      remaining.sort((a, b) => b.updatedAt - a.updatedAt)
      if (remaining.length > 0) {
        await ctx.get().switchProject(remaining[0].id)
      }
    }
    await ctx.get().refreshProjectList()
  },

  duplicateProject: async () => {
    const current = ctx.get().project
    if (!current) return

    ctx.get().flushPendingProjectSave()

    const dupe: Project = JSON.parse(JSON.stringify(current))
    dupe.id = uid()
    dupe.name = current.name + ' Copy'
    dupe.createdAt = Date.now()
    dupe.updatedAt = Date.now()

    await db.putProject(dupe)
    await ctx.get().switchProject(dupe.id)
    await ctx.get().refreshProjectList()
  },
})
