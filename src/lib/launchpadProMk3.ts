/**
 * Launchpad Pro MK3 integration — Programmer Mode
 *
 * Grid layout (8×8):
 *   16-step mode:
 *     Rows 7-8 (top 2 rows):     16-step sequencer for last-triggered pad
 *     Rows 5-6:                   unused (dimmed)
 *     Rows 1-4 (bottom 4 rows):  Left 4×4 = drum pads (1 bank), Right 4×4 = chromatic play
 *   32-step mode:
 *     Rows 5-8 (top 4 rows):     32-step sequencer (8 steps per row, top-to-bottom)
 *     Rows 1-4 (bottom 4 rows):  Left 4×4 = drum pads (1 bank), Right 4×4 = chromatic play
 *
 * Bottom thin buttons (notes 1-8): switch between 8 banks directly
 *
 * Pad note numbers in Programmer Mode:
 *   Row 1 (bottom) = 11-18, Row 2 = 21-28, ..., Row 8 (top) = 81-88
 */

import type { Pad, SequenceEvent } from '../types'
import { PADS_PER_BANK } from './constants'

// --- SysEx constants ---
const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e]
const SYSEX_END = 0xf7

// Enter Programmer mode
const SYSEX_PROGRAMMER_MODE = [...SYSEX_HEADER, 0x0e, 0x01, SYSEX_END]

// --- Colors (0-127 range for SysEx RGB) ---
// const COLOR_OFF: [number, number, number] = [0, 0, 0]
const COLOR_PAD_EMPTY: [number, number, number] = [3, 3, 3]           // very dim (visible grid)
const COLOR_PAD_ASSIGNED: [number, number, number] = [0, 80, 0]       // green
const COLOR_PAD_ACTIVE: [number, number, number] = [0, 127, 0]        // bright green (hit flash)
const COLOR_STEP_ON: [number, number, number] = [80, 80, 0]           // yellow
const COLOR_STEP_OFF: [number, number, number] = [8, 8, 8]            // dim gray
const COLOR_CHROMATIC_WHITE: [number, number, number] = [30, 30, 40]  // dim blueish white (natural notes)
const COLOR_CHROMATIC_BLACK: [number, number, number] = [10, 10, 50]  // dim blue (accidentals)
const COLOR_CHROMATIC_ACTIVE: [number, number, number] = [80, 80, 127] // bright blue (hit flash)

// --- Launchpad Pro MK3 Programmer Mode button addresses ---
// Bottom row below grid (left to right): notes 1-8
const BOTTOM_ROW_NOTES = [1, 2, 3, 4, 5, 6, 7, 8]

// Bottom narrow buttons (CCs)
const BOTTOM_NARROW_CCS = [101, 102, 103, 104, 105, 106, 107, 108]

// Left column — top to bottom: Click(80), Undo(70), Delete(60),
// Duplicate(50), Quantise(40), Double(30), Play(20), Record(10)
// NOTE: Verified on hardware — CC 40 = Quantise, CC 50 = Duplicate
const LEFT_COL_RECORD = 10
const LEFT_COL_PLAY = 20
const LEFT_COL_DUPLICATE = 50
const LEFT_COL_SHIFT = 90

// Colors for functional buttons
const COLOR_RECORD_OFF: [number, number, number] = [20, 0, 0]
const COLOR_RECORD_ON: [number, number, number] = [127, 0, 0]
const COLOR_PLAY_OFF: [number, number, number] = [0, 20, 0]
const COLOR_PLAY_ON: [number, number, number] = [0, 127, 0]
const COLOR_BANK_OFF: [number, number, number] = [10, 10, 10]
const COLOR_BANK_ON: [number, number, number] = [127, 80, 0]   // orange (active bank)
const COLOR_DUPLICATE_DIM: [number, number, number] = [20, 20, 40]   // dim blueish white

// Palette indices for note-velocity LED method
const PAL_OFF = 0
const PAL_DIM_GRAY = 1
const PAL_GREEN = 21
const PAL_GREEN_BRIGHT = 17
const PAL_YELLOW = 13
const PAL_DIM_WHITE = 2
const PAL_WHITE = 3
const PAL_ORANGE = 9
const PAL_BLUE = 45
const PAL_BLUE_BRIGHT = 41
const PAL_LIGHT_BLUE = 44

