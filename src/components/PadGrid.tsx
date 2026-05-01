import { useCallback, useRef, useSyncExternalStore } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { releaseMidiNote } from '../lib/midiOut'
import { parseMpcPgm, matchMpcSamplesToFiles } from '../lib/mpcImport'
import { db } from '../lib/db'
import { BANK_COUNT } from '../lib/constants'
import type { SampleAsset, SampleLayer } from '../types'
import { midiToName, uid } from '../lib/utils'
import {
  useStore,
  transportVisualStore,
  selectDisplayedPads,
} from '../store'

const velocityFromMouseEvent = (event: React.MouseEvent<HTMLElement>): number => {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  return Math.max(0.2, ratio)
}

export function PadGrid() {
  const samples = useStore((s) => s.samples)
  const selectedPadId = useStore((s) => s.selectedPadId)
  const sequencedPadHits = useSyncExternalStore(transportVisualStore.subscribe, transportVisualStore.getSequencedPadHits)
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
  } = useStore.getState()

  // Bank tab drag-switch: hovering over a bank button while dragging a pad switches banks after 300ms
  const bankSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    <div className="pad-panel">
      <div className="bank-nav-row">
        <div className="bank-nav">
          {Array.from({ length: BANK_COUNT }, (_, i) => (
          <button
            key={i}
            type="button"
            className={i === activeBank ? 'active' : ''}
            onClick={() => useStore.setState({ activeBank: i })}
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
            Bank {i + 1}
          </button>
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
      <div className="grid">
        {displayedPads.map((pad) => {
          const sample = samples.find((s) => s.id === pad.settings.sampleId)
          const selected = pad.id === selectedPadId
          const isSequencedHit = sequencedPadHits.has(pad.id)
          return (
            <div
              key={pad.id}
              role="button"
              tabIndex={0}
              className={`pad ${selected ? 'selected' : ''} ${isSequencedHit ? 'sequenced-hit' : ''} ${pad.id === padHoldRecordingPadId ? 'hold-recording' : ''}`}
              draggable={!!pad.settings.sampleId || pad.settings.source === 'synth'}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copyMove'
                e.dataTransfer.setData('application/x-online-sampler-pad-id', pad.id)
              }}
              onMouseDown={(e) => {
                useStore.setState({ selectedPadId: pad.id })
                if (padHoldRecordEnabled && !pad.settings.sampleId) {
                  startPadHoldRecord(pad.id)
                } else {
                  triggerPad(pad, velocityFromMouseEvent(e))
                }
              }}
              onMouseUp={() => {
                if (padHoldRecordingPadId === pad.id) {
                  stopPadHoldRecord()
                } else {
                  audioEngine.releasePad(pad.id)
                  releaseMidiNote(pad.id)
                }
              }}
              onMouseLeave={() => {
                if (padHoldRecordingPadId === pad.id) {
                  stopPadHoldRecord()
                } else {
                  audioEngine.releasePad(pad.id)
                  releaseMidiNote(pad.id)
                }
              }}
              onTouchStart={() => {
                useStore.setState({ selectedPadId: pad.id })
                if (padHoldRecordEnabled && !pad.settings.sampleId) {
                  startPadHoldRecord(pad.id)
                } else {
                  triggerPad(pad, 0.9)
                }
              }}
              onTouchEnd={() => {
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
                  const draggedSample = samples.find((s) => s.id === sampleId)
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
                      .map((id) => samples.find((s) => s.id === id))
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
                  const groupSamples = samples.filter((s) => s.autosampleRunId === groupId)
                  if (groupSamples.length > 0) {
                    groupSamples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

                    // Detect velocity layers: group by base name (strip _vNN suffix)
                    const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/
                    const noteGroups: { baseName: string; samples: { sample: SampleAsset; velocity: number }[] }[] = []
                    const noteGroupMap = new Map<string, typeof noteGroups[0]>()
                    for (const sample of groupSamples) {
                      const m = veloRegex.exec(sample.name)
                      if (m) {
                        const baseKey = m[1] + m[3]
                        let group = noteGroupMap.get(baseKey)
                        if (!group) {
                          group = { baseName: m[1] + m[3], samples: [] }
                          noteGroupMap.set(baseKey, group)
                          noteGroups.push(group)
                        }
                        group.samples.push({ sample, velocity: Number(m[2]) })
                      } else {
                        noteGroups.push({ baseName: sample.name, samples: [{ sample, velocity: 127 }] })
                      }
                    }
                    for (const group of noteGroups) group.samples.sort((a, b) => a.velocity - b.velocity)

                    const s = useStore.getState()
                    if (!s.project) return
                    const padsSorted = [...s.project.pads].sort((a, b) => a.bank !== b.bank ? a.bank - b.bank : a.slot - b.slot)
                    const startIdx = padsSorted.findIndex((p) => p.id === pad.id)
                    if (startIdx === -1) return

                    // Build assignment map: padId → note group
                    const assignMap = new Map<string, typeof noteGroups[0]>()
                    for (let i = 0; i < noteGroups.length; i++) {
                      const targetPad = padsSorted[startIdx + i]
                      if (!targetPad) break
                      assignMap.set(targetPad.id, noteGroups[i])
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
                        if (updatedPad?.settings.sampleId) assignedSampleIds.push(updatedPad.settings.sampleId)
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
