import { useRef, useCallback, useState, useLayoutEffect } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { useStore } from '../store'
import { VuMeter } from './VuMeter'

function useDragNumber(opts: { min: number; max: number; step: number; getValue: () => number; onChange: (v: number) => void; onCommit: () => void }) {
  const startRef = useRef<{ y: number; value: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)
  const optsRef = useRef(opts)
  useLayoutEffect(() => { optsRef.current = opts })

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return
    const o = optsRef.current
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    startRef.current = { y: e.clientY, value: o.getValue() }

    const clamp = (v: number) => {
      const clipped = Math.max(o.min, Math.min(o.max, v))
      return Math.round(clipped / o.step) * o.step
    }

    const onMove = (pe: PointerEvent) => {
      if (!startRef.current) return
      pe.preventDefault()
      const delta = startRef.current.y - pe.clientY
      const range = o.max - o.min
      const next = clamp(startRef.current.value + (delta / 200) * range)
      pendingRef.current = next
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          if (pendingRef.current !== null) {
            optsRef.current.onChange(pendingRef.current)
            pendingRef.current = null
          }
        })
      }
    }

    const onUp = () => {
      startRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (pendingRef.current !== null) {
        optsRef.current.onChange(pendingRef.current)
        pendingRef.current = null
      }
      optsRef.current.onCommit()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return onPointerDown
}

const BUFFER_SIZES = [128, 256, 512, 768, 1024] as const

