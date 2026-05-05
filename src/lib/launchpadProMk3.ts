/**
 * Launchpad Pro MK3 integration — Programmer Mode
 *
 * Grid layout (8×8):
 *   16-step mode:
 *     Rows 7-8 (top 2 rows):     16-step sequencer for last-triggered pad
 *     Rows 1-4 (bottom 4 rows):  Drum pads — Bank 1 (4×4 left) + Bank 2 (4×4 right)
 *     Rows 5-6:                   unused (dimmed)
 *   32-step mode:
 *     Rows 5-8 (top 4 rows):     32-step sequencer (8 steps per row, top-to-bottom)
 *     Rows 1-4 (bottom 4 rows):  Drum pads — Bank 1 (4×4 left) + Bank 2 (4×4 right)
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

// LED lighting (RGB): header + 03 03 <pad> <r> <g> <b> + F7
// For single pad:
function buildLedSysEx(pad: number, r: number, g: number, b: number): number[] {
  return [...SYSEX_HEADER, 0x03, 0x03, pad, r & 0x7f, g & 0x7f, b & 0x7f, SYSEX_END]
}

// Batch LED update (kept for potential future use)
// function buildBatchLedSysEx(leds: Array<{ pad: number; r: number; g: number; b: number }>): number[] {
//   const data = [...SYSEX_HEADER, 0x03]
//   for (const led of leds) {
//     data.push(0x03, led.pad, led.r & 0x7f, led.g & 0x7f, led.b & 0x7f)
//   }
//   data.push(SYSEX_END)
//   return data
// }

// --- Colors (0-127 range for SysEx RGB) ---
const COLOR_OFF: [number, number, number] = [0, 0, 0]
const COLOR_PAD_EMPTY: [number, number, number] = [3, 3, 3]           // very dim (visible grid)
const COLOR_PAD_B1_ASSIGNED: [number, number, number] = [0, 80, 0]    // green (bank 1)
const COLOR_PAD_B1_ACTIVE: [number, number, number] = [0, 127, 0]     // bright green (bank 1 hit)
const COLOR_PAD_B2_ASSIGNED: [number, number, number] = [80, 0, 80]   // purple (bank 2) — distinct from green
const COLOR_PAD_B2_ACTIVE: [number, number, number] = [127, 0, 127]   // bright purple (bank 2 hit)
const COLOR_STEP_ON: [number, number, number] = [80, 80, 0]           // yellow
const COLOR_STEP_OFF: [number, number, number] = [8, 8, 8]            // dim gray

// --- Launchpad Pro MK3 Programmer Mode button addresses ---
// Bottom row below grid (left to right): notes 1-8
// Left column (bottom to top): notes 10, 20, 30, 40, 50, 60, 70, 80
// Right column (bottom to top): notes 19, 29, 39, 49, 59, 69, 79, 89
// Top row: CCs 91-98

// Bottom row notes used for bank page switching (text label row)
const BOTTOM_ROW_NOTES = [1, 2, 3, 4, 5, 6, 7, 8]

// Bottom narrow buttons (between grid and text row) — likely CCs or different notes
// These will be confirmed via MIDI logging; trying common Programmer mode values
const BOTTOM_NARROW_CCS = [101, 102, 103, 104, 105, 106, 107, 108]

// Left column — Record and Play (trying both note and CC addresses)
const LEFT_COL_RECORD = 10   // bottom-left button
const LEFT_COL_PLAY = 20     // second from bottom-left

// Colors for functional buttons
const COLOR_RECORD_OFF: [number, number, number] = [20, 0, 0]     // dim red
const COLOR_RECORD_ON: [number, number, number] = [127, 0, 0]     // bright red
const COLOR_PLAY_OFF: [number, number, number] = [0, 20, 0]       // dim green
const COLOR_PLAY_ON: [number, number, number] = [0, 127, 0]       // bright green
const COLOR_BANK_PAGE_OFF: [number, number, number] = [10, 10, 10] // dim
const COLOR_BANK_PAGE_ON: [number, number, number] = [127, 80, 0]  // orange (active page)
// These are used as note-on velocity values on ch1 to set pad colors
const PAL_OFF = 0
const PAL_DIM_GRAY = 1
const PAL_GREEN = 21          // medium green
const PAL_GREEN_BRIGHT = 17   // bright green
const PAL_PURPLE = 53         // purple
const PAL_PURPLE_BRIGHT = 57  // bright magenta/purple
const PAL_YELLOW = 13         // yellow
const PAL_DIM_WHITE = 2       // dim white
const PAL_WHITE = 3           // white
const PAL_ORANGE = 9          // orange

// --- Pad layout mapping ---

type RGB = [number, number, number]
/** quadrant: 0 = left half of grid, 1 = right half */
function bankAssignedColor(quadrant: number): RGB { return quadrant === 0 ? COLOR_PAD_B1_ASSIGNED : COLOR_PAD_B2_ASSIGNED }
function bankActiveColor(quadrant: number): RGB { return quadrant === 0 ? COLOR_PAD_B1_ACTIVE : COLOR_PAD_B2_ACTIVE }

