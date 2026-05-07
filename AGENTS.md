# Agent Instructions

Browser-based sampler/sequencer — React + TypeScript + Vite, Zustand + immer state management, raw Web Audio API (no Tone.js).

## Primary Goals

- Keep sequencer playback behavior and offline export behavior aligned.
- Preserve a compact, dense UI layout (especially sequencer + center column).
- Avoid regressions in trim, pitch, mode-specific playback, multisample, and per-pad filter behavior.

## Dev Commands

- Install: `npm install`
- Dev server: `npm run dev`
- Build/typecheck: `npm run build`

## Architecture

### State Management
- Zustand store with immer middleware assembled from slice factories: `src/store/index.ts` (~574 lines) imports 16 domain slices from `src/store/slices/`
- Store infrastructure modules: `types.ts`, `constants.ts`, `helpers.ts`, `selectors.ts`, `visualStore.ts`, `confirmDialog.ts`, `refs.ts`, `importHelpers.ts`, `context.ts`
- All state, actions, and selectors live in the store
- App.tsx (~1520 lines) is a thin shell: effects, drag handlers, export callbacks, layout, computer keyboard chromatic input handler
- Sequencer render is optimized with pre-computed `Map<padId, Map<step, event>>` selectors and a lightweight custom lane virtualizer (`VirtualizedSequencerLanes.tsx`)
- Module-level `mutableRefs` object (in `refs.ts`) exposes mutable refs (not reactive) for drag state, frozen zoom range, etc.
- **Transport visual state** (`playheadStep`, `sequencedPadHits`) lives in a lightweight `transportVisualStore` (not immer) — subscribed via `useSyncExternalStore` for performance
- **Confirm dialogs** use a promise-based `showConfirm()` helper with module-level resolver — no native `window.confirm()` calls

### Audio
- Raw Web Audio API — single lazy `AudioContext`, `AudioBufferSourceNode` + `GainNode` per voice
- `AnalyserNode` for VU meter
- Per-pad `BiquadFilterNode` (LP/HP/BP)
- Multisample: round-robin, random, velocity-layer, stacked modes with `SampleLayer[]` per pad
- Round-robin counters are module-level Maps in audioEngine.ts / audioExport.ts (not in store)
- 4 mix buses (A/B/C/D) with gain, pan, mute/solo, 3 effect slots each
- Master bus with gain and 3 effect slots
- Per-bus `AnalyserNode` for level metering
- Effects: Compressor, Sidechain Compressor (AudioWorklet), EQ3, Delay, Reverb, Chorus
- Sidechain compressor uses `AudioWorkletNode` with 2 inputs (audio + key signal from another bus)
- Choke groups (1–8): voices in same group cut each other with 5ms fade-out, **time-aligned with scheduled `atTimeSec`** (not `currentTime`) so pre-scheduled sequencer notes choke at the correct moment. Dispose is deferred via `setTimeout` to avoid killing nodes before the scheduled fade completes.
- ADSR envelope model: attack ramps to peak gain, decay ramps to sustain level (peak * sustain), release ramps to zero
- **Bus/master gain/pan changes use `setTargetAtTime` with 5ms tau** — no instantaneous `.value =` writes (prevents clicks on mute/solo)
- **Effect param changes use `setTargetAtTime` with 10ms tau** via `updateBusEffectParams`/`updateMasterEffectParams` — no graph rebuild for knob turns
- **Sample preview** plays through `AudioContext` via master bus (`playPreview`/`stopPreview` in audioEngine) — no `HTMLAudioElement` (avoids glitches during sequencer playback)
- **Audio buffer size**: configurable (128/256/512/768/1024) via settings popover; `setBufferSize()` tears down and rebuilds AudioContext; persisted in localStorage
- **Shared voice utilities** (`voiceUtils.ts`): `mergeLayerSettings`, `resolveFilterType`, `resolveLayer`, `createFilterChain`, `scheduleAmplitudeEnvelope`, `createPanNode` — consumed by both `audioEngine.ts` (live) and `audioExport.ts` (offline) to prevent drift

### Transport
- `TransportScheduler` with worker-based clock (`transportClock.worker.ts`)
- `PlaybackSnapshot` carries pad/pattern/swing data for the scheduler (NOT mixer data)
- Snapshot rebuild is guarded — skips when only mixer/effect fields changed
- Swing: offsets odd steps forward by `swing/100 * 0.5 * stepDuration` (MPC-style)
- Sequencer live recording: record arm + quantize + overdub/replace modes
- MIDI out timing accounts for `audioContext.outputLatency` to align with audio
- **Metronome**: synthesized click (sine oscillator burst) on quarter-note boundaries, accent on beat 1; `playMetronomeClick` in audioEngine.ts
- **Count-in**: when `seqRecordArmed` + `countdownBars > 0` + metronome enabled, N bars of metronome play before transport starts
- `metronomeBeats` array in `SchedulerTickResult` carries `{ atTimeSec, accent }` per quarter-note step

## Important Files

### Core
- `src/store/index.ts` — Zustand store: state + slice assembly (~574 lines)
- `src/store/types.ts` — `AppState`, `SequencerHistorySnapshot`, `Toast`, `PerfStatsState`, `SequencerBankGroup`
- `src/store/constants.ts` — `PATTERN_COLORS`, `PATTERN_COLORS_CYCLE`, `PRESET_KITS`
- `src/store/helpers.ts` — `normalizeProject`, `createLayer`, `memoize`, `getLaneBoundsForEvent`, `updateGateEventRange`, `getDefaultEffectParams`
- `src/store/selectors.ts` — All memoized selectors (`selectSelectedPad`, `selectEventsByPadAndStep`, `selectSequencerBankGroups`, etc.)
- `src/store/visualStore.ts` — `transportVisualStore` pub/sub (no immer)
- `src/store/confirmDialog.ts` — `showConfirm()` / `resolveConfirmDialog()` promise-based dialog
- `src/store/refs.ts` — Module-level `mutableRefs` object (capture buffer, active recording notes, drag state, etc.) + `storeRefs` export
- `src/store/importHelpers.ts` — `importFileAsSample`, `loadPresetKits`
- `src/store/context.ts` — `StoreContext` interface for slice factories
- `src/store/slices/` — 15 domain slice factories: `project.ts`, `pad.ts`, `transport.ts`, `sequencer.ts`, `pianoRoll.ts`, `patterns.ts`, `songChain.ts`, `library.ts`, `sampleGroups.ts`, `chopSpreadDrag.ts`, `recording.ts`, `midiOut.ts`, `mixer.ts`, `ui.ts`, `audioMonitor.ts`, `history.ts`
- `src/App.tsx` — App shell: effects, drag handlers, export callbacks, layout (~1683 lines)
- `src/App.css` — All styling (single file, ~3617 lines)
- `src/types.ts` — Core types: Pad, PadSettings, SampleLayer, SampleAsset, Project, BusId, EffectSlot, MixBus, MasterBus, TrimSettings, MidiOutConfig, EnvelopeSettings, etc.

