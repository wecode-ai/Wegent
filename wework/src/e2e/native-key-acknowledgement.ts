export async function sendNativeKeyAndWait(
  target: HTMLElement,
  phase: 'press' | 'down' | 'up',
  send: () => Promise<unknown>,
  expectedCount = 1,
  observe?: (stage: 'native-event' | 'host-acknowledged') => void
): Promise<void> {
  const type = phase === 'up' ? 'keyup' : 'keydown'
  let acknowledge: () => void
  let reject: (error: Error) => void
  const received = new Promise<void>((resolve, rejectEvent) => {
    acknowledge = resolve
    reject = rejectEvent
  })
  let delivered = 0
  let timeout: number | undefined
  const waitForNextKey = () => {
    window.clearTimeout(timeout)
    timeout = window.setTimeout(
      () =>
        reject(
          new Error(
            `Native ${type} did not reach its target; delivered=${delivered}, expected=${expectedCount}, connected=${target.isConnected}`
          )
        ),
      10_000
    )
  }
  const record = (event: KeyboardEvent) => {
    if (event.isTrusted && event.composedPath()[0] === target) {
      observe?.('native-event')
      delivered += 1
      if (delivered === expectedCount) acknowledge()
      else waitForNextKey()
    }
  }
  window.addEventListener(type, record, true)
  waitForNextKey()
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
