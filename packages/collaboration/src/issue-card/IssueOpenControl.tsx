import { useRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { Button as ControlButton } from '../markdown/Button'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

const interactiveElement =
  'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [contenteditable]:not([contenteditable="false"])'

export function IssueOpenControl<Row extends HTMLElement>({
  children,
  buttonProps,
  className,
  testId,
  onOpen,
  onRowClick,
  rowClickDisabled,
  renderRow,
}: {
  children: ReactNode
  buttonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'children' | 'className' | 'onClick' | 'type'
  >
  className?: string
  testId?: string
  onOpen?: () => void
  onRowClick?: (event: MouseEvent<Row>) => void
  rowClickDisabled?: boolean
  renderRow: (button: ReactNode, onRowClick: (event: MouseEvent<Row>) => void) => ReactNode
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  return renderRow(
    <ControlButton
      variant="unstyled"
      {...buttonProps}
      ref={buttonRef}
      type="button"
      data-testid={testId}
      className={cn(
        'block w-full min-w-0 rounded-sm text-left keyboard:focus-visible:ring-inset',
        onOpen ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      onClick={onOpen}
    >
      {children}
    </ControlButton>,
    event => {
      const target = event.target
      // Portals participate in React event propagation without belonging to the row.
      if (!(target instanceof Element) || !event.currentTarget.contains(target)) return
      onRowClick?.(event)
      if (!onOpen || rowClickDisabled || buttonProps?.disabled || event.defaultPrevented) return
      const control = target.closest(interactiveElement)
      if (control && event.currentTarget.contains(control)) return
      buttonRef.current?.focus({ preventScroll: true })
      onOpen()
    }
  )
}