### Components (`src/components/`)
- `KnobControl.tsx` — Drag knob with optional `logScale` power-curve mapping (for envelope time knobs: 50%→20% of range, 0-5s with ms/s auto-format display) and optional `freqScale` exponential mapping (equal knob travel per octave, for filter frequency knobs, auto-formats as Hz/kHz)
- `MiniWaveform.tsx` — Memoized canvas waveform
- `SequencerStep.tsx` — Memoized step with drag interactions
- `ExportDialog.tsx` — Export format chooser with spinner
- `ImportDialog.tsx` — Import dialog
- `ConfirmDialog.tsx` — Promise-based confirm overlay (replaces all `window.confirm` calls)
- `SampleLibrary.tsx` — Sample library sidebar with file drop, chop/spread buttons, "Remove Unassigned" cleanup, record button, Import Samples button, autosample group UI (rename/delete/export/drag/assign-to-pads), group edit modal (name/bus/choke), manual sample grouping (multi-select + group button), per-sample ungroup, MPC badge on .pgm-imported groups, Preset badge on factory preset groups, ZIP import support, sidebar collapse button, projects section (list/new/duplicate/delete/switch)
- `PadEditor.tsx` — Collapsible pad settings, waveform trim with zoom (gain-scaled, layer-aware), filter knobs (LP12/LP24/HP/BP), MC-909 style AMP envelope section (vertical faders + ADSR/AHR curve visualization), multisample layer UI, per-layer editing, stacked timeline (canvas waveforms + drag offset), bus selector, choke group selector, pan knob (with random pan toggle), MIDI Out section, Crop button (destructively trims sample to trim markers), Normalize button (peak normalize to -0.3 dBFS), Reset Pad button (resets to defaults + clears sequencer events)
- `EnvelopeSection.tsx` — Reusable MC-909 style envelope section with ADSR/AHR curve SVG visualization, vertical faders (with log-scale support), level/depth fader, mode-aware (ADSR shows A/D/S/R, AHR shows A/H/R), used for AMP envelope in PadEditor
- `PadGrid.tsx` — Pad grid with bank nav (double-click to rename banks), pad drag (move/copy/swap), record button overlay on empty pads, MIDI debug display, autosample group drop with metadata (trim/bus/choke), group drop on bank tabs (assigns starting from pad 1 of target bank), MPC .pgm import on file drop, touch event handling (preventDefault to avoid double-trigger on mobile)
- `TopBar.tsx` — Header with transport, BPM, swing, tap tempo, VU meter, metronome toggle, sequencer record arm/quantize/overdub/count-in buttons, Capture MIDI button, MIDI input cluster, Audio Out device selector, drag-to-adjust BPM/Swing inputs, settings popover (buffer size, metronome volume)
- `Sequencer.tsx` — Compact toolbar, draggable pattern strip (drag to reorder), song chain, sequencer matrix with collapsible bank groups (all 8 banks visible, auto-collapsed if no events in current pattern), inline ColorPicker (8×8 grid popover), performance stats overlay (FPS + tick drift)
- `VirtualizedSequencerLanes.tsx` — Lightweight custom lane virtualizer: only renders visible bank groups + expanded piano roll lanes, uses cumulative height offsets with paddingTop/paddingBottom
- `PianoRollLane.tsx` — Memoized inline piano roll for any pad lane: 24-row (2 octave) grid, click-to-toggle notes, velocity drag (Shift+drag), octave scroll buttons, note length drag (left/right edges adjust gate), aligned with sequencer step columns via shared CSS grid template
- `Mixer.tsx` — Mix bus panel: custom drag faders, per-bus/master level meters (canvas), pan knobs, mute/solo, 3 effect slots per channel, sidechain source selector for SC Comp, input monitor strip, double-click bus name to rename
- `Toasts.tsx` — Toast notification container
- `VuMeter.tsx` — Canvas-based VU meter with rAF
- `RecordDialog.tsx` — 3-phase recording modal (ready/recording/review) with AudioWorklet, trim/crop, WAV save, normalize checkbox
- `ChopModal.tsx` — Sample chop modal: waveform canvas, click to add/remove markers, quick divide (÷2/÷4/÷8/÷16), preview per chop, bank+pad assignment
- `AutosampleDialog.tsx` — Full autosample UI: MIDI out config, audio input, note range, timing, pad assignment, normalize, auto-trim toggle, auto-crop toggle, mix bus routing, choke group config, device drumkit modes (MC-707), editable kit name
- `Timeline.tsx` — Sequencer history timeline: undo/redo stack visualization with draggable slider, shows pattern name + step count at each history point, click to jump, drag to scrub through undo history
### Library (`src/lib/`)
- `audioEngine.ts` — Web Audio voice pool, multisample resolution, per-pad filter (LP12/LP24/HP/BP/LPHP with live param updates), choke groups, ADSR/AHR envelope shaping, AnalyserNode, bus routing, effect chains (with sidechain compressor worklet), `buildEffectChain`, `buildEffectNode`, `updateEffectNodeParams`, `updateBusEffectParams`, `updateMasterEffectParams`, `getOutputLatency`, input monitor, `setOutputDevice`, `setBufferSize`, `playPreview`/`stopPreview` (sample preview via AudioContext) (~1600 lines)
- `audioExport.ts` — Offline WAV render with swing, layer resolution, per-pad filter, choke groups, ADSR envelope shaping, bus routing + effects (~513 lines)
- `voiceUtils.ts` — Shared voice utilities: `mergeLayerSettings`, `resolveFilterType`, `resolveLayer`, `createFilterChain`, `scheduleAmplitudeEnvelope`, `createPanNode` — consumed by both `audioEngine.ts` (live) and `audioExport.ts` (offline) to prevent drift
- `wavEncode.ts` — Shared WAV encoding: `encodeWav` (AudioBuffer), `encodeWavFromChannels` (raw Float32)
- `transportScheduler.ts` — Step scheduler with swing offset
- `playbackSnapshot.ts` — Snapshot builder (carries swing, pads, sequences — NOT mixer data)
- `standaloneHtml.ts` — Standalone HTML page builder
- `packageIO.ts` — Import/export packages (.zip), maps layer sample IDs, preserves all sample metadata (groups, chop points)
- `db.ts` — IndexedDB layer
- `project.ts` — Default project factory (includes mixBuses + masterBus)
- `utils.ts` — uid, midiToName, createDefaultPads, createDefaultMixBuses, createDefaultMasterBus
- `midiOut.ts` — MIDI output registry, `sendMidiNote` (with `delayMs` + Web MIDI timestamp scheduling), `sendMidiNoteOff`, `registerActiveNote`, `releaseMidiNote`, `isMidiEcho`, `cancelPendingNoteOff`
- `autotrim.ts` — `computeSilenceTrim()` (2ms pre-roll, -40dB peak-relative threshold) + `normalizePcm()` (peak normalize to -0.3 dBFS)
- `deviceDrumkits.ts` — Extensible device drumkit mapping system: `DeviceDrumkit` interface, `MC707_DRUMKIT` (16 pads with MIDI notes, drum names, choke groups), `DEVICE_DRUMKITS` registry, lookup helpers
- `pcmRecorder.ts` — Shared PCM capture with disabled browser audio processing, system-default sample rate
- `midiExport.ts` — MIDI export
- `mpcImport.ts` — MPC1000/MPC2500 `.pgm` program file parser: `parseMpcPgm` (extracts pad-to-sample mapping + per-pad settings from binary: choke group, pan, level, tuning, filter type/freq/Q, attack/decay, play mode, up to 4 velocity layers), `matchMpcSamplesToFiles` (matches mapping to dropped audio files, returns `MpcMatchedPad[]` with full mapping data including additional layer files)
- `lcdkImport.ts` — Loopcloud Drum `.lcdk` JSON kit parser: `parseLcdk` (extracts pad mappings with volume/pan/filter/choke/transpose/finetune/attack/release/samplestart + sequencer patterns), `matchLcdkSamplesToFiles` (matches pad filenames to dropped audio files). Patterns stored as JSON on first sample (`autosamplePatterns`) and imported into sequencer on `assignGroupToPads`.
- `batteryMonolithImport.ts` — Battery 4 monolith `.nbkt` parser: `parseBatteryMonolith` (extracts embedded WAV samples from monolith format, rejects patch-only files), `extractWavFromMonolith` (slice single WAV blob), `detectVelocityLayers` (groups `V1`/`V2`/`V3`… suffix samples and computes velocity splits: 2 layers = 0-99/100-127, N>2 = equal spread), `classifyBatterySample` (filename-based drum category classifier).
- `drumKitMap.ts` — Drum category classifier (`classifyDrumSample`, `looksLikeDrumKit`) and standard 16-pad layout mapper (`mapToStandardKit`)
- `touchDrag.ts` — Touch-based drag-and-drop for iPad/mobile (floating ghost, `elementFromPoint` drop detection, custom `touch-drop` event, configurable `DROP_SELECTORS` for pads + song chain elements). Works alongside HTML5 DnD for desktop.
- `constants.ts` — Constants (`BANK_COUNT=8`, `PADS_PER_BANK=16`, `TOTAL_PADS=128`)

