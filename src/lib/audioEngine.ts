import type { BusId, EffectSlot, FilterType, MixBus, Pad, PadSettings, SampleAsset } from '../types'
import { BUS_IDS } from '../types'
import {
  mergeLayerSettings,
  resolveFilterType,
  resolveLayer,
  createFilterChain,
  scheduleAmplitudeEnvelope,
  createPanNode,
  reverseAudioBuffer,
  resolveSourceOffsets,
} from './voiceUtils'

// Module-level round-robin counters (not in store — non-reactive)
const rrCounters = new Map<string, number>()

// Rate-limit eviction warnings (voice eviction is a hot path)
let _lastEvictionWarnMs = 0

interface ActiveVoice {
  source: AudioBufferSourceNode
  gain: GainNode
  filters: BiquadFilterNode[]
  pan: StereoPannerNode
  startedAt: number
  hold: boolean
  padId: string
  chokeGroup: number
  disposed: boolean
  release?: number
}

// ---------------------------------------------------------------------------
// Sidechain compressor worklet source (inlined as Blob URL)
// ---------------------------------------------------------------------------

const SC_WORKLET_SOURCE = /* js */ `
class SidechainCompressorProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.envelope = 0; }
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.003, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.25, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 10, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
    ];
  }
  process(inputs, outputs, parameters) {
    const audioInput = inputs[0];
    const scInput = inputs[1];
    const output = outputs[0];
    if (!audioInput || !audioInput.length || !output || !output.length) return true;
    const threshold = parameters.threshold[0];
    const ratio = parameters.ratio[0];
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const knee = parameters.knee[0];
    const sr = sampleRate;
    const attackCoeff = attack > 0 ? Math.exp(-1 / (sr * attack)) : 0;
    const releaseCoeff = release > 0 ? Math.exp(-1 / (sr * release)) : 0;
    const blockSize = audioInput[0].length;
    for (let i = 0; i < blockSize; i++) {
      let scSample = 0;
      if (scInput && scInput.length > 0) {
        for (let ch = 0; ch < scInput.length; ch++) scSample += (scInput[ch] && scInput[ch][i]) || 0;
        scSample /= scInput.length;
      }
      const scAbs = Math.abs(scSample);
      if (scAbs > this.envelope) this.envelope = attackCoeff * this.envelope + (1 - attackCoeff) * scAbs;
      else this.envelope = releaseCoeff * this.envelope + (1 - releaseCoeff) * scAbs;
      const envDb = this.envelope > 1e-8 ? 20 * Math.log10(this.envelope) : -160;
      let gainReductionDb = 0;
      if (knee > 0) {
        const halfKnee = knee / 2;
        if (envDb > threshold + halfKnee) gainReductionDb = (envDb - threshold) * (1 - 1 / ratio);
        else if (envDb > threshold - halfKnee) { const x = envDb - threshold + halfKnee; gainReductionDb = (x * x) / (4 * knee) * (1 - 1 / ratio); }
      } else { if (envDb > threshold) gainReductionDb = (envDb - threshold) * (1 - 1 / ratio); }
      const gainLinear = Math.pow(10, -gainReductionDb / 20);
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = audioInput[Math.min(ch, audioInput.length - 1)];
        output[ch][i] = ((inCh && inCh[i]) || 0) * gainLinear;
      }
    }
    return true;
  }
}
registerProcessor('sidechain-compressor', SidechainCompressorProcessor);
`

let scWorkletDataUrl: string | null = null
function getSCWorkletUrl(): string {
  if (!scWorkletDataUrl) {
    scWorkletDataUrl = 'data:application/javascript,' + encodeURIComponent(SC_WORKLET_SOURCE)
  }
  return scWorkletDataUrl
}

// ---------------------------------------------------------------------------
// Effect chain helpers
// ---------------------------------------------------------------------------

interface EffectChainNode {
  input: AudioNode
  output: AudioNode
  nodes: AudioNode[]
}

/** Generate a simple impulse response for convolution reverb */
function generateImpulseResponse(ctx: BaseAudioContext, decay: number, sampleRate: number): AudioBuffer {
  const clampedDecay = Math.min(8, decay)
  const length = Math.ceil(Math.max(sampleRate * 0.1, sampleRate * clampedDecay))
  const buffer = ctx.createBuffer(2, length, sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / (sampleRate * clampedDecay))
    }
  }
  return buffer
}

