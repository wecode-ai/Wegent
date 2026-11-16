import * as Popover from '@radix-ui/react-popover'
import { useRef, useState, type KeyboardEvent } from 'react'
import { useCollaborationPortalTheme } from '../theme'
import { ProjectViewLabel } from './ProjectViewLabel'
import type {
  CollaborationProjectView,
  CollaborationProjectViewOption,
} from './projectViewNavigation'

function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    ),
  ]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
          items.length
  event.preventDefault()
  items[next]?.focus()
}

export function ProjectViewMenu<View extends CollaborationProjectView>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: CollaborationProjectViewOption<View>[]
  value: View
  onChange(view: View): void
}) {
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const theme = useCollaborationPortalTheme()
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="project-view-switcher-trigger"
          data-testid="collaboration-compact-trigger"
          aria-haspopup="menu"
        >
          {label}
          <span aria-hidden="true">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...theme}
          ref={contentRef}
          className={`${theme.className} project-view-switcher-menu`}
          role="menu"
          aria-label={label}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          data-testid="collaboration-compact-menu"
          data-embedded-browser-occlusion
          onKeyDown={navigateMenu}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current
              ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
              ?.focus()
          }}
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              className="project-view-switcher-menu-item"
              data-testid={option.testId}
              aria-checked={option.id === value}
              aria-current={option.id === value ? 'page' : undefined}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
            >
              <ProjectViewLabel
                option={option}
                selected={option.id === value}
              />
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
