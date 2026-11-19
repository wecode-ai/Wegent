import { Tooltip } from '@/components/ui/tooltip'
import type { ReactNode } from 'react'

export function TitlebarTooltip({
  label,
  shortcut,
  align = 'center',
  testId,
  children,
}: {
  label: string
  shortcut?: string
  align?: 'start' | 'center' | 'end'
  testId?: string
  children: ReactNode
}) {
  return (
    <Tooltip label={label} shortcut={shortcut} side="bottom" align={align} testId={testId}>
      {children}
    </Tooltip>
  )
}
