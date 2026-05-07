import { useCallback, useMemo, useRef } from 'react'
import { useStore } from '../store'
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

  const {
    removeChainEntry,
    moveChainEntry,
    addChainEntry,
  } = useStore.getState()

  const dragRef = useRef<{ dragId: string; targetId: string } | null>(null)

  const entries = useMemo<TimelineEntry[]>(() => {
    if (!project) return []
    return project.songChain.flatMap((entry, index) => {
      const pattern = project.sequences.find((seq) => seq.id === entry.patternId)
      if (!pattern) return []
      return [{ entry, pattern, index }]
    })
  }, [project?.songChain, project?.sequences])

  const handleDragStart = useCallback((e: React.DragEvent, entryId: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-online-sampler-chain-id', entryId)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, entryId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const dragId = e.dataTransfer.getData('application/x-online-sampler-chain-id')
    if (dragId && dragId !== entryId) {
      dragRef.current = { dragId, targetId: entryId }
    }
  }, [])

  const handleDrop = useCallback((_e: React.DragEvent) => {
    if (dragRef.current) {
      void moveChainEntry(dragRef.current.dragId, dragRef.current.targetId)
      dragRef.current = null
    }
  }, [moveChainEntry])

  const handleContextMenu = useCallback((e: React.MouseEvent, entryId: string, patternId: string) => {
    e.preventDefault()
    // Simple menu via confirm-like dialog
    const action = window.prompt('Action: (d)elete, (c)lone')
    if (action === 'd') {
      void removeChainEntry(entryId)
    } else if (action === 'c') {
      void addChainEntry(patternId)
    }
  }, [removeChainEntry, addChainEntry])

  if (!project || !show) return null

  // Calculate playhead position
  const activePattern = project.sequences.find((s) => s.id === playingPatternId)
  const stepCount = activePattern?.lengthSteps ?? 16
  const playheadPct = playheadStep != null && stepCount > 0 ? (playheadStep / stepCount) * 100 : 0

  return (
    <div className="timeline-panel">
      <div className="timeline-scroll">
        <div className="timeline-track">
          {entries.length === 0 ? (
            <p className="timeline-empty">Add patterns to the song chain to see them here.</p>
          ) : (
            entries.map(({ entry, pattern, index }) => {
              const isActive = isPlaying && playingPatternId === pattern.id
              const repeats = entry.repeats > 1 ? ` x${entry.repeats}` : ''
              return (
                <div
                  key={entry.id}
                  className={`timeline-block ${isActive ? 'active' : ''}`}
                  style={{
                    backgroundColor: pattern.color,
                    width: `${Math.max(6, (pattern.lengthSteps / 64) * 100)}%`,
                    minWidth: 48,
                  }}
                  draggable
                  onDragStart={(e) => handleDragStart(e, entry.id)}
                  onDragOver={(e) => handleDragOver(e, entry.id)}
                  onDrop={handleDrop}
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
    </div>
  )
}
