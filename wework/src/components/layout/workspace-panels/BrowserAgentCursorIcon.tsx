import { MousePointer2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BrowserAgentCursorIconProps {
  className?: string
  testId?: string
}

export function BrowserAgentCursorIcon({ className, testId }: BrowserAgentCursorIconProps) {
  return (
    <span
      data-testid={testId}
      aria-hidden="true"
      className={cn('relative block shrink-0', className)}
    >
      <MousePointer2
        className="absolute inset-0 h-full w-full fill-white text-white"
        strokeWidth={4}
      />
      <MousePointer2
        className="absolute inset-0 h-full w-full fill-neutral-950 text-neutral-950"
        strokeWidth={1.4}
      />
    </span>
  )
}