### Workers (`src/workers/`)
- `transportClock.worker.ts` — Transport clock worker
- `recorderWorklet.ts` — Reference AudioWorklet processor (actual worklet inlined as Blob URL in RecordDialog)
- `sidechainCompressor.worklet.ts` — Reference sidechain compressor AudioWorklet (actual worklet inlined as Blob URL string in audioEngine.ts)

## Behavior Contract (Keep In Sync)

- Sequencer step pitch editing: `Alt+Shift+drag` on lit step, stored as `event.semitones`.
- MIDI export transposes by step semitones.
- Audio export supports: active pattern WAV, song chain WAV (full chain once).
- Pattern WAV export renders 2 cycles with WAV `smpl` loop markers around cycle 2.
- WAV filenames include BPM.
- Playback mode rules:
  - `one-shot`: attack ramp only, plays full trimmed sample. Not step/gate-clamped.
  - `adsr`: ADSR envelope — attack ramps to peak, decay ramps to sustain level (peak * sustain), release ramps to zero. In sequencer, ADSR respects step gate duration (`forceDuration`). For live pad hold (sample pads), voice holds at sustain level until `releasePad` triggers the release phase using the pad's actual release time.
  - `ahr`: AHR envelope — attack ramps to peak, hold at peak for `hold` seconds, release ramps to zero. Self-terminating (ignores gate). For live pad hold, hold phase extends until `releasePad` triggers release.
