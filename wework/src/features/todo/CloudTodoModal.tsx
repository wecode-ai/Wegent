import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface CloudTodoModalProps {
  title: string
  children: ReactNode
  onClose: () => void
}

export function CloudTodoModal({ title, children, onClose }: CloudTodoModalProps) {
  return (
    <div
      className="absolute inset-0 z-system flex items-center justify-center bg-black/30 p-6"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section className="w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-border bg-background shadow-lg">
        <header className="flex h-12 items-center border-b border-border px-5">
          <h2 className="heading-sm flex-1">{title}</h2>
          <button
            type="button"
            data-testid="cloud-todo-modal-close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-hover"
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
