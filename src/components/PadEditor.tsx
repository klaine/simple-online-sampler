import { useRef, useEffect, useCallback, type RefObject } from 'react'
import type { FilterType, MultiSampleMode, Pad, PadMode, PadSettings, BusId, SampleLayer } from '../types'
import { BUS_IDS } from '../types'
import {
  useStore,
  selectSelectedPad,
  selectSelectedLayer,
  storeRefs,
} from '../store'
import { showConfirm } from '../store/confirmDialog'
import { KnobControl } from './KnobControl'
import { EnvelopeSection } from './EnvelopeSection'
import { midiToName } from '../lib/utils'
import { audioEngine } from '../lib/audioEngine'

interface PadEditorProps {
  waveformRef: RefObject<HTMLDivElement | null>
  waveformCanvasRef: RefObject<HTMLCanvasElement | null>
  dragTargetRef: RefObject<'start' | 'end' | null>
}

/** Merge layer overrides onto pad settings for display */
function effectiveSettings(pad: Pad, layer: ReturnType<typeof selectSelectedLayer>): PadSettings {
  if (!layer) return pad.settings
  return {
    ...pad.settings,
    gain: layer.gain ?? pad.settings.gain,
    semitones: layer.semitones ?? pad.settings.semitones,
    fineCents: layer.fineCents ?? pad.settings.fineCents,
    trim: layer.trim ?? pad.settings.trim,
    envelope: layer.envelope ?? pad.settings.envelope,
    filterType: layer.filterType ?? pad.settings.filterType,
    filterFreq: layer.filterFreq ?? pad.settings.filterFreq,
    filterQ: layer.filterQ ?? pad.settings.filterQ,
  }
}

/* ---- Stacked lane waveform canvas ---- */
const LANE_COLORS = ['#4fc3f7', '#f06292', '#aed581', '#ffb74d', '#ba68c8', '#4dd0e1', '#ff8a65', '#9575cd']

function StackedLaneCanvas({ sampleId, color, trimStart, trimEnd }: { sampleId: string; color: string; trimStart: number; trimEnd: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const bar = canvas.parentElement
    if (!bar) return

    const draw = () => {
      const buf = audioEngine.getBuffer(sampleId)
      if (!buf) return
      const cssW = bar.clientWidth
      const cssH = bar.clientHeight
      if (cssW < 1 || cssH < 1) return
      const pr = window.devicePixelRatio || 1
      canvas.width = Math.floor(cssW * pr)
      canvas.height = Math.floor(cssH * pr)
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(pr, 0, 0, pr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      const data = buf.getChannelData(0)
      const sampleStart = Math.floor(trimStart * data.length)
      const sampleEnd = Math.floor(trimEnd * data.length)
      const trimLen = sampleEnd - sampleStart
      if (trimLen < 1) return
      const step = trimLen / cssW
      const mid = cssH / 2
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.globalAlpha = 1
      for (let x = 0; x < cssW; x++) {
        const s = sampleStart + Math.floor(x * step)
        const e = Math.min(sampleEnd, sampleStart + Math.floor((x + 1) * step))
        let peak = 0
        for (let i = s; i < e; i++) peak = Math.max(peak, Math.abs(data[i]))
        const h = Math.max(1, peak * cssH * 0.45)
        ctx.fillRect(x, mid - h, 1, h * 2)
      }
    }

    const ro = new ResizeObserver(() => draw())
    ro.observe(bar)
    draw()
    return () => ro.disconnect()
  }, [sampleId, color, trimStart, trimEnd])

  return <canvas ref={canvasRef} className="stacked-lane-canvas" />
}

/** Get effective trim for a layer (layer override ?? pad settings) */
function getLayerTrim(padSettings: PadSettings, layer: SampleLayer): { start: number; end: number } {
  const trim = layer.trim ?? padSettings.trim
  return { start: trim?.start ?? 0, end: trim?.end ?? 1 }
}