- Envelope shaping (gain automation via `linearRampToValueAtTime`) applied in both live and offline paths.
- Choke groups: voices in same group (1–8) cut each other. Applied in both live (5ms fade, time-aligned with `atTimeSec`) and offline (gain ramp-down) paths.
- Multisample: layer resolution happens in both live and offline paths.
- Per-pad filter: LP12 (single BiquadFilter), LP24 (two chained BiquadFilters), HP, BP, LPHP (HP+LP in series with independent freq controls). Applied in both live and offline paths. Live param updates via `updateActiveFilters` (setTargetAtTime with 10ms tau).
- Per-pad pan: `StereoPannerNode` per voice, inserted between filter chain (or gain node) and bus destination. `randomPan` mode: pan value = `random(-1,1) * panWidth`. Applied in both live and offline paths.
- Swing: applied to odd steps in both `TransportScheduler.tick()` and `audioExport.ts`.
- Mix bus routing: pads route to buses A–D via `PadSettings.bus`, applied in both live and offline paths.
- Bus effects: applied in both live and offline paths (sidechain compressor uses AudioWorklet in both live and offline contexts).
- Bus gain/pan/mute/solo: applied in both live and offline paths.
- Sequencer MIDI out: time-aligned with Web Audio via `delayMs` + `audioContext.outputLatency` compensation.
- Pads with `midiOut.enabled` are considered non-empty for "hide empty lanes" filter.
- Stacked mode: all layers play simultaneously with per-layer `stackOffsetMs` timing offset. Applied in both live and offline paths.
- Piano roll events: `SequenceEvent.note` field (MIDI note number). At playback, `semitoneOffset = note - (baseNote + settings.semitones)`. Handled in both store tick handler and `audioExport.ts`.
- Piano roll note length: drag left/right edges of note blocks to adjust `gate` (steps). Left edge moves start step + adjusts gate to keep end fixed. Store actions: `setPianoRollNoteGate`, `setPianoRollNoteStartAndGate`.
- Envelope time faders: MC-909 style vertical faders with logarithmic power curve (exponent ≈ 2.322), range 0–5s, display auto-formats as ms/s.
- Filter frequency knobs: exponential mapping (`freqScale`) — equal knob travel per octave, auto-formats as Hz/kHz.
**When changing playback logic, update:**
1. `src/lib/voiceUtils.ts` (shared envelope/filter/pan scheduling)
2. `src/lib/audioEngine.ts` (live playback)
3. `src/lib/audioExport.ts` (offline export)

**When changing effect chain logic, update all three:**
1. `buildEffectNode()` in `src/lib/audioEngine.ts` (construction)
2. `updateEffectNodeParams()` in `src/lib/audioEngine.ts` (live param updates)
3. The offline render section in `src/lib/audioExport.ts`

## Keyboard Shortcuts

- `Space` — Play/stop
- `S` — Stop
- `T` — Tap tempo
- `1`–`8` — Switch pad bank
- `Escape` — Close open dialog/panel
- `Cmd+Z` / `Ctrl+Z` — Undo (sequencer)
- `Cmd+Shift+Z` / `Ctrl+Shift+Z` — Redo (sequencer)
- `Cmd+D` / `Ctrl+D` — Duplicate pattern
- `Alt+Shift+drag` on lit step — Edit step pitch (semitones)

## Data Model Notes

- `PadSettings.layers: SampleLayer[]` — each layer has `sampleId`, `velocityMin`, `velocityMax`
- `SampleLayer` extended with nullable override fields: `gain`, `semitones`, `fineCents`, `trimStart`, `trimEnd`, `attack`, `decay`, `release`, `filterType`, `filterFreq`, `filterQ`, `stackOffsetMs` — `null` means inherit from pad
- `PadSettings.multiMode: 'single' | 'round-robin' | 'random' | 'velocity' | 'stacked'`
- `PadSettings.filterType: 'off' | 'lp12' | 'lp24' | 'highpass' | 'bandpass' | 'lphp'`
- `PadSettings.filterFreq` (Hz), `PadSettings.filterQ` (resonance)
- `PadSettings.filterFreq2?: number` — second frequency for LPHP filter (LP cutoff, Hz)
- `PadSettings.bus: BusId` — mix bus routing ('A' | 'B' | 'C' | 'D')
- `PadSettings.chokeGroup: number` — 0=off, 1–8
- `PadSettings.pan?: number` — per-pad pan (-1 left to +1 right, undefined = 0 center)
- `PadSettings.randomPan?: boolean` — when true, pan value controls random pan width per note
- `PadSettings.mode: 'one-shot' | 'adsr' | 'ahr'`
- `PadSettings.envelope: EnvelopeSettings` — `{ attack, decay, sustain, release, hold? }` (ADSR model: decay ramps to sustain level, release ramps to zero; AHR model: attack→peak, hold at peak, release→zero)
- `PadSettings.midiOut?: MidiOutConfig` — optional MIDI out config (undefined = disabled)
- `PadSettings.baseNote?: number` — MIDI note for sample's original pitch, default 60 (Middle C)
- `SequenceEvent.note?: number` — MIDI note number for piano roll events (overrides pad base note at playback)
- `SampleAsset.chopPoints?: number[]` — sorted fractional positions (0–1) for chop markers
- `SampleAsset.autosampleRunId?: string` — groups samples from the same autosample session
- `SampleAsset.autosampleRunLabel?: string` — user-editable group name
- `SampleAsset.autosampleTrim?: TrimSettings` — trim computed during autosample, applied on pad assignment
- `SampleAsset.autosampleBus?: BusId` — bus routing for group pads
- `SampleAsset.autosampleChokeGroup?: number` — choke group for group pads (0=off, 1–8)
- `SampleAsset.autosamplePadIndex?: number` — original pad index from imported program file (MPC .pgm), used for ordered assignment
- `SampleAsset.autosampleMpc?: boolean` — true only when imported via .pgm program file
- `SampleAsset.autosamplePreset?: boolean` — true for factory preset samples
- `SampleAsset.autosampleBattery?: boolean` — true when imported via Battery 4 monolith .nbkt
- `SampleAsset.metadataTags?: Record<string, string>` — metadata tags extracted from WAV LIST/INFO chunks (INAM, IART, ICMT, etc.)
- `SampleAsset.autosampleMpcPadSettings?: MpcPadImportSettings` — per-pad settings from .pgm (pan, level, tuning, filter, envelope, playMode)
- `SampleAsset.autosampleMpcLayerIndex?: number` — velocity layer index within an MPC pad (0=primary, 1–3=additional)
- `SampleAsset.autosampleMpcVelocityMax?: number` — MPC velocity range max for this layer
- `SampleAsset.autosampleImportedPadSettings?: ImportedPadSettings` — per-pad settings from imported kit files (.pgm, .lcdk), applied on pad assignment
- `SampleAsset.autosamplePatterns?: string` — JSON-encoded sequencer patterns from imported kit (stored on first sample in group only)
- `Project.swing: number` (0–100)
- `Project.mixBuses: [MixBus, MixBus, MixBus, MixBus]` — 4 mix buses with gain, pan, mute, solo, effects
- `Project.masterBus: MasterBus` — master gain + 3 effect slots
- `Project.bankNames?: string[]` — custom bank names (length = BANK_COUNT), undefined entries use default "Bank N"
- `EffectSlot.sidechainSource?: BusId` — only used when `type === 'sidechain-compressor'`
- `EffectType: 'off' | 'compressor' | 'sidechain-compressor' | 'eq3' | 'delay' | 'reverb' | 'chorus'`
- `MidiOutConfig: { enabled, deviceId, channel, note, velocity }` — per-pad MIDI output config
- `TrimSettings: { start, end }` — fractional positions (0–1)
- Runtime migration handled in `normalizeProject()` in `src/store/index.ts` (only runs on load/import, NOT in hot path)
- `mergeLayerSettings()` in audioEngine.ts / audioExport.ts merges layer overrides onto pad defaults
- `getDefaultEffectParams()` in store returns default knob values per effect type

