import { TextField as ControlInput } from '../controls/TextField'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { Button as UiButton } from '@ui-sdk/react/button'
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
      <ControlTextarea
        {...sharedProps}
        className="collaboration-project-create-inline-textarea"
        rows={2}
      />
    ) : (
      <ControlInput {...sharedProps} className="collaboration-project-create-inline-input" />
    )
  }
  const textClassName = [
    !value && placeholder ? 'is-placeholder' : '',
    activateOnTextClick ? 'is-clickable' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span
      className={`collaboration-project-create-hover-editable${
        showEditButton ? ' is-edit-affordance-visible' : ''
      }`}
    >
      {activateOnTextClick ? (
        <UiButton
          render={
            <span className={textClassName} data-testid={testId}>
              {value || placeholder}
            </span>
          }
          aria-label={ariaLabel}
          onClick={() => setEditing(true)}
        />
      ) : (
        <span className={textClassName} data-testid={testId}>
          {value || placeholder}
        </span>
      )}
      <UiButton
        ref={focusEditButton}
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
      >
        <Pencil aria-hidden="true" />
      </UiButton>
    </span>
  )
}
