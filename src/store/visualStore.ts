type TransportVisualListener = () => void

let _tvPlayheadStep: number | null = null
let _tvSequencedPadHits = new Set<string>()
const _tvListeners = new Set<TransportVisualListener>()

function _tvNotify() {
  for (const listener of _tvListeners) listener()
}

export const transportVisualStore = {
  getPlayheadStep: () => _tvPlayheadStep,
  getSequencedPadHits: () => _tvSequencedPadHits,

  setPlayheadStep(step: number | null) {
    if (step === _tvPlayheadStep) return
    _tvPlayheadStep = step
    _tvNotify()
  },

  flashPadHit(padId: string) {
    if (_tvSequencedPadHits.has(padId)) return
    _tvSequencedPadHits = new Set(_tvSequencedPadHits)
    _tvSequencedPadHits.add(padId)
    _tvNotify()
  },

  clearPadHit(padId: string) {
    if (!_tvSequencedPadHits.has(padId)) return
    _tvSequencedPadHits = new Set(_tvSequencedPadHits)
    _tvSequencedPadHits.delete(padId)
    _tvNotify()
  },

  reset() {
    _tvPlayheadStep = null
    _tvSequencedPadHits = new Set()
    _tvNotify()
  },

  subscribe(listener: TransportVisualListener): () => void {
    _tvListeners.add(listener)
    return () => { _tvListeners.delete(listener) }
  },

  getSnapshot: () => ({ playheadStep: _tvPlayheadStep, sequencedPadHits: _tvSequencedPadHits }),
}