/** Build a Web Audio effect chain for a single EffectSlot */
function buildEffectNode(ctx: BaseAudioContext, slot: EffectSlot, sidechainInput?: AudioNode | null): EffectChainNode | null {
  if (slot.type === 'off' || !slot.enabled) return null

  const p = slot.params
  switch (slot.type) {
    case 'compressor': {
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = p.threshold ?? -18
      comp.ratio.value = p.ratio ?? 4
      comp.knee.value = p.knee ?? 10
      comp.attack.value = p.attack ?? 0.003
      comp.release.value = p.release ?? 0.25
      return { input: comp, output: comp, nodes: [comp] }
    }
    case 'sidechain-compressor': {
      // Requires AudioWorkletNode — works in both AudioContext and OfflineAudioContext
      // when the worklet has been registered. Falls back to regular DynamicsCompressor
      // if no sidechain source is available.
      if (!sidechainInput) {
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = p.threshold ?? -18
        comp.ratio.value = p.ratio ?? 4
        comp.knee.value = p.knee ?? 10
        comp.attack.value = p.attack ?? 0.003
        comp.release.value = p.release ?? 0.25
        return { input: comp, output: comp, nodes: [comp] }
      }
      try {
        const scNode = new AudioWorkletNode(ctx, 'sidechain-compressor', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        })
        // Set params
        const setParam = (name: string, value: number) => {
          const param = (scNode.parameters as Map<string, AudioParam>).get(name)
          if (param) param.value = value
        }
        setParam('threshold', p.threshold ?? -18)
        setParam('ratio', p.ratio ?? 4)
        setParam('attack', p.attack ?? 0.003)
        setParam('release', p.release ?? 0.25)
        setParam('knee', p.knee ?? 10)
        // Connect sidechain key signal to input 1
        sidechainInput.connect(scNode, 0, 1)
        return { input: scNode, output: scNode, nodes: [scNode] }
      } catch {
        // Worklet not registered — fall back to passthrough
        const passthrough = ctx.createGain()
        passthrough.gain.value = 1
        return { input: passthrough, output: passthrough, nodes: [passthrough] }
      }
    }
    case 'eq3': {
      const low = ctx.createBiquadFilter()
      low.type = 'lowshelf'
      low.frequency.value = 320
      low.gain.value = p.lowGain ?? 0

      const mid = ctx.createBiquadFilter()
      mid.type = 'peaking'
      mid.frequency.value = p.midFreq ?? 1000
      mid.Q.value = 1
      mid.gain.value = p.midGain ?? 0

      const high = ctx.createBiquadFilter()
      high.type = 'highshelf'
      high.frequency.value = 3200
      high.gain.value = p.highGain ?? 0

      low.connect(mid)
      mid.connect(high)
      return { input: low, output: high, nodes: [low, mid, high] }
    }
    case 'delay': {
      const mix = p.mix ?? 0.3
      const splitter = ctx.createGain()
      splitter.gain.value = 1
      const dryGain = ctx.createGain()
      dryGain.gain.value = 1
      const wet = ctx.createGain()
      wet.gain.value = mix
      const delay = ctx.createDelay(5)
      delay.delayTime.value = p.time ?? 0.3
      const feedback = ctx.createGain()
      feedback.gain.value = Math.min(0.95, p.feedback ?? 0.35)
      const merger = ctx.createGain()
      merger.gain.value = 1

      splitter.connect(dryGain)
      dryGain.connect(merger)
      splitter.connect(delay)
      delay.connect(feedback)
      feedback.connect(delay)
      delay.connect(wet)
      wet.connect(merger)

      return { input: splitter, output: merger, nodes: [splitter, dryGain, wet, delay, feedback, merger] }
    }
    case 'reverb': {
      const mix = p.mix ?? 0.25
      const decay = Math.max(0.1, p.decay ?? 1.5)
      const splitter = ctx.createGain()
      splitter.gain.value = 1
      const dryGain = ctx.createGain()
      dryGain.gain.value = 1 - mix
      const wetGain = ctx.createGain()
      wetGain.gain.value = mix
      const convolver = ctx.createConvolver()
      convolver.buffer = generateImpulseResponse(ctx, decay, ctx.sampleRate)
      const merger = ctx.createGain()
      merger.gain.value = 1

      splitter.connect(dryGain)
      dryGain.connect(merger)
      splitter.connect(convolver)
      convolver.connect(wetGain)
      wetGain.connect(merger)

      return { input: splitter, output: merger, nodes: [splitter, dryGain, wetGain, convolver, merger] }
    }
    case 'chorus': {
      const mix = p.mix ?? 0.3
      const rate = p.rate ?? 1.5
      const depth = (p.depth ?? 5) / 1000

      const splitter = ctx.createGain()
      splitter.gain.value = 1
      const dryGain = ctx.createGain()
      dryGain.gain.value = 1
      const wet = ctx.createGain()
      wet.gain.value = mix
      const delay = ctx.createDelay(0.05)
      delay.delayTime.value = 0.01
      const lfo = ctx instanceof AudioContext
        ? ctx.createOscillator()
        : (ctx as OfflineAudioContext).createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = rate
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = depth
      const merger = ctx.createGain()
      merger.gain.value = 1

      lfo.connect(lfoGain)
      lfoGain.connect(delay.delayTime)
      lfo.start()

      splitter.connect(dryGain)
      dryGain.connect(merger)
      splitter.connect(delay)
      delay.connect(wet)
      wet.connect(merger)

      return { input: splitter, output: merger, nodes: [splitter, dryGain, wet, delay, lfo, lfoGain, merger] }
    }
    default:
      return null
  }
}

/** Wire effect slots in series, returning { input, output } for the chain */
function buildEffectChain(
  ctx: BaseAudioContext,
  slots: EffectSlot[],
  getSidechainSource?: (slot: EffectSlot) => AudioNode | null,
): { input: GainNode; output: GainNode; allNodes: AudioNode[]; slotNodes: (EffectChainNode | null)[] } {
  const inputNode = ctx.createGain()
  inputNode.gain.value = 1
  const outputNode = ctx.createGain()
  outputNode.gain.value = 1
  const allNodes: AudioNode[] = [inputNode, outputNode]
  const slotNodes: (EffectChainNode | null)[] = []

  let lastOutput: AudioNode = inputNode
  for (const slot of slots) {
    const scInput = getSidechainSource ? getSidechainSource(slot) : null
    const chain = buildEffectNode(ctx, slot, scInput)
    slotNodes.push(chain)
    if (chain) {
      lastOutput.connect(chain.input)
      lastOutput = chain.output
      allNodes.push(...chain.nodes)
    }
  }
  lastOutput.connect(outputNode)

  return { input: inputNode, output: outputNode, allNodes, slotNodes }
}

