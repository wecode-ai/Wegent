import { useEffect } from 'react'
import { cn } from '@/lib/utils'

interface TransientNoticeProps {
  message: string | null
  tone?: 'success' | 'error'
  onClear: () => void
}

export function TransientNotice({ message, tone = 'success', onClear }: TransientNoticeProps) {
  useEffect(() => {
    if (!message) return

    const timeout = window.setTimeout(onClear, 2200)
    return () => window.clearTimeout(timeout)
  }, [message, onClear])

  if (!message) {
    return null
  }

  return (
    <div
      role="status"
      data-testid="transient-notice"
      className={cn(
        'fixed left-1/2 top-16 z-[90] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border bg-surface px-4 py-3 text-sm shadow-[0_8px_28px_rgba(0,0,0,0.12)]',
        tone === 'success'
          ? 'border-primary/20 text-text-primary'
          : 'border-red-200 text-red-700'
      )}
    >
      {message}
    </div>
  )
}
