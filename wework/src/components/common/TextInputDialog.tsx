import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'

interface TextInputDialogProps {
  open: boolean
  title: string
  label: string
  description?: string
  initialValue: string
  confirmLabel: string
  cancelLabel: string
  inputTestId: string
  confirmTestId: string
  maxLength?: number
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
  maxLength,
  onClose,
  onSubmit,
}: Omit<TextInputDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const [value, setValue] = useState(initialValue)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const returnFocusElement = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )

  const trimmedValue = value.trim()

  const closeDialog = () => {
    if (!submittingRef.current) onClose()
  }

  useEscapeKey(closeDialog)

  useEffect(
    () => () => {
      if (returnFocusElement.current?.isConnected) returnFocusElement.current.focus()
    },
    []
  )

  useEffect(() => {
    if (submitting) dialogRef.current?.focus()
  }, [submitting])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => !element.hasAttribute('aria-hidden'))
    if (focusableElements.length === 0) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  const submit = async () => {
    if (!trimmedValue || submittingRef.current) return

    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmedValue)
      onClose()
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : t('workbench.save_failed', '保存失败')
      )
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      data-testid={`${inputTestId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputTestId}-title`}
        tabIndex={-1}
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 text-text-primary shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <form
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <h2 id={`${inputTestId}-title`} className="text-base font-semibold text-text-primary">
              {title}
            </h2>
            <button
              type="button"
              data-testid={`${inputTestId}-close-button`}
              onClick={closeDialog}
              disabled={submitting}
              className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={cancelLabel}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {description && (
            <p
              id={`${inputTestId}-description`}
              className="mt-2 text-sm leading-[18px] text-text-secondary"
            >
              {description}
            </p>
          )}
          <label
            htmlFor={`${inputTestId}-field`}
            className="mt-5 block text-sm font-medium leading-[18px] text-text-secondary"
          >
            {label}
          </label>
          <input
            id={`${inputTestId}-field`}
            data-testid={inputTestId}
            aria-describedby={description ? `${inputTestId}-description` : undefined}
            value={value}
            autoFocus
            maxLength={maxLength}
            disabled={submitting}
            onFocus={event => event.currentTarget.select()}
            onChange={event => {
              setValue(event.target.value)
              setError(null)
            }}
            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
          />
          {error && (
            <p className="mt-2 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              data-testid={`${inputTestId}-cancel-button`}
              onClick={closeDialog}
              disabled={submitting}
              className="h-11 min-w-[44px] rounded-md border border-border px-4 text-sm font-medium leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              data-testid={confirmTestId}
              disabled={!trimmedValue || submitting}
              className="h-11 min-w-[44px] rounded-md bg-text-primary px-4 text-sm font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
