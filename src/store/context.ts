import type { AppState } from './types'

export interface StoreContext {
  set: (fn: (s: AppState) => void) => void
  get: () => AppState
}
