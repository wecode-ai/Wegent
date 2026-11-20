import { DialogForm } from '@/components/common/DialogForm'
import { cn } from '@/lib/utils'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface CloudTodoModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  closeLabel?: string
  width?: 'default' | 'wide' | 'workflow' | 'workspace'
  onSubmit?: () => void | Promise<void>
  pending?: boolean
}

export function CloudTodoModal({
  title,
  children,
  onClose,
  closeLabel = '关闭',
  width = 'default',
  onSubmit,
  pending = false,
}: CloudTodoModalProps) {
  const titleId = useId()
  const close = () => {
    if (!pending) onClose()
  }
  const Surface = onSubmit ? DialogForm : 'section'
  const modal = (
    <div
      className={cn(
        'inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm',
        width === 'workspace' || width === 'workflow' ? 'fixed' : 'absolute'
      )}
      onMouseDown={event => event.currentTarget === event.target && close()}
    >
      <DialogSurface
        onClose={close}
        render={
          <Surface
            aria-labelledby={titleId}
            onSubmit={
              onSubmit
                ? event => {
                    event.preventDefault()
                    if (!pending) void onSubmit()
                  }
                : undefined
            }
            className={cn(
              'flex max-h-[calc(100vh-96px)] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl',
              width === 'workspace'
                ? 'h-[calc(100vh-72px)] w-[calc(100vw-48px)]'
                : width === 'workflow'
                  ? 'w-[680px]'
                  : width === 'wide'
                    ? 'w-[560px]'
                    : 'w-[480px]'
            )}
          />
        }
      >
        <header className="flex items-center gap-3 px-5 pt-4">
          <h2 id={titleId} className="flex-1 text-base font-semibold">
            {title}
          </h2>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="cloud-todo-modal-close"
            onClick={close}
            disabled={pending}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </header>
        {children}
      </DialogSurface>
    </div>
  )

  return width === 'workspace' || width === 'workflow' ? createPortal(modal, document.body) : modal
}
