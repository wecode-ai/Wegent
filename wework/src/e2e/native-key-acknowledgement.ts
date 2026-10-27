export async function sendNativeKeyAndWait(
  target: HTMLElement,
  phase: 'press' | 'down' | 'up',
  send: () => Promise<unknown>,
  options: { waitForRelease?: boolean } = {}
): Promise<void> {
  const type = phase === 'up' || (phase === 'press' && options.waitForRelease) ? 'keyup' : 'keydown'
  let acknowledge: () => void
  let reject: (error: Error) => void
  const received = new Promise<void>((resolve, rejectEvent) => {
    acknowledge = resolve
    reject = rejectEvent
  })
  const record = (event: KeyboardEvent) => {
    if (event.isTrusted && event.target === target) acknowledge()
  }
  window.addEventListener(type, record, true)
  const timeout = window.setTimeout(
    () => reject(new Error(`Native ${type} did not reach its target`)),
    10_000
  )
  try {
    await Promise.all([Promise.resolve().then(send), received])
  } finally {
    window.clearTimeout(timeout)
    window.removeEventListener(type, record, true)
  }
}
