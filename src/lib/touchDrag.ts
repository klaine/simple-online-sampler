// Touch-based drag-and-drop for iPad / mobile
// Works alongside HTML5 DnD which handles desktop

let _ghost: HTMLDivElement | null = null
let _data: Record<string, string> = {}
let _active = false
let _startX = 0
let _startY = 0
let _moved = false
const DRAG_THRESHOLD = 8 // px before drag starts

/** Optional list of CSS selectors that should receive touch-drop events (in addition to pads). */
const DROP_SELECTORS = [
  '.pad[data-pad-id]',
  '.chain-insert-slot',
  '.chain-cell',
]

export function getTouchDragData(key: string): string | undefined {
  return _data[key]
}

export function isTouchDragActive(): boolean {
  return _active
}

function createGhost(label: string, x: number, y: number) {
  const el = document.createElement('div')
  el.className = 'touch-drag-ghost'
  el.textContent = label
  el.style.cssText = `
    position: fixed;
    left: ${x - 40}px;
    top: ${y - 20}px;
    z-index: 9999;
    pointer-events: none;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(232, 168, 50, 0.9);
    color: #111;
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    opacity: 0.92;
  `
  document.body.appendChild(el)
  return el
}

let _lastHighlighted: Element | null = null

function findDropTarget(x: number, y: number): Element | null {
  if (_ghost) _ghost.style.display = 'none'
  const el = document.elementFromPoint(x, y)
  if (_ghost) _ghost.style.display = ''
  if (!el) return null
  for (const sel of DROP_SELECTORS) {
    const match = el.closest(sel)
    if (match) return match
  }
  return null
}

function highlightDropTarget(x: number, y: number) {
  const target = findDropTarget(x, y)

  if (_lastHighlighted && _lastHighlighted !== target) {
    (_lastHighlighted as HTMLElement).style.outline = ''
  }
  if (target) {
    (target as HTMLElement).style.outline = '2px solid rgba(232, 168, 50, 0.7)'
    _lastHighlighted = target
  } else {
    _lastHighlighted = null
  }
}

function clearHighlight() {
  if (_lastHighlighted) {
    (_lastHighlighted as HTMLElement).style.outline = ''
    _lastHighlighted = null
  }
}

/**
 * Returns touch event handlers to make an element touch-draggable.
 * `data` is a map of drag data keys to values (same as dataTransfer.setData).
 * `label` is displayed on the ghost element.
 */
export function makeTouchDragHandlers(
  data: Record<string, string>,
  label: string,
) {
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0]
    _startX = touch.clientX
    _startY = touch.clientY
    _moved = false
    _data = data
  }

  const onTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0]
    const dx = touch.clientX - _startX
    const dy = touch.clientY - _startY

    if (!_moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return

    if (!_moved) {
      _moved = true
      _active = true
      _ghost = createGhost(label, touch.clientX, touch.clientY)
    }

    e.preventDefault() // prevent scroll while dragging

    if (_ghost) {
      _ghost.style.left = `${touch.clientX - 40}px`
      _ghost.style.top = `${touch.clientY - 20}px`
    }

    highlightDropTarget(touch.clientX, touch.clientY)
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!_moved) {
      _active = false
      _data = {}
      return
    }

    const touch = e.changedTouches[0]

    clearHighlight()

    // Find drop target
    const target = findDropTarget(touch.clientX, touch.clientY)

    if (_ghost) {
      _ghost.remove()
      _ghost = null
    }

    if (target) {
      const evt = new CustomEvent('touch-drop', {
        bubbles: true,
        detail: { ..._data },
      })
      target.dispatchEvent(evt)
    }

    _active = false
    _data = {}
    _moved = false
  }

  return { onTouchStart, onTouchMove, onTouchEnd }
}
