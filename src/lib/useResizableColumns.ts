import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'layout-columns'
const MIN_LEFT = 200
const MIN_CENTER = 300
const MIN_RIGHT = 280
const COLLAPSE_WIDTH = 28
const DEFAULT_LEFT = 380
const DEFAULT_RIGHT = 480

interface ColumnState {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

function loadState(): ColumnState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        leftWidth: Math.max(MIN_LEFT, parsed.leftWidth ?? DEFAULT_LEFT),
        rightWidth: Math.max(MIN_RIGHT, parsed.rightWidth ?? DEFAULT_RIGHT),
        leftCollapsed: !!parsed.leftCollapsed,
        rightCollapsed: !!parsed.rightCollapsed,
      }
    }
  } catch { /* ignore */ }
  return { leftWidth: DEFAULT_LEFT, rightWidth: DEFAULT_RIGHT, leftCollapsed: false, rightCollapsed: false }
}

function saveState(s: ColumnState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

export function useResizableColumns(altLayout = false) {
  const [state, setState] = useState<ColumnState>(loadState)
  const stateRef = useRef(state)
  const altLayoutRef = useRef(altLayout)

  // Persist on change
  useEffect(() => { saveState(state) }, [state])
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { altLayoutRef.current = altLayout }, [altLayout])

  const dragging = useRef<'left' | 'right' | null>(null)
  const startX = useRef(0)
  const startVal = useRef(0)
  const rafId = useRef(0)

  const onPointerMoveRef = useRef<(e: PointerEvent) => void>(() => {})
  const onPointerUpRef = useRef<() => void>(() => {})

  const onPointerMove = useCallback((e: PointerEvent) => {
    const dx = e.clientX - startX.current
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(() => {
      const s = stateRef.current
      const containerWidth = document.querySelector('.studio-layout')?.clientWidth ?? window.innerWidth
      if (dragging.current === 'left') {
        const minMain = altLayoutRef.current ? MIN_RIGHT : (MIN_CENTER + (s.rightCollapsed ? COLLAPSE_WIDTH : s.rightWidth))
        const maxLeft = containerWidth - minMain - 12
        const newLeft = Math.max(MIN_LEFT, Math.min(maxLeft, startVal.current + dx))
        setState(prev => ({ ...prev, leftWidth: newLeft }))
      } else if (dragging.current === 'right') {
        const maxRight = containerWidth - (s.leftCollapsed ? COLLAPSE_WIDTH : s.leftWidth) - MIN_CENTER - 12
        const newRight = Math.max(MIN_RIGHT, Math.min(maxRight, startVal.current - dx))
        setState(prev => ({ ...prev, rightWidth: newRight }))
      }
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onPointerMoveRef.current)
    window.removeEventListener('pointerup', onPointerUpRef.current)
  }, [])

  useEffect(() => { onPointerMoveRef.current = onPointerMove }, [onPointerMove])
  useEffect(() => { onPointerUpRef.current = onPointerUp }, [onPointerUp])

  const makeDownHandler = useCallback((side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = side
    startX.current = e.clientX
    const s = stateRef.current
    startVal.current = side === 'left' ? s.leftWidth : s.rightWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMoveRef.current)
    window.addEventListener('pointerup', onPointerUpRef.current)
  }, [])

  const makeDblClickHandler = useCallback((side: 'left' | 'right') => () => {
    setState(prev => side === 'left'
      ? { ...prev, leftCollapsed: !prev.leftCollapsed }
      : { ...prev, rightCollapsed: !prev.rightCollapsed }
    )
  }, [])

  const toggleLeft = useCallback(() => {
    setState(prev => ({ ...prev, leftCollapsed: !prev.leftCollapsed }))
  }, [])

  const toggleRight = useCallback(() => {
    setState(prev => ({ ...prev, rightCollapsed: !prev.rightCollapsed }))
  }, [])

  return {
    leftWidth: state.leftCollapsed ? COLLAPSE_WIDTH : state.leftWidth,
    rightWidth: state.rightCollapsed ? COLLAPSE_WIDTH : state.rightWidth,
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    toggleLeft,
    toggleRight,
    leftDividerProps: {
      onPointerDown: makeDownHandler('left'),
      onDoubleClick: makeDblClickHandler('left'),
    },
    rightDividerProps: {
      onPointerDown: makeDownHandler('right'),
      onDoubleClick: makeDblClickHandler('right'),
    },
  }
}