## Feature Notes

### Library Drop (F1)
- Drop files anywhere on the sidebar to add samples
- Shared `importFileAsSample` helper (module-level async function in store)
- `addSamplesToLibrary(files: File[])` action processes files and shows toast
- ZIP files are detected and imported as autosample groups (reads `metadata.json` for trim/bus/choke metadata)
- **MPC .pgm import**: when a `.pgm` file is among dropped files, it is parsed for pad-to-sample mapping; matched WAV files are imported as a group with `autosamplePadIndex` metadata preserving the original pad order. Per-pad settings (choke group, pan, level, tuning, filter type/freq/Q, attack/decay, play mode) are stored on `SampleAsset.autosampleMpcPadSettings` and applied when samples are assigned to pads via `assignGroupToPads` or direct PadGrid drop. Up to 4 velocity layers per pad are supported with MPC velocity ranges preserved.
- **Loopcloud .lcdk import**: when a `.lcdk` file is among dropped files, it is parsed for pad-to-sample mapping + sequencer patterns; matched audio files are imported as a group with `autosampleImportedPadSettings` (volume/pan/filter/choke/transpose/finetune/attack/hold/release/samplestart/mute). Empty pads (no sample) are skipped; muted pads are imported with `mute: true` instead of gain 0. Sequencer patterns stored as JSON on first sample (`autosamplePatterns`) and imported into sequencer on `assignGroupToPads`. When both HP and LP cutoffs are active, LPHP dual filter is used. Pads with hold or release > 0 use AHR mode (attack 0-5s, hold 0-4s, release 0-6s, all quadratic mapped from 0-1).
- **Battery 4 monolith .nbkt import**: when a `.nbkt` file is among dropped files, it is parsed as a Battery 4 monolith (embedded WAV format). Patch-only `.nbkt` files (Factory Library references) are rejected. Extracted samples are grouped by kit name. Velocity layers with `V1`/`V2`/`V3`… suffix are detected and assigned as velocity layers on the same pad: 2 layers use Battery's default 0-99/100-127 split; N>2 layers use equal spread across 0-127. Samples get `autosampleBattery: true` and show a "Battery" badge in the library.
- **Multi-file drop auto-grouping**: when ≥2 audio files are dropped at once, they are automatically grouped with a label derived from the common filename prefix
- **Folder drop**: dropping a folder recursively reads all audio files using `webkitGetAsEntry`. If files look like a drum kit (≥40% match known categories), a confirm dialog offers to map them to a standard 16-pad MPC-style layout (kick→1, snare→2, clap→3, CH→4, OH→5, perc→6, toms→7-9, crash→10, ride→11, shaker→12, cowbell→13, conga→14, snap→15, other→16). Uses `autosamplePadIndex` for ordering on pad assignment. Folder name is used as group label (instead of common filename prefix).

### Sample Grouping
- Grouping is implicit: samples sharing the same `autosampleRunId` form a group
- `groupSamples(sampleIds, label?)` — assigns a shared `autosampleRunId` + label to existing samples
- `ungroupSample(sampleId)` — removes all group fields from a single sample
- Multi-select checkboxes on ungrouped library samples; "Group N Samples" button appears when ≥2 selected
- Per-sample "Remove from group" (⊟) button on samples inside groups
- Multi-file drop to library auto-groups (common prefix label)
- Multi-file drop to pad grid auto-groups (common prefix label)
- **Velocity subgroups**: within groups, samples with `_vNN` or ` VNN` filename suffix (e.g. `Kick_v32.wav`, `Kick V1.wav`) are automatically detected and displayed as collapsible subgroups showing base name + layer count. Requires ≥2 samples with matching base name to form a subgroup. Ungrouped samples are NOT auto-detected (must be grouped first).
- **Velocity subgroup drag**: dragging a velocity subgroup onto a pad assigns all its samples as velocity layers on that single pad (`multiMode: 'velocity'`), with auto-computed velocity splits. Works from both library sidebar and pad grid drop.
- Velocity subgroup detection uses regex `(?:_v| V)(\d+)` before the file extension; samples are sorted by velocity value ascending within subgroups

### Metadata Tags
- WAV `LIST/INFO` chunks are parsed during import for all WAV files (not just Battery kits), extracting tags like `INAM` (name), `IART` (artist), `ICMT` (comment), `IPRD` (product), `ISFT` (software), `IGNR` (genre), `IKEY` (keywords)
- Tags stored on `SampleAsset.metadataTags: Record<string, string>`
- Settings popover has a "Sample Metadata Tags" section with a master toggle + individual tag type checkboxes (persisted in localStorage)
- Enabled tags appear as small inline chips in the sample library sidebar and on pad grid pads
- `ungroupSample` clears `metadataTags` along with other group fields