/** Get trimmed duration in ms for a layer */
function getTrimmedDurationMs(sampleId: string, trimStart: number, trimEnd: number): number {
  const buf = audioEngine.getBuffer(sampleId)
  if (!buf) return 500
  return buf.duration * (trimEnd - trimStart) * 1000
}

/* ---- Stacked timeline with drag ---- */
function StackedTimeline({ layers, padSettings, sampleMap: sm }: { layers: SampleLayer[]; padSettings: PadSettings; sampleMap: Map<string, { name: string }> }) {
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ layerId: string; startX: number; startOffsetMs: number; maxEnd: number } | null>(null)

  const lanes = layers.map((layer) => {
    const trim = getLayerTrim(padSettings, layer)
    const durationMs = getTrimmedDurationMs(layer.sampleId, trim.start, trim.end)
    const offsetMs = layer.stackOffsetMs ?? 0
    return { offsetMs, durationMs, endMs: offsetMs + durationMs, trimStart: trim.start, trimEnd: trim.end }
  })
  const maxEnd = Math.max(100, ...lanes.map((l) => l.endMs))

  const onPointerDown = useCallback((e: React.PointerEvent, layerId: string, offsetMs: number) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const tl = timelineRef.current
    if (!tl) return
    const currentLanes = layers.map((layer) => {
      const trim = getLayerTrim(padSettings, layer)
      const dur = getTrimmedDurationMs(layer.sampleId, trim.start, trim.end)
      const off = layer.stackOffsetMs ?? 0
      return off + dur
    })
    dragRef.current = { layerId, startX: e.clientX, startOffsetMs: offsetMs, maxEnd: Math.max(100, ...currentLanes) }
  }, [layers, padSettings])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    const tl = timelineRef.current
    if (!d || !tl) return
    const tlWidth = tl.clientWidth
    if (tlWidth <= 0) return
    const pxPerMs = tlWidth / d.maxEnd
    const deltaPx = e.clientX - d.startX
    const deltaMs = deltaPx / pxPerMs
    const newOffset = Math.max(0, Math.round(d.startOffsetMs + deltaMs))
    useStore.getState().updateLayerSettings(d.layerId, { stackOffsetMs: newOffset || null })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  return (
    <div className="stacked-timeline" ref={timelineRef}>
      <div className="stacked-timeline-scale">
        <span>0ms</span>
        <span>{Math.round(maxEnd / 2)}ms</span>
        <span>{Math.round(maxEnd)}ms</span>
      </div>
      {layers.map((layer, idx) => {
        const l = lanes[idx]
        const leftPct = (l.offsetMs / maxEnd) * 100
        const widthPct = (l.durationMs / maxEnd) * 100
        const color = LANE_COLORS[idx % LANE_COLORS.length]
        const sample = sm.get(layer.sampleId)
        return (
          <div key={layer.id} className="stacked-lane">
            <div
              className="stacked-lane-bar"
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: color, cursor: 'ew-resize' }}
              title={`${sample?.name ?? 'Layer ' + (idx + 1)}: ${Math.round(l.offsetMs)}ms offset, ${Math.round(l.durationMs)}ms duration — drag to adjust`}
              onPointerDown={(e) => onPointerDown(e, layer.id, l.offsetMs)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <StackedLaneCanvas sampleId={layer.sampleId} color={color} trimStart={l.trimStart} trimEnd={l.trimEnd} />
              <span className="stacked-lane-label">{idx + 1}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function PadEditor({ waveformRef, waveformCanvasRef, dragTargetRef }: PadEditorProps) {
  const selectedPad = useStore(selectSelectedPad)
  const selectedPadIds = useStore((s) => s.selectedPadIds)
  const selectedLayer = useStore(selectSelectedLayer)
  const selectedLayerId = useStore((s) => s.selectedLayerId)
  const collapsed = useStore((s) => s.padEditorCollapsed)
  const trimDraft = useStore((s) => s.trimDraft)
  const waveformZoom = useStore((s) => s.waveformZoom)
  const sampleMap = useStore((s) => s.sampleMap)
  const project = useStore((s) => s.project)

  const {
    updatePadSettings,
    updateMultiplePads,
    assignFileToPad,
    renamePad,
    resetSelectedPadName,
    addLayerFile,
    removeLayer,
    updateLayerVelocity,
    updateLayerSettings,
    selectLayer,
    updatePadMidiOut,
  } = useStore.getState()

  const midiOutputs = useStore((s) => s.midiOutputs)

  const eff = selectedPad ? effectiveSettings(selectedPad, selectedLayer) : null

  // Batch editing mode
  const isBatchMode = selectedPadIds.length > 0
  const batchPads = isBatchMode && project ? project.pads.filter((p) => selectedPadIds.includes(p.id)) : null
  const batchSettings = batchPads && batchPads.length > 0 ? batchPads[0].settings : null

  const toggleCollapse = () => useStore.setState((s) => ({ padEditorCollapsed: !s.padEditorCollapsed }))

  return (
    <section className={`pad-editor-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="pad-editor-head">
        <h2>Pad Editor</h2>
        {selectedPad && collapsed && <span className="pad-editor-head-name">{selectedPad.name}</span>}
        <button type="button" className="pad-editor-toggle" onClick={toggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {isBatchMode && batchPads && batchSettings ? (
        <>
          <div className="editor-batch-header">
            <span>Editing {batchPads.length} pads</span>
            <button type="button" onClick={() => useStore.setState({ selectedPadIds: [] })} title="Clear selection">✕</button>
          </div>
          <div className="editor-top-row">
            <label>
              <span>Gain</span>
              <KnobControl label="Gain" value={batchSettings.gain} min={0} max={2} step={0.01} onChange={(v) => void updateMultiplePads(selectedPadIds, { gain: v })} />
            </label>
            <label>
              <span>Mode</span>
              <select value={batchSettings.mode} onChange={(e) => void updateMultiplePads(selectedPadIds, { mode: e.target.value as PadMode })}>
                <option value="one-shot">One-Shot</option>
                <option value="adsr">ADSR</option>
                <option value="ahr">AHR</option>
              </select>
            </label>
            <label>
              <span>Bus</span>
              <select value={batchSettings.bus} onChange={(e) => void updateMultiplePads(selectedPadIds, { bus: e.target.value as BusId })}>
                {BUS_IDS.map((id) => (<option key={id} value={id}>Bus {id}</option>))}
              </select>
            </label>
            <label>
              <span>Choke</span>
              <select value={batchSettings.chokeGroup} onChange={(e) => void updateMultiplePads(selectedPadIds, { chokeGroup: Number(e.target.value) })}>
                <option value={0}>Off</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (<option key={n} value={n}>Group {n}</option>))}
              </select>
            </label>
            <label>
              <span>Filter</span>
              <select value={batchSettings.filterType} onChange={(e) => void updateMultiplePads(selectedPadIds, { filterType: e.target.value as FilterType })}>
                <option value="off">Off</option>
                <option value="lp12">LP12</option>
                <option value="lp24">LP24</option>
                <option value="highpass">HP</option>
                <option value="bandpass">BP</option>
                <option value="lphp">LPHP</option>
              </select>
            </label>
            <label>
              <span>Freq</span>
              <KnobControl label="Freq" value={batchSettings.filterFreq} min={20} max={20000} step={1} freqScale onChange={(v) => void updateMultiplePads(selectedPadIds, { filterFreq: v })} />
            </label>
            <label>
              <span>Q</span>
              <KnobControl label="Q" value={batchSettings.filterQ} min={0.1} max={20} step={0.1} onChange={(v) => void updateMultiplePads(selectedPadIds, { filterQ: v })} />
            </label>
            <label>
              <span>Pan</span>
              <KnobControl label="Pan" value={batchSettings.pan ?? 0} min={-1} max={1} step={0.01} onChange={(v) => void updateMultiplePads(selectedPadIds, { pan: v })} />
            </label>
            <label>
              <span>Mute</span>
              <input type="checkbox" checked={batchSettings.mute ?? false} onChange={(e) => void updateMultiplePads(selectedPadIds, { mute: e.target.checked })} />
            </label>
          </div>
        </>
      ) : selectedPad ? (
        <>
          {/* --- Top row: only in expanded --- */}
          {!collapsed && (
            <div className="editor-top-row">
              <label>
                Pad Name
                <input type="text" value={selectedPad.name} onChange={(e) => void renamePad(e.target.value)} />
              </label>
              <button type="button" className="pad-name-reset" onClick={() => void resetSelectedPadName()}>
                Reset Name
              </button>
              <button type="button" className="pad-name-reset" onClick={() => void useStore.getState().resetPad(selectedPad.id)}>
                Reset Pad
              </button>
              <label>
                Mode
                <select
                  value={selectedPad.settings.mode}
                  onChange={(e) => void updatePadSettings({ mode: e.target.value as Pad['settings']['mode'] })}
                >
                  <option value="one-shot">One Shot</option>
                  <option value="adsr">ADSR</option>
                  <option value="ahr">AHR</option>
                </select>
              </label>
              <label>
                Bus
                <select
                  value={selectedPad.settings.bus ?? 'A'}
                  onChange={(e) => void updatePadSettings({ bus: e.target.value as BusId })}
                >
                  {BUS_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <label>
                Choke
                <select
                  value={selectedPad.settings.chokeGroup ?? 0}
                  onChange={(e) => void updatePadSettings({ chokeGroup: Number(e.target.value) })}
                >
                  <option value={0}>Off</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
              <>
              <label className="file-input-styled">
                Assign Sample File
                <span className="file-input-btn">Browse...</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void assignFileToPad(selectedPad, file)
                  }}
                />
              </label>
              {selectedPad.settings.sampleId && (selectedPad.settings.trim.start > 0 || selectedPad.settings.trim.end < 1) && (
                <button
                  type="button"
                  className="file-input-btn"
                  onClick={async () => {
                    if (await showConfirm('Crop sample to trim markers? This permanently rewrites the audio and cannot be undone.')) {
                      void useStore.getState().cropSampleToTrim(selectedPad.id)
                    }
                  }}
                >
                  Crop
                </button>
              )}
              {selectedPad.settings.sampleId && (
                <button
                  type="button"
                  className="file-input-btn"
                  onClick={async () => {
                    if (await showConfirm('Normalize sample to -0.3 dBFS? This permanently rewrites the audio and cannot be undone.')) {
                      void useStore.getState().normalizeSample(selectedPad.id)
                    }
                  }}
                >
                  Normalize
                </button>
              )}
              </>
            </div>
          )}

          {/* --- Waveform + collapsed knobs row (shared waveform block) --- */}
          <div className={collapsed ? 'collapsed-waveform-row' : 'waveform-block'}>
            {!collapsed && (
              <div className="waveform-head">
                <strong>Waveform</strong>
                <span>{`${trimDraft.start.toFixed(2)} - ${trimDraft.end.toFixed(2)}`}</span>
                <button
                  type="button"
                  className={`waveform-zoom-btn ${waveformZoom === 'trim' ? 'active' : ''}`}
                  onClick={() => useStore.setState((s) => ({ waveformZoom: s.waveformZoom === 'full' ? 'trim' : 'full' }))}
                >
                  {waveformZoom === 'trim' ? 'Full' : 'Zoom Trim'}
                </button>
              </div>
            )}
            <div className="waveform" ref={waveformRef}>
              <canvas ref={waveformCanvasRef} className="wave-canvas" />
              {(() => {
                // In zoom-trim mode, remap positions to the visible range
                // Use frozen range during drag to keep viewport stable
                const zoomRange = storeRefs.frozenZoomRange ?? trimDraft
                const viewStart = waveformZoom === 'trim' ? zoomRange.start : 0
                const viewEnd = waveformZoom === 'trim' ? zoomRange.end : 1
                const viewSpan = Math.max(0.001, viewEnd - viewStart)
                const toView = (v: number) => ((v - viewStart) / viewSpan) * 100
                const trimLeft = toView(trimDraft.start)
                const trimRight = toView(trimDraft.end)
                return (
                  <>
                    <div
                      className="trim-zone"
                      style={{ left: `${trimLeft}%`, width: `${trimRight - trimLeft}%` }}
                    />
                    <button type="button" className="trim-handle" style={{ left: `${trimLeft}%` }} onPointerDown={() => { dragTargetRef.current = 'start'; waveformRef.current?.classList.add('trim-dragging') }} />
                    <button type="button" className="trim-handle" style={{ left: `${trimRight}%` }} onPointerDown={() => { dragTargetRef.current = 'end'; waveformRef.current?.classList.add('trim-dragging') }} />
                  </>
                )
              })()}
            </div>
            {collapsed && (
              <div className="collapsed-knobs">
                <KnobControl label="Gain" value={eff!.gain} min={0} max={2} step={0.01} onChange={(v) => void updatePadSettings({ gain: v })} />
                <KnobControl label="Semi" value={eff!.semitones ?? 0} min={-24} max={24} step={1} precision={0} onChange={(v) => void updatePadSettings({ semitones: Math.round(v) })} />
              </div>
            )}
            </div>
          {!collapsed && (
            <>
              {selectedLayerId && <span className="editing-layer-badge">Editing Layer</span>}
              <div className="knob-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                <KnobControl label="Semitones" value={eff!.semitones ?? 0} min={-24} max={24} step={1} precision={0} onChange={(v) => void updatePadSettings({ semitones: Math.round(v) })} />
                <KnobControl label="Fine (ct)" value={eff!.fineCents ?? 0} min={-100} max={100} step={1} precision={0} onChange={(v) => void updatePadSettings({ fineCents: Math.round(v) })} />
                <KnobControl label={selectedPad.settings.randomPan ? 'Spread' : 'Pan'} value={selectedPad.settings.pan ?? 0} min={selectedPad.settings.randomPan ? 0 : -1} max={1} step={0.01} onChange={(v) => void updatePadSettings({ pan: v })} />
                <div className="pan-random-toggle">
                  <label title="Randomize pan position per note (Pan knob controls width)">
                    <input
                      type="checkbox"
                      checked={selectedPad.settings.randomPan ?? false}
                      onChange={(e) => {
                        const on = e.target.checked
                        void updatePadSettings({ randomPan: on, pan: on ? Math.abs(selectedPad.settings.pan ?? 0) || 0.5 : selectedPad.settings.pan ?? 0 })
                      }}
                    />
                    Rnd Pan
                  </label>
                </div>
              </div>

              <div className="envelope-sections-row">
                {/* AMP envelope (MC-909 style) */}
                <EnvelopeSection
                  title="AMP"
                  levelLabel="Level"
                  levelValue={eff!.gain}
                  levelMin={0}
                  levelMax={2}
                  levelStep={0.01}
                  onLevelChange={(v) => void updatePadSettings({ gain: v })}
                  formatLevel={(v) => `${Math.round(v * 100)}%`}
                  attack={eff!.envelope.attack}
                  decay={eff!.envelope.decay}
                  sustain={eff!.envelope.sustain ?? 0}
                  release={eff!.envelope.release}
                  hold={eff!.envelope.hold ?? 0}
                  onAttackChange={(v) => void updatePadSettings({ envelope: { ...eff!.envelope, attack: v } })}
                  onDecayChange={(v) => void updatePadSettings({ envelope: { ...eff!.envelope, decay: v } })}
                  onSustainChange={(v) => void updatePadSettings({ envelope: { ...eff!.envelope, sustain: v } })}
                  onReleaseChange={(v) => void updatePadSettings({ envelope: { ...eff!.envelope, release: v } })}
                  onHoldChange={(v) => void updatePadSettings({ envelope: { ...eff!.envelope, hold: v } })}
                  adsrDisabled={selectedPad.settings.mode === 'one-shot'}
                  mode={selectedPad.settings.mode === 'ahr' ? 'ahr' : 'adsr'}
                />

                {/* FILTER section (MC-909 style) */}
                <div className="envelope-section">
                  <div className="envelope-section-header">FILTER</div>
                  <div className="filter-controls-row">
                    <label>
                      Type
                      <select
                        value={eff!.filterType}
                        onChange={(e) => void updatePadSettings({ filterType: e.target.value as FilterType })}
                      >
                        <option value="off">Off</option>
                        <option value="lp12">High Cut 12dB</option>
                        <option value="lp24">High Cut 24dB</option>
                        <option value="highpass">Low Cut</option>
                        <option value="bandpass">Band Pass</option>
                        <option value="lphp">Low Cut + High Cut</option>
                      </select>
                    </label>
                    {eff!.filterType !== 'off' && (
                      <>
                        <KnobControl label={eff!.filterType === 'lphp' ? 'Low Cut' : 'Freq'} value={eff!.filterFreq} min={20} max={20000} step={1} precision={0} freqScale onChange={(v) => void updatePadSettings({ filterFreq: Math.round(v) })} />
                        {eff!.filterType === 'lphp' && (
                          <KnobControl label="High Cut" value={eff!.filterFreq2 ?? 20000} min={20} max={20000} step={1} precision={0} freqScale onChange={(v) => void updatePadSettings({ filterFreq2: Math.round(v) })} />
                        )}
                        <KnobControl label="Q" value={eff!.filterQ} min={0.1} max={20} step={0.1} onChange={(v) => void updatePadSettings({ filterQ: v })} />
                      </>
                    )}
                  </div>
                </div>
              </div>

              <>
              <div className="multisample-section">
                <div className="multisample-head">
                  <strong>Multi-Sample</strong>
                  <select
                    value={selectedPad.settings.multiMode}
                    onChange={(e) => void updatePadSettings({ multiMode: e.target.value as MultiSampleMode })}
                  >
                    <option value="single">Single</option>
                    <option value="round-robin">Round Robin</option>
                    <option value="random">Random</option>
                    <option value="velocity">Velocity</option>
                    <option value="stacked">Stacked</option>
                  </select>
                  <label className="layer-add-btn">
                    + Layer
                    <input
                      type="file"
                      accept="audio/*"
                      multiple
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const files = e.target.files
                        if (!files) return
                        for (let i = 0; i < files.length; i++) {
                          void addLayerFile(files[i])
                        }
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
                {selectedPad.settings.layers.length > 0 && (
                  <div className="layer-list">
                    {selectedPad.settings.layers.map((layer, idx) => {
                      const sample = sampleMap.get(layer.sampleId)
                      return (
                        <div key={layer.id} className={`layer-row${selectedLayerId === layer.id ? ' selected' : ''}`} onClick={() => selectLayer(selectedLayerId === layer.id ? null : layer.id)}>
                          <span className="layer-idx">{idx + 1}</span>
                          <span className="layer-name" title={sample?.name ?? layer.sampleId}>
                            {sample?.name ?? 'Unknown'}
                          </span>
                          {selectedPad.settings.multiMode === 'velocity' && (
                            <span className="layer-vel">
                              <input
                                type="number"
                                min={1}
                                max={127}
                                value={layer.velocityLow}
                                onChange={(e) => void updateLayerVelocity(layer.id, Number(e.target.value), layer.velocityHigh)}
                              />
                              –
                              <input
                                type="number"
                                min={1}
                                max={127}
                                value={layer.velocityHigh}
                                onChange={(e) => void updateLayerVelocity(layer.id, layer.velocityLow, Number(e.target.value))}
                              />
                            </span>
                          )}
                          {selectedPad.settings.multiMode === 'stacked' && (
                            <span className="layer-offset" title="Offset in ms">
                              <input
                                type="number"
                                min={0}
                                max={5000}
                                step={1}
                                value={layer.stackOffsetMs ?? 0}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => void updateLayerSettings(layer.id, { stackOffsetMs: Math.max(0, Number(e.target.value)) || null })}
                              />
                              <span className="layer-offset-unit">ms</span>
                            </span>
                          )}
                          <button type="button" className="layer-remove" onClick={(e) => { e.stopPropagation(); void removeLayer(layer.id) }}>×</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* --- Stacked Timeline --- */}
              {selectedPad.settings.multiMode === 'stacked' && selectedPad.settings.layers.length > 0 && (
                <StackedTimeline layers={selectedPad.settings.layers} padSettings={selectedPad.settings} sampleMap={sampleMap} />
              )}
              </>


              {/* --- MIDI Out section --- */}
              <div className="midi-out-section">
                <div className="midi-out-head">
                  <strong>MIDI Out</strong>
                  <label className="midi-out-enable">
                    <input
                      type="checkbox"
                      checked={selectedPad.settings.midiOut?.enabled ?? false}
                      onChange={(e) => void updatePadMidiOut(selectedPad.id, { enabled: e.target.checked })}
                    />
                    Enable
                  </label>
                </div>
                {selectedPad.settings.midiOut?.enabled && (
                  <div className="midi-out-body">
                    <label>
                      Device
                      <select
                        value={selectedPad.settings.midiOut?.deviceId ?? ''}
                        onChange={(e) => void updatePadMidiOut(selectedPad.id, { deviceId: e.target.value || null })}
                      >
                        <option value="">Default (first available)</option>
                        {midiOutputs.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Channel
                      <input
                        type="number"
                        min={1}
                        max={16}
                        value={selectedPad.settings.midiOut?.channel ?? 1}
                        onChange={(e) => void updatePadMidiOut(selectedPad.id, { channel: Math.max(1, Math.min(16, Number(e.target.value))) })}
                      />
                    </label>
                    <label>
                      Note
                      <span className="midi-out-note-name">{midiToName(selectedPad.settings.midiOut?.note ?? selectedPad.midiNote)}</span>
                      <input
                        type="number"
                        min={0}
                        max={127}
                        value={selectedPad.settings.midiOut?.note ?? selectedPad.midiNote}
                        onChange={(e) => void updatePadMidiOut(selectedPad.id, { note: Math.max(0, Math.min(127, Number(e.target.value))) })}
                      />
                    </label>
                    <label title="Fixed velocity (1–127), or -1 to follow trigger velocity">
                      Velocity
                      <select
                        value={selectedPad.settings.midiOut?.velocity === -1 ? 'follow' : 'fixed'}
                        onChange={(e) => void updatePadMidiOut(selectedPad.id, { velocity: e.target.value === 'follow' ? -1 : 100 })}
                      >
                        <option value="follow">Follow trigger</option>
                        <option value="fixed">Fixed</option>
                      </select>
                      {(selectedPad.settings.midiOut?.velocity ?? -1) >= 0 && (
                        <input
                          type="number"
                          min={1}
                          max={127}
                          value={selectedPad.settings.midiOut?.velocity ?? 100}
                          onChange={(e) => void updatePadMidiOut(selectedPad.id, { velocity: Math.max(1, Math.min(127, Number(e.target.value))) })}
                        />
                      )}
                    </label>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        !collapsed && <p>Select a pad.</p>
      )}
    </section>
  )
}