// type RGB = [number, number, number]

// --- Pad layout mapping ---

/**
 * Drum grid: bottom 4 rows (rows 1-4), left 4 columns (cols 1-4)
 * Bottom-left = pad 0, top-right = pad 15 (MPC layout)
 */
function drumPadToNote(padSlot: number): number {
  const row = Math.floor(padSlot / 4) + 1
  const col = (padSlot % 4) + 1
  return row * 10 + col
}

function noteToDrumPad(note: number): { bank: number; padSlot: number } | null {
  const row = Math.floor(note / 10)
  const col = note % 10
  if (row < 1 || row > 4 || col < 1 || col > 4) return null
  const padSlot = (row - 1) * 4 + (col - 1)
  return { bank: _activeBank, padSlot }
}

/**
 * Chromatic grid: bottom 4 rows (rows 1-4), right 4 columns (cols 5-8)
 * Bottom-left (row 1, col 5) = semitone offset 0
 * Goes left-to-right, then bottom-to-top: 0-3 on row 1, 4-7 on row 2, etc.
 */
function noteToChromaticOffset(note: number): number | null {
  const row = Math.floor(note / 10)
  const col = note % 10
  if (row < 1 || row > 4 || col < 5 || col > 8) return null
  return (row - 1) * 4 + (col - 5)
}

function chromaticOffsetToNote(offset: number): number {
  const row = Math.floor(offset / 4) + 1
  const col = (offset % 4) + 5
  return row * 10 + col
}

/** Returns true if semitone offset (mod 12) is a black key */
function isBlackKey(offset: number): boolean {
  const mod = offset % 12
  return mod === 1 || mod === 3 || mod === 6 || mod === 8 || mod === 10
}

/**
 * Sequencer step → note mapping
 * 16-step: rows 7-8 (top 2 rows)
 *   Row 8 (top):    steps 0-7   (notes 81-88)
 *   Row 7:          steps 8-15  (notes 71-78)
 * 32-step: rows 5-8 (top 4 rows)
 *   Row 8 (top):    steps 0-7   (notes 81-88)
 *   Row 7:          steps 8-15  (notes 71-78)
 *   Row 6:          steps 16-23 (notes 61-68)
 *   Row 5:          steps 24-31 (notes 51-58)
 */
function stepToNote(step: number): number {
  if (step < 8) return 81 + step
  if (step < 16) return 71 + (step - 8)
  if (step < 24) return 61 + (step - 16)
  return 51 + (step - 24)
}

function noteToStep(note: number): number | null {
  const row = Math.floor(note / 10)
  const col = note % 10
  if (col < 1 || col > 8) return null
  if (row === 8) return col - 1
  if (row === 7) return 8 + (col - 1)
  const stepCount = _getStepCount?.() ?? 16
  if (stepCount > 16) {
    if (row === 6) return 16 + (col - 1)
    if (row === 5) return 24 + (col - 1)
  }
  return null
}

// --- State ---
let _output: MIDIOutput | null = null
let _allOutputs: MIDIOutput[] = []
let _inputs: MIDIInput[] = []
let _connected = false
let _lastTriggeredPadId: string | null = null
let _unsubTransport: (() => void) | null = null
let _unsubStore: (() => void) | null = null
let _getPads: (() => Pad[]) | null = null
let _getEvents: (() => SequenceEvent[]) | null = null
let _getStepCount: (() => number) | null = null
let _triggerPadCb: ((pad: Pad, velocity: number) => void) | null = null
let _triggerChromaticCb: ((pad: Pad, velocity: number, semitoneOffset: number) => void) | null = null
let _releasePadCb: ((padId: string) => void) | null = null
let _releaseChromaticCb: ((padId: string, semitoneOffset: number) => void) | null = null
let _toggleStepCb: ((step: number, padId: string) => void) | null = null
let _selectPadCb: ((padId: string) => void) | null = null
let _togglePlayCb: (() => void) | null = null
let _toggleRecordCb: (() => void) | null = null
let _setBankCb: ((bank: number) => void) | null = null
let _getIsPlaying: (() => boolean) | null = null
let _getIsRecordArmed: (() => boolean) | null = null
let _duplicateLengthCb: ((mode: 'double' | 'half') => void) | null = null