### Chop Modal (F2)
- `chopPoints: number[]` stored on `SampleAsset` in IndexedDB — sorted fractional positions (0–1)
- Chops reuse parent sample with trim markers on pad (no new blobs)
- Library shows virtual chop entries (collapsible indented list) under parent sample
- Assignment auto-assigns first unused choke group

### Pad Drag (F3)
- Cross-bank drag via hovering bank tabs (300ms delay to switch)
- Move/Copy/Swap/Cancel modal with replace warning
- Move transfers sequencer events, resets source pad to defaults
- Swap exchanges both pad settings/names and sequencer events between source and target
- Pads use `<div role="button">` (not `<button>`) to avoid nested button HTML violation

### Sequencer Live Recording (F4)
- Record arm + quantize (Q, default on) + overdub/replace (OVR/REP) buttons in TopBar
- `recordPadHit(padId, velocity, note?)` action called from `triggerPad` when armed+playing
- Optional `note` parameter records piano roll events (computer keyboard + MIDI chromatic input)
- `recordPadRelease(padId, note?)` computes gate length from elapsed time (`performance.now()`) and BPM, more accurate than visual playhead
- Active recording notes tracked in module-level `_activeRecordingNotes` Map (cleared on transport stop)
- Records into `playingPatternId` pattern; replace mode uses `_seqRecordCleared` Set

### Capture MIDI (F5)
- Ableton-style "Capture MIDI": always buffers incoming pad triggers regardless of record arm or transport state
- **Capture buffer** (`mutableRefs.captureBuffer` in `refs.ts`): in-memory array of `{ padId, velocity, note?, type: 'on'|'off', timestamp }` events using `performance.now()` timestamps
- **Feed points** (all call `feedCaptureBuffer`):
  - `triggerPad` in pad.ts (drum pad note-on)
  - MIDI handler in App.tsx (drum pad note-off)
  - Computer keyboard handler in App.tsx (chromatic note-on/off)
  - PadGrid mouse/touch release (drum pad note-off)
- **Transport start tracking**: `mutableRefs.captureTransportStartMs` set when transport starts; cleared on stop (buffer preserved for post-stop capture)
- **`captureMidi()` action** (in recording.ts):
  - Filters buffer to last 4 bars (64 steps) from current time
  - **Playing mode**: maps timestamps → steps using `captureTransportStartMs` as reference, uses playing pattern's `lengthSteps`
  - **Stopped mode**: uses first note-on time as step 0, auto-sizes pattern length (rounds up to next multiple of 16, clamped 16–64)
  - Pairs note-on/note-off events to compute gate length (same formula as `recordPadRelease`)
  - Deduplicates: multiple note-ons on same step+padId+note keep highest velocity
  - Creates a **new pattern** with captured events, switches `activeSequenceId` to it
  - Single `saveProject` call (batch commit)
  - Clears buffer and resets `captureBufferCount` to 0
- **UI**: ⊞ CAP button in TopBar record cluster, enabled only when `captureBufferCount > 0`, glows blue when data available, shows buffered note count in tooltip
- **Buffer lifecycle**: cleared on explicit capture or `clearCaptureBuffer()`. NOT cleared on transport stop (allows post-stop capture). Memory-only (lost on page refresh)
- Reactive `captureBufferCount` state tracks note-on count for UI enable/disable

### Chromatic Spread
- 🎹 button on library sample row opens inline popover
- Bank, Start Pad, Count (default 12), Choke Group (Off or 1-8) selectors
- `spreadSampleChromatically()` assigns sample to N consecutive pads with semitones 0, +1, +2...

### Multi-Project
- Projects stored in IndexedDB `projects` table (multiple projects coexist, samples are shared globally)
- `projectList` state: lightweight `{ id, name, updatedAt }[]` sorted by most recent
- Store actions: `refreshProjectList`, `switchProject`, `createNewProject`, `deleteProject`, `duplicateProject`
- `createNewProject`: auto-names "Sketch NN", creates default project, switches to it
- `switchProject`: stops transport, flushes pending save, loads project from DB, resets UI state
- `deleteProject`: confirms via `showConfirm`, prevents deleting last project, switches to most recent if deleting current
- `duplicateProject`: deep-clones current project with new ID + " Copy" suffix
- Projects section in SampleLibrary sidebar (above Sample Library): collapsible list, active project highlighted, + button for new, ⧉ duplicate, ✕ delete
- Project name edited via TopBar input; `commitProjectNameDraft` refreshes project list

### Remove Unassigned Samples
- "Remove Unassigned" button in library panel removes samples not referenced by any pad (primary sampleId or layer sampleId)
- Confirms with count before deleting from IndexedDB and store

### Waveform Zoom
- Full-res `Float32Array` channel data cached in module-level `_waveformChannelCache` per sample
- Zoom-trim mode computes peaks from raw data at pixel resolution
- Frozen zoom range (`storeRefs.frozenZoomRange`) prevents feedback loop during trim drag
- Auto-scroll: when dragging handle past 95%/5% of waveform edge, viewport expands at 3%/frame
- **Gain-scaled display**: waveform peaks are multiplied by effective gain (layer gain override ?? pad gain) so the visual matches audible output
- **Layer-aware trim**: when a layer is selected, trim draft and drag handle commits route to the layer's trim override (via `updatePadSettings` → `LAYER_FIELDS` routing), not the pad-level trim

### MIDI Input / Output
- MIDI note-on sets `selectedPadId` (updates pad editor — disabled during playback)
- MIDI note-on calls `flashSequencedPadHit` (same visual flash as sequencer hits)
- Per-pad MIDI out: configurable device/channel/note/velocity in PadEditor
- MIDI loop prevention via `isMidiEcho` with 80ms suppression window (converts incoming channel 0-indexed → 1-indexed)
- Gate/ADSR note-off managed via `_activeGateNotes` Map in `midiOut.ts`
- Sequencer MIDI out: time-aligned via `delayMs` + `outputLatency` compensation; noteOffKey includes transposed note to avoid stuck notes
- **Pad MIDI channel**: global filter (`padMidiChannel` state) restricts which MIDI channel triggers pads (null = all)
- **Computer keyboard chromatic input**: Ableton-style 2-octave layout (Z-M = lower octave, Q-U = upper octave), toggle via TopBar button, -/= shift octave

