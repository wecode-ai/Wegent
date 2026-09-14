import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export const fieldClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-base text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50'

export function CapabilityDialog({
  title,
  id,
  busy,
  onClose,
  children,
}: {
  title: string
  id: string
  busy: boolean
  onClose: () => void
  children: ReactNode
}) {
  const { t } = useTranslation('capabilities')
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      data-testid={id}
      aria-labelledby={`${id}-title`}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto max-h-[85vh] w-[min(640px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-border bg-popover p-6 text-text-primary backdrop:bg-black/35"
    >
      <header className="mb-5 flex items-center justify-between gap-4">
        <h2 id={`${id}-title`} className="heading-small">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid={`${id}-close`}
          aria-label={t('close')}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {children}
    </dialog>
  )
}
