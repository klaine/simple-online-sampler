import { useState, useCallback, useMemo, useRef } from 'react'
import {
  useStore,
  selectSelectedPad,
  selectFilteredSamples,
  showConfirm,
} from '../store'
import type { BusId, SampleAsset, SynthPatch } from '../types'
import { BANK_COUNT, PADS_PER_BANK } from '../lib/constants'
import { uid } from '../lib/utils'
import { looksLikeDrumKit, mapToStandardKit } from '../lib/drumKitMap'
import { makeTouchDragHandlers } from '../lib/touchDrag'

// Module-level state survives component unmount (perf mode tab switches)
let _expandedChops = new Set<string>()
let _expandedGroups = new Set<string>()
let _expandedVeloGroups = new Set<string>()

export function SampleLibrary({ onCollapse }: { onCollapse?: () => void }) {
  const sampleQuery = useStore((s) => s.sampleQuery)
  const sampleSort = useStore((s) => s.sampleSort)
  const previewSampleId = useStore((s) => s.previewSampleId)
  const filteredSamples = useStore(selectFilteredSamples)
  const selectedPad = useStore(selectSelectedPad)
  const chromaticSpreadSampleId = useStore((s) => s.chromaticSpreadSampleId)
  const synthPatches = useStore((s) => s.synthPatches)

  const [dropActive, setDropActive] = useState(false)
  const [expandedChops, setExpandedChops] = useState<Set<string>>(() => _expandedChops)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => _expandedGroups)
  const [expandedVeloGroups, setExpandedVeloGroups] = useState<Set<string>>(() => _expandedVeloGroups)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const [editingGroupBus, setEditingGroupBus] = useState<BusId>('A')
  const [editingGroupChokeEnabled, setEditingGroupChokeEnabled] = useState(false)
  const [editingGroupChokeGroup, setEditingGroupChokeGroup] = useState(1)
  const [spreadBank, setSpreadBank] = useState(0)
  const [spreadSlot, setSpreadSlot] = useState(0)
  const [spreadCount, setSpreadCount] = useState(12)
  const [spreadChokeGroup, setSpreadChokeGroup] = useState(0)
  const [selectedSampleIds, setSelectedSampleIds] = useState<Set<string>>(new Set())

  const {
    previewSample,
    deleteSampleFromLibrary,
    assignSampleToSelectedPad,
    openRecordDialog,
    addSamplesToLibrary,
    openChopModal,
    openChromaticSpread,
    closeChromaticSpread,
    spreadSampleChromatically,
    removeUnassignedSamples,
    compactProject,
    openAutosampleDialog,
    groupSamples,
    ungroupSample,
    assignGroupToPads,
    importPatternsForGroupByRunId,
    renameAutosampleGroup,
    updateAutosampleGroupSettings,
    deleteAutosampleGroup,
    exportAutosampleGroupZip,
    deleteSynthPatch,
    applySynthPatchToPad,
    addToast,
  } = useStore.getState()

  const patchImportRef = useRef<HTMLInputElement>(null)
  const sampleImportRef = useRef<HTMLInputElement>(null)
  const folderImportRef = useRef<HTMLInputElement>(null)

  const handleExportPatch = useCallback((patch: SynthPatch) => {
    const json = JSON.stringify(patch, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${patch.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.ospatch`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleImportPatch = useCallback((files: FileList | null) => {
    if (!files) return
    Array.from(files).forEach((file) => {
      if (!file.name.endsWith('.ospatch')) {
        addToast(`Skipped "${file.name}" — not an .ospatch file`, 'error')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string) as SynthPatch
          if (!data.params || !data.padSettings || !data.name) throw new Error('Invalid patch format')
          // Save as a new patch (new id/timestamp via saveSynthPatch would duplicate — just push directly)
          const patch: SynthPatch = { ...data, id: uid(), createdAt: Date.now() }
          useStore.setState((s) => ({ synthPatches: [...s.synthPatches, patch] }))
          // persist
          try { localStorage.setItem('synthPatches', JSON.stringify(useStore.getState().synthPatches)) } catch {}
          addToast(`Imported patch "${patch.name}"`, 'success')
        } catch {
          addToast(`Failed to import "${file.name}"`, 'error')
        }
      }
      reader.readAsText(file)
    })
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Accept external files or internal pad drags (for synth patch saving)
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-online-sampler-pad-id')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset if leaving the sidebar entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(false)

    // Check for pad drag (synth pad -> save as patch)
    const padId = e.dataTransfer.getData('application/x-online-sampler-pad-id')
    if (padId) {
      const { project, saveSynthPatch: savePatch } = useStore.getState()
      if (!project) return
      const pad = project.pads.find((p) => p.id === padId)
      if (!pad || pad.settings.source !== 'synth') return
      const name = pad.name?.trim() || `Synth Patch ${project.pads.indexOf(pad) + 1}`
      savePatch(name, pad)
      return
    }

    const files = Array.from(e.dataTransfer.files)
    const items = Array.from(e.dataTransfer.items)

    // Check if any item is a directory (use webkitGetAsEntry for folder support)
    const hasDirectory = items.some((item) => {
      const entry = (item as any).webkitGetAsEntry?.() as FileSystemEntry | null
      return entry?.isDirectory
    })

    if (hasDirectory) {
      // Recursively read all files from dropped directories + top-level files
      const allFiles: File[] = []
      let folderName: string | undefined
      const readEntry = (entry: FileSystemEntry): Promise<void> => {
        if (entry.isFile) {
          return new Promise((resolve) => {
            (entry as FileSystemFileEntry).file((f) => { allFiles.push(f); resolve() }, () => resolve())
          })
        } else if (entry.isDirectory) {
          if (!folderName) folderName = entry.name
          return new Promise((resolve) => {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            const readBatch = () => {
              reader.readEntries(async (entries) => {
                if (entries.length === 0) { resolve(); return }
                for (const e of entries) await readEntry(e)
                readBatch()
              }, () => resolve())
            }
            readBatch()
          })
        }
        return Promise.resolve()
      }
      void (async () => {
        for (const item of items) {
          const entry = (item as any).webkitGetAsEntry?.() as FileSystemEntry | null
          if (entry) await readEntry(entry)
        }
        if (allFiles.length === 0) return

        // If .pgm or .lcdk files are present, let addSamplesToLibrary handle grouping
        const hasPgm = allFiles.some((f) => f.name.match(/\.pgm$/i))
        const hasLcdk = allFiles.some((f) => f.name.match(/\.lcdk$/i))
        if (hasPgm || hasLcdk) {
          void addSamplesToLibrary(allFiles, undefined, folderName)
          return
        }

        // Check if files look like a drum kit and offer standard layout mapping
        const audioFiles = allFiles.filter((f) => f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|ogg|flac|aiff?|m4a|webm)$/i))
        const filenames = audioFiles.map((f) => f.name)
        if (looksLikeDrumKit(filenames)) {
          const useKit = await showConfirm('These files look like a drum kit. Map to standard 16-pad layout?')
          if (useKit) {
            const kitResult = mapToStandardKit(filenames)
            const padIndexMap = new Map<string, number>()
            kitResult.slots.forEach((fname, idx) => {
              if (fname) padIndexMap.set(fname, idx)
            })
            void addSamplesToLibrary(audioFiles, padIndexMap, folderName)
            return
          }
        }
        void addSamplesToLibrary(allFiles, undefined, folderName)
      })()
    } else if (files.length > 0) {
      void addSamplesToLibrary(files)
    }
  }, [addSamplesToLibrary])

  const toggleChopExpand = useCallback((sampleId: string) => {
    setExpandedChops((prev) => {
      const next = new Set(prev)
      if (next.has(sampleId)) next.delete(sampleId)
      else next.add(sampleId)
      _expandedChops = next
      return next
    })
  }, [])

  const toggleGroupExpand = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      _expandedGroups = next
      return next
    })
  }, [])

  const toggleVeloGroupExpand = useCallback((key: string) => {
    setExpandedVeloGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      _expandedVeloGroups = next
      return next
    })
  }, [])

  // Group samples by autosampleRunId into collapsible batches
  type VeloSubgroup = { baseName: string; samples: SampleAsset[] }
  type LibItem = { type: 'single'; sample: SampleAsset } | { type: 'group'; key: string; label: string; samples: SampleAsset[]; veloSubgroups: VeloSubgroup[] }

  const veloRegex = /^(.+?)_v(\d+)(\.[^.]+)$/

  const buildVeloSubgroups = (samples: SampleAsset[]): VeloSubgroup[] => {
    const subgroupMap = new Map<string, VeloSubgroup>()
    const ordered: (VeloSubgroup | SampleAsset)[] = []
    const singleBucket: SampleAsset[] = []

    for (const sample of samples) {
      const m = veloRegex.exec(sample.name)
      if (m) {
        const baseKey = m[1] + m[3]
        let sg = subgroupMap.get(baseKey)
        if (!sg) {
          sg = { baseName: baseKey, samples: [] }
          subgroupMap.set(baseKey, sg)
          // Flush any accumulated singles before this subgroup
          if (singleBucket.length > 0) {
            for (const s of singleBucket) ordered.push(s)
            singleBucket.length = 0
          }
          ordered.push(sg)
        }
        sg.samples.push(sample)
      } else {
        singleBucket.push(sample)
      }
    }
    // Flush remaining singles
    for (const s of singleBucket) ordered.push(s)

    // Sort samples within each subgroup by velocity ascending
    for (const sg of subgroupMap.values()) {
      sg.samples.sort((a, b) => {
        const ma = veloRegex.exec(a.name)
        const mb = veloRegex.exec(b.name)
        return (ma ? Number(ma[2]) : 0) - (mb ? Number(mb[2]) : 0)
      })
    }

    // Only return subgroups that have ≥2 samples; demote singles back
    // Build final list preserving order
    const result: VeloSubgroup[] = []
    for (const entry of ordered) {
      if ('baseName' in entry) {
        if (entry.samples.length >= 2) {
          result.push(entry)
        }
        // Singles within a subgroup with <2 entries are not included here;
        // they stay in the flat samples list
      }
    }
    return result
  }

  const libraryItems: LibItem[] = useMemo(() => {
    // Collect run groups
    const runGroups = new Map<string, SampleAsset[]>()
    const singles: { index: number; sample: SampleAsset }[] = []
    // Track first occurrence index of each run to maintain position
    const runFirstIndex = new Map<string, number>()

    for (let i = 0; i < filteredSamples.length; i++) {
      const s = filteredSamples[i]
      if (s.autosampleRunId) {
        if (!runGroups.has(s.autosampleRunId)) {
          runGroups.set(s.autosampleRunId, [])
          runFirstIndex.set(s.autosampleRunId, i)
        }
        runGroups.get(s.autosampleRunId)!.push(s)
      } else {
        singles.push({ index: i, sample: s })
      }
    }

    // Build ordered items: insert groups at their first occurrence position
    type Positioned = { index: number; item: LibItem }
    const positioned: Positioned[] = []

    for (const { index, sample } of singles) {
      positioned.push({ index, item: { type: 'single', sample } })
    }

    for (const [runId, samples] of runGroups) {
      if (samples.length >= 2) {
        const customLabel = samples[0].autosampleRunLabel
        const fallback = `${samples[0].name.replace(/\.wav$/i, '')}…${samples[samples.length - 1].name.replace(/\.wav$/i, '')}`
        const label = customLabel ? `${customLabel} (${samples.length})` : `${fallback} (${samples.length})`
        const veloSubgroups = buildVeloSubgroups(samples)
        positioned.push({
          index: runFirstIndex.get(runId)!,
          item: { type: 'group', key: runId, label, samples, veloSubgroups },
        })
      } else {
        positioned.push({ index: runFirstIndex.get(runId)!, item: { type: 'single', sample: samples[0] } })
      }
    }

    positioned.sort((a, b) => a.index - b.index)
    return positioned.map((p) => p.item)
  }, [filteredSamples])

  const renderSampleRow = (sample: SampleAsset, inGroup = false) => {
    const hasChops = (sample.chopPoints?.length ?? 0) > 0
    const isExpanded = expandedChops.has(sample.id)
    const chopBoundaries = hasChops ? [0, ...(sample.chopPoints ?? []), 1] : []

    return (
      <div key={sample.id}>
        <div
          className="sample-row"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'copy'
            e.dataTransfer.setData('application/x-online-sampler-sample-id', sample.id)
            e.dataTransfer.setData('text/plain', sample.id)
          }}
          {...makeTouchDragHandlers(
            { 'application/x-online-sampler-sample-id': sample.id },
            sample.name,
          )}
        >
          {!inGroup && (
            <input
              type="checkbox"
              className="sample-select-cb"
              checked={selectedSampleIds.has(sample.id)}
              onChange={(e) => {
                e.stopPropagation()
                setSelectedSampleIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(sample.id)) next.delete(sample.id)
                  else next.add(sample.id)
                  return next
                })
              }}
              title="Select for grouping"
            />
          )}
          <button
            type="button"
            className={previewSampleId === sample.id ? 'sample-preview active' : 'sample-preview'}
            onClick={() => void previewSample(sample)}
          >
            <span className="sample-name">{sample.name}</span>
            <small>{`${Math.max(1, Math.round(sample.size / 1024))} KB`}</small>
          </button>
          <div className="sample-actions">
            <button
              type="button"
              className="sample-chop"
              onClick={() => openChopModal(sample.id)}
              title="Chop sample"
            >
              ✂
            </button>
            <button
              type="button"
              className="sample-spread"
              onClick={() => openChromaticSpread(sample.id)}
              title="Chromatic spread to pads"
            >
              🎹
            </button>
            {hasChops && (
              <button
                type="button"
                className="sample-chop-expand"
                onClick={() => toggleChopExpand(sample.id)}
                title={isExpanded ? 'Collapse chops' : 'Show chops'}
              >
                {isExpanded ? '▾' : '▸'} {chopBoundaries.length - 1}
              </button>
            )}
            <button
              type="button"
              className="sample-assign"
              onClick={() => void assignSampleToSelectedPad(sample)}
              disabled={!selectedPad}
              title="Assign to selected pad"
            >
              +
            </button>
            {inGroup && (
              <button
                type="button"
                className="sample-ungroup"
                onClick={() => ungroupSample(sample.id)}
                title="Remove from group"
              >
                ⊟
              </button>
            )}
            <button
              type="button"
              className="sample-delete"
              onClick={() => void deleteSampleFromLibrary(sample)}
              title="Delete sample"
            >
              ×
            </button>
          </div>
        </div>
        {hasChops && isExpanded && (
          <div className="chop-sub-list">
            {chopBoundaries.slice(0, -1).map((start, i) => {
              const end = chopBoundaries[i + 1]
              return (
                <div key={i} className="chop-sub-item">
                  <span>Chop {i + 1}</span>
                  <small>{(start * 100).toFixed(0)}%–{(end * 100).toFixed(0)}%</small>
                </div>
              )
            })}
          </div>
        )}
        {chromaticSpreadSampleId === sample.id && (
          <div className="spread-popover">
            <div className="spread-popover-head">
              <strong>Chromatic Spread</strong>
              <button type="button" onClick={closeChromaticSpread}>×</button>
            </div>
            <div className="spread-popover-controls">
              <label>
                Bank
                <select value={spreadBank} onChange={(e) => setSpreadBank(Number(e.target.value))}>
                  {Array.from({ length: BANK_COUNT }, (_, i) => (
                    <option key={i} value={i}>Bank {i + 1}</option>
                  ))}
                </select>
              </label>
              <label>
                Start
                <select value={spreadSlot} onChange={(e) => setSpreadSlot(Number(e.target.value))}>
                  {Array.from({ length: PADS_PER_BANK }, (_, i) => (
                    <option key={i} value={i}>Pad {i + 1}</option>
                  ))}
                </select>
              </label>
              <label>
                Count
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={spreadCount}
                  onChange={(e) => setSpreadCount(Math.max(1, Math.min(128, Number(e.target.value))))}
                />
              </label>
              <label>
                Choke
                <select value={spreadChokeGroup} onChange={(e) => setSpreadChokeGroup(Number(e.target.value))}>
                  <option value={0}>Off</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="spread-assign-btn"
              onClick={() => void spreadSampleChromatically(sample.id, spreadBank, spreadSlot, spreadCount, spreadChokeGroup)}
            >
              Spread {spreadCount} Pad{spreadCount > 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
    <aside
      className={`sidebar ${dropActive ? 'drop-active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="sidebar-content">
        <section>
          <div className="sidebar-header">
            <h2>Sample Library</h2>
            {onCollapse && <button type="button" className="sidebar-collapse-btn" onClick={onCollapse} title="Collapse Library">&#x25C2;</button>}
          </div>
          <div className="sample-toolbar">
            <input type="text" placeholder="Search samples" value={sampleQuery} onChange={(e) => useStore.setState({ sampleQuery: e.target.value })} />
            <select value={sampleSort} onChange={(e) => useStore.setState({ sampleSort: e.target.value as 'recent' | 'name' | 'size' })}>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
          </div>
          {selectedSampleIds.size >= 2 && (
            <div className="sample-toolbar">
              <button
                type="button"
                className="group-selected-btn"
                onClick={() => {
                  groupSamples(Array.from(selectedSampleIds))
                  setSelectedSampleIds(new Set())
                }}
              >
                Group {selectedSampleIds.size} Samples
              </button>
              <button
                type="button"
                onClick={() => setSelectedSampleIds(new Set())}
              >
                Clear
              </button>
            </div>
          )}
          <div className="library-list">
            {filteredSamples.length === 0 && <p>{dropActive ? 'Drop files here to add to library' : 'No samples yet. Drop audio files here.'}</p>}
            {libraryItems.map((item) => {
              if (item.type === 'group') {
                const isGroupExpanded = expandedGroups.has(item.key)
                const isMpcGroup = item.samples.some((s) => s.autosampleMpc === true)
                const isPresetGroup = item.samples.some((s) => s.autosamplePreset === true)
                return (
                  <div key={`grp-${item.key}`} className="sample-group">
                    <div
                      className="sample-group-head"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'copy'
                        e.dataTransfer.setData('application/x-online-sampler-group-id', item.key)
                      }}
                    >
                      <button
                        type="button"
                        className="sample-group-toggle"
                        onClick={() => toggleGroupExpand(item.key)}
                      >
                        <span className="sample-group-chevron">{isGroupExpanded ? '▾' : '▸'}</span>
                      </button>
                      <span
                        className="sample-group-label"
                        onClick={() => toggleGroupExpand(item.key)}
                      >
                        {isMpcGroup && <span className="sample-group-badge">MPC</span>}
                        {isPresetGroup && <span className="sample-group-badge">Preset</span>}
                        {item.label}
                      </span>
                      <div className="sample-group-actions">
                        <button
                          type="button"
                          title="Assign group to pads (from selected pad)"
                          onClick={() => void assignGroupToPads(item.key)}
                        >
                          ⎘
                        </button>
                        {item.samples.some((s) => s.autosamplePatterns) && (
                          <button
                            type="button"
                            title="Import sequencer patterns from this kit"
                            onClick={() => void importPatternsForGroupByRunId(item.key)}
                          >
                            ♫
                          </button>
                        )}
                        <button
                          type="button"
                          title="Edit group settings"
                          onClick={() => {
                            const firstSample = item.samples[0]
                            setEditingGroupId(item.key)
                            setEditingGroupName(firstSample.autosampleRunLabel || '')
                            setEditingGroupBus(firstSample.autosampleBus || 'A')
                            setEditingGroupChokeEnabled(!!(firstSample.autosampleChokeGroup && firstSample.autosampleChokeGroup > 0))
                            setEditingGroupChokeGroup(firstSample.autosampleChokeGroup || 1)
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          title="Export group as ZIP"
                          onClick={() => void exportAutosampleGroupZip(item.key)}
                        >
                          ⬇
                        </button>
                        <button
                          type="button"
                          title="Delete group and reset pads"
                          onClick={() => void deleteAutosampleGroup(item.key)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    {isGroupExpanded && (() => {
                      if (item.veloSubgroups.length === 0) {
                        // No velocity subgroups — render flat
                        return item.samples.map((sample) => renderSampleRow(sample, true))
                      }
                      // Build set of sample IDs that belong to a velocity subgroup
                      const veloSampleIds = new Set(item.veloSubgroups.flatMap((sg) => sg.samples.map((s) => s.id)))
                      const flatSamples = item.samples.filter((s) => !veloSampleIds.has(s.id))
                      return (
                        <>
                          {item.veloSubgroups.map((sg) => {
                            const veloKey = `${item.key}:${sg.baseName}`
                            const isVeloExpanded = expandedVeloGroups.has(veloKey)
                            return (
                              <div key={veloKey} className="velo-subgroup">
                                <div
                                  className="velo-subgroup-head"
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = 'copy'
                                    e.dataTransfer.setData('application/x-online-sampler-velo-subgroup', JSON.stringify(sg.samples.map((s) => s.id)))
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="sample-group-toggle"
                                    onClick={() => toggleVeloGroupExpand(veloKey)}
                                  >
                                    <span className="sample-group-chevron">{isVeloExpanded ? '▾' : '▸'}</span>
                                  </button>
                                  <span
                                    className="velo-subgroup-label"
                                    onClick={() => toggleVeloGroupExpand(veloKey)}
                                  >
                                    {sg.baseName.replace(/\.[^.]+$/, '')}
                                    <span className="velo-subgroup-count">{sg.samples.length} layers</span>
                                  </span>
                                </div>
                                {isVeloExpanded && sg.samples.map((sample) => renderSampleRow(sample, true))}
                              </div>
                            )
                          })}
                          {flatSamples.map((sample) => renderSampleRow(sample, true))}
                        </>
                      )
                    })()}
                  </div>
                )
              }
              return renderSampleRow(item.sample)
            })}
          </div>
          {/* Synth Patches */}
          {synthPatches.length > 0 && (
            <div className="synth-patches-section">
              <div className="synth-patches-header">
                <strong>Synth Patches</strong>
              </div>
              <div className="synth-patches-list">
                {synthPatches.map((patch) => (
                  <div
                    key={patch.id}
                    className="synth-patch-row"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy'
                      e.dataTransfer.setData('application/x-online-sampler-synth-patch', JSON.stringify(patch))
                    }}
                  >
                    <span className="synth-patch-name" title={patch.name}>~ {patch.name}</span>
                    <div className="synth-patch-actions">
                      <button
                        type="button"
                        title="Assign to selected pad"
                        disabled={!selectedPad}
                        onClick={() => {
                          if (selectedPad) applySynthPatchToPad(patch, selectedPad.id)
                        }}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        title="Export .ospatch"
                        onClick={() => handleExportPatch(patch)}
                      >
                        ⬇
                      </button>
                      <button
                        type="button"
                        title="Delete patch"
                        onClick={() => void deleteSynthPatch(patch.id)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="record-controls">
            <input
              ref={sampleImportRef}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.zip"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) {
                  void addSamplesToLibrary(Array.from(e.target.files))
                }
                e.target.value = ''
              }}
            />
            <input
              ref={patchImportRef}
              type="file"
              accept=".ospatch"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleImportPatch(e.target.files); e.target.value = '' }}
            />
            <button type="button" onClick={() => sampleImportRef.current?.click()}>Import Samples</button>
            <input
              ref={folderImportRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is non-standard but supported on iOS 15.4+
              webkitdirectory=""
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) {
                  void addSamplesToLibrary(Array.from(e.target.files))
                }
                e.target.value = ''
              }}
            />
            <button type="button" onClick={() => folderImportRef.current?.click()}>Import Folder</button>
            <button type="button" onClick={() => patchImportRef.current?.click()} title="Import .ospatch file">Import Patch</button>
            <button type="button" onClick={() => openRecordDialog()}>Record</button>
            <button type="button" onClick={() => openAutosampleDialog()} title="Automatically sample external MIDI gear">Auto-Sample</button>
            <button type="button" className="remove-unassigned-btn" onClick={() => void removeUnassignedSamples()}>Remove Unassigned</button>
            <button type="button" className="remove-unassigned-btn" onClick={() => void compactProject()} title="Remove unused pads/samples and consolidate to first banks">Compact Project</button>
          </div>
        </section>
      </div>
    </aside>

    {/* Group Edit Modal */}
    {editingGroupId && (
      <section className="import-dialog-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) setEditingGroupId(null) }}>
        <div className="import-dialog" style={{ maxWidth: 340 }}>
          <div className="import-dialog-head">
            <h2>Edit Group</h2>
            <button type="button" onClick={() => setEditingGroupId(null)}>Close</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px' }}>
            <label>
              Name
              <input
                type="text"
                value={editingGroupName}
                autoFocus
                onChange={(e) => setEditingGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
            <label>
              Mix Bus
              <select value={editingGroupBus} onChange={(e) => setEditingGroupBus(e.target.value as BusId)}>
                <option value="A">Bus A</option>
                <option value="B">Bus B</option>
                <option value="C">Bus C</option>
                <option value="D">Bus D</option>
              </select>
            </label>
            <label className="autosample-checkbox">
              <input type="checkbox" checked={editingGroupChokeEnabled} onChange={(e) => setEditingGroupChokeEnabled(e.target.checked)} />
              Choke group
            </label>
            {editingGroupChokeEnabled && (
              <label>
                Group
                <select value={editingGroupChokeGroup} onChange={(e) => setEditingGroupChokeGroup(Number(e.target.value))}>
                  {Array.from({ length: 8 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>{i + 1}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '8px 12px' }}>
            <button type="button" onClick={() => setEditingGroupId(null)}>Cancel</button>
            <button
              type="button"
              className="record-btn-save"
              onClick={() => {
                if (editingGroupName.trim()) renameAutosampleGroup(editingGroupId, editingGroupName.trim())
                updateAutosampleGroupSettings(editingGroupId, {
                  bus: editingGroupBus,
                  chokeGroup: editingGroupChokeEnabled ? editingGroupChokeGroup : 0,
                })
                setEditingGroupId(null)
              }}
            >
              Save
            </button>
          </div>
        </div>
      </section>
    )}
    </>
  )
}
