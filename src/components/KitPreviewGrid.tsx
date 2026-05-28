import { useMemo } from 'react'
import { useStore } from '../store'
import type { SampleAsset } from '../types'

interface KitPreviewGridProps {
  samples: SampleAsset[]
  onDismiss: () => void
}

export function KitPreviewGrid({ samples, onDismiss }: KitPreviewGridProps) {
  const { previewSample, previewSampleId } = useStore((s) => ({
    previewSample: s.previewSample,
    previewSampleId: s.previewSampleId,
  }))

  const padMap = useMemo(() => {
    const map = new Map<number, SampleAsset>()
    for (const s of samples) {
      if (s.autosamplePadIndex != null) {
        map.set(s.autosamplePadIndex, s)
      }
    }
    return map
  }, [samples])

  const gridPads = useMemo(() => {
    const pads: (SampleAsset | null)[] = []
    for (let i = 0; i < 16; i++) {
      pads.push(padMap.get(i) ?? null)
    }
    return pads
  }, [padMap])

  const kitName = samples[0]?.autosampleRunLabel || 'Kit Preview'

  return (
    <div className="kit-preview-grid">
      <div className="kit-preview-header">
        <h4 className="kit-preview-title">{kitName}</h4>
        <button type="button" className="kit-preview-close" onClick={onDismiss} title="Close preview">×</button>
      </div>
      <div className="kit-grid-cells">
        {gridPads.map((sample, idx) => {
          const isPreviewing = sample ? previewSampleId === sample.id : false
          return (
            <button
              key={idx}
              type="button"
              className={`kit-grid-cell${sample ? ' has-sample' : ''}${isPreviewing ? ' playing' : ''}`}
              disabled={!sample}
              onClick={() => sample && void previewSample(sample)}
              title={sample ? sample.name : `Pad ${idx + 1} (empty)`}
            >
              <span className="kit-cell-number">{idx + 1}</span>
              {sample && (
                <span className="kit-cell-name">
                  {sample.name.replace(/\.[^.]+$/, '').slice(0, 12)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
