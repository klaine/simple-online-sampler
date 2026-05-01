type ClockMessage =
  | { type: 'start'; intervalMs: number }
  | { type: 'stop' }

let timerId: number | null = null

const stopClock = () => {
  if (timerId !== null) {
    self.clearInterval(timerId)
    timerId = null
  }
}

self.onmessage = (event: MessageEvent<ClockMessage>) => {
  const message = event.data
  if (message.type === 'stop') {
    stopClock()
    return
  }

  stopClock()
  const intervalMs = Math.max(5, Math.round(message.intervalMs))
  timerId = self.setInterval(() => {
    self.postMessage({ type: 'tick', nowMs: performance.now() })
  }, intervalMs)
}
