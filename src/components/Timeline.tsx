import { useCallback, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { showConfirm } from '../store/confirmDialog'
import type { SongChainEntry, SequencePattern } from '../types'

interface TimelineEntry {
  entry: SongChainEntry
  pattern: SequencePattern
  index: number
}

interface TimelineProps {
  show: boolean
}

export function Timeline({ show }: TimelineProps) {
  const project = useStore((s) => s.project)
  const isPlaying = useStore((s) => s.isPlaying)
  const playheadStep = useStore((s) => s.playheadStep)
  const playingPatternId = useStore((s) => s.playingPatternId)
  const playbackScope = useStore((s) => s.playbackScope)
  const playingChainIndex = useStore((s) => s.playingChainIndex)
  const playingChainRepeat = useStore((s) => s.playingChainRepeat)
  const {
    removeChainEntry,
    moveChainEntry,
    addChainEntry,
  } = useStore.getState()

  const draggedEntryIdRef = useRef<string | null>(null)
  const [contextEntry, setContextEntry] = useState<{ entryId: string; patternId: string } | null>(null)

  const entries = useMemo<TimelineEntry[]>(() => {
    if (!project) return []
    return project.songChain.flatMap((entry, index) => {
      const pattern = project.sequences.find((seq) => seq.id === entry.patternId)
      if (!pattern) return []
      return [{ entry, pattern, index }]
    })
  }, [project?.songChain, project?.sequences])

  const totalSteps = useMemo(() => {
    return entries.reduce((sum, { entry, pattern }) => sum + pattern.lengthSteps * entry.repeats, 0)
  }, [entries])

  const songPosition = useMemo(() => {
    if (!isPlaying || playbackScope !== 'song' || playingChainIndex == null || totalSteps === 0) {
      if (isPlaying && playheadStep != null && totalSteps > 0) {
        const activePattern = project?.sequences.find((s) => s.id === playingPatternId)
        return playheadStep / (activePattern?.lengthSteps ?? 16) * 100
      }
      return null
    }
    let pos = 0
    for (const { entry, pattern, index } of entries) {
      const entryTotalSteps = pattern.lengthSteps * entry.repeats
      if (index === playingChainIndex) {
        pos += (playingChainRepeat - 1) * pattern.lengthSteps + (playheadStep ?? 0)
        break
      }
      pos += entryTotalSteps
    }
    return totalSteps > 0 ? (pos / totalSteps) * 100 : 0
  }, [isPlaying, playbackScope, playingChainIndex, playingChainRepeat, playheadStep, entries, totalSteps, project?.sequences, playingPatternId])

  const handleDragStart = useCallback((e: React.DragEvent, entryId: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-online-sampler-chain-id', entryId)
    draggedEntryIdRef.current = entryId
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const fromDataTransfer = e.dataTransfer.getData('application/x-online-sampler-chain-id')
    const dragId = draggedEntryIdRef.current ?? fromDataTransfer
    if (dragId && dragId !== targetId) {
      void moveChainEntry(dragId, targetId)
    }
    draggedEntryIdRef.current = null
  }, [moveChainEntry])

  const handleContextMenu = useCallback(async (e: React.MouseEvent, entryId: string, patternId: string) => {
    e.preventDefault()
    setContextEntry({ entryId, patternId })
  }, [])

  const handleContextDelete = useCallback(async () => {
    if (!contextEntry) return
    const ok = await showConfirm('Remove this block from the song chain?', { confirmLabel: 'Remove' })
    if (ok) {
      void removeChainEntry(contextEntry.entryId)
    }
    setContextEntry(null)
  }, [contextEntry, removeChainEntry])

  const handleContextClone = useCallback(() => {
    if (!contextEntry) return
    void addChainEntry(contextEntry.patternId)
    setContextEntry(null)
  }, [contextEntry, addChainEntry])

  const handleContextDismiss = useCallback(() => {
    setContextEntry(null)
  }, [])

  if (!project || !show) return null

  const playheadPct = songPosition ?? 0

  return (
    <div className="timeline-panel">
      <div className="timeline-scroll">
        <div className="timeline-track">
          {entries.length === 0 ? (
            <p className="timeline-empty">Add patterns to the song chain to see them here.</p>
          ) : (
            entries.map(({ entry, pattern, index }) => {
              const isActive = isPlaying && playbackScope === 'song' && playingChainIndex === index
              const repeats = entry.repeats > 1 ? ` x${entry.repeats}` : ''
              const widthPct = totalSteps > 0 ? (pattern.lengthSteps * entry.repeats / totalSteps) * 100 : Math.max(6, (pattern.lengthSteps / 64) * 100)
              return (
                <div
                  key={entry.id}
                  className={`timeline-block ${isActive ? 'active' : ''}`}
                  style={{
                    backgroundColor: pattern.color,
                    width: `${Math.max(6, widthPct)}%`,
                    minWidth: 48,
                  }}
                  draggable
                  onDragStart={(e) => handleDragStart(e, entry.id)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, entry.id)}
                  onContextMenu={(e) => handleContextMenu(e, entry.id, pattern.id)}
                  title={`${pattern.name}${repeats} — ${pattern.lengthSteps} steps`}
                >
                  <span className="timeline-block-name">{pattern.name}</span>
                  <span className="timeline-block-steps">{pattern.lengthSteps}{repeats}</span>
                  <span className="timeline-block-index">{index + 1}</span>
                </div>
              )
            })
          )}
        </div>
        {/* Playhead */}
        {isPlaying && entries.length > 0 && (
          <div
            className="timeline-playhead"
            style={{ left: `${playheadPct}%` }}
          />
        )}
      </div>
      {/* Context menu */}
      {contextEntry && (
        <div className="timeline-context-menu" onClick={handleContextDismiss}>
          <div className="timeline-context-menu-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="timeline-context-btn" onClick={handleContextDelete}>Remove Block</button>
            <button type="button" className="timeline-context-btn" onClick={handleContextClone}>Clone Block</button>
            <button type="button" className="timeline-context-btn timeline-context-cancel" onClick={handleContextDismiss}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}