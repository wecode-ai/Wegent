import { X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface TextInputDialogProps {
  open: boolean
  title: string
  label: string
  initialValue: string
  confirmLabel: string
  cancelLabel: string
  inputTestId: string
  confirmTestId: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void> | void
}

export function TextInputDialog({
  open,
  ...props
}: TextInputDialogProps) {
  if (!open) return null

  return <TextInputDialogContent key={props.initialValue} {...props} />
}

function TextInputDialogContent({
  title,
  label,
  initialValue,
  confirmLabel,
  cancelLabel,
  inputTestId,
  confirmTestId,
  onClose,
  onSubmit,
}: Omit<TextInputDialogProps, 'open'>) {
  const [value, setValue] = useState(initialValue)
  const [submitting, setSubmitting] = useState(false)

  const trimmedValue = value.trim()

  useEscapeKey(onClose)

  return createPortal(
    <div
      data-testid={`${inputTestId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${inputTestId}-title`}
        className="w-full max-w-[420px] rounded-lg border border-[#d8d8d8] bg-white p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id={`${inputTestId}-title`}
            className="text-base font-semibold text-[#202124]"
          >
            {title}
          </h2>
          <button
            type="button"
            data-testid={`${inputTestId}-close-button`}
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4]"
            aria-label={cancelLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-5 block text-[13px] font-medium leading-[18px] text-[#3c4043]">
          {label}
        </label>
        <input
          data-testid={inputTestId}
          value={value}
          autoFocus
          onChange={event => setValue(event.target.value)}
          className="mt-2 h-9 w-full rounded-md border border-[#d8d8d8] px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${inputTestId}-cancel-button`}
            onClick={onClose}
            className="h-11 min-w-[44px] rounded-md border border-[#d8d8d8] px-4 text-[13px] font-medium leading-[18px] text-[#3c4043] hover:bg-[#f7f7f8]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            disabled={!trimmedValue || submitting}
            onClick={async () => {
              setSubmitting(true)
              try {
                await onSubmit(trimmedValue)
                onClose()
              } finally {
                setSubmitting(false)
              }
            }}
            className="h-11 min-w-[44px] rounded-md bg-[#14b8a6] px-4 text-[13px] font-medium leading-[18px] text-white hover:bg-[#0f9f93] disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
