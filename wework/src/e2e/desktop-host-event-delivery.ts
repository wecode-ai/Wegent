import { invokeDesktopHost, readDesktopHostEventCursor } from '@/api/dsh/desktopHost'

export async function waitForDesktopHostEventDelivery(timeoutMs: number): Promise<string> {
  const { latestSequence } = await invokeDesktopHost<{ latestSequence: number }>('desktop.events', {
    after: readDesktopHostEventCursor(),
  })
  const startedAt = Date.now()
  while (readDesktopHostEventCursor() < latestSequence) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for desktop host event ${latestSequence}`)
    }
    await new Promise(resolve => window.setTimeout(resolve, 25))
  }
  return String(latestSequence)
}
