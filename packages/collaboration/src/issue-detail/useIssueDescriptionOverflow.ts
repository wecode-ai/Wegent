import { useCallback, useMemo, useSyncExternalStore } from 'react'

// This native description widget measures rendered blocks, including edits that
// do not change the host's markdown prop (images and editor decorations).
function createDescriptionOverflow() {
  let element: HTMLDivElement | null = null
  let overflowing = false
  let observedContent: string | undefined
  let observing = false
  let release: (() => void) | undefined
  const listeners = new Set<() => void>()
  return {
    target: {
      get current() {
        return element
      },
    },
    getSnapshot: () => overflowing,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach(next: HTMLDivElement | null, enabled: boolean, content: string) {
      if (element === next && observing === enabled && observedContent === content) return
      observing = enabled
      observedContent = content
      release?.()
      release = undefined
      element = next
      if (!next || !enabled) return
      let frame: number | null = null
      const measure = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = null
          const editor = next.querySelector<HTMLElement>('.bn-editor')
          const textarea = next.querySelector<HTMLTextAreaElement>('textarea')
          const bottom = editor?.getBoundingClientRect().bottom ?? 0
          const value = editor
            ? Array.from(editor.querySelectorAll<HTMLElement>('.bn-block-outer')).some(
                block => block.getBoundingClientRect().bottom > bottom + 1
              )
            : Boolean(textarea && textarea.scrollHeight > textarea.clientHeight + 1)
          if (overflowing !== value) {
            overflowing = value
            listeners.forEach(listener => listener())
          }
        })
      }
      const mutation = new MutationObserver(measure)
      mutation.observe(next, { characterData: true, childList: true, subtree: true })
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
      resize?.observe(next)
      measure()
      release = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        mutation.disconnect()
        resize?.disconnect()
      }
    },
  }
}

export function useIssueDescriptionOverflow(enabled: boolean, content: string) {
  const widget = useMemo(() => createDescriptionOverflow(), [])
  const overflowing = useSyncExternalStore(widget.subscribe, widget.getSnapshot, widget.getSnapshot)
  const ref = useCallback(
    (element: HTMLDivElement | null) => widget.attach(element, enabled, content),
    [widget, enabled, content]
  )
  return { overflowing, ref, target: widget.target }
}
