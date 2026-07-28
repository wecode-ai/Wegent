import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CloudTodoModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  width?: 'default' | 'wide'
}

export function CloudTodoModal({
  title,
  children,
  onClose,
  width = 'default',
}: CloudTodoModalProps) {
  return (
    <div
      className="absolute inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        className={cn(
          'flex max-h-[calc(100vh-96px)] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl',
          width === 'wide' ? 'w-[560px]' : 'w-[480px]'
        )}
      >
        <header className="flex items-center gap-3 px-5 pt-4">
          <h2 className="flex-1 text-base font-semibold">{title}</h2>
          <button
            type="button"
            data-testid="cloud-todo-modal-close"
            onClick={onClose}
            className="-mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}