let _activeBank = 0  // 0-7
let _shiftHeld = false
// Track flash state for pads
const _flashTimers = new Map<number, ReturnType<typeof setTimeout>>()
// Track active chromatic notes for release
const _activeChromaticNotes = new Map<number, number>() // LP note → semitoneOffset
// Cached pad lookup
let _padByIdCache: Map<string, Pad> | null = null
let _padsByBankSlotCache: Map<string, Pad> | null = null
let _cachedPadsRef: Pad[] | null = null

function getPadById(id: string): Pad | undefined {
  const pads = _getPads?.() ?? []
  if (pads !== _cachedPadsRef) {
    _cachedPadsRef = pads
    _padByIdCache = new Map(pads.map((p) => [p.id, p]))
    _padsByBankSlotCache = new Map(pads.map((p) => [`${p.bank}:${p.slot}`, p]))
  }
  return _padByIdCache!.get(id)
}

function getPadByBankSlot(bank: number, slot: number): Pad | undefined {
  const pads = _getPads?.() ?? []
  if (pads !== _cachedPadsRef) {
    _cachedPadsRef = pads
    _padByIdCache = new Map(pads.map((p) => [p.id, p]))
    _padsByBankSlotCache = new Map(pads.map((p) => [`${p.bank}:${p.slot}`, p]))
  }
  return _padsByBankSlotCache!.get(`${bank}:${slot}`)
}

let _repaintTimer: ReturnType<typeof setTimeout> | null = null

// --- Public API ---

export function isLaunchpadProMk3(name: string): boolean {
  const n = name.toLowerCase()
  return (n.includes('launchpad pro') && (n.includes('mk3') || n.includes('mk iii'))) || n.includes('lppromk3')
}

export function isConnected(): boolean {
  return _connected
}

export function connect(
  outputs: MIDIOutput[],
  inputs: MIDIInput[],
  opts: {
    getPads: () => Pad[]
    getEvents: () => SequenceEvent[]
    getStepCount: () => number
    getIsPlaying: () => boolean
    getIsRecordArmed: () => boolean
    getActiveBank: () => number
    triggerPad: (pad: Pad, velocity: number) => void
    triggerChromatic: (pad: Pad, velocity: number, semitoneOffset: number) => void
    releasePad: (padId: string) => void
    releaseChromatic: (padId: string, semitoneOffset: number) => void
    toggleStep: (step: number, padId: string) => void
    selectPad: (padId: string) => void
    togglePlay: () => void
    toggleRecord: () => void
    setBank: (bank: number) => void
    duplicateLength: (mode: 'double' | 'half') => void
    subscribeStore: (listener: () => void) => () => void
  },
): void {
  _allOutputs = outputs
  _output = outputs.find((o) => (o.name || '').toLowerCase().includes('daw')) ?? outputs[0]
  _inputs = inputs
  _getPads = opts.getPads
  _getEvents = opts.getEvents
  _getStepCount = opts.getStepCount
  _getIsPlaying = opts.getIsPlaying
  _getIsRecordArmed = opts.getIsRecordArmed
  _triggerPadCb = opts.triggerPad
  _triggerChromaticCb = opts.triggerChromatic
  _releasePadCb = opts.releasePad
  _releaseChromaticCb = opts.releaseChromatic
  _toggleStepCb = opts.toggleStep
  _selectPadCb = opts.selectPad
  _togglePlayCb = opts.togglePlay
  _toggleRecordCb = opts.toggleRecord
  _setBankCb = opts.setBank
  _duplicateLengthCb = opts.duplicateLength

  // Enter Programmer mode — send to ALL outputs
  for (const out of _allOutputs) {
    try {
      out.send(new Uint8Array(SYSEX_PROGRAMMER_MODE))
    } catch { /* ignore */ }
  }

  // Listen for pad presses on ALL launchpad inputs
  for (const inp of _inputs) {
    inp.onmidimessage = handleMidiMessage
  }

  // Subscribe to store changes — debounced repaint
  _unsubStore = opts.subscribeStore(() => {
    if (_repaintTimer) clearTimeout(_repaintTimer)
    _repaintTimer = setTimeout(() => {
      _repaintTimer = null
      repaintDrumGrid()
      repaintChromaticGrid()
      repaintSequencer()
      repaintFunctionButtons()
    }, 50)
  })

  _connected = true
  _activeBank = opts.getActiveBank() ?? 0

  // Delay initial repaint to let Programmer mode switch complete
  setTimeout(() => {
    if (!_connected) return
    console.log('[LaunchpadProMk3] Sending initial LED repaint')
    repaintDrumGrid()
    repaintChromaticGrid()
    repaintSequencer()
    repaintFunctionButtons()
  }, 300)
}