export function SettingsContent() {
  const [bufferSize, setBufferSize] = useState(() => audioEngine.getBufferSize())

  const midiInputEnabled = useStore((s) => s.midiInputEnabled)
  const midiInputDeviceId = useStore((s) => s.midiInputDeviceId)
  const padMidiChannel = useStore((s) => s.padMidiChannel)
  const launchpadSpecialMode = useStore((s) => s.launchpadSpecialMode)
  const midiInputs = useStore((s) => s.midiInputs)
  const audioOutputs = useStore((s) => s.audioOutputs)
  const audioOutputDeviceId = useStore((s) => s.audioOutputDeviceId)
  const audioInputs = useStore((s) => s.audioInputs)
  const audioInputDeviceId = useStore((s) => s.audioInputDeviceId)
  const metronomeVolume = useStore((s) => s.metronomeVolume)
  const showMetadataTags = useStore((s) => s.showMetadataTags)
  const metadataTagWhitelist = useStore((s) => s.metadataTagWhitelist)

  const toggleTag = (tag: string) => {
    const next = new Set(metadataTagWhitelist)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    useStore.setState({ metadataTagWhitelist: next })
    localStorage.setItem('metadataTagWhitelist', JSON.stringify([...next]))
  }

  const TAG_OPTIONS = [
    { id: 'INAM', label: 'Name' },
    { id: 'IART', label: 'Artist' },
    { id: 'ICMT', label: 'Comment' },
    { id: 'IPRD', label: 'Product' },
    { id: 'ISFT', label: 'Software' },
    { id: 'IGNR', label: 'Genre' },
    { id: 'IKEY', label: 'Keywords' },
  ] as const

  return (
    <>
      <strong className="settings-section-title">Sample Metadata Tags</strong>
      <label className="settings-row">
        <span>Show tags</span>
        <input
          type="checkbox"
          checked={showMetadataTags}
          onChange={(e) => {
            useStore.setState({ showMetadataTags: e.target.checked })
            localStorage.setItem('showMetadataTags', String(e.target.checked))
          }}
        />
      </label>
      {showMetadataTags && (
        <div className="settings-tag-list">
          {TAG_OPTIONS.map((tag) => (
            <label key={tag.id} className="settings-row settings-tag-row">
              <span>{tag.label}</span>
              <input
                type="checkbox"
                checked={metadataTagWhitelist.has(tag.id)}
                onChange={() => toggleTag(tag.id)}
              />
            </label>
          ))}
        </div>
      )}

      <strong className="settings-section-title">MIDI Input</strong>
      <label className="settings-row">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={midiInputEnabled}
          onChange={() => useStore.setState((s) => ({ midiInputEnabled: !s.midiInputEnabled }))}
        />
      </label>
      {midiInputEnabled && (
        <>
          <label className="settings-row">
            <span>Device</span>
            <select
              value={midiInputDeviceId ?? ''}
              onChange={(e) => useStore.setState({ midiInputDeviceId: e.target.value || null })}
            >
              <option value="">All devices</option>
              {midiInputs.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span>Pad Channel</span>
            <select
              value={padMidiChannel ?? ''}
              onChange={(e) => useStore.setState({ padMidiChannel: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">All</option>
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i + 1} value={i + 1}>Ch {i + 1}</option>
              ))}
            </select>
          </label>
          {midiInputs.some((d) => d.name.toLowerCase().includes('launchpad') || d.name.toLowerCase().includes('lppromk3')) && (
            <label className="settings-row">
              <span>LP Pro MK3 Mode</span>
              <input
                type="checkbox"
                checked={launchpadSpecialMode}
                onChange={(e) => {
                  useStore.setState({ launchpadSpecialMode: e.target.checked })
                  localStorage.setItem('launchpadSpecialMode', String(e.target.checked))
                  // Force reconnect by reloading
                  window.location.reload()
                }}
              />
            </label>
          )}
        </>
      )}
      {midiInputEnabled && midiInputs.length === 0 && (
        <p className="settings-hint">No MIDI devices detected.</p>
      )}

      <strong className="settings-section-title">Audio Output</strong>
      <label className="settings-row">
        <span>Device</span>
        <select
          value={audioOutputDeviceId ?? ''}
          onChange={(e) => useStore.setState({ audioOutputDeviceId: e.target.value || null })}
        >
          <option value="">System default</option>
          {audioOutputs.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>

      <strong className="settings-section-title">Audio Input</strong>
      <label className="settings-row">
        <span>Device</span>
        <select
          value={audioInputDeviceId ?? ''}
          onChange={(e) => {
            const val = e.target.value || null
            useStore.setState({ audioInputDeviceId: val })
            if (val) localStorage.setItem('audioInputDeviceId', val)
            else localStorage.removeItem('audioInputDeviceId')
          }}
        >
          <option value="">System default</option>
          {audioInputs.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>

      <strong className="settings-section-title">Metronome</strong>
      <label className="settings-row">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(metronomeVolume * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100
            useStore.setState({ metronomeVolume: v })
            localStorage.setItem('metronomeVolume', String(v))
          }}
          style={{ width: 80 }}
        />
      </label>

      <strong className="settings-section-title">Audio Engine</strong>
      <label className="settings-row">
        <span>Buffer Size</span>
        <select
          value={bufferSize}
          onChange={(e) => {
            const size = Number(e.target.value)
            setBufferSize(size)
            void audioEngine.setBufferSize(size)
          }}
        >
          {BUFFER_SIZES.map((s) => (
            <option key={s} value={s}>{s} samples</option>
          ))}
        </select>
      </label>
      <p className="settings-hint">Lower = less latency, higher CPU. Requires stopping playback.</p>
    </>
  )
}

function SettingsPopover() {
  const [open, setOpen] = useState(false)

  return (
    <div className="settings-popover-wrap">
      <button type="button" className="tb-secondary tb-gear" onClick={() => setOpen((o) => !o)} title="Settings">
        &#x2699;
      </button>
      {open && (
        <div className="settings-popover">
          <SettingsContent />
        </div>
      )}
    </div>
  )
}

export function TopBar({ isPhone }: { isPhone?: boolean }) {
  const project = useStore((s) => s.project)
  const isPlaying = useStore((s) => s.isPlaying)
  const loopEnabled = useStore((s) => s.loopEnabled)
  const bpmDraft = useStore((s) => s.bpmDraft)
  const swingDraft = useStore((s) => s.swingDraft)
  const projectNameDraft = useStore((s) => s.projectNameDraft)
  const seqRecordArmed = useStore((s) => s.seqRecordArmed)
  const seqRecordQuantize = useStore((s) => s.seqRecordQuantize)
  const seqRecordOverdub = useStore((s) => s.seqRecordOverdub)
  const captureBufferCount = useStore((s) => s.captureBufferCount)
  const midiInputEnabled = useStore((s) => s.midiInputEnabled)
  const computerKeyboardEnabled = useStore((s) => s.computerKeyboardEnabled)
  const computerKeyboardOctave = useStore((s) => s.computerKeyboardOctave)
  const metronomeEnabled = useStore((s) => s.metronomeEnabled)
  const countdownBars = useStore((s) => s.countdownBars)

  const {
    saveProject,
    initializeCurrentProject,
    stopTransport,
    togglePlayPause,
    commitBpmDraft,
    commitSwingDraft,
    commitProjectNameDraft,
    tapTempo,
  } = useStore.getState()

  const bpmDrag = useDragNumber({
    min: 50, max: 200, step: 1,
    getValue: () => Number(bpmDraft) || 120,
    onChange: (v) => useStore.setState({ bpmDraft: String(v) }),
    onCommit: () => void commitBpmDraft(),
  })

  const swingDrag = useDragNumber({
    min: 0, max: 100, step: 1,
    getValue: () => Number(swingDraft) || 0,
    onChange: (v) => useStore.setState({ swingDraft: String(v) }),
    onCommit: () => void commitSwingDraft(),
  })

  const [nameEditing, setNameEditing] = useState(false)

  if (!project) return null

  return (
    <header className={`topbar sticky${isPhone ? ' topbar-phone' : ''}`}>
      {isPhone ? (
        <>
          {/* Phone: minimal project name (double-tap to edit) */}
          <div className="tb-cluster tb-project">
            <span className="tb-wordmark">OS</span>
            {nameEditing ? (
              <input
                className="tb-project-name"
                type="text"
                autoFocus
                value={projectNameDraft}
                onChange={(e) => useStore.setState({ projectNameDraft: e.target.value })}
                onBlur={() => { void commitProjectNameDraft(); setNameEditing(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                title="Project name"
              />
            ) : (
              <span
                className="tb-project-name-readonly"
                onDoubleClick={() => setNameEditing(true)}
                title="Double-tap to edit"
              >
                {projectNameDraft}
              </span>
            )}
          </div>

          {/* Phone: BPM only */}
          <div className="tb-cluster tb-params">
            <div className="tb-led-group">
              <span className="tb-led-label">BPM</span>
              <input
                className="tb-led-value"
                style={{ cursor: 'ns-resize', width: 40 }}
                type="number"
                min={50}
                max={200}
                value={bpmDraft}
                onChange={(e) => useStore.setState({ bpmDraft: e.target.value })}
                onBlur={() => void commitBpmDraft()}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                onPointerDown={bpmDrag}
              />
            </div>
          </div>

          {/* Phone: Play/Stop/Loop only */}
          <div className="tb-cluster tb-transport">
            <button type="button" className={`tb-play ${isPlaying ? 'playing' : ''}`} onClick={togglePlayPause}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button type="button" className="tb-stop" onClick={stopTransport} disabled={!isPlaying}>■</button>
            <button
              type="button"
              className={`tb-loop ${loopEnabled ? 'on' : ''}`}
              onClick={() => useStore.setState((s) => ({ loopEnabled: !s.loopEnabled }))}
              title={loopEnabled ? 'Loop On' : 'Loop Off'}
            >
              ⟳
            </button>
          </div>

          {/* Phone: Settings gear only */}
          <div className="tb-cluster tb-actions">
            <SettingsPopover />
          </div>
        </>
      ) : (
        <>
          {/* Project cluster */}
          <div className="tb-cluster tb-project">
            <span className="tb-wordmark">OS</span>
            <input
              className="tb-project-name"
              type="text"
              value={projectNameDraft}
              onChange={(e) => useStore.setState({ projectNameDraft: e.target.value })}
              onBlur={() => void commitProjectNameDraft()}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              title="Project name"
            />
          </div>

          {/* Parameters cluster */}
          <div className="tb-cluster tb-params">
            <div className="tb-led-group">
              <span className="tb-led-label">BPM</span>
              <input
                className="tb-led-value"
                style={{ cursor: 'ns-resize' }}
                type="number"
                min={50}
                max={200}
                value={bpmDraft}
                onChange={(e) => useStore.setState({ bpmDraft: e.target.value })}
                onBlur={() => void commitBpmDraft()}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                onPointerDown={bpmDrag}
              />
            </div>
            <div className="tb-led-group">
              <span className="tb-led-label">SWG</span>
              <input
                className="tb-led-value"
                style={{ cursor: 'ns-resize' }}
                type="number"
                min={0}
                max={100}
                value={swingDraft}
                onChange={(e) => useStore.setState({ swingDraft: e.target.value })}
                onBlur={() => void commitSwingDraft()}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                onPointerDown={swingDrag}
              />
            </div>
            <button type="button" className="tb-tap" onClick={tapTempo}>TAP</button>
            <div className="tb-led-group">
              <span className="tb-led-label">POLY</span>
              <select
                className="tb-led-value"
                value={project.polyphony}
                onChange={(e) => {
                  const polyphony = Number(e.target.value) as 4 | 8 | 16 | 32
                  audioEngine.setPolyphony(polyphony)
                  void saveProject({ ...project, polyphony })
                }}
              >
                <option value={4}>4</option>
                <option value={8}>8</option>
                <option value={16}>16</option>
                <option value={32}>32</option>
              </select>
            </div>
          </div>

          {/* Transport cluster */}
          <div className="tb-cluster tb-transport">
            <button type="button" className={`tb-play ${isPlaying ? 'playing' : ''}`} onClick={togglePlayPause}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button type="button" className="tb-stop" onClick={stopTransport} disabled={!isPlaying}>■</button>
            <button
              type="button"
              className={`tb-loop ${loopEnabled ? 'on' : ''}`}
              onClick={() => useStore.setState((s) => ({ loopEnabled: !s.loopEnabled }))}
              title={loopEnabled ? 'Loop On' : 'Loop Off'}
            >
              ⟳
            </button>
            <button
              type="button"
              className={`tb-metronome ${metronomeEnabled ? 'on' : ''}`}
              onClick={() => {
                const next = !metronomeEnabled
                useStore.setState({ metronomeEnabled: next })
                localStorage.setItem('metronomeEnabled', String(next))
              }}
              title={metronomeEnabled ? 'Metronome On' : 'Metronome Off'}
            >
              MET
            </button>
          </div>

           {/* Seq record cluster */}
           <div className="tb-cluster tb-rec">
             <button
               type="button"
               className={`seq-rec-btn ${seqRecordArmed ? 'armed' : ''}`}
               onClick={() => useStore.setState((s) => ({ seqRecordArmed: !s.seqRecordArmed }))}
               title="Arm sequencer recording"
             >
               ● REC
             </button>
             <button
               type="button"
               className={`tb-capture ${captureBufferCount > 0 ? 'has-data' : ''}`}
               onClick={() => void useStore.getState().captureMidi()}
               disabled={captureBufferCount === 0}
               title={captureBufferCount > 0 ? `Capture MIDI (${captureBufferCount} notes buffered)` : 'Capture MIDI — play some notes first'}
             >
               ⊞ CAP
             </button>
            <button
              type="button"
              className={`seq-rec-option ${seqRecordQuantize ? 'active-toggle' : ''}`}
              onClick={() => useStore.setState((s) => ({ seqRecordQuantize: !s.seqRecordQuantize }))}
              title="Quantize recorded hits to grid"
            >
              Q
            </button>
            <button
              type="button"
              className={`seq-rec-option ${seqRecordOverdub ? 'active-toggle' : ''}`}
              onClick={() => useStore.setState((s) => ({ seqRecordOverdub: !s.seqRecordOverdub }))}
              title={seqRecordOverdub ? 'Overdub mode: adds to existing events' : 'Replace mode: clears pad events on first hit'}
            >
              {seqRecordOverdub ? 'OVR' : 'REP'}
            </button>
            <select
              className="seq-rec-countdown"
              value={countdownBars}
              onChange={(e) => {
                const v = Number(e.target.value)
                useStore.setState({ countdownBars: v })
                localStorage.setItem('countdownBars', String(v))
              }}
              title="Count-in bars before recording (requires metronome)"
            >
              <option value={0}>No count-in</option>
              <option value={1}>1 bar</option>
              <option value={2}>2 bars</option>
              <option value={4}>4 bars</option>
            </select>
          </div>

          {/* MIDI + keyboard toggles */}
          <div className="tb-cluster tb-midi-in">
            <button
              type="button"
              className={`tb-midi-toggle ${midiInputEnabled ? 'on' : ''}`}
              onClick={() => useStore.setState((s) => ({ midiInputEnabled: !s.midiInputEnabled }))}
              title={midiInputEnabled ? 'MIDI input enabled — click to disable' : 'MIDI input disabled — click to enable'}
            >
              MIDI
            </button>
            <button
              type="button"
              className={`tb-keyboard-toggle ${computerKeyboardEnabled ? 'on' : ''}`}
              onClick={() => useStore.setState((s) => ({ computerKeyboardEnabled: !s.computerKeyboardEnabled }))}
              title={computerKeyboardEnabled ? `Computer keyboard: ON (Oct ${computerKeyboardOctave}, -/= to shift)` : 'Computer keyboard input: OFF'}
            >
              ⌨{computerKeyboardEnabled ? ` C${computerKeyboardOctave}` : ''}
            </button>
          </div>

          {/* VU + actions cluster */}
          <div className="tb-cluster tb-actions">
            <VuMeter />
            <button type="button" className="tb-secondary" onClick={() => useStore.setState({ showExportDialog: true })}>
              Export
            </button>
            <button type="button" className="tb-secondary" onClick={() => useStore.setState({ showImportDialog: true })}>
              Import
            </button>
            <button type="button" className="tb-secondary" onClick={() => void initializeCurrentProject()}>
              Init
            </button>
            <button type="button" className="tb-secondary" onClick={() => window.location.reload()}>
              Refresh
            </button>
            <SettingsPopover />
          </div>
        </>
      )}
    </header>
  )
}
