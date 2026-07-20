import { audioEngine } from '../../lib/audioEngine'
import { sendMidiNote } from '../../lib/midiOut'
import { notifySequencerHit as notifyLaunchpadSeqHit } from '../../lib/launchpadProMk3'
import { mutableRefs } from '../refs'
import { transportVisualStore } from '../visualStore'
import { selectActiveSequence } from '../selectors'
import TransportClockWorker from '../../workers/transportClock.worker?worker'
import type { StoreContext } from '../context'

export const createTransportActions = (ctx: StoreContext) => ({
  stopTransport: () => {
    if (mutableRefs.transportWorker) {
      mutableRefs.transportWorker.postMessage({ type: 'stop' })
      mutableRefs.transportWorker.terminate()
    }
    mutableRefs.sequencedPadHitTimers.forEach((timerId) => window.clearTimeout(timerId))
    mutableRefs.sequencedPadHitTimers.clear()
    mutableRefs.transportWorker = null

    transportVisualStore.reset()
    audioEngine.stopAllVoices()

    ctx.set((d) => {
      d.isPlaying = false
      d.playingPatternId = null
      d.playingChainIndex = null
      d.playingChainRepeat = 1
    })

    mutableRefs.seqRecordCleared.clear()
    mutableRefs.activeRecordingNotes.clear()

    // Clear capture transport start (buffer stays for post-stop capture)
    mutableRefs.captureTransportStartMs = null

    if (mutableRefs.pendingPersist) {
      ctx.get().flushPendingProjectSave()
    }
  },

  flashSequencedPadHit: (padId: string) => {
    transportVisualStore.flashPadHit(padId)

    const existing = mutableRefs.sequencedPadHitTimers.get(padId)
    if (existing) window.clearTimeout(existing)

    const timerId = window.setTimeout(() => {
      transportVisualStore.clearPadHit(padId)
      mutableRefs.sequencedPadHitTimers.delete(padId)
    }, 120)
    mutableRefs.sequencedPadHitTimers.set(padId, timerId)
  },

  startTransport: async () => {
    try {
      const s = ctx.get()
      if (!s.project || !s.activeSequenceId || s.isPlaying) return

      const activeSeq = selectActiveSequence(s)
      if (!activeSeq) return

      if (mutableRefs.transportWorker) {
        mutableRefs.transportWorker.postMessage({ type: 'stop' })
        mutableRefs.transportWorker.terminate()
        mutableRefs.transportWorker = null
      }

      // Prepare buffers
      const patternIdsToPrepare =
        s.playbackScope === 'song' && s.project.songChain.length > 0
          ? Array.from(new Set(s.project.songChain.map((entry) => entry.patternId)))
          : [activeSeq.id]
      const patternsToPrepare = s.project.sequences.filter((seq) => patternIdsToPrepare.includes(seq.id))
      const sampleIdsToPrepare = Array.from(
        new Set(
          patternsToPrepare
            .flatMap((seq) => seq.events)
            .flatMap((event) => {
              const pad = s.project!.pads.find((p) => p.id === event.padId)
              if (!pad) return []
              const ids: string[] = []
              if (pad.settings.sampleId) ids.push(pad.settings.sampleId)
              for (const layer of pad.settings.layers ?? []) {
                if (layer.sampleId) ids.push(layer.sampleId)
              }
              return ids
            }),
        ),
      )
      await audioEngine.unlock()

      for (const sampleId of sampleIdsToPrepare) {
        if (audioEngine.hasSample(sampleId)) continue
        const sample = s.sampleMap.get(sampleId)
        if (sample) await audioEngine.registerSample(sample)
      }

      const initialChainIndex =
        s.playbackScope === 'song' && s.project.songLoopStart !== null
          ? Math.max(0, Math.min(s.project.songChain.length - 1, s.project.songLoopStart))
          : 0

      ctx.set((d) => {
        d.isPlaying = true
        d.playingChainRepeat = 1
        if (s.playbackScope === 'song' && s.project!.songChain.length > 0) {
          const firstPattern = s.project!.sequences.find(
            (seq) => seq.id === s.project!.songChain[initialChainIndex]?.patternId,
          )
          d.playingPatternId = firstPattern?.id ?? activeSeq.id
          d.playingChainIndex = initialChainIndex
        } else {
          d.playingPatternId = activeSeq.id
          d.playingChainIndex = null
        }
      })

      const snapshot = mutableRefs.playbackSnapshot
      const lookaheadMs = 128
      const schedulerMs = 20
      const startLatencyMs = 30
      let visualStep = -1
      let tickCount = 0
      let lateNotes = 0
      let maxDriftMs = 0

      // Countdown: schedule metronome-only bars before actual playback
      const countdownBars = ctx.get().seqRecordArmed ? ctx.get().countdownBars : 0
      const bpm = snapshot.bpm
      const beatDurationSec = 60 / bpm
      const countdownBeats = countdownBars * 4
      const countdownDurationMs = countdownBeats * beatDurationSec * 1000
      let transportStartMs = performance.now() + startLatencyMs

      if (countdownBeats > 0 && ctx.get().metronomeEnabled) {
        const audioNow = audioEngine.nowSeconds()
        const audioStartSec = audioNow + startLatencyMs / 1000
        const vol = ctx.get().metronomeVolume
        for (let i = 0; i < countdownBeats; i++) {
          const t = audioStartSec + i * beatDurationSec
          audioEngine.playMetronomeClick(t, i % 4 === 0, vol)
        }
        transportStartMs += countdownDurationMs
      }

      mutableRefs.transportScheduler.start(transportStartMs, snapshot, {
        mode: ctx.get().playbackScope,
        loopEnabled: ctx.get().loopEnabled,
        activePatternId: activeSeq.id,
        lookaheadMs,
        visualCompMs: 46,
      })

      mutableRefs.captureTransportStartMs = transportStartMs

      const tick = () => {
        const currentState = ctx.get()
        if (!currentState.isPlaying) return

        const currentSnapshot = mutableRefs.playbackSnapshot
        const activeSequence = selectActiveSequence(currentState)
        if (!activeSequence) {
          ctx.get().stopTransport()
          return
        }

        const tickPerfNow = performance.now()
        const tickAudioNow = audioEngine.nowSeconds()
        const result = mutableRefs.transportScheduler.tick(
          tickPerfNow,
          tickAudioNow,
          currentSnapshot,
          {
            mode: currentState.playbackScope,
            loopEnabled: currentState.loopEnabled,
            activePatternId: activeSequence.id,
            lookaheadMs,
            visualCompMs: 46,
          },
        )

        if (result.shouldStop) {
          ctx.get().stopTransport()
          return
        }

        result.events.forEach((event: { padId: string; velocity: number; gate: number; semitoneOffset: number; note?: number; atTimeSec: number; stepDurationSec: number }) => {
          const pad = currentSnapshot.padById.get(event.padId)
          if (!pad || currentState.mutedLanePadIds.has(pad.id) || pad.settings.mute) return

          tickCount += 1
          const driftMs = Math.max(0, (audioEngine.nowSeconds() - event.atTimeSec) * 1000)
          maxDriftMs = Math.max(maxDriftMs, driftMs)
          mutableRefs.perfDriftWindow.push(driftMs)
          if (mutableRefs.perfDriftWindow.length > 200) mutableRefs.perfDriftWindow.splice(0, mutableRefs.perfDriftWindow.length - 200)
          if (driftMs > 5) lateNotes += 1

          // For piano roll events with absolute note, compute semitone offset from pad base
          let effectiveSemitoneOffset = event.semitoneOffset
          if (event.note != null) {
            effectiveSemitoneOffset = event.note - ((pad.settings.baseNote ?? 60) + (pad.settings.semitones ?? 0))
          }

          ctx.get().flashSequencedPadHit(pad.id)
          notifyLaunchpadSeqHit(pad.id)
          void audioEngine.playPad(pad, event.velocity / 127, {
            forceDuration:
              pad.settings.mode === 'one-shot'
                ? undefined
                : Math.max(0.04, event.gate * event.stepDurationSec),
            semitoneOffset: effectiveSemitoneOffset,
            atTimeSec: event.atTimeSec,
            bpm: currentSnapshot.bpm,
          })

          // MIDI out from sequencer
          const midiOut = pad.settings.midiOut
          if (midiOut?.enabled) {
            const note = event.note != null ? event.note : Math.max(0, Math.min(127, midiOut.note + event.semitoneOffset))
            const vel = midiOut.velocity < 0
              ? Math.max(1, Math.min(127, Math.round((event.velocity / 127) * 127)))
              : midiOut.velocity
            const durationMs = Math.max(40, event.gate * event.stepDurationSec * 1000)
            // Align MIDI timing with Web Audio scheduled time (account for audio output latency)
            const audioLatencyMs = (audioEngine.getOutputLatency()) * 1000
            const midiDelayMs = Math.max(0, (event.atTimeSec - tickAudioNow) * 1000 + audioLatencyMs)
            sendMidiNote(midiOut.deviceId, midiOut.channel, note, vel, durationMs, `midiout:seq:${pad.id}:${note}`, midiDelayMs)
          }
        })

        // Metronome clicks
        if (currentState.metronomeEnabled && result.metronomeBeats.length > 0) {
          const vol = currentState.metronomeVolume
          for (const beat of result.metronomeBeats) {
            audioEngine.playMetronomeClick(beat.atTimeSec, beat.accent, vol)
          }
        }

        if (result.visual.playheadStep !== visualStep) {
          visualStep = result.visual.playheadStep
          transportVisualStore.setPlayheadStep(result.visual.playheadStep)
        }

        {
          const s2 = ctx.get()
          if (
            s2.playingPatternId !== result.visual.patternId ||
            s2.playingChainIndex !== result.visual.chainIndex ||
            s2.playingChainRepeat !== result.visual.chainRepeat
          ) {
            ctx.set((d) => {
              d.playingPatternId = result.visual.patternId
              d.playingChainIndex = result.visual.chainIndex
              d.playingChainRepeat = result.visual.chainRepeat
            })
          }
        }

        if (tickCount > 0 && tickCount % 24 === 0 && ctx.get().showPerfStats) {
          const sorted = [...mutableRefs.perfDriftWindow].sort((a, b) => a - b)
          const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0
          ctx.set((d) => {
            d.perfStats = { tickCount, lateNotes, maxDriftMs, p95DriftMs: p95 }
          })
        }
      }

      tick()
      const worker = new TransportClockWorker()
      mutableRefs.transportWorker = worker
      worker.onmessage = (message: MessageEvent<{ type: 'tick'; nowMs: number }>) => {
        if (message.data.type === 'tick') tick()
      }
      worker.postMessage({ type: 'start', intervalMs: schedulerMs })
    } catch (e) {
      console.error('[startTransport] failed:', e)
      if (mutableRefs.transportWorker) {
        mutableRefs.transportWorker.terminate()
        mutableRefs.transportWorker = null
      }
      ctx.set((d) => { d.isPlaying = false })
    }
  },

  togglePlayPause: () => {
    if (ctx.get().isPlaying) {
      ctx.get().stopTransport()
    } else {
      // Kick off audio unlock synchronously in gesture callstack (iOS requirement)
      audioEngine.unlockAndPrepare()
      void ctx.get().startTransport()
    }
  },
})
