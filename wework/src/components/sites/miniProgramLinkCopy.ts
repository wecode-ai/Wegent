import { copyTextToClipboard } from '@/lib/clipboard'

/** A link owns its copy receipt and dismissal timer only while observed. */
export function createMiniProgramLinkCopy(url: string) {
  const listeners = new Set<() => void>()
  let state: 'idle' | 'copied' | 'failed' = 'idle'
  let revision = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const publish = (next: typeof state) => {
    state = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          clearTimeout(timeout)
          timeout = undefined
          state = 'idle'
        }
      }
    },
    async copy() {
      if (!url || !listeners.size) return
      const current = ++revision
      clearTimeout(timeout)
      try {
        await copyTextToClipboard(url)
        if (current !== revision || !listeners.size) return
        timeout = setTimeout(() => {
          timeout = undefined
          publish('idle')
        }, 1500)
        publish('copied')
      } catch (error) {
        if (current !== revision || !listeners.size) return
        console.error('Failed to copy mini program URL:', error)
        publish('failed')
      }
    },
  }
}