### Launchpad Pro MK3 (Programmer Mode)
- Enabled via "LP Pro MK3 Mode" checkbox in TopBar when device is detected; enters Programmer Mode via SysEx on connect
- **Grid layout**: bottom 4 rows = drum pads (left 4×4) + chromatic play (right 4×4); top rows = sequencer steps (16-step or 32-step depending on pattern length)
- **Chromatic play** (bottom-right 4×4): plays the selected pad (or last-triggered pad if none selected) at different semitone offsets. 16 semitone offsets arranged left-to-right, bottom-to-top (offsets 0–15). Black keys dim blue, white keys dim blueish white. **Root note** (offset 0) highlighted in red. Shift range adjustable via Click/Undo buttons.
- **Click button (CC 80)**: shifts chromatic grid up by +4 semitones (one row), clamped at +48
- **Undo button (CC 70)**: shifts chromatic grid down by -4 semitones (one row), clamped at -48
- **Left column** (top → bottom): **Click(CC 80)**=chromatic shift up, **Undo(70)**=chromatic shift down, Delete(60), Quantise(50), **Duplicate(40)**, Double(30), Play(20), Record(10)
- **Duplicate button (CC 40)**: doubles active pattern length up to 64 steps (copies events to second half)
- **Shift + Duplicate (CC 90 + CC 40)**: halves active pattern length (truncates out-of-range events)
- **Bottom row**: notes 1–8 and narrow CCs 101–108 switch between 8 banks
- **Arrow left (CC 91)** / **arrow right (CC 92)**: switch to previous/next pattern (wraps around)
- LED feedback: drum pads show assignment state, sequencer steps show event state, active bank highlighted in orange, Click/Undo buttons dim when shiftable, arrow buttons dim when navigable, chromatic root in red

### Autosampler
- `AutosampleDialog.tsx` — Full autosample workflow: MIDI out → audio capture → auto-trim → normalize → pad assignment
- Configurable: MIDI device/channel, audio input device, note range/step/velocity, timing, threshold, name pattern, normalize, mix bus, choke group
- **Note mode toggle**: Range (start/count/step), Scale (root + major/minor + octave range), Custom (manual note list + MIDI Learn), Device Drumkit (MC-707)
- Scale mode: Major `[0,2,4,5,7,9,11]` and Minor `[0,2,3,5,7,8,10]` intervals, configurable root (C–B), start octave, octave count; adds top root note
- Custom mode: add notes by number input or MIDI Learn (listens on all MIDI inputs for note-on, appends unique notes); notes sorted ascending before sampling
- **Device Drumkit mode**: extensible system via `DeviceDrumkit` interface in `deviceDrumkits.ts`. MC-707 Drumkit maps 16 pads to fixed MIDI notes with drum names. Samples are named with drum names (e.g. `MC-707 Drumkit_Kick.wav`). Per-pad choke groups from kit mapping (hi-hat pair uses choke group 1). `autosamplePadIndex` set from kit pad order. Auto-trim defaults to on.
- **Auto-trim toggle**: checkbox in Audio Input section, controls whether `computeSilenceTrim` is applied to captured samples (default on, always on when switching to drumkit mode)
- **Auto-crop toggle**: checkbox in Audio Input section, destructively removes silent head/tail from PCM before encoding to WAV (smaller files, less memory). Mutually exclusive with auto-trim (crop makes trim redundant). Default off.
- **Kit name**: editable text field in drumkit mode, used as group label and sample name prefix (falls back to device kit label if empty)
- `computeNoteList()` returns `number[]` for all modes; sampling loop iterates this array instead of arithmetic
- **Velocity layers**: 1–4 layers per note; `computeVelocitySplits()` divides 1–127 range evenly, sends appropriate MIDI velocity per layer; creates `SampleLayer[]` with `velocityLow`/`velocityHigh` ranges and sets `multiMode: 'velocity'` on the pad
- 150ms settle delay after `startPcmCapture` before first note (avoids hardware init glitch)
- **Double-flush** before each note: clear PCM buffer, wait 50ms, clear again — prevents residual audio from bleeding into capture
- Samples stored with group metadata: `autosampleRunId`, `autosampleRunLabel`, `autosampleTrim`, `autosampleBus`, `autosampleChokeGroup`, `autosamplePadIndex`
- **MIDI output and audio input device IDs persisted** in localStorage and restored on dialog open
- Library shows collapsible autosample groups with rename/delete/export-zip/drag support
- Group edit modal (✎ button): rename + change bus + change choke group for all group samples + assigned pads
- Group drop on PadGrid: assigns samples to sequential pads with metadata (trim/bus/choke) applied, sorted by name with numeric locale comparison
- Group drop on bank tabs: assigns starting from pad 1 of the target bank
- Group assignment (`assignGroupToPads` and PadGrid drop): sorts by `autosamplePadIndex` when present (kit-mapped groups), otherwise by name (numeric locale)
- Group assignment detects velocity layers by `_vNN` filename suffix — groups samples by base name, assigns all velocity layers to a single pad with `multiMode: 'velocity'` and proper `SampleLayer[]`
- ZIP export includes `metadata.json` (label + per-sample trim/bus/choke/padIndex)
- ZIP import restores group with metadata from `metadata.json` (including `autosamplePadIndex` for ordered assignment)

