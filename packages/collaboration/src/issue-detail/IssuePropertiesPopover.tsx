import * as Popover from '@radix-ui/react-popover'
import { Ellipsis } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import './IssuePropertiesPopover.css'

export function IssuePropertiesPopover({
  label,
  children,
  onClose,
}: {
  label: string
  children: ReactNode
  onClose?: () => void
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
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="task-detail-more-menu-trigger"
          aria-label={label}
          data-testid="cloud-todo-more-properties"
        >
          <Ellipsis className="h-4 w-4" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalTheme}
          className={`${portalTheme.className} task-detail-more-menu-popover z-system-popover`}
          aria-labelledby={titleId}
          data-testid="cloud-todo-more-properties-popover"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={event => event.preventDefault()}
        >
          <h3 id={titleId} className="task-detail-more-menu-title">
            {label}
          </h3>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
