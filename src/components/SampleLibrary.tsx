import { useState, useCallback, useMemo, useRef, useEffect, memo, type ComponentProps } from 'react'
import {
  useStore,
  selectSelectedPad,
  selectFilteredSamples,
  selectSampleToPadMap,
  showConfirm,
} from '../store'
import type { BusId, Pad, SampleAsset } from '../types'
import { BANK_COUNT, PADS_PER_BANK } from '../lib/constants'
import { looksLikeDrumKit, mapToStandardKit } from '../lib/drumKitMap'
import { makeTouchDragHandlers } from '../lib/touchDrag'
import { MiniWaveform } from './MiniWaveform'
import { LibraryInspector } from './LibraryInspector'
import { KitPreviewGrid } from './KitPreviewGrid'

// Module-level state survives component unmount (perf mode tab switches)
let _expandedChops = new Set<string>()
let _expandedGroups = new Set<string>()
let _expandedVeloGroups = new Set<string>()

const TAG_LABELS: Record<string, string> = {
  INAM: 'Name', IART: 'Artist', ICMT: 'Comment',
  IPRD: 'Product', ISFT: 'Software', IGNR: 'Genre', IKEY: 'Keywords',
}

export function MetadataTagChips({ sample, max = 3 }: { sample: SampleAsset; max?: number }) {
  const showTags = useStore((s) => s.showMetadataTags)
  const whitelist = useStore((s) => s.metadataTagWhitelist)
  if (!showTags || !sample.metadataTags) return null
  const entries = Object.entries(sample.metadataTags)
    .filter(([k]) => whitelist.has(k))
    .slice(0, max)
  if (entries.length === 0) return null
  return (
    <span className="metadata-tag-chips">
      {entries.map(([k, v]) => (
        <span key={k} className="metadata-tag-chip" title={`${TAG_LABELS[k] ?? k}: ${v}`}>
          {v}
        </span>
      ))}
    </span>
  )
}

interface SampleRowProps {
  sample: SampleAsset
  inGroup?: boolean
  isPreviewing: boolean
  isChopExpanded: boolean
  isSelected: boolean
  isSpreadTarget: boolean
  isInspectorSelected: boolean
  hasSelectedPad: boolean
  wavePeaks: number[] | undefined
  assignedPads: Pad[] | undefined
  onToggleChop: (sampleId: string) => void
  onToggleSelect: (sampleId: string) => void
  onInspect: (sampleId: string) => void
  onNavigateToPad: (pad: Pad) => void
  spreadBank?: number
  spreadSlot?: number
  spreadCount?: number
  spreadChokeGroup?: number
  setSpreadBank?: (v: number) => void
  setSpreadSlot?: (v: number) => void
  setSpreadCount?: (v: number) => void
  setSpreadChokeGroup?: (v: number) => void
}