### Audio Input Monitor
- Toggle + device dropdown + bus selector in Mixer panel
- `startInputMonitor`/`stopInputMonitor` in audioEngine.ts
- `getUserMedia` with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`

### Preset Kits
- On first launch (no samples in IndexedDB), `loadPresetKits()` fetches ZIP files from `/public`: `TR7x7ISH_Kit.zip`, `TR8x8ISH_Kit.zip`, `TR9x9ISH_Kit.zip`
- Each ZIP is imported as an autosample group with `autosamplePreset: true`
- After loading, kits are auto-assigned to pads: TR7x7ISH → Bank 1, TR8x8ISH → Bank 2, TR9x9ISH → Bank 3 (via `assignGroupToPads`)
- Preset groups show a "Preset" badge in the SampleLibrary sidebar (same pattern as MPC badge)
- `PRESET_KITS` array in `src/store/index.ts` defines which ZIPs to load
- Stable `runId` per kit (`preset-<kitname>`) prevents duplicate groups on partial re-loads
- `_hydratePromise` module-level guard prevents React Strict Mode double-invoke from duplicating presets
- Preset flag preserved through project export/import via `PackageManifest.sampleMeta`

### Confirm Dialog
- All destructive actions use `showConfirm()` (promise-based) instead of `window.confirm()`
- `ConfirmDialog.tsx` renders as DOM overlay with ESC/Enter keyboard support
- Used by: initialize project, clear lane, duplicate/halve pattern, delete sample, remove unassigned, delete group

## Mix Bus / Mixer Notes

- Mixer panel is a separate grid section from the sequencer, using shared panel styling
- Custom `Fader` component (pointer-drag based, not native `<input type="range">`) for vertical volume faders
- Per-bus and master `LevelMeter` components use canvas + `AnalyserNode` + rAF (same pattern as VuMeter.tsx)
- Sidechain compressor worklet source is inlined as a JS string in `audioEngine.ts` and registered via Blob URL on context init
- Sidechain compressor is not available on the master bus (filtered from the effect type dropdown)
- Self-sidechain (bus sidechaining itself) is prevented in both UI and engine
- Bus effect chain rebuilds use **structural key** (type + enabled + sidechainSource + reverb decay) — param-only changes update existing AudioParams in-place via `updateBusEffectParams`/`updateMasterEffectParams`
- Bus names editable via double-click in Mixer panel; `setBusName` action persists via `saveProjectLight`
- Bank names editable via double-click on bank buttons in PadGrid; `setBankName` action persists via `saveProjectLight`; stored as `Project.bankNames?: string[]`

## UI Defaults / Persistence

- Song Chain panel collapsed by default, persisted in localStorage.
- Hide Empty Lanes defaults to on (unless persisted setting exists). When enabled, only lanes with events **in the active pattern** are shown (pad content alone is not sufficient).
- Sequencer shows all 8 banks as collapsible groups. Banks with events in the current pattern are expanded by default; banks without events are collapsed. User can toggle any bank. State tracked via `seqExpandedBanks`/`seqCollapsedBanks` Sets. Selector: `selectSequencerBankGroups`.
- Audio output device persisted in localStorage (`audioOutputDeviceId`), restored on app init, fallback to system default.
- Sequencer is intentionally compact; avoid increasing vertical spacing without strong reason.
- Sequencer/Mixer vertical split is draggable via horizontal divider; ratio (0.2–0.85) persisted in localStorage (`layout-seq-mixer-split`), default 60% sequencer.
- Mixer channels use `flex: 1` to fill available horizontal space evenly.
- Layout: Performance mode only (tabs for library/padEditor/sequencer/mixer/projects/settings). Phone sub-layout for touch devices under 768px.

## Performance Notes

- **Playback snapshot rebuild is guarded**: `rebuildPlaybackSnapshot` tracks references to snapshot-relevant fields (`pads`, `sequences`, `bpm`, `swing`, `songChain`, loop markers) and skips when only mixer/effect fields changed. This prevents expensive snapshot reconstruction during fader/knob drags.
- **`saveProjectLight` skips `normalizeProject`**: The hot path only calls `touchProject` (sets `updatedAt`), preserving sub-object reference identity for the snapshot guard. `normalizeProject` only runs on initial load/import.
- **Effect param updates are graph-safe**: `updateEffectNodeParams` writes to existing AudioParams via `setTargetAtTime(value, now, 0.01)` — no node disconnection, no clicks. Full graph rebuild only happens on structural changes (type/enabled/sidechain source/reverb decay).
- **Transport visual state bypasses immer**: `playheadStep` and `sequencedPadHits` are managed by `transportVisualStore` (a lightweight pub/sub) instead of Zustand's immer middleware. Components subscribe via `useSyncExternalStore`. This eliminates ~90 immer produces/sec during active playback.
- **Performance stats overlay**: Toggle via "Show Performance Stats" button in Sequencer help panel. Shows FPS, tick count, late notes, max drift, P95 drift.

## Coding Notes

- **Always update AGENTS.md** after completing new features or major changes. This includes: new files, new store actions, new types, changed component descriptions, updated line counts, new behavior contract entries, new feature notes sections. Do this as part of the task — not as a separate step the user has to request.
- **Update README.md** when user-facing features are added or changed (feature lists, keyboard shortcuts, architecture notes). Keep it in sync with AGENTS.md where relevant.
- Prefer minimal targeted changes over broad refactors.
- Preserve existing naming/style conventions in touched files.
- For export/download features, use the `downloadOrShare()` helper in `App.tsx` (module-level async fn). It tries `navigator.share({ files })` first (required for iOS Safari PWA where anchor-click downloads are silently blocked), then falls back to anchor click with a 60s deferred `revokeObjectURL`. AbortError from share sheet cancellation is swallowed silently.
- `tone` has been removed from `package.json` — raw Web Audio API is used exclusively.
- Keep single `App.css` file — no CSS splitting.
- immer + DOM elements don't mix — use `as any` cast when storing DOM refs in store.
- AudioWorklet processors are inlined as Blob URLs (not imported as modules) to avoid build/path issues.
- Pads use `<div role="button" tabIndex={0}>` instead of `<button>` to avoid nested button violations.
- `storeRefs` is the pattern for sharing mutable non-reactive state between App.tsx and components.
- `audioEngine.getBuffer(sampleId)` exposes private buffer map for ChopModal preview.
- NEVER use `window.confirm()` / `window.alert()` / `window.prompt()` — use `showConfirm()` from the store instead.
- Use `saveProjectLight` (not `saveProject`) for per-pad edits — prevents async round-trip UI flicker.
- Use `setTargetAtTime` (not direct `.value =`) for all AudioParam changes during playback to prevent clicks.
- `PCM_RECORDER_SAMPLE_RATE` is `let` (not `const`) — updated at runtime from actual AudioContext sample rate.
