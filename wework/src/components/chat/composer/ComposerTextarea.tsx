import type { KeyboardEventHandler, RefObject } from 'react'

interface ComposerTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  canSend: boolean
  placeholder: string
  rows: number
  textareaRef: RefObject<HTMLTextAreaElement | null>
  className: string
}

export function ComposerTextarea({
  value,
  onChange,
  onSubmit,
  canSend,
  placeholder,
  rows,
  textareaRef,
  className,
}: ComposerTextareaProps) {
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

    event.preventDefault()
    if (canSend) onSubmit()
  }

  return (
    <textarea
      ref={textareaRef}
      data-testid="chat-message-input"
      rows={rows}
      value={value}
      onChange={event => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={className}
    />
  )
}