export function disconnect(): void {
  if (_unsubTransport) { _unsubTransport(); _unsubTransport = null }
  if (_unsubStore) { _unsubStore(); _unsubStore = null }
  for (const inp of _inputs) inp.onmidimessage = null
  if (_connected && _output) {
    clearAll()
  }
  _output = null
  _allOutputs = []
  _inputs = []
  _connected = false
  _lastTriggeredPadId = null
  _activeChromaticNotes.clear()
  _shiftHeld = false
  _duplicateLengthCb = null
}

/** Called externally when a pad is triggered (from UI, MIDI, or sequencer) */
export function notifyPadTriggered(padId: string): void {
  if (!_connected) return
  const changed = _lastTriggeredPadId !== padId
  _lastTriggeredPadId = padId
  if (changed) {
    repaintSequencer()
    repaintChromaticGrid()
  }
  flashDrumPad(padId)
}

/** Called from sequencer tick — only flashes drum pad LED, does NOT change sequencer display */
export function notifySequencerHit(padId: string): void {
  if (!_connected) return
  flashDrumPad(padId)
}

function flashDrumPad(padId: string): void {
  const pad = getPadById(padId)
  if (!pad || pad.bank !== _activeBank) return

  const note = drumPadToNote(pad.slot)

  // Cancel any existing flash on this note
  const existing = _flashTimers.get(note)
  if (existing) {
    clearTimeout(existing)
    _flashTimers.delete(note)
  }

  // Flash bright
  setLed(note, ...COLOR_PAD_ACTIVE)

  // Restore after 100ms
  _flashTimers.set(note, setTimeout(() => {
    _flashTimers.delete(note)
    const hasContent = pad.settings.sampleId || pad.settings.source === 'synth'
    setLed(note, ...(hasContent ? COLOR_PAD_ASSIGNED : COLOR_PAD_EMPTY))
  }, 100))
}

function flashChromaticPad(offset: number): void {
  const note = chromaticOffsetToNote(offset)

  const existing = _flashTimers.get(note)
  if (existing) {
    clearTimeout(existing)
    _flashTimers.delete(note)
  }

  setLed(note, ...COLOR_CHROMATIC_ACTIVE)

  _flashTimers.set(note, setTimeout(() => {
    _flashTimers.delete(note)
    setLed(note, ...(isBlackKey(offset) ? COLOR_CHROMATIC_BLACK : COLOR_CHROMATIC_WHITE))
  }, 100))
}

// --- Internal ---

function sendToAll(data: Uint8Array): void {
  for (const out of _allOutputs) {
    try {
      out.send(data)
    } catch { /* device may be disconnected */ }
  }
}

/** Map an RGB color to the closest palette index */
function rgbToPalette(r: number, g: number, b: number): number {
  if (r === 0 && g === 0 && b === 0) return PAL_OFF
  if (r <= 8 && g <= 8 && b <= 8) return PAL_DIM_GRAY
  // Green family
  if (g > r && g > b && g >= 80) return PAL_GREEN_BRIGHT
  if (g > r && g > b) return PAL_GREEN
  // Blue family
  if (b > r && b > g && b >= 80) return PAL_BLUE_BRIGHT
  if (b > r && b > g) return PAL_BLUE
  // Blueish white (chromatic white keys)
  if (r >= 20 && g >= 20 && b >= 30 && b > r) return PAL_LIGHT_BLUE
  // Yellow
  if (r > 40 && g > 40 && b < 20) return PAL_YELLOW
  // Orange
  if (r > 80 && g > 30 && g < 80 && b < 20) return PAL_ORANGE
  // White
  if (r > 80 && g > 80 && b > 80) return PAL_WHITE
  return PAL_DIM_WHITE
}

