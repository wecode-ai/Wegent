import { useEffect, useRef } from 'react'

export function useAutoResizeTextarea(value: string, maxHeight: number) {
  const textareaRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    if (textarea.tagName !== 'TEXTAREA') {
      textarea.style.height = ''
      textarea.style.maxHeight = `${maxHeight}px`
      return
    }

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [maxHeight, value])

  return textareaRef
}
