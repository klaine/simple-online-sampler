import type { PlaybackPreparedSequence, PlaybackSnapshot } from './playbackSnapshot'

interface SchedulerOptions {
  mode: 'pattern' | 'song'
  loopEnabled: boolean
  activePatternId: string
  lookaheadMs: number
  visualCompMs: number
}

interface SchedulerEvent {
  padId: string
  velocity: number
  gate: number
  semitoneOffset: number
  note?: number
  atTimeSec: number
  stepDurationSec: number
}

interface SchedulerVisual {
  playheadStep: number
  patternId: string
  chainIndex: number | null
  chainRepeat: number
}

interface MetronomeBeat {
  atTimeSec: number
  accent: boolean   // true on beat 1 of each bar
}

interface SchedulerTickResult {
  events: SchedulerEvent[]
  metronomeBeats: MetronomeBeat[]
  visual: SchedulerVisual
  shouldStop: boolean
}

export class TransportScheduler {
  private currentStep = 0

  private nextAtMs = 0

  private chainIndex = 0

  private chainRepeat = 1

  private currentPatternId = ''

  start(nowMs: number, snapshot: PlaybackSnapshot, options: SchedulerOptions): void {
    this.currentStep = 0
    this.nextAtMs = nowMs

    if (options.mode === 'song' && snapshot.songChain.length > 0) {
      this.chainIndex = snapshot.songLoopStart ?? 0
      this.chainRepeat = 1
      this.currentPatternId =
        snapshot.songChain[this.chainIndex]?.patternId ?? options.activePatternId
    } else {
      this.chainIndex = 0
      this.chainRepeat = 1
      this.currentPatternId = options.activePatternId
    }
  }

  tick(nowMs: number, audioNowSec: number, snapshot: PlaybackSnapshot, options: SchedulerOptions): SchedulerTickResult {
    const events: SchedulerEvent[] = []
    const metronomeBeats: MetronomeBeat[] = []
    let shouldStop = false

    let sequence = this.resolveSequence(snapshot, options)
    if (!sequence) {
      return {
        events,
        metronomeBeats: [],
        shouldStop: true,
        visual: {
          playheadStep: 0,
          patternId: options.activePatternId,
          chainIndex: null,
          chainRepeat: 1,
        },
      }
    }

    let currentStepDurationMs =
      (sequence.resolution === 16 ? 60 / snapshot.bpm / 4 : 60 / snapshot.bpm / 8) * 1000

    while (this.nextAtMs <= nowMs + options.lookaheadMs) {
      if (this.currentStep >= sequence.lengthSteps) {
        if (options.mode === 'song' && snapshot.songChain.length > 0) {
          const chain = snapshot.songChain[this.chainIndex]
          const repeats = Math.max(1, chain?.repeats ?? 1)
          if (this.chainRepeat < repeats) {
            this.chainRepeat += 1
          } else {
            this.chainRepeat = 1
            this.chainIndex += 1
          }

          const loopStart = snapshot.songLoopStart ?? 0
          const loopEnd = snapshot.songLoopEnd ?? (snapshot.songChain.length - 1)
          if (this.chainIndex > loopEnd) {
            if (!options.loopEnabled) {
              shouldStop = true
              break
            }
            this.chainIndex = loopStart
          }

          if (this.chainIndex >= snapshot.songChain.length) {
            this.chainIndex = loopStart
          }

          this.currentPatternId = snapshot.songChain[this.chainIndex]?.patternId ?? this.currentPatternId
          sequence = snapshot.sequenceById.get(this.currentPatternId) ?? sequence
        } else {
          if (!options.loopEnabled) {
            shouldStop = true
            break
          }
        }

        this.currentStep = 0
      }

      currentStepDurationMs =
        (sequence.resolution === 16 ? 60 / snapshot.bpm / 4 : 60 / snapshot.bpm / 8) * 1000

      // Swing: offset odd steps forward, pull even steps back to compensate
      const swingAmount = (snapshot.swing ?? 0) / 100 * 0.5 * currentStepDurationMs
      const isOddStep = this.currentStep % 2 === 1

      const leadMs = Math.max(0, this.nextAtMs - nowMs)
      const swingOffsetMs = isOddStep ? swingAmount : 0
      const eventAudioTimeSec = audioNowSec + Math.max(0.01, (leadMs + swingOffsetMs) / 1000)
      const stepDurationSec = currentStepDurationMs / 1000

      // Metronome: emit beat on quarter-note boundaries
      const stepsPerBeat = sequence.resolution === 16 ? 4 : 8
      if (this.currentStep % stepsPerBeat === 0) {
        const stepsPerBar = stepsPerBeat * 4
        const isBarStart = this.currentStep % stepsPerBar === 0
        metronomeBeats.push({ atTimeSec: eventAudioTimeSec, accent: isBarStart })
      }

      const stepEvents = sequence.eventsByStep.get(this.currentStep) ?? []
      stepEvents.forEach((event) => {
        events.push({
          ...event,
          atTimeSec: eventAudioTimeSec,
          stepDurationSec,
        })
      })

      this.currentStep += 1
      this.nextAtMs += currentStepDurationMs
    }

    const elapsed = this.nextAtMs - nowMs
    const offsetSteps = Math.max(0, Math.ceil((elapsed - options.visualCompMs) / currentStepDurationMs))
    const playheadStep =
      (this.currentStep - offsetSteps + Math.max(1, sequence.lengthSteps) * 4) %
      Math.max(1, sequence.lengthSteps)

    return {
      events,
      metronomeBeats,
      shouldStop,
      visual: {
        playheadStep,
        patternId: this.currentPatternId,
        chainIndex: options.mode === 'song' ? this.chainIndex : null,
        chainRepeat: this.chainRepeat,
      },
    }
  }

  private resolveSequence(
    snapshot: PlaybackSnapshot,
    options: SchedulerOptions,
  ): PlaybackPreparedSequence | undefined {
    if (options.mode === 'song' && snapshot.songChain.length > 0) {
      this.currentPatternId = snapshot.songChain[this.chainIndex]?.patternId ?? options.activePatternId
      return snapshot.sequenceById.get(this.currentPatternId)
    }

    this.currentPatternId = options.activePatternId
    return snapshot.sequenceById.get(options.activePatternId)
  }
}