/**
 * Drum grid: bottom 4 rows (rows 1-4), two 4×4 quadrants
 * Left quadrant (cols 1-4) = bank page's first bank
 * Right quadrant (cols 5-8) = bank page's second bank
 * Within each 4×4 block: bottom-left = pad 1, top-right = pad 16 (MPC layout)
 */
function drumPadToNote(quadrant: number, padSlot: number): number {
  const row = Math.floor(padSlot / 4)
  const col = padSlot % 4
  const noteRow = row + 1
  const noteCol = (quadrant === 0 ? col : col + 4) + 1
  return noteRow * 10 + noteCol
}

function noteToDrumPad(note: number): { bank: number; padSlot: number } | null {
  const row = Math.floor(note / 10)
  const col = note % 10
  if (row < 1 || row > 4 || col < 1 || col > 8) return null
  const quadrant = col <= 4 ? 0 : 1
  const localCol = quadrant === 0 ? col - 1 : col - 5
  const padSlot = (row - 1) * 4 + localCol
  // Map quadrant to absolute bank using current bank page
  const bank = _activeBankPage * 2 + quadrant
  return { bank, padSlot }
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
  if (step < 8) return 81 + step       // row 8: steps 0-7
  if (step < 16) return 71 + (step - 8)  // row 7: steps 8-15
  if (step < 24) return 61 + (step - 16) // row 6: steps 16-23
  return 51 + (step - 24)               // row 5: steps 24-31
}