/** Set LED using note-on velocity (palette) method — for grid pads */
function setLedNote(pad: number, paletteColor: number): void {
  sendToAll(new Uint8Array([0x90, pad, paletteColor]))
}

/** Set LED using CC value (palette) method — for side/top/bottom buttons */
function setLedCC(cc: number, paletteColor: number): void {
  sendToAll(new Uint8Array([0xb0, cc, paletteColor]))
}

function setLed(pad: number, r: number, g: number, b: number): void {
  setLedNote(pad, rgbToPalette(r, g, b))
}

function clearAll(): void {
  for (let row = 1; row <= 8; row++) {
    for (let col = 1; col <= 8; col++) {
      setLedNote(row * 10 + col, PAL_OFF)
    }
  }
  // Clear bottom row (note-addressed) and narrow buttons (CC-addressed)
  for (let i = 0; i < 8; i++) {
    setLedNote(BOTTOM_ROW_NOTES[i], PAL_OFF)
    setLedCC(BOTTOM_NARROW_CCS[i], PAL_OFF)
  }
  // Clear left column
  setLedCC(LEFT_COL_RECORD, PAL_OFF)
  setLedCC(LEFT_COL_PLAY, PAL_OFF)
  setLedCC(LEFT_COL_DUPLICATE, PAL_OFF)
}

function repaintDrumGrid(): void {
  if (!_connected || !_getPads) return
  const pads = _getPads()

  for (let slot = 0; slot < PADS_PER_BANK; slot++) {
    const pad = pads.find((p) => p.bank === _activeBank && p.slot === slot)
    const note = drumPadToNote(slot)
    const hasContent = pad && (pad.settings.sampleId || pad.settings.source === 'synth')
    setLed(note, ...(hasContent ? COLOR_PAD_ASSIGNED : COLOR_PAD_EMPTY))
  }
}

function repaintChromaticGrid(): void {
  if (!_connected) return

  for (let offset = 0; offset < 16; offset++) {
    const note = chromaticOffsetToNote(offset)
    setLed(note, ...(isBlackKey(offset) ? COLOR_CHROMATIC_BLACK : COLOR_CHROMATIC_WHITE))
  }
}

function repaintSequencer(): void {
  if (!_connected) return

  const stepCount = _getStepCount?.() ?? 16

  if (!_lastTriggeredPadId || !_getEvents) {
    for (let step = 0; step < stepCount; step++) {
      const note = stepToNote(step)
      setLedNote(note, rgbToPalette(...COLOR_STEP_OFF))
    }
    // In 16-step mode, clear rows 5-6
    if (stepCount <= 16) {
      for (let col = 1; col <= 8; col++) {
        setLedNote(51 + col - 1, PAL_OFF)
        setLedNote(61 + col - 1, PAL_OFF)
      }
    }
    return
  }

  const events = _getEvents()
  const padEvents = new Set(
    events.filter((e) => e.padId === _lastTriggeredPadId).map((e) => e.step)
  )

  for (let step = 0; step < stepCount; step++) {
    const note = stepToNote(step)
    const isActive = padEvents.has(step)
    setLedNote(note, rgbToPalette(...(isActive ? COLOR_STEP_ON : COLOR_STEP_OFF)))
  }

  // In 16-step mode, clear rows 5-6
  if (stepCount <= 16) {
    for (let col = 1; col <= 8; col++) {
      setLedNote(51 + col - 1, PAL_OFF)
      setLedNote(61 + col - 1, PAL_OFF)
    }
  }
}

