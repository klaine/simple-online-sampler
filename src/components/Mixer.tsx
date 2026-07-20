import { useState, useRef, useEffect, useCallback } from 'react'
import type { BusId, EffectSlot, EffectType, MixBus } from '../types'
import { BUS_IDS } from '../types'
import { useStore } from '../store'
import { audioEngine } from '../lib/audioEngine'
import { KnobControl } from './KnobControl'
const EFFECT_TYPES: { value: EffectType; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'compressor', label: 'Comp' },
  { value: 'sidechain-compressor', label: 'SC Comp' },
  { value: 'eq3', label: 'EQ3' },
  { value: 'delay', label: 'Delay' },
  { value: 'reverb', label: 'Reverb' },
  { value: 'chorus', label: 'Chorus' },
]

// ---------------------------------------------------------------------------
// Custom Vertical Fader (pointer-drag based)
// ---------------------------------------------------------------------------

function Fader({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)

  const computeValue = useCallback(
    (clientY: number) => {
      const track = trackRef.current
      if (!track) return value
      const rect = track.getBoundingClientRect()
      // top = max, bottom = min
      const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      return min + ratio * (max - min)
    },
    [min, max, value],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      onChange(computeValue(e.clientY))

      const onMove = (ev: PointerEvent) => {
        onChange(computeValue(ev.clientY))
      }
      const onUp = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId)
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
    },
    [computeValue, onChange],
  )

  const pct = ((value - min) / (max - min)) * 100

  return (
    <div className="fader" ref={trackRef} onPointerDown={onPointerDown}>
      <div className="fader-track" />
      <div className="fader-fill" style={{ height: `${pct}%` }} />
      <div className="fader-thumb" style={{ bottom: `${pct}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Level Meter (per-bus or master)
// ---------------------------------------------------------------------------

function LevelMeter({ getBusId, isMaster }: { getBusId?: BusId; isMaster?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const dataRef = useRef<Uint8Array | null>(null)

  useEffect(() => {
    // Silence gating: once silent, only sample every ~10th frame and skip redraws
    let silentStreak = 0
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      const analyser = isMaster
        ? audioEngine.getMasterAnalyser()
        : getBusId ? audioEngine.getBusAnalyser(getBusId) : null
      const canvas = canvasRef.current
      if (!analyser || !canvas) return

      if (silentStreak > 12) {
        silentStreak++
        if (silentStreak % 10 !== 0) return
      }

      if (!dataRef.current || dataRef.current.length !== analyser.frequencyBinCount) {
        dataRef.current = new Uint8Array(analyser.frequencyBinCount)
      }

      analyser.getByteTimeDomainData(dataRef.current as Uint8Array<ArrayBuffer>)

      let sum = 0
      for (let i = 0; i < dataRef.current.length; i++) {
        const v = (dataRef.current[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / dataRef.current.length)
      const level = Math.min(1, rms * 3)

      const silent = level < 0.004
      silentStreak = silent ? silentStreak + 1 : 0
      if (silent && silentStreak > 12) return // already showing empty meter

      const ctx = canvas.getContext('2d')
      if (ctx) {
        const w = canvas.width
        const h = canvas.height
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = '#111'
        ctx.fillRect(0, 0, w, h)

        const barH = Math.round(level * h)
        const green = level < 0.6
        const yellow = level >= 0.6 && level < 0.85
        ctx.fillStyle = green ? '#3a3' : yellow ? '#bb3' : '#c33'
        ctx.fillRect(0, h - barH, w, barH)
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [getBusId, isMaster])

  return <canvas ref={canvasRef} className="mixer-meter" width={8} height={140} />
}

// ---------------------------------------------------------------------------
// Effect Slot UI
// ---------------------------------------------------------------------------

export function EffectSlotUI({
  slot,
  currentBusId,
  onTypeChange,
  onEnabledChange,
  onParamChange,
  onSidechainSourceChange,
}: {
  slot: EffectSlot
  currentBusId?: BusId
  onTypeChange: (type: EffectType) => void
  onEnabledChange: (enabled: boolean) => void
  onParamChange: (name: string, value: number) => void
  onSidechainSourceChange?: (source: BusId) => void
}) {
  const [expanded, setExpanded] = useState(false)

  // Filter out SC Comp from master channel (no bus to sidechain from)
  const availableTypes = currentBusId
    ? EFFECT_TYPES
    : EFFECT_TYPES.filter((t) => t.value !== 'sidechain-compressor')

  return (
    <div className={`mixer-fx-slot ${slot.type !== 'off' ? 'active' : ''}`}>
      <div className="mixer-fx-slot-head">
        <select
          className="mixer-fx-type"
          value={slot.type}
          onChange={(e) => onTypeChange(e.target.value as EffectType)}
        >
          {availableTypes.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {slot.type !== 'off' && (
          <>
            <button
              type="button"
              className={`mixer-fx-enable ${slot.enabled ? 'on' : ''}`}
              onClick={() => onEnabledChange(!slot.enabled)}
            >
              {slot.enabled ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              className="mixer-fx-expand"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '▾' : '▸'}
            </button>
          </>
        )}
      </div>
      {expanded && slot.type !== 'off' && (
        <div className="mixer-fx-params">
          {slot.type === 'compressor' && (
            <>
              <KnobControl label="Thresh" value={slot.params.threshold ?? -18} min={-50} max={0} step={0.5} precision={1} onChange={(v) => onParamChange('threshold', v)} />
              <KnobControl label="Ratio" value={slot.params.ratio ?? 4} min={1} max={20} step={0.1} precision={1} onChange={(v) => onParamChange('ratio', v)} />
              <KnobControl label="Knee" value={slot.params.knee ?? 10} min={0} max={40} step={1} precision={0} onChange={(v) => onParamChange('knee', v)} />
              <KnobControl label="Atk" value={slot.params.attack ?? 0.003} min={0} max={1} step={0.001} onChange={(v) => onParamChange('attack', v)} />
              <KnobControl label="Rel" value={slot.params.release ?? 0.25} min={0} max={1} step={0.01} onChange={(v) => onParamChange('release', v)} />
            </>
          )}
          {slot.type === 'sidechain-compressor' && currentBusId && (
            <>
              <div className="mixer-sc-source">
                <label className="mixer-sc-label">Key</label>
                <select
                  className="mixer-sc-select"
                  value={slot.sidechainSource ?? ''}
                  onChange={(e) => onSidechainSourceChange?.(e.target.value as BusId)}
                >
                  <option value="" disabled>Source</option>
                  {BUS_IDS.filter((id) => id !== currentBusId).map((id) => (
                    <option key={id} value={id}>Bus {id}</option>
                  ))}
                </select>
              </div>
              <KnobControl label="Thresh" value={slot.params.threshold ?? -18} min={-50} max={0} step={0.5} precision={1} onChange={(v) => onParamChange('threshold', v)} />
              <KnobControl label="Ratio" value={slot.params.ratio ?? 4} min={1} max={20} step={0.1} precision={1} onChange={(v) => onParamChange('ratio', v)} />
              <KnobControl label="Knee" value={slot.params.knee ?? 10} min={0} max={40} step={1} precision={0} onChange={(v) => onParamChange('knee', v)} />
              <KnobControl label="Atk" value={slot.params.attack ?? 0.003} min={0} max={1} step={0.001} onChange={(v) => onParamChange('attack', v)} />
              <KnobControl label="Rel" value={slot.params.release ?? 0.25} min={0} max={1} step={0.01} onChange={(v) => onParamChange('release', v)} />
            </>
          )}
          {slot.type === 'eq3' && (
            <>
              <KnobControl label="Low" value={slot.params.lowGain ?? 0} min={-12} max={12} step={0.5} precision={1} onChange={(v) => onParamChange('lowGain', v)} />
              <KnobControl label="Mid" value={slot.params.midGain ?? 0} min={-12} max={12} step={0.5} precision={1} onChange={(v) => onParamChange('midGain', v)} />
              <KnobControl label="High" value={slot.params.highGain ?? 0} min={-12} max={12} step={0.5} precision={1} onChange={(v) => onParamChange('highGain', v)} />
              <KnobControl label="MidF" value={slot.params.midFreq ?? 1000} min={200} max={8000} step={10} precision={0} onChange={(v) => onParamChange('midFreq', v)} />
            </>
          )}
          {slot.type === 'delay' && (
            <>
              <KnobControl label="Time" value={slot.params.time ?? 0.3} min={0.01} max={2} step={0.01} onChange={(v) => onParamChange('time', v)} />
              <KnobControl label="Fdbk" value={slot.params.feedback ?? 0.35} min={0} max={0.95} step={0.01} onChange={(v) => onParamChange('feedback', v)} />
              <KnobControl label="Mix" value={slot.params.mix ?? 0.3} min={0} max={1} step={0.01} onChange={(v) => onParamChange('mix', v)} />
            </>
          )}
          {slot.type === 'reverb' && (
            <>
              <KnobControl label="Decay" value={slot.params.decay ?? 1.5} min={0.1} max={8} step={0.1} precision={1} onChange={(v) => onParamChange('decay', v)} />
              <KnobControl label="Mix" value={slot.params.mix ?? 0.25} min={0} max={1} step={0.01} onChange={(v) => onParamChange('mix', v)} />
            </>
          )}
          {slot.type === 'chorus' && (
            <>
              <KnobControl label="Rate" value={slot.params.rate ?? 1.5} min={0.1} max={10} step={0.1} precision={1} onChange={(v) => onParamChange('rate', v)} />
              <KnobControl label="Depth" value={slot.params.depth ?? 5} min={0} max={20} step={0.5} precision={1} onChange={(v) => onParamChange('depth', v)} />
              <KnobControl label="Mix" value={slot.params.mix ?? 0.3} min={0} max={1} step={0.01} onChange={(v) => onParamChange('mix', v)} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bus Channel
// ---------------------------------------------------------------------------

function BusChannel({ bus }: { bus: MixBus }) {
  const {
    setBusName,
    setBusGain,
    setBusPan,
    setBusMute,
    setBusSolo,
    setBusEffectType,
    setBusEffectEnabled,
    setBusEffectParam,
    setBusEffectSidechainSource,
  } = useStore.getState()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(bus.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commitName = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== bus.name) setBusName(bus.id, trimmed)
    setEditing(false)
  }

  return (
    <div className={`mixer-channel ${bus.mute ? 'muted' : ''}`}>
      {editing ? (
        <input
          ref={inputRef}
          className="mixer-channel-label-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditing(false) }}
          autoFocus
        />
      ) : (
        <div className="mixer-channel-label" onDoubleClick={() => { setDraft(bus.name); setEditing(true) }}>{bus.name}</div>
      )}
      <div className="mixer-fader-area">
        <LevelMeter getBusId={bus.id} />
        <Fader
          value={bus.gain}
          min={0}
          max={2}
          onChange={(v) => setBusGain(bus.id, v)}
        />
        <span className="mixer-fader-value">{(bus.gain * 100).toFixed(0)}%</span>
      </div>
      <KnobControl label="Pan" value={bus.pan} min={-1} max={1} step={0.01} onChange={(v) => setBusPan(bus.id, v)} />
      <div className="mixer-channel-btns">
        <button type="button" className={`mixer-mute ${bus.mute ? 'active' : ''}`} onClick={() => setBusMute(bus.id, !bus.mute)}>M</button>
        <button type="button" className={`mixer-solo ${bus.solo ? 'active' : ''}`} onClick={() => setBusSolo(bus.id, !bus.solo)}>S</button>
      </div>
      {bus.effects.map((slot, i) => (
        <EffectSlotUI
          key={slot.id}
          slot={slot}
          currentBusId={bus.id}
          onTypeChange={(t) => setBusEffectType(bus.id, i, t)}
          onEnabledChange={(e) => setBusEffectEnabled(bus.id, i, e)}
          onParamChange={(n, v) => setBusEffectParam(bus.id, i, n, v)}
          onSidechainSourceChange={(src) => setBusEffectSidechainSource(bus.id, i, src)}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Master Channel
// ---------------------------------------------------------------------------

function MasterChannel() {
  const masterBus = useStore((s) => s.project?.masterBus)
  const {
    setMasterGain,
    setMasterEffectType,
    setMasterEffectEnabled,
    setMasterEffectParam,
  } = useStore.getState()

  if (!masterBus) return null

  return (
    <div className="mixer-channel mixer-master">
      <div className="mixer-channel-label">Master</div>
      <div className="mixer-fader-area">
        <LevelMeter isMaster />
        <Fader
          value={masterBus.gain}
          min={0}
          max={2}
          onChange={(v) => setMasterGain(v)}
        />
        <span className="mixer-fader-value">{(masterBus.gain * 100).toFixed(0)}%</span>
      </div>
      {masterBus.effects.map((slot, i) => (
        <EffectSlotUI
          key={slot.id}
          slot={slot}
          onTypeChange={(t) => setMasterEffectType(i, t)}
          onEnabledChange={(e) => setMasterEffectEnabled(i, e)}
          onParamChange={(n, v) => setMasterEffectParam(i, n, v)}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Input Monitor Strip
// ---------------------------------------------------------------------------

function InputMonitorStrip() {
  const audioMonitorEnabled = useStore((s) => s.audioMonitorEnabled)
  const audioMonitorDeviceId = useStore((s) => s.audioMonitorDeviceId)
  const audioMonitorBusId = useStore((s) => s.audioMonitorBusId)
  const { setAudioMonitorEnabled, setAudioMonitorDeviceId, setAudioMonitorBusId } = useStore.getState()

  const [audioInputs, setAudioInputs] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null)

  // Enumerate audio input devices
  useEffect(() => {
    const enumerate = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const inputs = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ id: d.deviceId, name: d.label || `Input ${d.deviceId.slice(0, 6)}` }))
        setAudioInputs(inputs)
      } catch {
        // silently ignore
      }
    }
    enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  const handleToggle = async () => {
    if (audioMonitorEnabled) {
      setAudioMonitorEnabled(false)
    } else {
      setError(null)
      setAudioMonitorEnabled(true)
    }
  }

  return (
    <div className="mixer-monitor-strip">
      <span className="mixer-monitor-label">In Mon</span>
      <button
        type="button"
        className={`mixer-monitor-toggle ${audioMonitorEnabled ? 'on' : ''}`}
        onClick={handleToggle}
        title={audioMonitorEnabled ? 'Stop monitoring' : 'Start monitoring audio input'}
      >
        {audioMonitorEnabled ? 'On' : 'Off'}
      </button>
      <select
        className="mixer-monitor-device"
        value={audioMonitorDeviceId ?? ''}
        onChange={(e) => setAudioMonitorDeviceId(e.target.value || null)}
        title="Audio input device"
      >
        <option value="">Default</option>
        {audioInputs.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
      <select
        className="mixer-monitor-bus"
        value={audioMonitorBusId}
        onChange={(e) => setAudioMonitorBusId(e.target.value as BusId)}
        title="Route to bus"
      >
        {BUS_IDS.map((id) => (
          <option key={id} value={id}>Bus {id}</option>
        ))}
      </select>
      {error && <span className="mixer-monitor-error">{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mixer Panel
// ---------------------------------------------------------------------------

export function Mixer() {
  const mixBuses = useStore((s) => s.project?.mixBuses)
  const [collapsed, setCollapsed] = useState(false)

  if (!mixBuses) return null

  return (
    <section className={`mixer-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="mixer-head">
        <h3>Mixer</h3>
        <button
          type="button"
          className="mixer-toggle"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="mixer-body">
          <div className="mixer-channels">
            {mixBuses.map((bus) => (
              <BusChannel key={bus.id} bus={bus} />
            ))}
            <div className="mixer-divider" />
            <MasterChannel />
          </div>
          <InputMonitorStrip />
        </div>
      )}
    </section>
  )
}
