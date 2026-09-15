import { CornerDownLeft } from 'lucide-react'
import { getPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'

interface KeyboardShortcutProps {
  value: string
  className?: string
}

export function KeyboardShortcut({ value, className }: KeyboardShortcutProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-full bg-white/10 px-2 text-sm font-medium leading-none text-current',
        className
      )}
    >
      {value.split('+').map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center">
          {index > 0 ? <span className="w-0.5" /> : null}
          <KeyboardShortcutPart value={part} />
        </span>
      ))}
    </span>
  )
}

function KeyboardShortcutPart({ value }: { value: string }) {
  const platform = getPlatform()
  const isMac = platform === 'mac'

  if (value === 'Command') {
    return isMac ? <span aria-label="Command">⌘</span> : <span>Ctrl</span>
  }
  if (value === 'Control') {
    return isMac ? <span aria-label="Control">⌃</span> : <span>Ctrl</span>
  }
  if (value === 'Shift') {
    return isMac ? <span aria-label="Shift">⇧</span> : <span>Shift</span>
  }
  if (value === 'Alt') {
    return isMac ? <span aria-label="Option">⌥</span> : <span>Alt</span>
  }
  if (value === 'Enter') return <CornerDownLeft className="h-3.5 w-3.5" aria-label="Enter" />
  return <span>{value}</span>
}
