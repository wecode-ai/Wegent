import { useCallback, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Pencil } from 'lucide-react'

export function HoverEditableText({
  value,
  ariaLabel,
  placeholder,
  testId,
  activateOnTextClick = false,
  showEditButton = false,
  multiline = true,
  onChange,
}: {
  value: string
  ariaLabel: string
  placeholder?: string
  testId?: string
  activateOnTextClick?: boolean
  showEditButton?: boolean
  multiline?: boolean
  onChange(value: string): void
}) {
  const [editing, setEditing] = useState(false)
  const restoreFocus = useRef(false)
  const focusEditButton = useCallback((node: HTMLButtonElement | null) => {
    if (node && restoreFocus.current) {
      restoreFocus.current = false
      node.focus()
    }
  }, [])
  if (editing) {
    const sharedProps = {
      autoFocus: true,
      value,
      'aria-label': ariaLabel,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value),
      onBlur: () => setEditing(false),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === 'Escape' || (!multiline && event.key === 'Enter')) {
          event.preventDefault()
          event.stopPropagation()
          restoreFocus.current = true
          setEditing(false)
        }
      },
    }
    return multiline ? (
      <textarea
        {...sharedProps}
        className="collaboration-project-create-inline-textarea"
        rows={2}
      />
    ) : (
      <input {...sharedProps} className="collaboration-project-create-inline-input" />
    )
  }
  const startEditingFromText = () => {
    if (activateOnTextClick) setEditing(true)
  }
  return (
    <span
      className={`collaboration-project-create-hover-editable${
        showEditButton ? ' is-edit-affordance-visible' : ''
      }`}
    >
      <span
        className={[
          !value && placeholder ? 'is-placeholder' : '',
          activateOnTextClick ? 'is-clickable' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role={activateOnTextClick ? 'button' : undefined}
        tabIndex={activateOnTextClick ? 0 : undefined}
        data-testid={testId}
        onClick={startEditingFromText}
        onKeyDown={event => {
          if (activateOnTextClick && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            setEditing(true)
          }
        }}
      >
        {value || placeholder}
      </span>
      <button
        ref={focusEditButton}
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
      >
        <Pencil aria-hidden="true" />
      </button>
    </span>
  )
}
