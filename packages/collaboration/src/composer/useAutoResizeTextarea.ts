import { useEffect, useRef } from 'react'

export function useAutoResizeTextarea(value: string, maxHeight: number) {
  const textareaRef = useRef<HTMLElement>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const textarea = textareaRef.current
      if (!textarea) return

      if (textarea.tagName !== 'TEXTAREA') {
        textarea.style.height = ''
        textarea.style.maxHeight = `${maxHeight}px`
        return
      }

      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    })

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [maxHeight, value])

  return textareaRef
}
