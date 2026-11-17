import type { WebContents } from 'electron'

/** Installed in the renderer so acknowledgement follows the editor's native handlers. */
function installNativeTextCommit(key: string): void {
  let focused = document.activeElement
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement
  const target = focused
  if (!target) throw new Error('Native text target is unavailable')
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: number }
  >()
  let completed = 0
  const listener = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.key !== 'Enter' || event.composedPath()[0] !== target) return
    queueMicrotask(() => {
      completed += 1
      const waiting = pending.get(completed)
      if (!waiting) return
      window.clearTimeout(waiting.timer)
      pending.delete(completed)
      waiting.resolve()
    })
  }
  window.addEventListener('keyup', listener)
  const state = {
    wait(expected: number): Promise<void> {
      if (completed > expected) throw new Error('Unexpected native Enter acknowledgement')
      if (completed === expected) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(expected)
          reject(
            new Error(
              `Native Enter commit missing; delivered=${completed}, expected=${expected}, connected=${target.isConnected}`
            )
          )
        }, 10_000)
        pending.set(expected, { resolve, reject, timer })
      })
    },
    dispose(): void {
      window.removeEventListener('keyup', listener)
      for (const waiting of pending.values()) {
        window.clearTimeout(waiting.timer)
        waiting.reject(new Error('Native text acknowledgement disposed'))
      }
      pending.clear()
      delete (globalThis as unknown as Record<string, unknown>)[key]
    },
  }
  ;(globalThis as unknown as Record<string, unknown>)[key] = state
}

export async function createE2ENativeTextCommit(
  contents: { readonly focusedFrame: Pick<WebContents['mainFrame'], 'executeJavaScript'> | null },
  batchId: string
) {
  const frame = contents.focusedFrame
  if (!frame) throw new Error('Native text frame is unavailable')
  const key = JSON.stringify(`__weworkNativeText_${batchId}`)
  await frame.executeJavaScript(`(${installNativeTextCommit.toString()})(${key})`)
  return {
    wait: (expected: number) => frame.executeJavaScript(`globalThis[${key}].wait(${expected})`),
    dispose: () => frame.executeJavaScript(`globalThis[${key}].dispose()`),
  }
}