function noteToStep(note: number): number | null {
  const row = Math.floor(note / 10)
  const col = note % 10
  if (col < 1 || col > 8) return null
  if (row === 8) return col - 1        // steps 0-7
  if (row === 7) return 8 + (col - 1)  // steps 8-15
  // Rows 5-6 only valid in 32-step mode
  const stepCount = _getStepCount?.() ?? 16
  if (stepCount > 16) {
    if (row === 6) return 16 + (col - 1)  // steps 16-23
    if (row === 5) return 24 + (col - 1)  // steps 24-31
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
let _releasePadCb: ((padId: string) => void) | null = null
let _toggleStepCb: ((step: number, padId: string) => void) | null = null
let _selectPadCb: ((padId: string) => void) | null = null
let _togglePlayCb: (() => void) | null = null
let _toggleRecordCb: (() => void) | null = null
let _setBankPageCb: ((page: number) => void) | null = null
let _getIsPlaying: (() => boolean) | null = null
let _getIsRecordArmed: (() => boolean) | null = null

let _activeBankPage = 0  // 0-3, each page shows 2 banks
// Track flash state for drum pads — multiple simultaneous flashes
const _flashTimers = new Map<number, ReturnType<typeof setTimeout>>()

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
    getBankPage: () => number
    triggerPad: (pad: Pad, velocity: number) => void
    releasePad: (padId: string) => void
    toggleStep: (step: number, padId: string) => void
    selectPad: (padId: string) => void
    togglePlay: () => void
    toggleRecord: () => void
    setBankPage: (page: number) => void
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
  _releasePadCb = opts.releasePad
  _toggleStepCb = opts.toggleStep
  _selectPadCb = opts.selectPad
  _togglePlayCb = opts.togglePlay
  _toggleRecordCb = opts.toggleRecord
  _setBankPageCb = opts.setBankPage

  // Enter Programmer mode — send to ALL outputs to ensure the right port gets it
  for (const out of _allOutputs) {
    try {
      out.send(new Uint8Array(SYSEX_PROGRAMMER_MODE))
    } catch { /* ignore */ }
  }

  // Listen for pad presses on ALL launchpad inputs
  for (const inp of _inputs) {
    inp.onmidimessage = handleMidiMessage
  }

  // No transport visual subscription — we don't animate the playhead on the LP

  // Subscribe to store changes (pad assignments, sequence edits) — debounced
  _unsubStore = opts.subscribeStore(() => {
    if (_repaintTimer) clearTimeout(_repaintTimer)
    _repaintTimer = setTimeout(() => {
      _repaintTimer = null
      repaintDrumGrid()
      repaintSequencer()
      repaintFunctionButtons()
    }, 50)
  })

  _connected = true
  _activeBankPage = Math.floor((opts.getBankPage() ?? 0) / 2)

  // Delay initial repaint to let Programmer mode switch complete
  setTimeout(() => {
    if (!_connected) return
    console.log('[LaunchpadProMk3] Sending initial LED repaint')
    repaintDrumGrid()
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
}

/** Called externally when a pad is triggered (from UI, MIDI, or sequencer) */
export function notifyPadTriggered(padId: string): void {
  if (!_connected) return
  const changed = _lastTriggeredPadId !== padId
  _lastTriggeredPadId = padId
  if (changed) repaintSequencer()
  flashDrumPad(padId)
  flashDrumPad(padId)
}

/** Called from sequencer tick — only flashes drum pad LED, does NOT change sequencer display */
export function notifySequencerHit(padId: string): void {
  if (!_connected) return
  flashDrumPad(padId)
}

function flashDrumPad(padId: string): void {
  // Flash the drum pad briefly — only if the pad's bank is on the current page
  const pads = _getPads?.() ?? []
  const pad = pads.find((p) => p.id === padId)
  if (!pad) return
  const pageFirstBank = _activeBankPage * 2
  const quadrant = pad.bank - pageFirstBank
  if (quadrant < 0 || quadrant > 1) return  // not on current page

  const note = drumPadToNote(quadrant, pad.slot)

  // Cancel any existing flash on this note
  const existing = _flashTimers.get(note)
  if (existing) {
    clearTimeout(existing)
    _flashTimers.delete(note)
  }

  // Flash bright
  setLed(note, ...bankActiveColor(quadrant))

  // Restore after 100ms
  _flashTimers.set(note, setTimeout(() => {
    _flashTimers.delete(note)
    const hasContent = pad.settings.sampleId
    setLed(note, ...(hasContent ? bankAssignedColor(quadrant) : COLOR_PAD_EMPTY))
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

function sendSysEx(data: number[]): void {
  sendToAll(new Uint8Array(data))
}

/** Map an RGB color to the closest palette index for note-velocity LED method */
function rgbToPalette(r: number, g: number, b: number): number {
  if (r === 0 && g === 0 && b === 0) return PAL_OFF
  if (r <= 8 && g <= 8 && b <= 8) return PAL_DIM_GRAY
  // Green family (bank 1)
  if (g > r && g > b && g >= 80) return PAL_GREEN_BRIGHT
  if (g > r && g > b) return PAL_GREEN
  // Purple family (bank 2)
  if (r > 0 && b > 0 && r >= 80 && b >= 80) return PAL_PURPLE_BRIGHT
  if (r > 0 && b > 0 && g < r) return PAL_PURPLE
  // Yellow
  if (r > 40 && g > 40 && b < 20) return PAL_YELLOW
  // Orange
  if (r > 80 && g > 30 && g < 80 && b < 20) return PAL_ORANGE
  // White
  if (r > 80 && g > 80 && b > 80) return PAL_WHITE
  return PAL_DIM_WHITE
}

/** Set LED using note-on velocity (palette) method — works reliably in Programmer mode */
function setLedNote(pad: number, paletteColor: number): void {
  // Note-on on channel 1 (0x90), note = pad number, velocity = color index
  // Velocity 0 = note-off (LED off)
  sendToAll(new Uint8Array([0x90, pad, paletteColor]))
}

function setLed(pad: number, r: number, g: number, b: number): void {
  // Primary: note-on palette method (reliable for all pads in Programmer mode)
  setLedNote(pad, rgbToPalette(r, g, b))
  // Also send SysEx RGB for more accurate color (may not work on all rows)
  sendSysEx(buildLedSysEx(pad, r, g, b))
}

function clearAll(): void {
  // Clear all 64 main pads
  for (let row = 1; row <= 8; row++) {
    for (let col = 1; col <= 8; col++) {
      setLed(row * 10 + col, ...COLOR_OFF)
    }
  }
}

function repaintDrumGrid(): void {
  if (!_connected || !_getPads) return
  const pads = _getPads()

  // Paint the two banks for the active bank page (quadrant 0 = left, 1 = right)
  for (let quadrant = 0; quadrant < 2; quadrant++) {
    const bank = _activeBankPage * 2 + quadrant
    for (let slot = 0; slot < PADS_PER_BANK; slot++) {
      const pad = pads.find((p) => p.bank === bank && p.slot === slot)
      const note = drumPadToNote(quadrant, slot)
      const hasContent = pad && pad.settings.sampleId
      setLed(note, ...(hasContent ? bankAssignedColor(quadrant) : COLOR_PAD_EMPTY))
    }
  }
}

function repaintSequencer(): void {
  if (!_connected) return

  const stepCount = _getStepCount?.() ?? 16

  // If no pad selected yet, show dim grid for all sequencer rows
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
  const channel = status & 0x0f

  // Log ALL incoming messages for mapping discovery
  const cmdName = command === 0x90 ? 'NoteOn' : command === 0x80 ? 'NoteOff' : command === 0xb0 ? 'CC' : `0x${command.toString(16)}`
  console.log(`[LaunchpadProMk3] ${cmdName} ch${channel + 1} note/cc=${note} vel/val=${velocity}`)

  // --- CC messages ---
  if (command === 0xb0 && velocity > 0) {
    // Left column CCs (Programmer mode): record, play, etc.
    // Bottom narrow row CCs
    // Try all — log will tell us which is which
    if (note === LEFT_COL_RECORD) {
      _toggleRecordCb?.()
      return
    }
    if (note === LEFT_COL_PLAY) {
      _togglePlayCb?.()
      return
    }
    // Bottom narrow row for bank pages
    if (BOTTOM_NARROW_CCS.includes(note)) {
      const page = BOTTOM_NARROW_CCS.indexOf(note)
      if (page >= 0 && page < 4) {
        _activeBankPage = page
        _setBankPageCb?.(page)
        repaintDrumGrid()
        repaintFunctionButtons()
      }
      return
    }
    return
  }

  // --- Note-off: release drum pads (gate mode, hold recording, etc.) ---
  const isNoteOff = command === 0x80 || (command === 0x90 && velocity === 0)
  if (isNoteOff) {
    const drumPad = noteToDrumPad(note)
    if (drumPad && _releasePadCb) {
      const pads = _getPads?.() ?? []
      const pad = pads.find((p) => p.bank === drumPad.bank && p.slot === drumPad.padSlot)
      if (pad) _releasePadCb(pad.id)
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

  // --- Bottom row notes (1-8) for bank pages ---
  if (note >= 1 && note <= 4) {
    const page = note - 1
    _activeBankPage = page
    _setBankPageCb?.(page)
    repaintDrumGrid()
    repaintFunctionButtons()
    return
  }

  // Check if it's a drum pad press (rows 1-4)
  const drumPad = noteToDrumPad(note)
  if (drumPad) {
    const pads = _getPads?.() ?? []
    const pad = pads.find((p) => p.bank === drumPad.bank && p.slot === drumPad.padSlot)
    if (pad && _triggerPadCb) {
      _triggerPadCb(pad, velocity / 127)
      if (_selectPadCb) _selectPadCb(pad.id)
    }
    return
  }

  // Check if it's a sequencer step press (rows 5-8, depending on step count)
  const step = noteToStep(note)
  if (step !== null && _lastTriggeredPadId && _toggleStepCb) {
    _toggleStepCb(step, _lastTriggeredPadId)
    return
  }
}

/** Repaint play/record LEDs and bank page buttons */
function repaintFunctionButtons(): void {
  if (!_connected) return

  // Record button (left column, bottom)
  const isRecording = _getIsRecordArmed?.() ?? false
  setLed(LEFT_COL_RECORD, ...(isRecording ? COLOR_RECORD_ON : COLOR_RECORD_OFF))

  // Play button (left column, second from bottom)
  const isPlaying = _getIsPlaying?.() ?? false
  setLed(LEFT_COL_PLAY, ...(isPlaying ? COLOR_PLAY_ON : COLOR_PLAY_OFF))

  // Bank page buttons — light both bottom narrow CCs and bottom note row
  for (let i = 0; i < 4; i++) {
    const color: RGB = i === _activeBankPage ? COLOR_BANK_PAGE_ON : COLOR_BANK_PAGE_OFF
    // Narrow row (CC-addressed LEDs — use note-on method which may address them)
    setLed(BOTTOM_NARROW_CCS[i], ...color)
    // Text label row (note-addressed)
    setLed(BOTTOM_ROW_NOTES[i], ...color)
  }
}