/** Update AudioParams on an existing effect node without rebuilding the graph */
function updateEffectNodeParams(node: EffectChainNode, slot: EffectSlot, ctx: AudioContext): void {
  const p = slot.params
  const now = ctx.currentTime
  const tau = 0.01 // ~10ms smoothing

  switch (slot.type) {
    case 'compressor': {
      const comp = node.nodes[0] as DynamicsCompressorNode
      comp.threshold.setTargetAtTime(p.threshold ?? -18, now, tau)
      comp.ratio.setTargetAtTime(p.ratio ?? 4, now, tau)
      comp.knee.setTargetAtTime(p.knee ?? 10, now, tau)
      comp.attack.setTargetAtTime(p.attack ?? 0.003, now, tau)
      comp.release.setTargetAtTime(p.release ?? 0.25, now, tau)
      break
    }
    case 'sidechain-compressor': {
      const scNode = node.nodes[0]
      if (scNode instanceof AudioWorkletNode) {
        const setParam = (name: string, value: number) => {
          const param = (scNode.parameters as Map<string, AudioParam>).get(name)
          if (param) param.setTargetAtTime(value, now, tau)
        }
        setParam('threshold', p.threshold ?? -18)
        setParam('ratio', p.ratio ?? 4)
        setParam('attack', p.attack ?? 0.003)
        setParam('release', p.release ?? 0.25)
        setParam('knee', p.knee ?? 10)
      } else {
        const comp = scNode as unknown as DynamicsCompressorNode
        comp.threshold.setTargetAtTime(p.threshold ?? -18, now, tau)
        comp.ratio.setTargetAtTime(p.ratio ?? 4, now, tau)
        comp.knee.setTargetAtTime(p.knee ?? 10, now, tau)
        comp.attack.setTargetAtTime(p.attack ?? 0.003, now, tau)
        comp.release.setTargetAtTime(p.release ?? 0.25, now, tau)
      }
      break
    }
    case 'eq3': {
      const [low, mid, high] = node.nodes as BiquadFilterNode[]
      low.gain.setTargetAtTime(p.lowGain ?? 0, now, tau)
      mid.frequency.setTargetAtTime(p.midFreq ?? 1000, now, tau)
      mid.gain.setTargetAtTime(p.midGain ?? 0, now, tau)
      high.gain.setTargetAtTime(p.highGain ?? 0, now, tau)
      break
    }
    case 'delay': {
      const wet = node.nodes[2] as GainNode
      const delay = node.nodes[3] as DelayNode
      const feedback = node.nodes[4] as GainNode
      wet.gain.setTargetAtTime(p.mix ?? 0.3, now, tau)
      delay.delayTime.setTargetAtTime(p.time ?? 0.3, now, tau)
      feedback.gain.setTargetAtTime(Math.min(0.95, p.feedback ?? 0.35), now, tau)
      break
    }
    case 'reverb': {
      const dryGain = node.nodes[1] as GainNode
      const wetGain = node.nodes[2] as GainNode
      const mix = p.mix ?? 0.25
      dryGain.gain.setTargetAtTime(1 - mix, now, tau)
      wetGain.gain.setTargetAtTime(mix, now, tau)
      break
    }
    case 'chorus': {
      const wet = node.nodes[2] as GainNode
      const lfo = node.nodes[4] as OscillatorNode
      const lfoGain = node.nodes[5] as GainNode
      wet.gain.setTargetAtTime(p.mix ?? 0.3, now, tau)
      lfo.frequency.setTargetAtTime(p.rate ?? 1.5, now, tau)
      lfoGain.gain.setTargetAtTime((p.depth ?? 5) / 1000, now, tau)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

interface BusNodes {
  gain: GainNode
  pan: StereoPannerNode
  effectChain: { input: GainNode; output: GainNode; allNodes: AudioNode[]; slotNodes: (EffectChainNode | null)[] }
  analyser: AnalyserNode
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private _bufferSize: number = Number(localStorage.getItem('audioBufferSize')) || 512

  private masterGain: GainNode | null = null
  private previewSource: AudioBufferSourceNode | null = null
  private masterEffectChain: { input: GainNode; output: GainNode; allNodes: AudioNode[]; slotNodes: (EffectChainNode | null)[] } | null = null

  private analyser: AnalyserNode | null = null

  private masterAnalyser: AnalyserNode | null = null

  private busNodes = new Map<BusId, BusNodes>()

  private buffers = new Map<string, AudioBuffer>()

  private activeVoices: ActiveVoice[] = []

  private polyphony = 32

  // Node pool to reduce allocation in hot path
  private gainPool: GainNode[] = []

  private workletReady = false

  // Input monitor state
  private monitorRequestId = 0
  private monitorStream: MediaStream | null = null
  private monitorSource: MediaStreamAudioSourceNode | null = null
  private monitorGain: GainNode | null = null

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: this._bufferSize / 48000 })
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0.9

      // Master effect chain (initially bypass)
      this.masterEffectChain = buildEffectChain(this.ctx, [])
      this.masterGain.connect(this.masterEffectChain.input)

      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.8
      this.masterEffectChain.output.connect(this.analyser)
      this.analyser.connect(this.ctx.destination)

      // Create 4 bus nodes, all feeding into masterGain
      for (const busId of BUS_IDS) {
        const gain = this.ctx.createGain()
        gain.gain.value = 1
        const pan = this.ctx.createStereoPanner()
        pan.pan.value = 0
        const effectChain = buildEffectChain(this.ctx, [])
        const busAnalyser = this.ctx.createAnalyser()
        busAnalyser.fftSize = 256
        busAnalyser.smoothingTimeConstant = 0.8

        gain.connect(pan)
        pan.connect(effectChain.input)
        effectChain.output.connect(busAnalyser)
        busAnalyser.connect(this.masterGain)

        this.busNodes.set(busId, { gain, pan, effectChain, analyser: busAnalyser })
      }

      // Master analyser is the existing this.analyser (post-effects, pre-destination)
      this.masterAnalyser = this.analyser

      // Register sidechain worklet (async, non-blocking)
      void this.registerWorklet()
    }
    return this.ctx
  }

  private async registerWorklet(): Promise<void> {
    if (!this.ctx || this.workletReady) return
    try {
      await this.ctx.audioWorklet.addModule(getSCWorkletUrl())
      this.workletReady = true
    } catch (e) {
      console.warn('Failed to register sidechain compressor worklet:', e)
    }
  }

  /** Return the AudioContext if already created, or null */
  getContextIfReady(): AudioContext | null {
    return this.ctx
  }

  getBufferSize(): number {
    return this._bufferSize
  }

  /** Recreate AudioContext with a new buffer size. Stops all playback. */
  async setBufferSize(size: number): Promise<void> {
    this._bufferSize = size
    localStorage.setItem('audioBufferSize', String(size))

    if (!this.ctx) return

    for (const v of this.activeVoices) {
      if (!v.disposed) {
        v.disposed = true
        try { v.source.stop() } catch { /* ignore */ }
        try { v.source.disconnect() } catch { /* ignore */ }
        try { v.gain.disconnect() } catch { /* ignore */ }
        if (v.filters) v.filters.forEach((f) => { try { f.disconnect() } catch { /* ignore */ } })
      }
    }
    this.activeVoices.length = 0

    this.stopInputMonitor()

    await this.ctx.close()

    this.ctx = null
    this.masterGain = null
    this.masterEffectChain = null
    this.analyser = null
    this.masterAnalyser = null
    this.busNodes.clear()
    this.gainPool.length = 0
    this.workletReady = false

    this.getContext()
  }

  private acquireGain(): GainNode {
    const node = this.gainPool.pop()
    if (node) {
      node.gain.cancelScheduledValues(0)
      node.gain.value = 1
      return node
    }
    return this.getContext().createGain()
  }

  private releaseGain(node: GainNode): void {
    try { node.disconnect() } catch { /* */ }
    if (this.gainPool.length < 16) this.gainPool.push(node)
  }

  private releaseFilters(nodes: BiquadFilterNode[]): void {
    for (const f of nodes) {
      try { f.disconnect() } catch { /* */ }
    }
  }

  nowSeconds(): number {
    return this.getContext().currentTime
  }

  getOutputLatency(): number {
    const ctx = this.getContext()
    return (ctx as unknown as { outputLatency?: number }).outputLatency ?? ctx.baseLatency ?? 0
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  getBusAnalyser(busId: BusId): AnalyserNode | null {
    return this.busNodes.get(busId)?.analyser ?? null
  }

  getMasterAnalyser(): AnalyserNode | null {
    return this.masterAnalyser
  }

  setPolyphony(polyphony: 4 | 8 | 16 | 32): void {
    this.polyphony = polyphony
  }

  setBpm(bpm: number): void {
    // BPM is handled by TransportScheduler, not by the audio context.
    void bpm
  }

  hasSample(sampleId: string): boolean {
    return this.buffers.has(sampleId)
  }

  getBuffer(sampleId: string): AudioBuffer | undefined {
    return this.buffers.get(sampleId)
  }

  /** Play a sample preview through the master bus. Returns a callback to invoke on ended (for UI cleanup). */
  playPreview(sampleId: string, onEnded?: () => void): void {
    this.stopPreview()
    const ctx = this.getContext()
    const buffer = this.buffers.get(sampleId)
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const dest = this.masterGain ?? ctx.destination
    source.connect(dest)
    source.onended = () => {
      if (this.previewSource === source) this.previewSource = null
      onEnded?.()
    }
    this.previewSource = source
    source.start()
  }

  stopPreview(): void {
    if (this.previewSource) {
      try { this.previewSource.stop() } catch { /* */ }
      this.previewSource = null
    }
  }

  // Queue for samples that failed decoding on a suspended context (Safari)
  private pendingDecodes: Map<string, ArrayBuffer> = new Map()

  // Reversed buffer cache (keyed by sampleId, invalidated when the sample buffer changes)
  private reversedBuffers = new Map<string, AudioBuffer>()

  /** Get (or lazily create) the reversed copy of a sample's buffer */
  private getReversedBuffer(sampleId: string, source: AudioBuffer): AudioBuffer {
    let rev = this.reversedBuffers.get(sampleId)
    if (!rev || rev.length !== source.length) {
      rev = reverseAudioBuffer(source)
      this.reversedBuffers.set(sampleId, rev)
    }
    return rev
  }

  private async flushPendingDecodes(): Promise<void> {
    if (this.pendingDecodes.size === 0) return
    const ctx = this.getContext()
    const entries = [...this.pendingDecodes.entries()]
    this.pendingDecodes.clear()
    for (const [id, buf] of entries) {
      if (this.buffers.has(id)) continue // already decoded
      try {
        const audioBuffer = await ctx.decodeAudioData(buf.slice(0))
        this.buffers.set(id, audioBuffer)
      } catch (e) {
        console.warn('Failed to decode pending sample', id, e)
      }
    }
  }

  private getBusDestination(busId: BusId): GainNode {
    this.getContext()
    return this.busNodes.get(busId)!.gain
  }

  // iOS silent switch workaround: playing a tiny <audio> element promotes the
  // audio session from "ambient" (muted by silent switch) to "playback".
  private _iosAudioUnlocked = false
  private _iosUnlockPromise: Promise<void> | null = null

  /** Kick off iOS audio unlock synchronously (must be in user gesture callstack) */
  private startIOSAudioUnlock(): void {
    if (this._iosAudioUnlocked || this._iosUnlockPromise) return
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    if (!isIOS) { this._iosAudioUnlocked = true; return }
    // Tiny 1-sample silent WAV
    const silentWav = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA=='
    const audio = new Audio(silentWav)
    audio.volume = 0.01
    audio.setAttribute('playsinline', '')
    // Start play synchronously in gesture — store the promise for awaiting later
    this._iosUnlockPromise = audio.play().then(() => {
      this._iosAudioUnlocked = true
      this._iosUnlockPromise = null
    }).catch(() => {
      this._iosUnlockPromise = null
    })
  }

  /** Must be called synchronously inside a user gesture handler.
   *  Kicks off context creation + resume + iOS audio unlock in the same callstack.
   *  Returns a promise that resolves when everything is ready. */
  unlockAndPrepare(): Promise<void> {
    try {
      // All of these must start synchronously within the gesture:
      // iOS silent audio: fire-and-forget (just needs to START in gesture, don't await)
      this.startIOSAudioUnlock()
      const ctx = this.getContext()
      const resumeP = ctx.state !== 'running'
        ? ctx.resume().catch(() => {})
        : Promise.resolve()
      // Only wait for ctx.resume + pending decodes (not the iOS audio element)
      return resumeP.then(() => this.flushPendingDecodes()).catch((e) => {
        console.warn('[audioEngine] unlockAndPrepare error:', e)
      })
    } catch (e) {
      console.warn('[audioEngine] unlockAndPrepare sync error:', e)
      return Promise.resolve()
    }
  }

  async unlock(): Promise<void> {
    return this.unlockAndPrepare()
  }

  /** Synchronous unlock — resumes context without awaiting (fire-and-forget) */
  unlockSync(): void {
    void this.unlockAndPrepare()
  }

  async registerSample(sample: SampleAsset): Promise<void> {
    const ctx = this.getContext()
    const buffer = await sample.blob.arrayBuffer()
    try {
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0))
      this.buffers.set(sample.id, audioBuffer)
      this.reversedBuffers.delete(sample.id) // invalidate stale reversed copy (e.g. after crop/normalize)
    } catch (e) {
      // Safari may fail decodeAudioData on a suspended context —
      // queue the raw buffer and decode after unlock/resume
      console.warn('decodeAudioData failed (context may be suspended), queueing for later', e)
      this.pendingDecodes.set(sample.id, buffer)
    }
  }

  unregisterSample(sampleId: string): void {
    this.buffers.delete(sampleId)
    this.reversedBuffers.delete(sampleId)
  }

  /** Remove cached AudioBuffers for samples no longer assigned to any pad */
  pruneUnusedBuffers(usedSampleIds: Set<string>): void {
    for (const id of this.buffers.keys()) {
      if (!usedSampleIds.has(id)) {
        this.buffers.delete(id)
        this.reversedBuffers.delete(id)
      }
    }
  }

  // --- Mixer control methods ---

  updateBus(busId: BusId, bus: MixBus, anySoloed: boolean): void {
    const ctx = this.getContext()
    const nodes = this.busNodes.get(busId)
    if (!nodes) return
    const now = ctx.currentTime
    const targetGain = bus.mute ? 0 : (anySoloed && !bus.solo ? 0 : bus.gain)
    nodes.gain.gain.setTargetAtTime(targetGain, now, 0.005)
    nodes.pan.pan.setTargetAtTime(bus.pan, now, 0.005)
  }

  updateMasterGain(gain: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(gain * 0.9, this.ctx.currentTime, 0.005)
    }
  }

  rebuildBusEffects(busId: BusId, slots: EffectSlot[]): void {
    const ctx = this.ctx
    if (!ctx) return
    const nodes = this.busNodes.get(busId)
    if (!nodes) return

    // Disconnect old effect chain output from bus analyser
    for (const n of nodes.effectChain.allNodes) {
      if (n instanceof OscillatorNode) try { n.stop() } catch { /* */ }
      try { n.disconnect() } catch { /* noop */ }
    }
    nodes.pan.disconnect()

    // Build new chain with sidechain source resolution
    const getSidechainSource = (slot: EffectSlot): AudioNode | null => {
      if (slot.type !== 'sidechain-compressor' || !slot.sidechainSource) return null
      if (slot.sidechainSource === busId) return null // prevent self-sidechain
      return this.busNodes.get(slot.sidechainSource)?.gain ?? null
    }

    const newChain = buildEffectChain(ctx, slots, getSidechainSource)
    nodes.pan.connect(newChain.input)
    newChain.output.connect(nodes.analyser)
    // analyser already connected to masterGain from init
    nodes.effectChain = newChain
  }

  rebuildMasterEffects(slots: EffectSlot[]): void {
    const ctx = this.ctx
    if (!ctx || !this.masterGain || !this.masterEffectChain || !this.analyser) return

    // Disconnect old chain
    this.masterGain.disconnect()
    for (const n of this.masterEffectChain.allNodes) {
      if (n instanceof OscillatorNode) try { n.stop() } catch { /* */ }
      try { n.disconnect() } catch { /* noop */ }
    }

    const newChain = buildEffectChain(ctx, slots)
    this.masterGain.connect(newChain.input)
    newChain.output.connect(this.analyser)
    this.masterEffectChain = newChain
  }

  /** Update params on existing bus effect nodes without rebuilding the graph */
  updateBusEffectParams(busId: BusId, slots: EffectSlot[]): void {
    const ctx = this.ctx
    if (!ctx) return
    const nodes = this.busNodes.get(busId)
    if (!nodes) return
    const { slotNodes } = nodes.effectChain
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      const node = slotNodes[i]
      if (node && slot.enabled && slot.type !== 'off') {
        updateEffectNodeParams(node, slot, ctx)
      }
    }
  }

  /** Update params on existing master effect nodes without rebuilding the graph */
  updateMasterEffectParams(slots: EffectSlot[]): void {
    const ctx = this.ctx
    if (!ctx || !this.masterEffectChain) return
    const { slotNodes } = this.masterEffectChain
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      const node = slotNodes[i]
      if (node && slot.enabled && slot.type !== 'off') {
        updateEffectNodeParams(node, slot, ctx)
      }
    }
  }

  // --- Playback ---

  playPad(
    pad: Pad,
    velocity: number,
    options?: { forceDuration?: number; hold?: boolean; atTimeSec?: number; semitoneOffset?: number; bpm?: number },
  ): void {
    // --- Stacked mode: trigger ALL layers simultaneously ---
    if (pad.settings.multiMode === 'stacked' && pad.settings.layers && pad.settings.layers.length > 0) {
      this.evictIfNeeded()

      // Choke group: once before all voices
      const chokeGroup = pad.settings.chokeGroup ?? 0
      if (chokeGroup > 0) {
        const chokeTime = options?.atTimeSec ?? this.getContext().currentTime
        const chokeDelayMs = Math.max(0, (chokeTime - this.getContext().currentTime) * 1000) + 15
        const toChoke = this.activeVoices.filter((v) => v.chokeGroup === chokeGroup)
        for (const v of toChoke) {
          try { v.gain.gain.setValueAtTime(v.gain.gain.value, chokeTime); v.gain.gain.linearRampToValueAtTime(0, chokeTime + 0.005) } catch { /* */ }
          try { v.source.stop(chokeTime + 0.01) } catch { /* */ }
          window.setTimeout(() => this.disposeVoice(v), chokeDelayMs)
        }
      }

      for (const layer of pad.settings.layers) {
        const rawBuffer = this.buffers.get(layer.sampleId)
        if (!rawBuffer) continue
        const settings = mergeLayerSettings(pad.settings, layer)
        const sourceBuffer = settings.reverse ? this.getReversedBuffer(layer.sampleId, rawBuffer) : rawBuffer
        const offsetMs = layer.stackOffsetMs ?? 0
        this.playVoice(pad, settings, sourceBuffer, velocity, chokeGroup, {
          ...options,
          stackDelayMs: offsetMs,
        })
      }
      return
    }

    const resolved = resolveLayer(pad, Math.max(1, Math.min(127, Math.round(velocity * 127))), {
      get: (id) => rrCounters.get(id) ?? 0,
      set: (id, v) => rrCounters.set(id, v),
    })
    if (!resolved) return

    const { sampleId, layer } = resolved
    const settings = mergeLayerSettings(pad.settings, layer)

    const rawBuffer = this.buffers.get(sampleId)
    if (!rawBuffer) return
    const sourceBuffer = settings.reverse ? this.getReversedBuffer(sampleId, rawBuffer) : rawBuffer

    this.evictIfNeeded()

    // Choke group: stop all voices in the same group
    const chokeGroup = pad.settings.chokeGroup ?? 0
    if (chokeGroup > 0) {
      const chokeTime = options?.atTimeSec ?? this.getContext().currentTime
      const chokeDelayMs = Math.max(0, (chokeTime - this.getContext().currentTime) * 1000) + 15
      const toChoke = this.activeVoices.filter((v) => v.chokeGroup === chokeGroup)
      for (const v of toChoke) {
        try { v.gain.gain.setValueAtTime(v.gain.gain.value, chokeTime); v.gain.gain.linearRampToValueAtTime(0, chokeTime + 0.005) } catch { /* */ }
        try { v.source.stop(chokeTime + 0.01) } catch { /* */ }
        window.setTimeout(() => this.disposeVoice(v), chokeDelayMs)
      }
    }

    const ctx = this.getContext()
    const busDestination = this.getBusDestination(settings.bus ?? 'A')

    const source = ctx.createBufferSource()
    source.buffer = sourceBuffer

    const semitoneShift = (settings.semitones ?? 0) + (options?.semitoneOffset ?? 0)
    const fineShift = (settings.fineCents ?? 0) / 100
    source.playbackRate.value = Math.pow(2, (semitoneShift + fineShift) / 12)

    const gainNode = this.acquireGain()
    const linearGain = Math.max(0.001, settings.gain * velocity)
    const startTimeSec = options?.atTimeSec ?? ctx.currentTime
    const hold = options?.hold ?? false

    source.connect(gainNode)

    // Per-pad pan
    const panNode = createPanNode(ctx, settings)
    panNode.connect(busDestination)

    // Per-pad filter
    const filterChain = createFilterChain(ctx, settings)
    const filterNodes = filterChain ? filterChain.nodes : []
    if (filterChain) {
      gainNode.connect(filterChain.input)
      filterChain.output.connect(panNode)
    } else {
      gainNode.connect(panNode)
    }

    const duration = sourceBuffer.duration
    const { startOffsetSec: startOffset, playbackDurationSec: playbackDuration } = resolveSourceOffsets(settings, duration)

    const delayMs = Math.max(0, (startTimeSec - ctx.currentTime) * 1000)

    // --- Amplitude envelope ---
    const envResult = scheduleAmplitudeEnvelope(
      gainNode.gain,
      startTimeSec,
      linearGain,
      settings,
      playbackDuration,
      options?.forceDuration,
      hold,
    )

    source.start(startTimeSec, startOffset, envResult.sourceStopSec)

    const voice: ActiveVoice = {
      source,
      gain: gainNode,
      filters: filterNodes,
      pan: panNode,
      startedAt: Date.now(),
      hold: (settings.mode === 'adsr' || settings.mode === 'ahr') ? hold : false,
      padId: pad.id,
      chokeGroup,
      disposed: false,
      release: settings.envelope.release,
    }
    this.activeVoices.push(voice)

    if (!voice.hold) {
      window.setTimeout(() => {
        this.disposeVoice(voice)
      }, Math.ceil(delayMs + envResult.sourceStopSec * 1000) + 120)
    }
  }

  /** Play a single voice from pre-merged settings + buffer (used by stacked mode) */
  private playVoice(
    pad: Pad,
    settings: PadSettings,
    sourceBuffer: AudioBuffer,
    velocity: number,
    chokeGroup: number,
    options?: { forceDuration?: number; hold?: boolean; atTimeSec?: number; semitoneOffset?: number; stackDelayMs?: number },
  ): void {
    const ctx = this.getContext()
    const busDestination = this.getBusDestination(settings.bus ?? 'A')
    const stackDelaySec = (options?.stackDelayMs ?? 0) / 1000

    const source = ctx.createBufferSource()
    source.buffer = sourceBuffer

    const semitoneShift = (settings.semitones ?? 0) + (options?.semitoneOffset ?? 0)
    const fineShift = (settings.fineCents ?? 0) / 100
    source.playbackRate.value = Math.pow(2, (semitoneShift + fineShift) / 12)

    const gainNode = this.acquireGain()
    const linearGain = Math.max(0.001, settings.gain * velocity)
    const baseStartTime = options?.atTimeSec ?? ctx.currentTime
    const startTimeSec = baseStartTime + stackDelaySec
    const holdS = options?.hold ?? false

    source.connect(gainNode)

    // Per-pad pan (stacked voice)
    const panNodeS = createPanNode(ctx, settings)
    panNodeS.connect(busDestination)

    // Per-pad filter
    const filterChainS = createFilterChain(ctx, settings)
    const filterNodes = filterChainS ? filterChainS.nodes : []
    if (filterChainS) {
      gainNode.connect(filterChainS.input)
      filterChainS.output.connect(panNodeS)
    } else {
      gainNode.connect(panNodeS)
    }

    const duration = sourceBuffer.duration
    const { startOffsetSec: startOffset, playbackDurationSec: playbackDuration } = resolveSourceOffsets(settings, duration)
    const delayMs = Math.max(0, (startTimeSec - ctx.currentTime) * 1000)

    // --- Amplitude envelope ---
    const envResultS = scheduleAmplitudeEnvelope(
      gainNode.gain,
      startTimeSec,
      linearGain,
      settings,
      playbackDuration,
      options?.forceDuration,
      holdS,
    )

    source.start(startTimeSec, startOffset, envResultS.sourceStopSec)

    const voice: ActiveVoice = {
      source,
      gain: gainNode,
      filters: filterNodes,
      pan: panNodeS,
      startedAt: Date.now(),
      hold: (settings.mode === 'adsr' || settings.mode === 'ahr') ? holdS : false,
      padId: pad.id,
      chokeGroup,
      disposed: false,
      release: settings.envelope.release,
    }
    this.activeVoices.push(voice)

    if (!voice.hold) {
      window.setTimeout(() => { this.disposeVoice(voice) }, Math.ceil(delayMs + envResultS.sourceStopSec * 1000) + 120)
    }
  }

  async startInputMonitor(deviceId: string | null, busId: BusId): Promise<void> {
    this.stopInputMonitor()
    const requestId = this.monitorRequestId
    const ctx = this.getContext()
    const audioConstraints: MediaTrackConstraints & Record<string, unknown> = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    if (deviceId) audioConstraints.deviceId = { exact: deviceId }
    const constraints: MediaStreamConstraints = { audio: audioConstraints, video: false }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (requestId !== this.monitorRequestId || this.monitorStream) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.monitorStream = stream
      this.monitorSource = ctx.createMediaStreamSource(stream)
      this.monitorGain = this.acquireGain()
      this.monitorGain.gain.value = 1
      const busNode = this.getBusDestination(busId)
      this.monitorSource.connect(this.monitorGain)
      this.monitorGain.connect(busNode)
    } catch (e) {
      if (requestId !== this.monitorRequestId) return
      console.warn('Input monitor: getUserMedia failed', e)
      throw e
    }
  }

  stopInputMonitor(): void {
    this.monitorRequestId++
    if (this.monitorSource) {
      try { this.monitorSource.disconnect() } catch { /* noop */ }
      this.monitorSource = null
    }
    if (this.monitorGain) {
      try { this.monitorGain.disconnect() } catch { /* noop */ }
      this.releaseGain(this.monitorGain)
      this.monitorGain = null
    }
    if (this.monitorStream) {
      this.monitorStream.getTracks().forEach((t) => t.stop())
      this.monitorStream = null
    }
  }

  /** Switch audio output device (uses AudioContext.setSinkId) */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    const ctx = this.getContext()
    if ('setSinkId' in ctx) {
      await (ctx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId ?? '')
    }
  }

  releasePad(padId: string): void {
    const holdVoices = this.activeVoices.filter((voice) => voice.padId === padId && voice.hold)
    holdVoices.forEach((voice) => {
      const releaseSec = Math.max(0.02, voice.release ?? 0.02)
      const ctx = this.getContext()
      const now = ctx.currentTime
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
      voice.gain.gain.linearRampToValueAtTime(0, now + releaseSec)
      try { voice.source.stop(now + releaseSec + 0.01) } catch { /* already stopped */ }
      // Recycle nodes after release completes
      window.setTimeout(() => {
        if (voice.disposed) return
        voice.disposed = true
        this.releaseGain(voice.gain)
        this.releaseFilters(voice.filters)
        try { voice.pan.disconnect() } catch { /* ignore */ }
      }, Math.ceil((releaseSec + 0.02) * 1000))
    })
    this.activeVoices = this.activeVoices.filter((voice) => !holdVoices.includes(voice))
  }

  /** Stop all currently playing voices with a 5ms fade-out (used on transport stop). */
  stopAllVoices(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const toStop = this.activeVoices.filter((v) => !v.disposed)

    for (const voice of toStop) {
      try {
        voice.gain.gain.cancelScheduledValues(now)
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
        voice.gain.gain.linearRampToValueAtTime(0, now + 0.005)
        voice.source.stop(now + 0.01)
      } catch { /* already stopped/ended */ }
    }

    window.setTimeout(() => {
      for (const voice of toStop) {
        if (voice.disposed) continue
        voice.disposed = true
        this.releaseGain(voice.gain)
        this.releaseFilters(voice.filters)
        try { voice.source.disconnect() } catch { /* ignore */ }
        try { voice.pan.disconnect() } catch { /* ignore */ }
      }
      this.activeVoices = this.activeVoices.filter((v) => !toStop.includes(v))
    }, 20)
  }

  private disposeVoice(voice: ActiveVoice): void {
    if (voice.disposed) return
    voice.disposed = true
    try { voice.source.stop() } catch { /* already stopped */ }
    try { voice.source.disconnect() } catch { /* already disconnected */ }
    try { voice.pan.disconnect() } catch { /* already disconnected */ }
    this.releaseGain(voice.gain)
    this.releaseFilters(voice.filters)
    const idx = this.activeVoices.indexOf(voice)
    if (idx !== -1) this.activeVoices.splice(idx, 1)
  }

  private evictIfNeeded(): void {
    const ctx = this.ctx
    while (this.activeVoices.length >= this.polyphony) {
      const idx = this.activeVoices.findIndex((voice) => !voice.hold)
      const candidateIdx = idx !== -1 ? idx : 0
      const candidate = this.activeVoices[candidateIdx]
      if (!candidate) break

      const evictWarnNow = Date.now()
      if (evictWarnNow - _lastEvictionWarnMs > 1000) {
        _lastEvictionWarnMs = evictWarnNow
        console.warn('[AudioEngine] Voice eviction — polyphony limit reached:', this.activeVoices.length, '/', this.polyphony, 'evicting padId:', candidate.padId, 'age:', evictWarnNow - candidate.startedAt, 'ms')
      }

      // Fade out over 5ms to avoid click, then stop at 10ms
      if (ctx) {
        const now = ctx.currentTime
        try {
          candidate.gain.gain.setValueAtTime(candidate.gain.gain.value, now)
          candidate.gain.gain.linearRampToValueAtTime(0, now + 0.005)
          candidate.source.stop(now + 0.01)
        } catch { /* already stopped */ }
      } else {
        try { candidate.source.stop() } catch { /* already stopped */ }
      }
      try { candidate.source.disconnect() } catch { /* noop */ }
      try { candidate.pan.disconnect() } catch { /* noop */ }
      candidate.disposed = true
      this.releaseGain(candidate.gain)
      this.releaseFilters(candidate.filters)
      this.activeVoices.splice(candidateIdx, 1)
    }
  }

  /** Update filter params on all active voices for a pad (live knob changes). */
  updateActiveFilters(padId: string, filterType: FilterType, freq: number, q: number, freq2?: number): void {
    const TAU = 0.01
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    const resolved = resolveFilterType(filterType)
    const isLphp = filterType === 'lphp'

    // Sample voices
    for (const voice of this.activeVoices) {
      if (voice.padId !== padId || voice.disposed) continue
      if (!resolved && !isLphp) {
        continue
      }
      if (isLphp && voice.filters.length >= 2) {
        // filters[0] = HP, filters[1] = LP
        voice.filters[0].type = 'highpass'
        voice.filters[0].frequency.setTargetAtTime(freq, now, TAU)
        voice.filters[0].Q.setTargetAtTime(q, now, TAU)
        voice.filters[1].type = 'lowpass'
        voice.filters[1].frequency.setTargetAtTime(freq2 ?? 20000, now, TAU)
        voice.filters[1].Q.setTargetAtTime(q, now, TAU)
      } else {
        for (const f of voice.filters) {
          f.type = resolved!.biquadType
          f.frequency.setTargetAtTime(freq, now, TAU)
          f.Q.setTargetAtTime(q, now, TAU)
        }
      }
    }
  }

  /** Play a short synthesized metronome click at the given audio time */
  playMetronomeClick(atTimeSec: number, accent: boolean, volume: number): void {
    const ctx = this.ctx
    if (!ctx) return
    const dest = this.masterGain ?? ctx.destination

    const gain = ctx.createGain()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    // Accent (beat 1) = higher pitch, louder
    osc.frequency.value = accent ? 1500 : 1000
    gain.gain.value = volume * (accent ? 0.7 : 0.45)
    // Sharp click: ramp down quickly
    gain.gain.setTargetAtTime(0, atTimeSec + 0.005, 0.008)

    osc.connect(gain)
    gain.connect(dest)
    osc.start(atTimeSec)
    osc.stop(atTimeSec + 0.05)

    osc.onended = () => {
      try { osc.disconnect() } catch { /* */ }
      try { gain.disconnect() } catch { /* */ }
    }
  }
}

// Export shared helpers for audioExport.ts
export { buildEffectChain, getSCWorkletUrl, type EffectChainNode }

export const audioEngine = new AudioEngine()
