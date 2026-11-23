import { TooltipContent, TooltipTrigger, Tooltip as UiTooltip } from '@ui-sdk/react/tooltip'
import { isValidElement, useState, type ReactNode } from 'react'
import { useWindowEvent } from '../dom-events'
import { KeyboardShortcut } from './KeyboardShortcut'
import { useCollaborationPortalTheme } from '../theme'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

import { TooltipContext } from './tooltipContext'

export interface TooltipProps {
  label: string
  disabled?: boolean
  shortcut?: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  testId?: string
  className?: string
  children: ReactNode
}

export function Tooltip({
  label,
  disabled = false,
  shortcut,
  side = 'top',
  align = 'center',
  testId,
  className,
  children,
}: TooltipProps) {
  const theme = useCollaborationPortalTheme()
  const [open, setOpen] = useState(false)
  if (disabled && open) setOpen(false)
  const dismiss = () => setOpen(false)
  useWindowEvent('resize', dismiss, { enabled: open })
  useWindowEvent('scroll', dismiss, { enabled: open, capture: true })
  return (
    <TooltipContext.Provider value={true}>
      <UiTooltip delay={700} disabled={disabled} open={!disabled && open} onOpenChange={setOpen}>
        <TooltipTrigger
          data-tooltip-trigger
          render={isValidElement(children) ? children : <span>{children}</span>}
        />
        <TooltipContent
          {...theme}
          data-testid={testId}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            theme.className,
            'z-system-popover inline-flex max-w-xs items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1 text-sm text-text-primary shadow-lg',
            className
          )}
        >
          <span>{label}</span>
          {shortcut && <KeyboardShortcut value={shortcut} className="bg-muted" />}
        </TooltipContent>
      </UiTooltip>
    </TooltipContext.Provider>
  )
}
