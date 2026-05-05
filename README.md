# Online Sampler

A browser-based sampler/sequencer built with React, TypeScript, and the Web Audio API. No backend required — everything runs locally in the browser with IndexedDB for persistence.

## Features

### Sampler
- **128 pads** across 8 banks (16 pads per bank)
- **Velocity-sensitive pads** — vertical click/touch position maps to velocity
- **3 layout modes** — Classic (3-column), Wide (sequencer on top), Performance (pads + tabbed panels, auto-detected on landscape mobile)
- **Touch support** for mobile/tablet pad triggering, touch drag-and-drop for samples and patterns to song chain
- **Multisample** support: round-robin, random, velocity-layer, and stacked modes
- **Per-pad settings**: gain, pitch (semitones + fine cents), playback mode (one-shot/ADSR), trim, MC-909 style AMP envelope (vertical faders, ADSR curve visualization), filter (LP/HP/BP) with filter envelope (ADSR+depth, both sample and synth pads), per-pad pan (with random pan mode), mix bus routing, choke groups (1–8), normalize, crop
- **Additive synth engine** — each pad can be sample-based or synth-based (16 sine-wave harmonics with filter envelope and LFO)
- **Synth patches** — save, load, export/import (.ospatch), drag between library and pads
- **Pad naming** — editable pad names with reset to default
- **Pad drag** — move, copy, or swap pads across banks (hover bank tabs to switch)
- **Bank naming** — double-click bank buttons to rename
- **Multi-file drop** — drop multiple audio files on a pad to assign sequentially
- **Sample assign modes** — replace existing sample or add as multisample layer
- **Record to pad** — record button on empty pads opens recording dialog targeted to that pad
- **Waveform editor** with zoom, trim handles, and auto-scroll
- **Sample library** with drag-and-drop import, search, sort, preview playback, chop, chromatic spread, collapsible sidebar
- **Sample grouping** — select multiple samples and group them; remove individual samples from groups
- **Auto-grouping** — multi-file drops (library or pad grid) automatically group samples by common filename prefix
- **Drag sample to pad** from the library sidebar
- **Recording** directly in the browser (AudioWorklet-based, with normalize option)
- **Configurable polyphony** (4/8/16 voices)

### Sequencer
- **Step sequencer** with per-step velocity, gate length, and pitch offset
- **Inline piano roll** for synth pads — 2-octave grid (click-to-toggle notes, Shift+drag velocity, drag note edges to adjust length), octave scroll, aligned with sequencer step columns
- **Configurable resolution** — 1/16 or 1/32 note steps per pattern
- **Configurable step count** per pattern
- **Gate note resize** — drag handles on gate-mode notes to adjust length
- **Velocity editing** — Shift+drag on a lit step to adjust velocity
- **Multiple patterns** with color coding and double-click rename
- **Song chain** for arranging patterns with repeat counts, loop start/end markers, drag reorder, and copy/paste blocks
- **Playback scope** — play active pattern or full song chain
- **Loop toggle** for transport looping
- **Metronome** with volume control, accent on beat 1, and count-in (1/2/4 bars) before recording
- **Live recording** with quantize, overdub, and replace modes
- **Lane tools**: fill, shift, random, clear, duplicate, mute per lane
- **Undo/redo** for sequencer edits
- **Hide empty lanes** toggle (respects MIDI-out-only pads)
- **Performance stats overlay** — FPS, tick count, late notes, max/P95 drift

### Mixer
- **4 mix buses** (A/B/C/D) + master bus with editable bus names (double-click to rename)
- **Per-bus**: gain fader, pan knob, mute/solo, 3 effect slots
- **Effects**: Compressor, Sidechain Compressor (AudioWorklet), 3-Band EQ, Delay, Reverb, Chorus
- **Real-time level meters** (canvas-based, per-bus + master + VU)
- **Audio input monitor** with device selection and bus routing
- **Collapsible mixer panel**
- **Audio output device selector** with localStorage persistence
- **Configurable audio buffer size** (128/256/512/768/1024) via settings popover

### MIDI
- **MIDI input**: trigger pads from external controllers
- **Pad MIDI channel**: global filter restricts which MIDI channel triggers pads
- **Per-pad MIDI output**: configurable device, channel, note, velocity
- **Per-synth MIDI input**: synth pads receive chromatic note input on their own MIDI channel/device
- **Computer keyboard chromatic input**: Ableton-style 2-octave layout, toggle via TopBar button
- **Sequencer MIDI out**: time-aligned with audio via Web MIDI timestamp scheduling + output latency compensation
- **MIDI loop prevention** with 80ms echo suppression
- **MIDI export** of patterns/song chain

