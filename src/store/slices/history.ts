import type { Project } from '../../types'
import type { StoreContext } from '../context'

const MAX_UNDO_DEPTH = 50

interface UndoEntry {
  description: string
  project: Project
}

export interface HistoryState {
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
  isUndoingOrRedoing: boolean
}

export const createHistoryActions = (ctx: StoreContext) => ({
  pushUndo: (description: string) => {
    const s = ctx.get()
    if (!s.project || s.isUndoingOrRedoing) return

    // Store the pre-edit project by reference — immer updates are immutable with
    // structural sharing, so past states are never mutated and clones are unnecessary.
    const project = s.project

    ctx.set((d) => {
      d.undoStack = [...d.undoStack, { description, project }].slice(-MAX_UNDO_DEPTH)
      d.redoStack = []
    })
  },

  undo: () => {
    const s = ctx.get()
    if (!s.project || s.undoStack.length === 0 || s.isUndoingOrRedoing) return

    const entry = s.undoStack[s.undoStack.length - 1]
    const currentProject = s.project

    ctx.set((d) => {
      d.isUndoingOrRedoing = true
      d.redoStack = [...d.redoStack, { description: entry.description, project: currentProject }].slice(-MAX_UNDO_DEPTH)
      d.undoStack = d.undoStack.slice(0, -1)
    })

    ctx.get().saveProject(entry.project).then(() => {
      ctx.set((d) => { d.isUndoingOrRedoing = false })
    })

    ctx.get().addToast(`Undo: ${entry.description}`, 'info')
  },

  redo: () => {
    const s = ctx.get()
    if (!s.project || s.redoStack.length === 0 || s.isUndoingOrRedoing) return

    const entry = s.redoStack[s.redoStack.length - 1]
    const currentProject = s.project

    ctx.set((d) => {
      d.isUndoingOrRedoing = true
      d.undoStack = [...d.undoStack, { description: entry.description, project: currentProject }].slice(-MAX_UNDO_DEPTH)
      d.redoStack = d.redoStack.slice(0, -1)
    })

    ctx.get().saveProject(entry.project).then(() => {
      ctx.set((d) => { d.isUndoingOrRedoing = false })
    })

    ctx.get().addToast(`Redo: ${entry.description}`, 'info')
  },

  clearUndoHistory: () => {
    ctx.set((d) => {
      d.undoStack = []
      d.redoStack = []
    })
  },
})

export type HistoryActions = ReturnType<typeof createHistoryActions>
