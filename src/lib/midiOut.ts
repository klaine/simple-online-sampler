// ---------------------------------------------------------------------------
// MIDI Output registry & helpers
// ---------------------------------------------------------------------------

export interface MidiOutputInfo {
  id: string
  name: string
}

/** Module-level Map of raw MIDIOutput objects (non-reactive, non-serializable) */
const _outputs = new Map<string, MIDIOutput>()

/** Register (or update) a MIDIOutput object by id */
export function registerMidiOutput(output: MIDIOutput): void {
  _outputs.set(output.id, output)
}

/** Remove a MIDIOutput by id */
export function unregisterMidiOutput(id: string): void {
  _outputs.delete(id)
}

/** Get current list of output infos for display in the store/UI */
export function getMidiOutputInfos(): MidiOutputInfo[] {
  return Array.from(_outputs.values()).map((o) => ({ id: o.id, name: o.name || o.id }))
}

// ---------------------------------------------------------------------------
// Loop-prevention: track recently-sent (channel, note) pairs so incoming
// MIDI input messages that echo our own output are suppressed.
// Key: `${channel}:${note}`, value: timestamp when note-on was sent.
// ---------------------------------------------------------------------------
const _recentlySent = new Map<string, number>()
const ECHO_SUPPRESS_MS = 80  // suppress echoed note-ons within this window

/** Returns true if the incoming (channel0, note) looks like an echo of our output.
 *  channel0 is 0-indexed as received from a MIDIMessageEvent status byte. */
export function isMidiEcho(channel0: number, note: number): boolean {
  // _recentlySent keys use 1-indexed channel (as passed to sendMidiNote)
  const key = `${channel0 + 1}:${note}`
  const ts = _recentlySent.get(key)
  if (ts === undefined) return false
  if (Date.now() - ts < ECHO_SUPPRESS_MS) return true
  _recentlySent.delete(key)
  return false
}

// ---------------------------------------------------------------------------
// Active gate/adsr notes — so releaseMidiNote can send note-off correctly
// even if pad settings changed since note-on.
// ---------------------------------------------------------------------------
const _activeGateNotes = new Map<string, { outputId: string | null; channel: number; note: number }>()

/** Called by triggerPad for gate/adsr pads to register the active note. */
export function registerActiveNote(padId: string, outputId: string | null, channel: number, note: number): void {
  _activeGateNotes.set(padId, { outputId, channel, note })
}

/** Send note-off for a gate/adsr pad and clean up. */
export function releaseMidiNote(padId: string): void {
  const active = _activeGateNotes.get(padId)
  if (!active) return
  _activeGateNotes.delete(padId)
  sendMidiNoteOff(active.outputId, active.channel, active.note, `midiout:${padId}`)
}

/** Pending note-off timeouts keyed by a stable identifier */
const _pendingNoteOffs = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Send a MIDI note-on to the given output, and schedule note-off after durationMs.
 * Pass durationMs = null to send note-on only (call sendMidiNoteOff / releaseMidiNote manually).
 */
export function sendMidiNote(
  outputId: string | null,
  channel: number,           // 1–16
  note: number,              // 0–127
  velocity: number,          // 1–127
  durationMs: number | null,
  noteOffKey?: string,
  delayMs?: number,
): void {
  const output = outputId ? _outputs.get(outputId) : _outputs.values().next().value
  if (!output) return

  const ch = Math.max(1, Math.min(16, channel)) - 1  // 0-indexed
  const n = Math.max(0, Math.min(127, Math.round(note)))
  const v = Math.max(1, Math.min(127, Math.round(velocity)))

  // Mark as recently sent to suppress echo on the input side
  _recentlySent.set(`${channel}:${n}`, Date.now())
  // Periodic sweep to prevent unbounded growth
  if (_recentlySent.size > 64) {
    const now = Date.now()
    for (const [k, v] of _recentlySent) {
      if (now - v > 200) _recentlySent.delete(k)
    }
  }

  const sendTimestamp = delayMs && delayMs > 0 ? performance.now() + delayMs : undefined

  try {
    output.send([0x90 | ch, n, v], sendTimestamp)
  } catch {
    return
  }

  if (durationMs != null) {
    const key = noteOffKey ?? `${outputId}:${ch}:${n}`
    const existing = _pendingNoteOffs.get(key)
    if (existing) clearTimeout(existing)

    const totalDelayMs = (delayMs ?? 0) + durationMs
    const timer = setTimeout(() => {
      sendMidiNoteOff(outputId, channel, note, noteOffKey)
    }, Math.max(1, totalDelayMs))
    _pendingNoteOffs.set(key, timer)
  }
}

/**
 * Send a MIDI note-off and cancel any pending scheduled note-off for the given key.
 */
export function sendMidiNoteOff(
  outputId: string | null,
  channel: number,
  note: number,
  noteOffKey?: string,
): void {
  const output = outputId ? _outputs.get(outputId) : _outputs.values().next().value
  if (!output) return

  const ch = Math.max(1, Math.min(16, channel)) - 1
  const n = Math.max(0, Math.min(127, Math.round(note)))

  const key = noteOffKey ?? `${outputId}:${ch}:${n}`
  const existing = _pendingNoteOffs.get(key)
  if (existing) {
    clearTimeout(existing)
    _pendingNoteOffs.delete(key)
  }

  try {
    output.send([0x80 | ch, n, 0])
  } catch {
    // ignore
  }
}

/** Cancel a pending note-off without sending the message (e.g. already cut by choke) */
export function cancelPendingNoteOff(noteOffKey: string): void {
  const existing = _pendingNoteOffs.get(noteOffKey)
  if (existing) {
    clearTimeout(existing)
    _pendingNoteOffs.delete(noteOffKey)
  }
}
