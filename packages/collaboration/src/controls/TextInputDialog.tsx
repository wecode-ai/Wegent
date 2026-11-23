import { DialogSurface } from './DialogSurface'
import { TextField as ControlInput } from './TextField'
import { Button as ControlButton } from '../markdown/Button'
import { X } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogForm } from './DialogForm'

export interface TextInputDialogProps {
  failedLabel: string
  allowEmpty?: boolean
  trimValue?: boolean
  open: boolean
  title: string
  label: string
  description?: string
  initialValue: string
  confirmLabel: string
  cancelLabel: string
  inputTestId: string
  confirmTestId: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void> | void
}

export function TextInputDialog({ open, ...props }: TextInputDialogProps) {
  if (!open) return null

  return <TextInputDialogContent key={props.initialValue} {...props} />
}

function TextInputDialogContent({
  title,
  label,
  description,
  initialValue,
  confirmLabel,
  cancelLabel,
  inputTestId,
  confirmTestId,
  onClose,
  onSubmit,
  failedLabel,
  allowEmpty = false,
  trimValue = true,
}: Omit<TextInputDialogProps, 'open'>) {
  const [value, setValue] = useState(initialValue)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedValue = value.trim()

  const inputRef = useRef<HTMLInputElement>(null)

  return createPortal(
    <div
      data-testid={`${inputTestId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <DialogSurface
        initialFocus={() => inputRef.current}
        onClose={() => {
          if (!submitting) onClose()
        }}
        render={
          <DialogForm
            aria-labelledby={`${inputTestId}-title`}
            className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 text-text-primary shadow-2xl"
            onSubmit={async event => {
              event.preventDefault()
              if ((!allowEmpty && !trimmedValue) || submitting) return
              setSubmitting(true)
              setError(null)
              try {
                await onSubmit(trimValue ? trimmedValue : value)
                onClose()
              } catch (submitError) {
                setError(submitError instanceof Error ? submitError.message : failedLabel)
              } finally {
                setSubmitting(false)
              }
            }}
          />
        }
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id={`${inputTestId}-title`} className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${inputTestId}-close-button`}
            onClick={onClose}
            disabled={submitting}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={cancelLabel}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </div>
        {description && (
          <p className="mt-2 text-sm leading-[18px] text-text-secondary">{description}</p>
        )}
        <label
          htmlFor={inputTestId}
          className="mt-5 block text-sm font-medium leading-[18px] text-text-secondary"
        >
          {label}
        </label>
        <ControlInput
          ref={inputRef}
          id={inputTestId}
          data-testid={inputTestId}
          value={value}
          disabled={submitting}
          onFocus={event => event.currentTarget.select()}
          onChange={event => {
            setValue(event.target.value)
            setError(null)
          }}
          className="mt-2 h-9 w-full"
        />
        {error && <p className="mt-2 text-xs text-destructive wework:text-red-500">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid={`${inputTestId}-cancel-button`}
            onClick={onClose}
            disabled={submitting}
            className="h-11 min-w-[44px] rounded-md border border-border px-4 text-sm font-medium leading-[18px] text-text-primary hover:bg-muted"
          >
            {cancelLabel}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="submit"
            data-testid={confirmTestId}
            disabled={(!allowEmpty && !trimmedValue) || submitting}
            className="h-11 min-w-[44px] rounded-md bg-text-primary px-4 text-sm font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {confirmLabel}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