const SampleRow = memo(function SampleRow({
  sample,
  inGroup = false,
  isPreviewing,
  isChopExpanded,
  isSelected,
  isSpreadTarget,
  isInspectorSelected,
  hasSelectedPad,
  wavePeaks,
  assignedPads,
  onToggleChop,
  onToggleSelect,
  onInspect,
  onNavigateToPad,
  spreadBank,
  spreadSlot,
  spreadCount,
  spreadChokeGroup,
  setSpreadBank,
  setSpreadSlot,
  setSpreadCount,
  setSpreadChokeGroup,
}: SampleRowProps) {
  const hasChops = (sample.chopPoints?.length ?? 0) > 0
  const chopBoundaries = hasChops ? [0, ...(sample.chopPoints ?? []), 1] : []

  const {
    previewSample,
    assignSampleToSelectedPad,
    openChopModal,
    openChromaticSpread,
    closeChromaticSpread,
    deleteSampleFromLibrary,
    ungroupSample,
    spreadSampleChromatically,
  } = useStore.getState()

  return (
    <div>
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
            checked={isSelected}
            onChange={(e) => {
              e.stopPropagation()
              onToggleSelect(sample.id)
            }}
            title="Select for grouping"
          />
        )}
        <div className="sample-info-col">
          <button
            type="button"
            className={`sample-preview${isPreviewing ? ' active' : ''}${isInspectorSelected ? ' inspector-active' : ''}`}
            onClick={() => void previewSample(sample)}
            onContextMenu={(e) => { e.preventDefault(); onInspect(sample.id) }}
          >
            <span className="sample-name">{sample.name}</span>
            <small>{`${Math.max(1, Math.round(sample.size / 1024))} KB`}</small>
          </button>
          {wavePeaks && wavePeaks.length > 0 && (
            <div className="sample-waveform">
              <MiniWaveform peaks={wavePeaks} />
            </div>
          )}
          {assignedPads && assignedPads.length > 0 && (
            <span className="pad-assign-badges">
              {assignedPads.slice(0, 4).map((pad) => (
                <button
                  key={pad.id}
                  type="button"
                  className="pad-assign-badge"
                  title={`Bank ${pad.bank + 1} Pad ${pad.slot + 1}`}
                  onClick={(e) => { e.stopPropagation(); onNavigateToPad(pad) }}
                >
                  {pad.bank + 1}·{pad.slot + 1}
                </button>
              ))}
              {assignedPads.length > 4 && (
                <span className="pad-assign-badge pad-assign-more">+{assignedPads.length - 4}</span>
              )}
            </span>
          )}
          <MetadataTagChips sample={sample} />
        </div>
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
              onClick={() => onToggleChop(sample.id)}
              title={isChopExpanded ? 'Collapse chops' : 'Show chops'}
            >
              {isChopExpanded ? '▾' : '▸'} {chopBoundaries.length - 1}
            </button>
          )}
          <button
            type="button"
            className="sample-assign"
            onClick={() => void assignSampleToSelectedPad(sample)}
            disabled={!hasSelectedPad}
            title="Assign to selected pad"
          >
            +
          </button>
          <button
            type="button"
            className="sample-inspect"
            onClick={() => onInspect(sample.id)}
            title="Inspect sample"
          >
            ⓘ
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
      {hasChops && isChopExpanded && (
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
      {isSpreadTarget && spreadBank != null && spreadSlot != null && spreadCount != null && spreadChokeGroup != null && setSpreadBank && setSpreadSlot && setSpreadCount && setSpreadChokeGroup && (
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
})

// Group samples by autosampleRunId into collapsible batches
type VeloSubgroup = { baseName: string; samples: SampleAsset[] }
type LibItem = { type: 'single'; sample: SampleAsset } | { type: 'group'; key: string; label: string; samples: SampleAsset[]; veloSubgroups: VeloSubgroup[] }

const veloRegex = /^(.+?)(?:_v| V)(\d+)(\.[^.]+)$/

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

export function SampleLibrary({ onCollapse }: { onCollapse?: () => void }) {
  const sampleQuery = useStore((s) => s.sampleQuery)
  const sampleSort = useStore((s) => s.sampleSort)
  const previewSampleId = useStore((s) => s.previewSampleId)
  const filteredSamples = useStore(selectFilteredSamples)
  const selectedPad = useStore(selectSelectedPad)
  const chromaticSpreadSampleId = useStore((s) => s.chromaticSpreadSampleId)
  const libraryWavePeaks = useStore((s) => s.libraryWavePeaks)
  const sampleToPadMap = useStore(selectSampleToPadMap)
  const inspectorSampleId = useStore((s) => s.libraryInspectorSampleId)
  const libraryExpanded = useStore((s) => s.libraryExpanded)
  const kitPreviewRunId = useStore((s) => s.kitPreviewRunId)

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
    openRecordDialog,
    addSamplesToLibrary,
    removeUnassignedSamples,
    compactProject,
    openAutosampleDialog,
    groupSamples,
    assignGroupToPads,
    importPatternsForGroupByRunId,
    renameAutosampleGroup,
    updateAutosampleGroupSettings,
    deleteAutosampleGroup,
    exportAutosampleGroupZip,
    setLibraryInspectorSample,
    toggleLibraryExpanded,
    setKitPreviewRunId,
  } = useStore.getState()

  const handleInspect = useCallback((sampleId: string) => {
    const current = useStore.getState().libraryInspectorSampleId
    setLibraryInspectorSample(current === sampleId ? null : sampleId)
  }, [setLibraryInspectorSample])

  const handleNavigateToPad = useCallback((pad: Pad) => {
    useStore.setState({
      activeBank: pad.bank,
      selectedPadId: pad.id,
      performanceTab: 'padEditor',
    })
    try { localStorage.setItem('performanceTab', 'padEditor') } catch { /* ignore */ }
  }, [])

  const handleDismissInspector = useCallback(() => {
    setLibraryInspectorSample(null)
  }, [setLibraryInspectorSample])

  const sampleImportRef = useRef<HTMLInputElement>(null)
  const folderImportRef = useRef<HTMLInputElement>(null)

  // Storage usage estimate
  const [storageUsage, setStorageUsage] = useState<string>('')
  useEffect(() => {
    const update = () => {
      if (navigator.storage?.estimate) {
        navigator.storage.estimate().then((est) => {
          if (est.usage != null) {
            const mb = est.usage / (1024 * 1024)
            setStorageUsage(mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`)
          }
        }).catch(() => {})
      }
    }
    update()
    const interval = setInterval(update, 10000)
    return () => clearInterval(interval)
  }, [])

  const handleToggleSelect = useCallback((sampleId: string) => {
    setSelectedSampleIds((prev) => {
      const next = new Set(prev)
      if (next.has(sampleId)) next.delete(sampleId)
      else next.add(sampleId)
      return next
    })
  }, [])



  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
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

    const files = Array.from(e.dataTransfer.files)
    const items = Array.from(e.dataTransfer.items)

    // Check if any item is a directory (use webkitGetAsEntry for folder support)
    const hasDirectory = items.some((item) => {
      const entry = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
      return entry?.isDirectory
    })

    if (hasDirectory) {
      // Recursively read all files from dropped directories + top-level files,
      // tracking subfolder structure so it is preserved in the library.
      const allFiles: File[] = []
      const dirBuckets = new Map<string, File[]>()
      let rootFolderName: string | undefined
      const readEntry = (entry: FileSystemEntry, relPath = ''): Promise<void> => {
        if (entry.isFile) {
          return new Promise((resolve) => {
            (entry as FileSystemFileEntry).file((f) => {
              allFiles.push(f)
              const parent = relPath.split('/').filter(Boolean).join(' / ') || null
              if (parent) {
                let bucket = dirBuckets.get(parent)
                if (!bucket) { bucket = []; dirBuckets.set(parent, bucket) }
                bucket.push(f)
              }
              resolve()
            }, () => resolve())
          })
        } else if (entry.isDirectory) {
          if (!rootFolderName) rootFolderName = entry.name
          const childPath = relPath ? `${relPath}/${entry.name}` : entry.name
          return new Promise((resolve) => {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            const readBatch = () => {
              reader.readEntries(async (entries) => {
                if (entries.length === 0) { resolve(); return }
                for (const e of entries) await readEntry(e, childPath)
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
          const entry = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
          if (entry) await readEntry(entry)
        }
        if (allFiles.length === 0) return

        const hasSubfolders = dirBuckets.size > 0

        // If .pgm or .lcdk files are present, let addSamplesToLibrary handle grouping
        const hasPgm = allFiles.some((f) => f.name.match(/\.pgm$/i))
        const hasLcdk = allFiles.some((f) => f.name.match(/\.lcdk$/i))
        if (hasPgm || hasLcdk) {
          void addSamplesToLibrary(allFiles, undefined, rootFolderName)
          return
        }

        // When subfolders exist, import each subfolder as a separate group
        if (hasSubfolders) {
          // Files at the root level (not in any subfolder)
          const rootFiles = allFiles.filter((f) => ![...dirBuckets.values()].some((bucket) => bucket.includes(f)))
          if (rootFiles.length > 0) {
            void addSamplesToLibrary(rootFiles, undefined, rootFolderName || undefined)
          }
          for (const [dirName, dirFiles] of dirBuckets) {
            void addSamplesToLibrary(dirFiles, undefined, dirName)
          }
          return
        }

        // Flat folder — check if files look like a drum kit and offer standard layout mapping
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
            void addSamplesToLibrary(audioFiles, padIndexMap, rootFolderName)
            return
          }
        }
        void addSamplesToLibrary(allFiles, undefined, rootFolderName)
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

  const makeSampleRowProps = (sample: SampleAsset, inGroup = false): ComponentProps<typeof SampleRow> => ({
    sample,
    inGroup,
    isPreviewing: previewSampleId === sample.id,
    isChopExpanded: expandedChops.has(sample.id),
    isSelected: selectedSampleIds.has(sample.id),
    isSpreadTarget: chromaticSpreadSampleId === sample.id,
    isInspectorSelected: inspectorSampleId === sample.id,
    hasSelectedPad: !!selectedPad,
    wavePeaks: libraryWavePeaks[sample.id],
    assignedPads: sampleToPadMap.get(sample.id),
    onToggleChop: toggleChopExpand,
    onToggleSelect: handleToggleSelect,
    onInspect: handleInspect,
    onNavigateToPad: handleNavigateToPad,
    ...(chromaticSpreadSampleId === sample.id
      ? {
          spreadBank,
          spreadSlot,
          spreadCount,
          spreadChokeGroup,
          setSpreadBank,
          setSpreadSlot,
          setSpreadCount,
          setSpreadChokeGroup,
        }
      : {}),
  })

  return (
    <>
    <aside
      className={`sidebar${dropActive ? ' drop-active' : ''}${libraryExpanded ? ' library-expanded' : ''}`}
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
            <button
              type="button"
              className={`library-expand-btn${libraryExpanded ? ' active' : ''}`}
              onClick={() => toggleLibraryExpanded()}
              title={libraryExpanded ? 'Collapse library view' : 'Expand library view'}
            >
              {libraryExpanded ? '⊟' : '⊞'}
            </button>
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
                const isLcdkGroup = item.samples.some((s) => s.autosampleLcdk === true)
                const isBatteryGroup = item.samples.some((s) => s.autosampleBattery === true)
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
                        {isLcdkGroup && <span className="sample-group-badge">LCDK</span>}
                        {isBatteryGroup && <span className="sample-group-badge">Battery</span>}
                        {item.label}
                      </span>
                      <div className="sample-group-actions">
                        {(isMpcGroup || isBatteryGroup || isLcdkGroup || isPresetGroup) && (
                          <button
                            type="button"
                            className={kitPreviewRunId === item.key ? 'kit-preview-btn active' : 'kit-preview-btn'}
                            title="Preview kit layout"
                            onClick={() => setKitPreviewRunId(kitPreviewRunId === item.key ? null : item.key)}
                          >
                            ▦
                          </button>
                        )}
                        <button
                          type="button"
                          className="sample-group-assign"
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
                    {isGroupExpanded && (
                      <>
                        {item.veloSubgroups.length === 0 ? (
                          // No velocity subgroups — render flat
                          item.samples.map((sample) => (
                            <SampleRow key={sample.id} {...makeSampleRowProps(sample, true)} />
                          ))
                        ) : (
                          // Build set of sample IDs that belong to a velocity subgroup
                          (() => {
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
                                      {isVeloExpanded && sg.samples.map((sample) => (
                                        <SampleRow key={sample.id} {...makeSampleRowProps(sample, true)} />
                                      ))}
                                    </div>
                                  )
                                })}
                                {flatSamples.map((sample) => (
                                  <SampleRow key={sample.id} {...makeSampleRowProps(sample, true)} />
                                ))}
                              </>
                            )
                          })()
                        )}
                      </>
                    )}
                  </div>
                )
              }
              return <SampleRow key={item.sample.id} {...makeSampleRowProps(item.sample)} />
            })}
          </div>
          {kitPreviewRunId && (() => {
            const kitSamples = filteredSamples.filter((s) => s.autosampleRunId === kitPreviewRunId)
            if (kitSamples.length === 0) return null
            return (
              <KitPreviewGrid
                samples={kitSamples}
                onDismiss={() => setKitPreviewRunId(null)}
              />
            )
          })()}
          {inspectorSampleId && (() => {
            const inspectorSample = filteredSamples.find((s) => s.id === inspectorSampleId) || useStore.getState().sampleMap.get(inspectorSampleId)
            if (!inspectorSample) return null
            return (
              <LibraryInspector
                sample={inspectorSample}
                onDismiss={handleDismissInspector}
                onNavigateToPad={handleNavigateToPad}
              />
            )
          })()}
          <div className="record-controls">
            <input
              ref={sampleImportRef}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.zip,.nbkt"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) {
                  void addSamplesToLibrary(Array.from(e.target.files))
                }
                e.target.value = ''
              }}
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
            <button type="button" onClick={() => openRecordDialog()}>Record</button>
            <button type="button" onClick={() => openAutosampleDialog()} title="Automatically sample external MIDI gear">Auto-Sample</button>
            <button type="button" className="remove-unassigned-btn" onClick={() => void removeUnassignedSamples()}>Remove Unassigned</button>
            <button type="button" className="remove-unassigned-btn" onClick={() => void compactProject()} title="Remove unused pads/samples and consolidate to first banks">Compact Project</button>
            {storageUsage && <span className="storage-usage" title="Local storage used by this app">{storageUsage}</span>}
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
