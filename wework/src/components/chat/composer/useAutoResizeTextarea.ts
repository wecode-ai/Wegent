import { useEffect, useRef } from 'react'

export function useAutoResizeTextarea(value: string, maxHeight: number) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [maxHeight, value])

  return textareaRef
}
