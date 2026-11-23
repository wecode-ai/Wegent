import { codeHighlightClient, type CodeHighlightClient } from './codeHighlightClient'
import type { HighlightedCode } from './highlightCode'

interface HighlightInput {
  code: string
  language: string
}
type HighlightSnapshot = (HighlightedCode & { language: string }) | null

/** One code block owns a coalescing queue and a committed worker subscription. */
export function createCodeHighlightStore(
  client: Pick<CodeHighlightClient, 'retain' | 'highlight'> = codeHighlightClient
) {
  let input: HighlightInput = { code: '', language: '' }
  let snapshot: HighlightSnapshot = null
  let busy = false
  let generation = 0
  let teardownRevision = 0
  let release: (() => void) | undefined
  const listeners = new Set<() => void>()

  const run = () => {
    if (busy || !listeners.size) return
    const request = { ...input, generation }
    busy = true
    void client
      .highlight(request.code, request.language)
      .then(
        highlighted => {
          if (
            listeners.size &&
            request.generation === generation &&
            input.language === request.language &&
            input.code.startsWith(highlighted.code)
          ) {
            snapshot = { ...highlighted, language: request.language }
            listeners.forEach(listener => listener())
          }
        },
        cause => {
          if (listeners.size && request.generation === generation)
            console.error('[code-highlight]', cause)
        }
      )
      .finally(() => {
        busy = false
        if (
          input.code !== request.code ||
          input.language !== request.language ||
          generation !== request.generation
        )
          run()
      })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: HighlightInput) {
      teardownRevision++
      listeners.add(listener)
      input = next
      release ??= client.retain()
      run()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        const closing = ++teardownRevision
        // A changed query replaces its subscription within the same commit.
        // Release only after that commit has no remaining consumer.
        queueMicrotask(() => {
          if (closing !== teardownRevision || listeners.size) return
          generation++
          release?.()
          release = undefined
        })
      }
    },
  }
}
