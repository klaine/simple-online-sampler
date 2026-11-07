import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { isChunkLoadError, reloadOnceForNewVersion, resetAppCacheAndReload } from '../lib/chunkReload'

interface Props {
  children: ReactNode
  /** 'app' = full-screen recovery screen; 'dialog' = swallow the failure and call onError (app keeps running) */
  scope?: 'app' | 'dialog'
  onError?: (error: Error) => void
}

interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
    // Stale deploy (missing hashed chunk): a single reload fetches the current build
    if (isChunkLoadError(error) && this.props.scope !== 'dialog') reloadOnceForNewVersion()
    this.props.onError?.(error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.scope === 'dialog') return null

    return (
      <main className="app-crash" role="alert" style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12, padding: 24, background: '#0e1015', color: '#d8dce6', fontFamily: 'system-ui, sans-serif', textAlign: 'center',
      }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Sampler hit a problem</h1>
        <p style={{ margin: 0, maxWidth: 520, opacity: 0.8 }}>
          {isChunkLoadError(error)
            ? 'A part of the app failed to load (the site may have just been updated). Reloading usually fixes this.'
            : 'The app crashed while rendering. Your projects and samples are stored in this browser and have not been deleted.'}
        </p>
        <pre style={{
          maxWidth: 'min(720px, 92vw)', maxHeight: 160, overflow: 'auto', margin: 0, padding: 10, fontSize: 12,
          textAlign: 'left', background: '#171a22', borderRadius: 6, whiteSpace: 'pre-wrap',
        }}>{error.name}: {error.message}</pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" onClick={() => void resetAppCacheAndReload()}>Clear app cache &amp; reload</button>
        </div>
      </main>
    )
  }
}
