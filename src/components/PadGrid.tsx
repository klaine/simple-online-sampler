import { useCallback, useRef, useState, useEffect, useSyncExternalStore, useMemo } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { releaseMidiNote } from '../lib/midiOut'
import { parseMpcPgm, matchMpcSamplesToFiles } from '../lib/mpcImport'
import { parseLcdk, matchLcdkSamplesToFiles } from '../lib/lcdkImport'
import { db } from '../lib/db'
import { BANK_COUNT } from '../lib/constants'
import type { SampleAsset, SampleLayer } from '../types'
import { midiToName, uid } from '../lib/utils'
import {
  useStore,
  transportVisualStore,
  selectDisplayedPads,
  selectVisibleSequence,
} from '../store'

// Guard: suppress mouse events that follow a recent touch (prevents double-trigger)
let _lastTouchTime = 0

const velocityFromMouseEvent = (event: React.MouseEvent<HTMLElement>): number => {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  return Math.max(0.2, ratio)
}

const velocityFromTouchEvent = (event: React.TouchEvent<HTMLElement>): number => {
  const touch = event.touches[0]
  if (!touch) return 0.9
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = 1 - Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height))
  return Math.max(0.2, ratio)
}

export function PadGrid() {
  const sampleMap = useStore((s) => s.sampleMap)
  const selectedPadId = useStore((s) => s.selectedPadId)
  const sequencedPadHits = useSyncExternalStore(transportVisualStore.subscribe, transportVisualStore.getSequencedPadHits)
  const playheadStep = useSyncExternalStore(transportVisualStore.subscribe, transportVisualStore.getPlayheadStep)
  const activeBank = useStore((s) => s.activeBank)
  const midiStatus = useStore((s) => s.midiStatus)
  const lastMidiNote = useStore((s) => s.lastMidiNote)
  const padDragPrompt = useStore((s) => s.padDragPrompt)
  const project = useStore((s) => s.project)
  const displayedPads = useStore(selectDisplayedPads)
  const padHoldRecordEnabled = useStore((s) => s.padHoldRecordEnabled)
  const padHoldRecordingPadId = useStore((s) => s.padHoldRecordingPadId)

  const {
    triggerPad,
    assignSampleToPad,
    assignFileToPad,
    openRecordDialog,
    showPadDragPrompt,
    executePadMove,
    executePadCopy,
    executePadSwap,
    cancelPadDragPrompt,
    togglePadHoldRecord,
    startPadHoldRecord,
    stopPadHoldRecord,
    addToast,
    toggleStep,
  } = useStore.getState()

  const visibleSequence = useStore(selectVisibleSequence)

  // Steps for the selected pad in the active pattern
  const inlineSteps = useMemo(() => {
    if (!visibleSequence || !selectedPadId) return null
    const stepMap = new Map<number, { velocity: number }>()
    for (const ev of visibleSequence.events) {
      if (ev.padId === selectedPadId) {
        stepMap.set(ev.step, { velocity: ev.velocity })
      }
    }
    return { lengthSteps: visibleSequence.lengthSteps, stepMap }
  }, [visibleSequence, selectedPadId])

  // Touch drag-and-drop from library (iPad / mobile)
  const gridRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, string>
      const padEl = (e.target as HTMLElement).closest('.pad[data-pad-id]') as HTMLElement | null
      if (!padEl) return
      const padId = padEl.getAttribute('data-pad-id')
      if (!padId) return

      const sampleId = detail['application/x-online-sampler-sample-id']
      if (sampleId) {
        const draggedSample = useStore.getState().samples.find((s) => s.id === sampleId)
        if (draggedSample) {
          useStore.setState({ selectedPadId: padId })
          void useStore.getState().assignSampleToPad(draggedSample, padId)
        }
        return
      }

      const groupData = detail['application/x-online-sampler-group']
      if (groupData) {
        // Group drop handled elsewhere
        return
      }
    }
    el.addEventListener('touch-drop', handler)
    return () => el.removeEventListener('touch-drop', handler)
  }, [])

  // Bank tab drag-switch: hovering over a bank button while dragging a pad switches banks after 300ms
  const bankSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [editingBank, setEditingBank] = useState<number | null>(null)
  const [bankDraft, setBankDraft] = useState('')
  const bankNames = useStore((s) => s.project?.bankNames)

  // Derive which banks have active sequencer hits (for cross-bank flash on bank buttons)
  const hitBanks = useMemo(() => {
    if (!project || sequencedPadHits.size === 0) return new Set<number>()
    const banks = new Set<number>()
    for (const padId of sequencedPadHits) {
      const pad = project.pads.find((p) => p.id === padId)
      if (pad !== undefined) banks.add(pad.bank)
    }
    return banks
  }, [project, sequencedPadHits])

  const clearBankSwitchTimer = useCallback(() => {
    if (bankSwitchTimer.current) {
      clearTimeout(bankSwitchTimer.current)
      bankSwitchTimer.current = null
    }
  }, [])

  // Pad drag prompt modal
  const promptSource = padDragPrompt ? project?.pads.find((p) => p.id === padDragPrompt.sourcePadId) : null
  const promptTarget = padDragPrompt ? project?.pads.find((p) => p.id === padDragPrompt.targetPadId) : null

  return (
    <div className="pad-panel" ref={gridRef}>
      <div className="bank-nav-row">
        <div className="bank-nav">
          {Array.from({ length: BANK_COUNT }, (_, i) => (
          editingBank === i ? (
            <input
              key={i}
              className="bank-name-input"
              value={bankDraft}
              autoFocus
              onChange={(e) => setBankDraft(e.target.value)}
              onBlur={() => {
                const trimmed = bankDraft.trim()
                if (trimmed && trimmed !== `Bank ${i + 1}`) {
                  useStore.getState().setBankName(i, trimmed)
                }
                setEditingBank(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingBank(null)
              }}
            />
          ) : (
          <button
            key={i}
            type="button"
            className={`${i === activeBank ? 'active' : ''} ${hitBanks.has(i) && i !== activeBank ? 'bank-hit' : ''}`}
            onClick={() => useStore.setState({ activeBank: i })}
            onDoubleClick={() => {
              const name = bankNames?.[i] ?? `Bank ${i + 1}`
              setBankDraft(name)
              setEditingBank(i)
            }}
            onDragOver={(e) => {
              // Allow pad drags to hover over bank tabs
              if (e.dataTransfer.types.includes('application/x-online-sampler-pad-id')) {
                e.preventDefault()
                if (!bankSwitchTimer.current && i !== activeBank) {
                  bankSwitchTimer.current = setTimeout(() => {
                    useStore.setState({ activeBank: i })
                    bankSwitchTimer.current = null
                  }, 300)
                }
              }
              // Allow group drops on bank tabs
              if (e.dataTransfer.types.includes('application/x-online-sampler-group-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }
            }}
            onDragLeave={clearBankSwitchTimer}
            onDrop={(e) => {
              clearBankSwitchTimer()
              const groupId = e.dataTransfer.getData('application/x-online-sampler-group-id')
              if (groupId) {
                e.preventDefault()
                e.stopPropagation()
                void useStore.getState().assignGroupToPads(groupId, i)
              }
            }}
          >
            {bankNames?.[i] ?? `Bank ${i + 1}`}
          </button>
          )
        ))}
        </div>
        <button
          type="button"
          className="bank-reset-btn"
          onClick={() => void useStore.getState().resetBank(activeBank)}
          title={`Reset all pads in Bank ${activeBank + 1}`}
        >
          Reset Bank
        </button>
        <button
          type="button"
          className={`hold-rec-toggle ${padHoldRecordEnabled ? 'armed' : ''}`}
          onClick={togglePadHoldRecord}
          title="Hold empty pad to record from mic"
        >
          ● REC PAD
        </button>
      </div>
      {/* Inline TR-style step sequencer for selected pad */}
      {inlineSteps && selectedPadId && (
        <div className="inline-step-row">
          <div className="inline-step-grid" style={{ gridTemplateColumns: `repeat(${inlineSteps.lengthSteps}, 1fr)` }}>
            {Array.from({ length: inlineSteps.lengthSteps }, (_, i) => {
              const hit = inlineSteps.stepMap.get(i)
              const isPlayhead = playheadStep === i
              return (
                <button
                  key={i}
                  type="button"
                  className={`inline-step${hit ? ' on' : ''}${isPlayhead ? ' playhead' : ''}${i % 4 === 0 ? ' beat' : ''}${Math.floor(i / 4) % 2 === 1 ? ' group-odd' : ''}`}
                  onClick={() => void toggleStep(i, selectedPadId)}
                >
                  {hit && <span className="inline-step-fill" style={{ opacity: hit.velocity / 127 }} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="grid">
        {displayedPads.map((pad) => {
          const sample = pad.settings.sampleId ? sampleMap.get(pad.settings.sampleId) : undefined
          const selected = pad.id === selectedPadId
          const isSequencedHit = sequencedPadHits.has(pad.id)
          return (
            <div
              key={pad.id}
              role="button"
              tabIndex={0}
              data-pad-id={pad.id}
              className={`pad ${selected ? 'selected' : ''} ${isSequencedHit ? 'sequenced-hit' : ''} ${pad.id === padHoldRecordingPadId ? 'hold-recording' : ''} ${pad.settings.mute ? 'muted-pad' : ''}`}
              draggable={!!pad.settings.sampleId || pad.settings.source === 'synth'}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copyMove'
                e.dataTransfer.setData('application/x-online-sampler-pad-id', pad.id)
              }}
              onMouseDown={(e) => {
                if (Date.now() - _lastTouchTime < 500) return
                useStore.setState({ selectedPadId: pad.id })
                if (padHoldRecordEnabled && !pad.settings.sampleId) {
                  startPadHoldRecord(pad.id)
                } else {
                  triggerPad(pad, velocityFromMouseEvent(e))
                }
              }}
              onMouseUp={() => {
                if (Date.now() - _lastTouchTime < 500) return
                if (padHoldRecordingPadId === pad.id) {
                  stopPadHoldRecord()
                } else {
                  audioEngine.releasePad(pad.id)
                  releaseMidiNote(pad.id)
                }
              }}
              onMouseLeave={() => {
                if (Date.now() - _lastTouchTime < 500) return
                if (padHoldRecordingPadId === pad.id) {
                  stopPadHoldRecord()
                } else {
                  audioEngine.releasePad(pad.id)
                  releaseMidiNote(pad.id)
                }
              }}
              onTouchStart={(e) => {
                e.preventDefault()
                _lastTouchTime = Date.now()
                useStore.setState({ selectedPadId: pad.id })
                if (padHoldRecordEnabled && !pad.settings.sampleId) {
                  startPadHoldRecord(pad.id)
                } else {
                  triggerPad(pad, velocityFromTouchEvent(e))
                }
              }}
              onTouchEnd={(e) => {
                e.preventDefault()
                if (padHoldRecordingPadId === pad.id) {
                  stopPadHoldRecord()
                } else {
                  audioEngine.releasePad(pad.id)
                  releaseMidiNote(pad.id)
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault()
                clearBankSwitchTimer()

                // Check for pad drag
                const sourcePadId = e.dataTransfer.getData('application/x-online-sampler-pad-id')
                if (sourcePadId && sourcePadId !== pad.id) {
                  showPadDragPrompt(sourcePadId, pad.id)
                  return
                }

                // Check for sample drag
                const sampleId =
                  e.dataTransfer.getData('application/x-online-sampler-sample-id') ||
                  e.dataTransfer.getData('text/plain')
                if (sampleId) {
                  const draggedSample = sampleMap.get(sampleId)
                  if (draggedSample) {
                    useStore.setState({ selectedPadId: pad.id })
                    void assignSampleToPad(draggedSample, pad.id)
                    return
                  }
                }

                // Check for velocity subgroup drag (assign all layers to single pad)
                const veloSubgroupData = e.dataTransfer.getData('application/x-online-sampler-velo-subgroup')
                if (veloSubgroupData) {
                  try {
                    const veloSampleIds = JSON.parse(veloSubgroupData) as string[]
                    const veloSamples = veloSampleIds
                      .map((id) => sampleMap.get(id))
                      .filter((s): s is SampleAsset => s != null)
                    if (veloSamples.length === 0) return

                    // Sort by _vNN velocity value ascending
                    const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/
                    veloSamples.sort((a, b) => {
                      const ma = veloRegex.exec(a.name)
                      const mb = veloRegex.exec(b.name)
                      return (ma ? Number(ma[2]) : 0) - (mb ? Number(mb[2]) : 0)
                    })

                    // Compute velocity splits
                    const count = veloSamples.length
                    const splits: Array<{ velocityLow: number; velocityHigh: number }> = []
                    for (let i = 0; i < count; i++) {
                      const low = i === 0 ? 1 : splits[i - 1].velocityHigh + 1
                      const high = i === count - 1 ? 127 : Math.round(((i + 1) / count) * 127)
                      splits.push({ velocityLow: low, velocityHigh: high })
                    }

                    const layers: SampleLayer[] = veloSamples.map((sample, i) => ({
                      id: uid(),
                      sampleId: sample.id,
                      velocityLow: splits[i].velocityLow,
                      velocityHigh: splits[i].velocityHigh,
                      gain: null, semitones: null, fineCents: null,
                      trim: sample.autosampleTrim ?? null,
                      envelope: null, filterType: null, filterFreq: null, filterQ: null,
                      stackOffsetMs: null,
                    }))

                    const baseName = veloSamples[0].name.replace(veloRegex, '$1$3').replace(/\.[^.]+$/, '')
                    const s = useStore.getState()
                    if (!s.project) return

                    const updatedPads = s.project.pads.map((p) => {
                      if (p.id !== pad.id) return p
                      return {
                        ...p,
                        name: baseName,
                        settings: {
                          ...p.settings,
                          sampleId: veloSamples[0].id,
                          source: 'sample' as const,
                          layers,
                          multiMode: 'velocity' as const,
                          trim: { start: 0, end: 1 },
                          bus: veloSamples[0].autosampleBus ?? p.settings.bus,
                          chokeGroup: veloSamples[0].autosampleChokeGroup ?? 0,
                        },
                      }
                    })

                    const updated = { ...s.project, pads: updatedPads }
                    useStore.setState({ selectedPadId: pad.id })
                    void useStore.getState().saveProjectLight(updated)
                    return
                  } catch { /* ignore parse error */ }
                }

                // Check for autosample group drag
                const groupId = e.dataTransfer.getData('application/x-online-sampler-group-id')
                if (groupId) {
                  const groupSamples = Array.from(sampleMap.values()).filter((s) => s.autosampleRunId === groupId)
                  if (groupSamples.length > 0) {
                    // Sort by autosamplePadIndex when present, otherwise by name
                    const hasKitMap = groupSamples.some((s) => s.autosamplePadIndex != null)
                    if (hasKitMap) {
                      groupSamples.sort((a, b) => (a.autosamplePadIndex ?? 999) - (b.autosamplePadIndex ?? 999))
                    } else {
                      groupSamples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                    }

                    // Detect velocity layers: group by base name (strip _vNN suffix)
                    const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/
                    const noteGroups: { baseName: string; padIndex: number | null; samples: { sample: SampleAsset; velocity: number }[] }[] = []
                    const noteGroupMap = new Map<string, typeof noteGroups[0]>()
                    for (const sample of groupSamples) {
                      const m = veloRegex.exec(sample.name)
                      if (m) {
                        const baseKey = m[1] + m[3]
                        let group = noteGroupMap.get(baseKey)
                        if (!group) {
                          group = { baseName: m[1] + m[3], padIndex: sample.autosamplePadIndex ?? null, samples: [] }
                          noteGroupMap.set(baseKey, group)
                          noteGroups.push(group)
                        }
                        group.samples.push({ sample, velocity: Number(m[2]) })
                      } else {
                        noteGroups.push({ baseName: sample.name, padIndex: sample.autosamplePadIndex ?? null, samples: [{ sample, velocity: 127 }] })
                      }
                    }
                    for (const group of noteGroups) group.samples.sort((a, b) => a.velocity - b.velocity)

                    const s = useStore.getState()
                    if (!s.project) return
                    const padsSorted = [...s.project.pads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
                    const startIdx = padsSorted.findIndex((p) => p.id === pad.id)
                    if (startIdx === -1) return

                    // Build assignment map: padId → note group
                    // Respect autosamplePadIndex offsets relative to drop target
                    const assignMap = new Map<string, typeof noteGroups[0]>()
                    if (hasKitMap) {
                      const minPadIdx = Math.min(...noteGroups.map((g) => g.padIndex ?? 0))
                      for (const group of noteGroups) {
                        const offset = (group.padIndex ?? 0) - minPadIdx
                        const targetPad = padsSorted[startIdx + offset]
                        if (targetPad) assignMap.set(targetPad.id, group)
                      }
                    } else {
                      for (let i = 0; i < noteGroups.length; i++) {
                        const targetPad = padsSorted[startIdx + i]
                        if (!targetPad) break
                        assignMap.set(targetPad.id, noteGroups[i])
                      }
                    }
                    if (assignMap.size === 0) return

                    // Compute velocity splits
                    const computeVelocitySplits = (count: number): Array<{ velocityLow: number; velocityHigh: number }> => {
                      if (count <= 1) return [{ velocityLow: 1, velocityHigh: 127 }]
                      const splits: Array<{ velocityLow: number; velocityHigh: number }> = []
                      for (let i = 0; i < count; i++) {
                        const low = i === 0 ? 1 : splits[i - 1].velocityHigh + 1
                        const high = i === count - 1 ? 127 : Math.round(((i + 1) / count) * 127)
                        splits.push({ velocityLow: low, velocityHigh: high })
                      }
                      return splits
                    }

                    const updatedPads = s.project.pads.map((p) => {
                      const noteGroup = assignMap.get(p.id)
                      if (!noteGroup) return p
                      const primarySample = noteGroup.samples[0].sample
                      const hasVeloLayers = noteGroup.samples.length > 1

                      if (hasVeloLayers) {
                        const splits = computeVelocitySplits(noteGroup.samples.length)
                        const layers: SampleLayer[] = noteGroup.samples.map((entry, i) => ({
                          id: uid(),
                          sampleId: entry.sample.id,
                          velocityLow: splits[i].velocityLow,
                          velocityHigh: splits[i].velocityHigh,
                          gain: null, semitones: null, fineCents: null, trim: entry.sample.autosampleTrim ?? null,
                          envelope: null, filterType: null, filterFreq: null, filterQ: null,
                          stackOffsetMs: null,
                        }))
                        return {
                          ...p,
                          name: noteGroup.baseName.replace(/\.[^.]+$/, ''),
                          settings: {
                            ...p.settings,
                            sampleId: primarySample.id,
                            source: 'sample' as const,
                            layers,
                            multiMode: 'velocity' as const,
                            trim: { start: 0, end: 1 },  // per-layer trim overrides via SampleLayer.trim
                            bus: primarySample.autosampleBus ?? p.settings.bus,
                            chokeGroup: primarySample.autosampleChokeGroup ?? 0,
                          },
                        }
                      } else {
                        return {
                          ...p,
                          name: primarySample.name,
                          settings: {
                            ...p.settings,
                            sampleId: primarySample.id,
                            source: 'sample' as const,
                            layers: [],
                            multiMode: 'single' as const,
                            trim: primarySample.autosampleTrim ?? { start: 0, end: 1 },
                            bus: primarySample.autosampleBus ?? p.settings.bus,
                            chokeGroup: primarySample.autosampleChokeGroup ?? 0,
                          },
                        }
                      }
                    })
                    void s.saveProject({ ...s.project, pads: updatedPads })

                    // Record autosamplePadIndex on samples
                    useStore.setState((d) => {
                      let i = 0
                      for (const [, noteGroup] of assignMap) {
                        for (const entry of noteGroup.samples) {
                          const sam = d.samples.find((x) => x.id === entry.sample.id)
                          if (sam) sam.autosamplePadIndex = i
                        }
                        i++
                      }
                    })
                    const updated = useStore.getState().samples.filter((x) => x.autosampleRunId === groupId)
                    for (const sample of updated) void db.putSample(sample)
                    addToast(`Assigned ${noteGroups.length} note${noteGroups.length !== 1 ? 's' : ''} to pads`, 'success')
                    return
                  }
                }

                // Check for synth patch drag from library
                const synthPatchJson = e.dataTransfer.getData('application/x-online-sampler-synth-patch')
                if (synthPatchJson) {
                  try {
                    const patch = JSON.parse(synthPatchJson) as import('../types').SynthPatch
                    useStore.setState({ selectedPadId: pad.id })
                    useStore.getState().applySynthPatchToPad(patch, pad.id)
                    addToast(`Applied patch "${patch.name}" to pad`, 'success')
                  } catch { /* ignore parse error */ }
                  return
                }

                // Check for file drag — detect MPC .pgm among dropped files
                const allDroppedFiles = Array.from(e.dataTransfer.files)
                const pgmFile = allDroppedFiles.find((f) => /\.pgm$/i.test(f.name))
                if (pgmFile) {
                  // MPC program import: parse .pgm, match WAV files, assign to pads sequentially
                  const pgmResult = parseMpcPgm(await pgmFile.arrayBuffer(), pgmFile.name)
                  if (pgmResult && pgmResult.pads.length > 0) {
                    const audioFiles = allDroppedFiles.filter((f) => f !== pgmFile && (f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i.test(f.name)))
                    const matched = matchMpcSamplesToFiles(pgmResult.pads, audioFiles)
                    if (matched.length > 0) {
                      const allPads = useStore.getState().project?.pads
                      if (!allPads) return
                      const padsSorted = [...allPads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
                      const startIdx = padsSorted.findIndex((p) => p.id === pad.id)
                      if (startIdx === -1) return
                      const assignedSampleIds: string[] = []
                      for (let i = 0; i < matched.length; i++) {
                        const targetPad = padsSorted[startIdx + i]
                        if (!targetPad) break
                        await assignFileToPad(targetPad, matched[i].file)
                        const updatedPad = useStore.getState().project?.pads.find((p) => p.id === targetPad.id)
                        if (updatedPad?.settings.sampleId) {
                          assignedSampleIds.push(updatedPad.settings.sampleId)
                          // Apply MPC pad settings from mapping
                          const mpc = matched[i].mapping
                          const { project, saveProject } = useStore.getState()
                          if (project && (mpc.chokeGroup || mpc.pan != null || mpc.level != null || mpc.filterType || mpc.attack != null || mpc.decay != null || mpc.semitones != null || mpc.fineCents != null || mpc.playMode)) {
                            await saveProject({
                              ...project,
                              pads: project.pads.map((p) => {
                                if (p.id !== targetPad.id) return p
                                return {
                                  ...p,
                                  settings: {
                                    ...p.settings,
                                    ...(mpc.chokeGroup ? { chokeGroup: mpc.chokeGroup } : {}),
                                    ...(mpc.pan != null ? { pan: mpc.pan } : {}),
                                    ...(mpc.level != null ? { gain: mpc.level } : {}),
                                    ...(mpc.semitones != null ? { semitones: mpc.semitones } : {}),
                                    ...(mpc.fineCents != null ? { fineCents: mpc.fineCents } : {}),
                                    ...(mpc.filterType ? { filterType: mpc.filterType } : {}),
                                    ...(mpc.filterFreq != null ? { filterFreq: mpc.filterFreq } : {}),
                                    ...(mpc.filterQ != null ? { filterQ: mpc.filterQ } : {}),
                                    ...(mpc.playMode ? { mode: mpc.playMode } : {}),
                                    ...(mpc.attack != null || mpc.decay != null ? {
                                      envelope: {
                                        ...p.settings.envelope,
                                        ...(mpc.attack != null ? { attack: mpc.attack } : {}),
                                        ...(mpc.decay != null ? { decay: mpc.decay } : {}),
                                      },
                                    } : {}),
                                  },
                                }
                              }),
                            })
                          }
                        }
                      }
                      if (assignedSampleIds.length >= 2) {
                        const { groupSamples: grp } = useStore.getState()
                        grp(assignedSampleIds, pgmResult.label)
                      }
                      const clamped = Math.min(matched.length, padsSorted.length - startIdx)
                      addToast(`Imported MPC kit "${pgmResult.label}" (${clamped} pads)`, 'success')
                      return
                    }
                  }
                }

                // Check for Loopcloud Drum .lcdk file
                const lcdkFile = allDroppedFiles.find((f) => /\.lcdk$/i.test(f.name))
                if (lcdkFile) {
                  try {
                    const jsonStr = await lcdkFile.text()
                    const lcdkResult = parseLcdk(jsonStr, lcdkFile.name)
                    if (lcdkResult && lcdkResult.pads.length > 0) {
                      const audioFiles = allDroppedFiles.filter((f) => f !== lcdkFile && (f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i.test(f.name)))
                      const matched = matchLcdkSamplesToFiles(lcdkResult.pads, audioFiles)
                      if (matched.length > 0) {
                        const allPads = useStore.getState().project?.pads
                        if (!allPads) return
                        const padsSorted = [...allPads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
                        const startIdx = padsSorted.findIndex((p) => p.id === pad.id)
                        if (startIdx === -1) return
                        const assignedSampleIds: string[] = []
                        for (let i = 0; i < matched.length; i++) {
                          const targetPad = padsSorted[startIdx + i]
                          if (!targetPad) break
                          await assignFileToPad(targetPad, matched[i].file)
                          const updatedPad = useStore.getState().project?.pads.find((p) => p.id === targetPad.id)
                          if (updatedPad?.settings.sampleId) {
                            assignedSampleIds.push(updatedPad.settings.sampleId)
                            // Apply LCDK pad settings
                            const lcdk = matched[i].mapping.settings
                            const { project, saveProject } = useStore.getState()
                            if (project && Object.keys(lcdk).length > 0) {
                              await saveProject({
                                ...project,
                                pads: project.pads.map((p) => {
                                  if (p.id !== targetPad.id) return p
                                  return {
                                    ...p,
                                    settings: {
                                      ...p.settings,
                                      ...(lcdk.chokeGroup ? { chokeGroup: lcdk.chokeGroup } : {}),
                                      ...(lcdk.pan != null ? { pan: lcdk.pan } : {}),
                                      ...(lcdk.level != null ? { gain: lcdk.level } : {}),
                                      ...(lcdk.semitones != null ? { semitones: lcdk.semitones } : {}),
                                      ...(lcdk.fineCents != null ? { fineCents: lcdk.fineCents } : {}),
                                      ...(lcdk.filterType ? { filterType: lcdk.filterType } : {}),
                                      ...(lcdk.filterFreq != null ? { filterFreq: lcdk.filterFreq } : {}),
                                      ...(lcdk.filterQ != null ? { filterQ: lcdk.filterQ } : {}),
                                      ...(lcdk.playMode ? { mode: lcdk.playMode } : {}),
                                      ...(lcdk.attack != null ? { envelope: { ...p.settings.envelope, attack: lcdk.attack } } : {}),
                                    },
                                  }
                                }),
                              })
                            }
                          }
                        }
                        if (assignedSampleIds.length >= 2) {
                          const { groupSamples: grp } = useStore.getState()
                          grp(assignedSampleIds, lcdkResult.label)
                        }
                        const clamped = Math.min(matched.length, padsSorted.length - startIdx)
                        addToast(`Imported Loopcloud kit "${lcdkResult.label}" (${clamped} pads)`, 'success')
                        return
                      }
                    }
                  } catch (e) {
                    console.warn('Failed to parse Loopcloud kit', lcdkFile.name, e)
                  }
                }

                const files = allDroppedFiles.filter((f) => f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|opus)$/i))
                if (files.length === 0) return
                if (files.length === 1) {
                  void assignFileToPad(pad, files[0])
                  return
                }
                // Multiple files: sort alphabetically, assign to pad and sequential pads
                const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
                const allPads = useStore.getState().project?.pads
                if (!allPads) return
                const padsSorted = [...allPads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
                const startIdx = padsSorted.findIndex((p) => p.id === pad.id)
                if (startIdx === -1) return
                const assignedSampleIds: string[] = []
                for (let i = 0; i < sorted.length; i++) {
                  const targetPad = padsSorted[startIdx + i]
                  if (!targetPad) break
                  await assignFileToPad(targetPad, sorted[i])
                  // Find the sample that was just assigned
                  const updatedPad = useStore.getState().project?.pads.find((p) => p.id === targetPad.id)
                  if (updatedPad?.settings.sampleId) assignedSampleIds.push(updatedPad.settings.sampleId)
                }
                // Auto-group the assigned samples
                if (assignedSampleIds.length >= 2) {
                  const { groupSamples: grp } = useStore.getState()
                  const names = sorted.map((f) => f.name.replace(/\.[^.]+$/, ''))
                  let prefix = names[0]
                  for (const n of names) { while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1) }
                  prefix = prefix.replace(/[\s_\-0-9]+$/, '')
                  const label = prefix || `${names[0]}…${names[names.length - 1]}`
                  grp(assignedSampleIds, label)
                }
                const clamped = Math.min(sorted.length, padsSorted.length - startIdx)
                addToast(`Assigned ${clamped} sample${clamped !== 1 ? 's' : ''} to pads`, 'success')
              }}
            >
              <span>{pad.slot + 1}</span>
              <strong>{pad.name}</strong>
              <small>{midiToName(pad.midiNote)}</small>
              <em>{pad.settings.source === 'synth' ? '~ Synth' : sample ? sample.name : 'Drop sample'}</em>
              {!pad.settings.sampleId && pad.settings.source !== 'synth' && (
                <button
                  type="button"
                  className="pad-record-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    useStore.setState({ selectedPadId: pad.id })
                    openRecordDialog(pad.id)
                  }}
                  title="Record to this pad"
                >
                  ●
                </button>
              )}
              {(pad.settings.sampleId || pad.settings.source === 'synth') && (
                <button
                  type="button"
                  className={`pad-mute-btn${pad.settings.mute ? ' muted' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const s = useStore.getState()
                    if (!s.project) return
                    const updatedPads = s.project.pads.map((p) =>
                      p.id === pad.id ? { ...p, settings: { ...p.settings, mute: !p.settings.mute } } : p,
                    )
                    void s.saveProjectLight({ ...s.project, pads: updatedPads })
                  }}
                  onMouseDown={(e) => { e.stopPropagation() }}
                  onTouchStart={(e) => { e.stopPropagation() }}
                  title={pad.settings.mute ? 'Unmute pad' : 'Mute pad'}
                >
                  M
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="midi-status">
        {midiStatus}
        {lastMidiNote && (
          <span className="midi-debug"> | Note {lastMidiNote.note} ({midiToName(lastMidiNote.note)}) vel {lastMidiNote.velocity}</span>
        )}
      </div>

      {/* Pad drag Move/Copy modal */}
      {padDragPrompt && promptSource && promptTarget && (
        <div className="modal-overlay" onClick={cancelPadDragPrompt}>
          <div className="pad-drag-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Move or Copy Pad?</h3>
            <p>
              <strong>{promptSource.name}</strong> → <strong>{promptTarget.name}</strong>
              {' '}(Bank {promptTarget.bank + 1}, Pad {promptTarget.slot + 1})
            </p>
            {(promptTarget.settings.sampleId || promptTarget.settings.source === 'synth') && (
              <p className="pad-drag-warning">Target pad <strong>{promptTarget.name}</strong> has content — Move/Copy will replace it</p>
            )}
            <div className="pad-drag-buttons">
              <button type="button" onClick={() => void executePadMove(padDragPrompt.sourcePadId, padDragPrompt.targetPadId)}>Move</button>
              <button type="button" onClick={() => void executePadCopy(padDragPrompt.sourcePadId, padDragPrompt.targetPadId)}>Copy</button>
              {(promptTarget.settings.sampleId || promptTarget.settings.source === 'synth') && (
                <button type="button" onClick={() => void executePadSwap(padDragPrompt.sourcePadId, padDragPrompt.targetPadId)}>Swap</button>
              )}
              <button type="button" onClick={cancelPadDragPrompt}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
