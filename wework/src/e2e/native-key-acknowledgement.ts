export async function sendNativeKeyAndWait(
  target: HTMLElement,
  phase: 'press' | 'down' | 'up',
  send: () => Promise<unknown>,
  observe?: (stage: 'native-event' | 'host-acknowledged') => void
): Promise<void> {
  const type = phase === 'up' ? 'keyup' : 'keydown'
  let acknowledge: () => void
  let reject: (error: Error) => void
  const received = new Promise<void>((resolve, rejectEvent) => {
    acknowledge = resolve
    reject = rejectEvent
  })
  const record = (event: KeyboardEvent) => {
    if (event.isTrusted && event.composedPath()[0] === target) {
      observe?.('native-event')
      acknowledge()
    }
  }
  window.addEventListener(type, record, true)
  const timeout = window.setTimeout(
    () => reject(new Error(`Native ${type} did not reach its target`)),
    10_000
  )
  try {
    await Promise.all([
      Promise.resolve()
        .then(send)
        .then(() => observe?.('host-acknowledged')),
      received,
    ])
  } finally {
    window.clearTimeout(timeout)
    window.removeEventListener(type, record, true)
  }
}