### Autosampler
- Automated sampling of external MIDI gear
- Configurable note range, velocity, timing, silence threshold
- **Note modes**: Range, Scale, Custom (MIDI Learn), Device Drumkit (MC-707)
- **MC-707 Drumkit mode**: fixed 16-pad MIDI mapping with drum names, per-pad choke groups (hi-hat pair), editable kit name
- Auto-trim and auto-crop (destructive silence removal for smaller files)
- Normalize, mix bus routing, choke group assignment
- Velocity layers (1–4 per note) with auto-computed splits
- Samples grouped with editable metadata (rename, bus, choke) via group edit modal
- Drag autosample group to pad grid or bank tabs for bulk assignment with metadata
- MIDI output and audio input device selections persisted across sessions
- Export/import groups as ZIP with metadata

### Export & Import
- **WAV export**: active pattern (with loop markers) or full song chain
- **Synth WAV export**: render synth pad to WAV with loop points
- **Synth patch export/import**: `.ospatch` JSON files
- **MIDI export**: patterns with pitch transposition
- **Standalone HTML** export
- **Project import/export** as ZIP packages
- **Import modes**: New Project, Merge, or Overwrite with conflict preview
- **Editable project name** in the TopBar
- **Multiple projects** — create, switch, duplicate, and delete projects (samples shared globally)
- **Initialize project** button to reset to defaults
- **Preset drum kits** — 3 factory kits (TR-7x7, TR-8x8, TR-9x9) auto-loaded and assigned to Banks 1–3 on first launch

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a Chromium-based browser (Chrome, Edge, Brave) for full Web MIDI and AudioWorklet support.

### Build

```bash
npm run build
```

Runs TypeScript type checking followed by Vite production build.

## Tech Stack

- **React 18** + TypeScript
- **Vite** for dev server and build
- **Zustand** + immer for state management
- **Web Audio API** (raw — no Tone.js)
- **Web MIDI API** for MIDI I/O
- **IndexedDB** (via idb) for sample and project persistence
- **JSZip** for ZIP import/export
- **Canvas API** for waveforms, level meters, VU meter

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Stop |
| `S` | Stop |
| `T` | Tap tempo |
| `1`–`8` | Switch pad bank |
| `Escape` | Close dialog / panel |
| `Cmd/Ctrl+Z` | Undo (sequencer) |
| `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` | Redo (sequencer) |
| `Cmd/Ctrl+D` | Duplicate pattern |
| `Cmd/Ctrl+C` / `Cmd/Ctrl+V` | Copy / paste song chain block |
| `Delete` / `Backspace` | Remove selected chain block |
| `Alt+Shift+drag` | Edit step pitch (on lit step) |
| `Shift+drag` | Edit step velocity (on lit step) |
| `Alt+Arrow Left/Right` | Nudge gate note edge |
| `Alt+Shift+Arrow Left/Right` | Nudge opposite gate note edge |
| Vertical drag on BPM/Swing | Adjust value by dragging up/down |
| `Z`-`M` / `Q`-`U` (keyboard mode) | Play chromatic notes on selected synth pad |
| `-` / `=` (keyboard mode) | Shift computer keyboard octave down/up |

## Architecture

Single-page app with all state in a Zustand store (~4600 lines). Audio runs on the Web Audio API with a worker-based transport clock for reliable timing. See [AGENTS.md](./AGENTS.md) for detailed architecture documentation.

### Key Design Decisions

- **No audio library dependencies** — raw Web Audio API for full control over scheduling, routing, and effects
- **Worker-based clock** — 20ms tick interval with 95ms lookahead ensures tight timing even under UI load
- **Transport visual state bypasses immer** — `playheadStep` and pad hit flashes use a lightweight pub/sub store to avoid expensive state updates during playback
- **Effect param updates are graph-safe** — knob changes write to existing AudioParams via `setTargetAtTime` (no graph teardown, no clicks)
- **Snapshot rebuild is guarded** — mixer/effect changes don't trigger playback snapshot reconstruction

## Browser Support

Best experience in Chromium-based browsers (Chrome, Edge, Brave). Firefox supports core audio but lacks Web MIDI. Safari has partial Web Audio support.

## License

Private project.
