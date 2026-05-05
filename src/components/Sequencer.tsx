import { useRef, useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import {
  MAX_SEQUENCE_STEPS,
  MIN_SEQUENCE_STEPS,
} from '../lib/constants'
import type { SequenceResolution } from '../types'
import {
  useStore,
  transportVisualStore,
  selectSelectedPad,
  selectActiveSequence,
  selectVisibleSequence,
  selectEventsByPadAndStep,
  selectSpanningByPadAndStep,
  selectSequencerBankGroups,
  selectEventsByPad,
  PATTERN_COLORS,
} from '../store'
import { SequencerStep } from './SequencerStep'
import { PianoRollLane } from './PianoRollLane'
import { makeTouchDragHandlers } from '../lib/touchDrag'

function ColorPicker({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const handleOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
  }, [])

  useEffect(() => {
    if (open) document.addEventListener('pointerdown', handleOutside)
    return () => document.removeEventListener('pointerdown', handleOutside)
  }, [open, handleOutside])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="color-picker-wrap" ref={ref}>
      <button
        type="button"
        className="color-swatch-btn"
        style={{ background: color }}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      />
      {open && (
        <div className="color-grid-popover" onClick={(e) => e.stopPropagation()}>
          {PATTERN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-grid-cell${c === color ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => { onChange(c); setOpen(false) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function Sequencer() {
  const project = useStore((s) => s.project)
  const isPlaying = useStore((s) => s.isPlaying)
  const playbackScope = useStore((s) => s.playbackScope)
  const playingPatternId = useStore((s) => s.playingPatternId)
  const playingChainIndex = useStore((s) => s.playingChainIndex)
  const playingChainRepeat = useStore((s) => s.playingChainRepeat)
  const playheadStep = useSyncExternalStore(transportVisualStore.subscribe, transportVisualStore.getPlayheadStep)
  const showPerfStats = useStore((s) => s.showPerfStats)
  const perfStats = useStore((s) => s.perfStats)
  const activeSequenceId = useStore((s) => s.activeSequenceId)
  const mutedLanePadIds = useStore((s) => s.mutedLanePadIds)
  const selectedPadId = useStore((s) => s.selectedPadId)
  const hideEmptyLanes = useStore((s) => s.hideEmptyLanes)
  const showSongChain = useStore((s) => s.showSongChain)
  const showGateResizeTip = useStore((s) => s.showGateResizeTip)
  const showSequencerHelp = useStore((s) => s.showSequencerHelp)
  const showSequencerTools = useStore((s) => s.showSequencerTools)
  const sequenceLengthDraft = useStore((s) => s.sequenceLengthDraft)
  const patternRenameId = useStore((s) => s.patternRenameId)
  const patternRenameDraft = useStore((s) => s.patternRenameDraft)
  const selectedChainEntryId = useStore((s) => s.selectedChainEntryId)
  const copiedChainPatternId = useStore((s) => s.copiedChainPatternId)
  const historyPast = useStore((s) => s.historyPast)
  const historyFuture = useStore((s) => s.historyFuture)

  const selectedPad = useStore(selectSelectedPad)
  const activeSequence = useStore(selectActiveSequence)
  const visibleSequence = useStore(selectVisibleSequence)
  const eventsByPadAndStep = useStore(selectEventsByPadAndStep)
  const spanningByPadAndStep = useStore(selectSpanningByPadAndStep)
  const bankGroups = useStore(selectSequencerBankGroups)
  const eventsByPad = useStore(selectEventsByPad)
  const expandedPianoRollPads = useStore((s) => s.expandedPianoRollPads)
  const pianoRollOctaveOffset = useStore((s) => s.pianoRollOctaveOffset)

  const {
    triggerPad,
    pushSequencerHistory,
    undoSequencer,
    redoSequencer,
    clearLane,
    laneToolFill,
    laneToolShift,
    laneToolRandom,
    duplicatePatternLength,
    toggleLaneMute,
    setSequenceResolution,
    commitSequenceLengthDraft: commitSeqLength,
    addSequence,
    renamePattern,
    setPatternColor,
    duplicatePattern,
    deletePattern,
    addChainEntryAt,
    removeChainEntry,
    moveChainEntry,
    updateChainRepeats,
    setSongLoopStart,
    setSongLoopEnd,
    copySelectedChainEntry,
    pasteChainEntry,
    togglePianoRollExpanded,
    toggleSeqBankCollapsed,
    reorderPattern,
  } = useStore.getState()

  const draggedPatternIdRef = useRef<string | null>(null)
  const draggedChainEntryIdRef = useRef<string | null>(null)
  const chainGridRef = useRef<HTMLDivElement>(null)
  const [dragOverPatternId, setDragOverPatternId] = useState<string | null>(null)
  const [fps, setFps] = useState(0)

  // Handle touch-drop events on chain area
  useEffect(() => {
    const el = chainGridRef.current
    if (!el) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, string> | undefined
      if (!detail) return
      const patternId = detail['x-pattern-id']
      const chainEntryId = detail['x-chain-entry-id']
      const target = e.target as HTMLElement

      // Determine insert index from data attribute
      const insertSlot = target.closest('.chain-insert-slot') as HTMLElement | null
      const chainCell = target.closest('.chain-cell') as HTMLElement | null

      if (insertSlot && patternId) {
        const idx = Number(insertSlot.dataset.chainIndex ?? 0)
        void useStore.getState().addChainEntryAt(patternId, idx)
      } else if (chainCell && patternId) {
        const idx = Number(chainCell.dataset.chainIndex ?? 0)
        void useStore.getState().addChainEntryAt(patternId, idx)
      } else if (chainCell && chainEntryId) {
        const targetEntryId = chainCell.dataset.chainEntryId
        if (targetEntryId) void useStore.getState().moveChainEntry(chainEntryId, targetEntryId)
      } else if (patternId) {
        // Dropped on chain area but not on a specific slot — append to end
        const chainLen = useStore.getState().project?.songChain.length ?? 0
        void useStore.getState().addChainEntryAt(patternId, chainLen)
      }
    }
    el.addEventListener('touch-drop', handler)
    return () => el.removeEventListener('touch-drop', handler)
  }, [])

  // FPS counter (only active when perf stats visible)
  useEffect(() => {
    if (!showPerfStats) return
    let frames = 0
    let lastTime = performance.now()
    let rafId = 0
    const tick = () => {
      frames++
      const now = performance.now()
      if (now - lastTime >= 1000) {
        setFps(frames)
        frames = 0
        lastTime = now
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [showPerfStats])

  const layoutMode = useStore((s) => s.layoutMode)

  if (!project || !activeSequence || !visibleSequence) return null

  const fitSteps = layoutMode === 'wide' || layoutMode === 'performance' || visibleSequence.lengthSteps <= 16
  const stepColSize = fitSteps ? 'minmax(0, 1fr)' : 'minmax(24px, 1fr)'
  const laneLabelWidth = layoutMode === 'performance' ? 172 : 148
  const sequenceGridColumns = `${laneLabelWidth}px repeat(3, 26px) repeat(${visibleSequence.lengthSteps}, ${stepColSize})`
  const stepGridColumns = `repeat(${visibleSequence.lengthSteps}, ${stepColSize})`
  const chainWithPatterns = project.songChain.flatMap((entry) => {
    const pattern = project.sequences.find((seq) => seq.id === entry.patternId)
    if (!pattern) return []
    return [{ entry, pattern }]
  })

  return (
    <section className="sequencer studio-sequencer">
      <div className="sequencer-top">
        <div className="sequencer-controls-row">
          <select className="seq-select" value={playbackScope} onChange={(e) => useStore.setState({ playbackScope: e.target.value as 'pattern' | 'song' })}>
            <option value="pattern">Pattern</option>
            <option value="song">Song</option>
          </select>
          <select className="seq-select" value={visibleSequence.resolution} onChange={(e) => void setSequenceResolution(Number(e.target.value) as SequenceResolution)}>
            <option value={16}>1/16</option>
            <option value={32}>1/32</option>
          </select>
          <div className="seq-length-group">
            <span className="seq-length-label">Steps</span>
            {[16, 32, 64].map((n) => (
              <button
                key={n}
                type="button"
                className={`seq-length-btn${visibleSequence.lengthSteps === n && sequenceLengthDraft === String(n) ? ' active' : ''}`}
                onClick={() => { useStore.setState({ sequenceLengthDraft: String(n) }); void commitSeqLength() }}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              className="seq-length-custom"
              min={MIN_SEQUENCE_STEPS}
              max={MAX_SEQUENCE_STEPS}
              value={sequenceLengthDraft}
              onChange={(e) => useStore.setState({ sequenceLengthDraft: e.target.value })}
              onBlur={() => void commitSeqLength()}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              title="Custom step count"
            />
          </div>
          <label className="sequencer-toggle">
            <input type="checkbox" checked={hideEmptyLanes} onChange={(e) => useStore.setState({ hideEmptyLanes: e.target.checked })} />
            Hide Empty
          </label>
          <span className="seq-controls-spacer" />
          <button type="button" className="seq-action-btn" onClick={() => void addSequence()}>+ Pattern</button>
          <button type="button" className="seq-action-btn" onClick={() => useStore.setState((s) => ({ showSequencerTools: !s.showSequencerTools }))}>
            Tools
          </button>
          <button type="button" className="seq-action-btn" onClick={() => useStore.setState((s) => ({ showSequencerHelp: !s.showSequencerHelp }))}>
            ?
          </button>
          <span className="seq-status-inline">
            {isPlaying
              ? playbackScope === 'song' && playingChainIndex !== null
                ? `Chain ${playingChainIndex + 1}/${playingChainRepeat}`
                : `▶ ${project.sequences.find((s) => s.id === playingPatternId)?.name ?? ''}`
              : 'Stopped'}
          </span>
        </div>
      </div>

      {showSequencerHelp && (
        <div className="sequencer-help">
          <p>Shortcuts: Space play/pause, S stop, T tap tempo, Escape close dialog.</p>
          <p>Banks: 1-8 switch bank. Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo.</p>
          <p>Chain: Cmd/Ctrl+C copy block, Cmd/Ctrl+V paste block, Delete remove selected block.</p>
          <p>Gate notes: drag left/right handles to resize, Alt+Left/Right nudge edges.</p>
          <p>Velocity: Shift+drag a lit step up/down to edit velocity.</p>
          <p>Pitch: Alt+Shift+drag a lit step up/down to edit semitones.</p>
          <p>Lane tools: use Fill/Shift/Random strip for selected lane.</p>
          <button type="button" onClick={() => useStore.setState((s) => ({ showPerfStats: !s.showPerfStats }))}>
            {showPerfStats ? 'Hide Performance Stats' : 'Show Performance Stats'}
          </button>
          {showPerfStats && (
            <p>{`FPS ${fps} | Ticks ${perfStats.tickCount} | Late Notes ${perfStats.lateNotes} | Max Drift ${perfStats.maxDriftMs.toFixed(1)}ms | P95 Drift ${perfStats.p95DriftMs.toFixed(1)}ms`}</p>
          )}
        </div>
      )}

      {showSequencerTools && (
        <div className="lane-tools-strip compact">
          <button type="button" onClick={() => void duplicatePatternLength('double')}>Pattern x2</button>
          <button type="button" onClick={() => void duplicatePatternLength('half')}>Pattern /2</button>
          <button type="button" onClick={() => selectedPad && void laneToolFill(selectedPad.id, 4)} disabled={!selectedPad}>Fill 4</button>
          <button type="button" onClick={() => selectedPad && void laneToolFill(selectedPad.id, 2)} disabled={!selectedPad}>Fill 2</button>
          <button type="button" onClick={() => selectedPad && void laneToolShift(selectedPad.id, -1)} disabled={!selectedPad}>Shift &lt;</button>
          <button type="button" onClick={() => selectedPad && void laneToolShift(selectedPad.id, 1)} disabled={!selectedPad}>Shift &gt;</button>
          <button type="button" onClick={() => selectedPad && void laneToolRandom(selectedPad.id)} disabled={!selectedPad}>Random</button>
        </div>
      )}

      <div className="pattern-strip" onDragLeave={() => setDragOverPatternId(null)}>
        {project.sequences.map((sequence) => {
          const isActive = sequence.id === activeSequence.id
          const isPlayingPat = sequence.id === playingPatternId
          return (
             <div
              key={sequence.id}
              className={`pattern-chip ${isActive ? 'active' : ''} ${isPlayingPat ? 'playing' : ''} ${dragOverPatternId === sequence.id ? 'drag-over' : ''}`}
              style={{ borderColor: sequence.color }}
              draggable
              onDragStart={() => {
                draggedPatternIdRef.current = sequence.id
                draggedChainEntryIdRef.current = null
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (draggedPatternIdRef.current && draggedPatternIdRef.current !== sequence.id && !draggedChainEntryIdRef.current) {
                  setDragOverPatternId(sequence.id)
                }
              }}
              onDrop={() => {
                if (draggedPatternIdRef.current && draggedPatternIdRef.current !== sequence.id && !draggedChainEntryIdRef.current) {
                  void reorderPattern(draggedPatternIdRef.current, sequence.id)
                }
                setDragOverPatternId(null)
              }}
              onDragEnd={() => setDragOverPatternId(null)}
              onClick={() => useStore.setState({ activeSequenceId: sequence.id })}
              {...makeTouchDragHandlers({ 'x-pattern-id': sequence.id }, sequence.name)}
            >
              <span className="pattern-color" style={{ background: sequence.color }}></span>
              {patternRenameId === sequence.id ? (
                <input
                  autoFocus
                  className="pattern-name-input"
                  value={patternRenameDraft}
                  onChange={(e) => useStore.setState({ patternRenameDraft: e.target.value })}
                  onBlur={() => {
                    void renamePattern(sequence.id, patternRenameDraft)
                    useStore.setState({ patternRenameId: null })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') useStore.setState({ patternRenameId: null })
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="pattern-name"
                  onDoubleClick={() => useStore.setState({ patternRenameId: sequence.id, patternRenameDraft: sequence.name })}
                >
                  {sequence.name}
                </button>
              )}
              <ColorPicker color={sequence.color} onChange={(c) => void setPatternColor(sequence.id, c)} />
              <button type="button" className="pattern-dup" onClick={() => void duplicatePattern(sequence.id)}>Dup</button>
              {project.sequences.length > 1 && (
                <button type="button" className="pattern-del" onClick={() => void deletePattern(sequence.id)} title="Delete pattern">&times;</button>
              )}
            </div>
          )
        })}
      </div>

      <div className={`chain-grid ${showSongChain ? '' : 'collapsed'}`} ref={chainGridRef}>
        <div className="chain-grid-head">
          <h3>Song Chain</h3>
          <button
            type="button"
            className="chain-toggle"
            onClick={() => useStore.setState((s) => ({ showSongChain: !s.showSongChain }))}
            aria-label={showSongChain ? 'Collapse song chain' : 'Expand song chain'}
          >
            {showSongChain ? '▾' : '▸'}
          </button>
        </div>
        {showSongChain && (
          <>
            <div className="chain-loop-controls">
              <label>
                Loop Start
                <select
                  value={project.songLoopStart ?? ''}
                  onFocus={() => pushSequencerHistory(project, activeSequenceId)}
                  onChange={(e) => void setSongLoopStart(e.target.value === '' ? null : Number(e.target.value), true)}
                >
                  <option value="">None</option>
                  {project.songChain.map((entry, i) => <option key={`ls-${entry.id}`} value={i}>{i + 1}</option>)}
                </select>
              </label>
              <label>
                Loop End
                <select
                  value={project.songLoopEnd ?? ''}
                  onFocus={() => pushSequencerHistory(project, activeSequenceId)}
                  onChange={(e) => void setSongLoopEnd(e.target.value === '' ? null : Number(e.target.value), true)}
                >
                  <option value="">None</option>
                  {project.songChain.map((entry, i) => <option key={`le-${entry.id}`} value={i}>{i + 1}</option>)}
                </select>
              </label>
            </div>
            <div className="chain-actions">
              <button type="button" onClick={copySelectedChainEntry} disabled={!selectedChainEntryId}>Copy Block</button>
              <button type="button" onClick={() => void pasteChainEntry()} disabled={!copiedChainPatternId}>Paste Block</button>
              <button type="button" onClick={() => selectedChainEntryId && void removeChainEntry(selectedChainEntryId)} disabled={!selectedChainEntryId}>Delete Block</button>
              <button type="button" onClick={() => void undoSequencer()} disabled={historyPast.length === 0}>Undo</button>
              <button type="button" onClick={() => void redoSequencer()} disabled={historyFuture.length === 0}>Redo</button>
            </div>
            <div className="chain-help">Insert slots: drop a pattern on any + between blocks.</div>
            <div className="chain-row">
              {chainWithPatterns.length === 0 && <span className="chain-empty">Drag patterns here</span>}
              <button
                type="button"
                className="chain-insert-slot"
                data-chain-index={0}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (draggedPatternIdRef.current) {
                    void addChainEntryAt(draggedPatternIdRef.current, 0)
                    draggedPatternIdRef.current = null
                  }
                }}
              >+</button>
              {chainWithPatterns.map(({ entry, pattern }) => {
                const entryIndex = project.songChain.findIndex((item) => item.id === entry.id)
                const isPlayingEntry = playingChainIndex === entryIndex
                const inLoop =
                  project.songLoopStart !== null &&
                  project.songLoopEnd !== null &&
                  entryIndex >= project.songLoopStart &&
                  entryIndex <= project.songLoopEnd
                return (
                  <div key={`cw-${entry.id}`} className="chain-entry-wrap">
                    <div
                      className={`chain-cell ${selectedChainEntryId === entry.id ? 'selected' : ''} ${isPlayingEntry ? 'playing' : ''} ${inLoop ? 'in-loop' : ''}`}
                      style={{ borderColor: pattern.color, background: `${pattern.color}22` }}
                      data-chain-entry-id={entry.id}
                      data-chain-index={entryIndex}
                      draggable
                      onDragStart={() => { draggedChainEntryIdRef.current = entry.id; draggedPatternIdRef.current = null }}
                      onClick={() => useStore.setState({ selectedChainEntryId: entry.id })}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (draggedChainEntryIdRef.current) {
                          void moveChainEntry(draggedChainEntryIdRef.current, entry.id)
                          draggedChainEntryIdRef.current = null
                          return
                        }
                        if (draggedPatternIdRef.current) {
                          void addChainEntryAt(draggedPatternIdRef.current, entryIndex)
                          draggedPatternIdRef.current = null
                        }
                      }}
                      {...makeTouchDragHandlers({ 'x-chain-entry-id': entry.id }, pattern.name)}
                    >
                      <button type="button" className="chain-name" onClick={() => useStore.setState({ activeSequenceId: pattern.id })}>{pattern.name}</button>
                      <label className="chain-repeat">
                        x
                        <input
                          type="number"
                          min={1}
                          max={32}
                          value={entry.repeats}
                          onFocus={() => pushSequencerHistory(project, activeSequenceId)}
                          onChange={(e) => void updateChainRepeats(entry.id, Number(e.target.value))}
                        />
                      </label>
                      {isPlayingEntry && <span className="chain-progress">{`r${playingChainRepeat}/${entry.repeats}`}</span>}
                      <button type="button" className="chain-remove" onClick={() => void removeChainEntry(entry.id)}>x</button>
                    </div>
                    <button
                      type="button"
                      className="chain-insert-slot"
                      data-chain-index={entryIndex + 1}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (draggedPatternIdRef.current) {
                          void addChainEntryAt(draggedPatternIdRef.current, entryIndex + 1)
                          draggedPatternIdRef.current = null
                        }
                      }}
                    >+</button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      <div className={`sequencer-matrix-wrap ${fitSteps ? 'fit-sixteen' : ''}`}>
        <div
          className={`sequencer-matrix-head ${fitSteps ? 'fit-sixteen' : ''}`}
          style={{ gridTemplateColumns: sequenceGridColumns }}
        >
          <span className="lane-head">Pad</span>
          <span className="lane-head">M</span>
          <span className="lane-head">C</span>
          <span className="lane-head">D</span>
          {Array.from({ length: visibleSequence.lengthSteps }, (_, step) => (
            <span
              key={step}
              className={`step-head ${playheadStep === step ? 'playhead' : ''} ${
                Math.floor(step / 4) % 2 === 0 ? 'group-even' : 'group-odd'
              } ${step > 0 && step % 16 === 0 ? 'bar-divider' : ''}`}
            >
              {step + 1}
            </span>
          ))}
        </div>

        {bankGroups.map((group) => (
          <div key={group.bank} className="seq-bank-group">
            <button
              type="button"
              className={`seq-bank-header ${group.collapsed ? 'collapsed' : ''} ${group.hasEvents ? 'has-events' : ''}`}
              onClick={() => toggleSeqBankCollapsed(group.bank)}
            >
              <span className="seq-bank-chevron">{group.collapsed ? '\u25B8' : '\u25BE'}</span>
              <span className="seq-bank-name">{group.name}</span>
              {group.collapsed && group.pads.length > 0 && (
                <span className="seq-bank-count">{group.pads.length}</span>
              )}
            </button>
            {!group.collapsed && group.pads.map((pad) => {
              const selectedLane = selectedPadId === pad.id
              const padExactMap = eventsByPadAndStep.get(pad.id)
              const padSpanMap = spanningByPadAndStep.get(pad.id)
              const isSynth = pad.settings.source === 'synth'
              const isPianoRollExpanded = isSynth && expandedPianoRollPads.has(pad.id)
              return (
                <div key={pad.id} className={isPianoRollExpanded ? 'sequencer-lane-group' : undefined}>
                  <div
                    className={`sequencer-row ${selectedLane ? 'selected-lane' : ''} ${fitSteps ? 'fit-sixteen' : ''}`}
                    style={{ gridTemplateColumns: sequenceGridColumns }}
                  >
                    <button
                      type="button"
                      className="lane-label"
                      onClick={() => {
                        useStore.setState({ selectedPadId: pad.id })
                        void triggerPad(pad, 0.9)
                      }}
                    >
                      {isSynth && <span className="lane-synth-badge">~</span>}
                      {pad.slot + 1} - {pad.name}
                    </button>
                    <button
                      type="button"
                      className={`lane-action ${mutedLanePadIds.has(pad.id) ? 'active' : ''}`}
                      onClick={() => toggleLaneMute(pad.id)}
                    >M</button>
                    <button type="button" className="lane-action" onClick={() => void clearLane(pad.id)}>C</button>
                    {isSynth ? (
                      <button
                        type="button"
                        className={`lane-action ${isPianoRollExpanded ? 'active' : ''}`}
                        onClick={() => togglePianoRollExpanded(pad.id)}
                        title={isPianoRollExpanded ? 'Collapse piano roll' : 'Expand piano roll'}
                      >&#x266B;</button>
                    ) : (
                      <button type="button" className="lane-action" onClick={() => void clearLane(pad.id)} title="Delete lane events">D</button>
                    )}
                    {Array.from({ length: visibleSequence.lengthSteps }, (_, step) => {
                      const exactEvent = padExactMap?.get(step)
                      const spanningEvent = padSpanMap?.get(step)
                      return (
                        <SequencerStep
                          key={`${pad.id}-${step}`}
                          padId={pad.id}
                          step={step}
                          exactEvent={exactEvent}
                          spanningEvent={spanningEvent}
                          isPlayhead={playheadStep === step}
                          isGateMode={pad.settings.mode === 'adsr'}
                          fitSixteen={fitSteps}
                          showGateResizeTip={showGateResizeTip}
                          patternId={visibleSequence.id}
                        />
                      )
                    })}
                  </div>
                  {isPianoRollExpanded && (
                    <PianoRollLane
                      padId={pad.id}
                      baseNote={pad.settings.synthParams?.baseNote ?? 60}
                      octaveOffset={pianoRollOctaveOffset[pad.id] ?? 0}
                      lengthSteps={visibleSequence.lengthSteps}
                      events={eventsByPad.get(pad.id) ?? []}
                      playheadStep={playheadStep}
                      stepGridColumns={stepGridColumns}
                      fitSixteen={fitSteps}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {bankGroups.every((g) => g.collapsed || g.pads.length === 0) && <p className="sequencer-status">No visible lanes. Expand a bank or disable "Hide Empty Lanes".</p>}
      </div>
      {showGateResizeTip && <p className="gate-tip">Tip: drag note edges to resize gate note length.</p>}
    </section>
  )
}
