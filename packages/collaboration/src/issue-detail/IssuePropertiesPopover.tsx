import * as Popover from '@radix-ui/react-popover'
import { Ellipsis } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import './IssuePropertiesPopover.css'

export function IssuePropertiesPopover({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const portalTheme = useCollaborationPortalTheme()
  const titleId = useId()

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen) {
      // Commit focused field drafts before dismissing and unmounting the content.
      const content = contentRef.current
      const activeElement = content?.ownerDocument.activeElement
      if (activeElement instanceof HTMLElement && content?.contains(activeElement)) {
        activeElement.blur()
      }
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
          ref={contentRef}
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
