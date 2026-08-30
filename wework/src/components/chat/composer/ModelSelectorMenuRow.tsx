import { ChevronRight } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ModelSelectorMenuRowProps {
  active: boolean
  label: ReactNode
  onActivate: () => void
  testId: string
  value: ReactNode
}

export const ModelSelectorMenuRow = forwardRef<HTMLButtonElement, ModelSelectorMenuRowProps>(
  function ModelSelectorMenuRow({ active, label, onActivate, testId, value }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        data-testid={testId}
        onMouseEnter={onActivate}
        onPointerEnter={onActivate}
        onFocus={onActivate}
        onClick={onActivate}
        onKeyDown={event => {
          if (['ArrowRight', 'Enter', ' '].includes(event.key)) {
            event.preventDefault()
            onActivate()
          }
        }}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-normal leading-[18px]',
          active
            ? 'bg-muted text-text-primary'
            : 'text-text-secondary hover:bg-muted hover:text-text-primary'
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="max-w-24 truncate text-text-muted">{value}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
      </button>
    )
  }
)