function handleMidiMessage(event: MIDIMessageEvent): void {
  if (!event.data || event.data.length < 3) return
  const [status, note, velocity] = event.data
  const command = status & 0xf0

  // --- CC messages ---
  if (command === 0xb0) {
    // Track Shift state on both press and release
    if (note === LEFT_COL_SHIFT) {
      _shiftHeld = velocity > 0
      return
    }
    if (velocity > 0) {
      if (note === LEFT_COL_RECORD) {
        _toggleRecordCb?.()
        return
      }
      if (note === LEFT_COL_PLAY) {
        _togglePlayCb?.()
        return
      }
      if (note === LEFT_COL_DUPLICATE) {
        _duplicateLengthCb?.(_shiftHeld ? 'half' : 'double')
        return
      }
      // Bottom narrow row CCs for bank switching (all 8)
      if (BOTTOM_NARROW_CCS.includes(note)) {
        const bank = BOTTOM_NARROW_CCS.indexOf(note)
        _activeBank = bank
        _setBankCb?.(bank)
        repaintDrumGrid()
        repaintFunctionButtons()
        return
      }
    }
    return
  }

  // --- Note-off: release drum pads and chromatic pads ---
  const isNoteOff = command === 0x80 || (command === 0x90 && velocity === 0)
  if (isNoteOff) {
    // Drum pad release
    const drumPad = noteToDrumPad(note)
    if (drumPad && _releasePadCb) {
      const pad = getPadByBankSlot(drumPad.bank, drumPad.padSlot)
      if (pad) _releasePadCb(pad.id)
      return
    }
    // Chromatic pad release
    const chromaticOffset = noteToChromaticOffset(note)
    if (chromaticOffset !== null && _releaseChromaticCb && _lastTriggeredPadId) {
      _activeChromaticNotes.delete(note)
      _releaseChromaticCb(_lastTriggeredPadId, chromaticOffset)
      return
    }
    return
  }

  if (command !== 0x90) return  // Only handle note-on beyond this point

  // --- Left column note-on buttons ---
  if (note === LEFT_COL_RECORD) {
    _toggleRecordCb?.()
    return
  }
  if (note === LEFT_COL_PLAY) {
    _togglePlayCb?.()
    return
  }

  // --- Bottom row notes (1-8) for bank switching ---
  if (note >= 1 && note <= 8) {
    const bank = note - 1
    _activeBank = bank
    _setBankCb?.(bank)
    repaintDrumGrid()
    repaintFunctionButtons()
    return
  }

  // --- Drum pad press (rows 1-4, cols 1-4) ---
  const drumPad = noteToDrumPad(note)
  if (drumPad) {
    const pad = getPadByBankSlot(drumPad.bank, drumPad.padSlot)
    if (pad && _triggerPadCb) {
      _triggerPadCb(pad, velocity / 127)
      if (_selectPadCb) _selectPadCb(pad.id)
    }
    return
  }

  // --- Chromatic pad press (rows 1-4, cols 5-8) ---
  const chromaticOffset = noteToChromaticOffset(note)
  if (chromaticOffset !== null && _lastTriggeredPadId && _triggerChromaticCb) {
    const pad = getPadById(_lastTriggeredPadId)
    if (pad) {
      _activeChromaticNotes.set(note, chromaticOffset)
      _triggerChromaticCb(pad, velocity / 127, chromaticOffset)
      flashChromaticPad(chromaticOffset)
    }
    return
  }

  // --- Sequencer step press (rows 5-8, depending on step count) ---
  const step = noteToStep(note)
  if (step !== null && _lastTriggeredPadId && _toggleStepCb) {
    _toggleStepCb(step, _lastTriggeredPadId)
    return
  }
}

/** Repaint play/record LEDs and bank buttons */
function repaintFunctionButtons(): void {
  if (!_connected) return

  // Record button (left column — uses CC for LED)
  const isRecording = _getIsRecordArmed?.() ?? false
  setLedCC(LEFT_COL_RECORD, rgbToPalette(...(isRecording ? COLOR_RECORD_ON : COLOR_RECORD_OFF)))

  // Play button (left column — uses CC for LED)
  const isPlaying = _getIsPlaying?.() ?? false
  setLedCC(LEFT_COL_PLAY, rgbToPalette(...(isPlaying ? COLOR_PLAY_ON : COLOR_PLAY_OFF)))

  // Duplicate button — dim blueish white to show it's active
  setLedCC(LEFT_COL_DUPLICATE, rgbToPalette(...COLOR_DUPLICATE_DIM))

  // Bank buttons — bottom row (note-addressed) and narrow CCs
  for (let i = 0; i < 8; i++) {
    const pal = rgbToPalette(...(i === _activeBank ? COLOR_BANK_ON : COLOR_BANK_OFF))
    setLedCC(BOTTOM_NARROW_CCS[i], pal)
    setLedNote(BOTTOM_ROW_NOTES[i], pal)
  }
}
