import { Button as UiButton } from '@ui-sdk/react/button'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
import { Pencil } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'

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
  const editButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      editButton.current?.focus()
    }
  }, [editing])
  if (editing) {
    const sharedProps = {
      autoFocus: true,
      value,
      'aria-label': ariaLabel,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value),
      onBlur: () => setEditing(false),
      onKeyDown: (
        event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        if (isImeComposingEvent(event)) return
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
      <ControlInput
        {...sharedProps}
        className="collaboration-project-create-inline-input"
      />
    )
  }
  return (
    <span
      className={`collaboration-project-create-hover-editable${
        showEditButton ? ' is-edit-affordance-visible' : ''
      }`}
    >
      {activateOnTextClick ? (
        <UiButton
          render={
            <span
              className={[
                !value && placeholder ? 'is-placeholder' : '',
                activateOnTextClick ? 'is-clickable' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid={testId}
            >
              {value || placeholder}
            </span>
          }
          aria-label={ariaLabel}
          onClick={() => setEditing(true)}
        />
      ) : (
        <span
          className={[
            !value && placeholder ? 'is-placeholder' : '',
            activateOnTextClick ? 'is-clickable' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={testId}
        >
          {value || placeholder}
        </span>
      )}
      <ControlButton
        variant="ghost"
        size="sm"
        ref={editButton}
        data-testid={(testId ?? 'hover-editable-text') + '-edit'}
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
      >
        <Pencil aria-hidden="true" />
      </ControlButton>
    </span>
  )
}
