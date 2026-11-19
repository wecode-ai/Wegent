import { Popover, PopoverContent, PopoverTrigger } from '../controls/Popover'
import { Ellipsis } from 'lucide-react'
import { useId, useState, type ReactNode, type Ref } from 'react'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import './IssuePropertiesPopover.css'

export function IssuePropertiesPopover({
  label,
  children,
  onClose,
  triggerRef,
  testIdPrefix = 'cloud-todo-more-properties',
}: {
  label: string
  children: ReactNode
  onClose?: () => void
  triggerRef?: Ref<HTMLButtonElement>
  testIdPrefix?: string
}) {
  const [open, setOpen] = useState(false)
  const portalTheme = useCollaborationPortalTheme()
  const titleId = useId()

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) {
      // Commit drafts explicitly: inactive desktop windows may not emit blur.
      onClose?.()
    }
    setOpen(nextOpen)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            className="task-detail-more-menu-trigger"
            aria-label={label}
            data-testid={testIdPrefix}
          />
        }
      >
        <Ellipsis className="h-4 w-4" aria-hidden="true" />
      </PopoverTrigger>
      <>
        <PopoverContent
          {...portalTheme}
          className={`${portalTheme.className} task-detail-more-menu-popover z-system-popover`}
          aria-labelledby={titleId}
          data-testid={`${testIdPrefix}-popover`}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          initialFocus={'none'}
        >
          <h3 id={titleId} className="sr-only">
            {label}
          </h3>
          {children}
        </PopoverContent>
      </>
    </Popover>
  )
}
