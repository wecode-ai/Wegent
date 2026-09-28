import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

interface CloudTodoModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  width?: 'default' | 'wide' | 'workflow' | 'workspace'
  onSubmit?: () => void | Promise<void>
  pending?: boolean
}

export function CloudTodoModal({
  title,
  children,
  onClose,
  width = 'default',
  onSubmit,
  pending = false,
}: CloudTodoModalProps) {
  const titleId = useId()
  const close = () => {
    if (!pending) onClose()
  }
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close)
  const Surface = onSubmit ? DialogForm : 'section'
  const modal = (
    <div
      ref={dialogRef}
      className={cn(
        'inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm',
        width === 'workspace' || width === 'workflow' ? 'fixed' : 'absolute'
      )}
      onMouseDown={event => event.currentTarget === event.target && close()}
    >
      <Surface
        role="dialog"
        aria-modal="true"
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
      >
        <header className="flex items-center gap-3 px-5 pt-4">
          <h2 id={titleId} className="flex-1 text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            data-testid="cloud-todo-modal-close"
            onClick={close}
            disabled={pending}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {children}
      </Surface>
    </div>
  )

  return width === 'workspace' || width === 'workflow' ? createPortal(modal, document.body) : modal
}
