import { useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskListMode } from './TaskFilters'

export function TaskViewSwitcher({
  mode,
  onChange,
}: {
  mode: TaskListMode
  onChange?(mode: TaskListMode): void
}) {
  const { t } = useTranslation('collaborationExp')
  const [open, setOpen] = useState(false)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const modes = ['tasks', 'projects'] as const
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={t('tasks.viewMode')}
          aria-haspopup="listbox"
          className="experience-task-view-switch-trigger"
          data-testid="collaboration-exp-task-view-mode"
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <span>{t(mode === 'tasks' ? 'tasks.title' : 'tasks.byProject')}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="start"
        sideOffset={4}
        collisionPadding={8}
        role="listbox"
        aria-label={t('tasks.viewMode')}
        className="experience-task-view-menu"
        data-testid="collaboration-exp-task-view-mode-menu"
        onOpenAutoFocus={event => {
          event.preventDefault()
          options.current[modes.indexOf(mode)]?.focus()
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const current = options.current.indexOf(document.activeElement as HTMLButtonElement)
          const next =
            (current + (event.key === 'ArrowDown' ? 1 : -1) + modes.length) % modes.length
          options.current[next]?.focus()
        }}
      >
        {modes.map((option, index) => (
          <button
            key={option}
            ref={element => {
              options.current[index] = element
            }}
            type="button"
            role="option"
            aria-selected={mode === option}
            data-testid={`collaboration-exp-task-view-mode-${option}`}
            onClick={() => {
              onChange?.(option)
              setOpen(false)
            }}
          >
            <span>{t(option === 'tasks' ? 'tasks.title' : 'tasks.byProject')}</span>
            {mode === option && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </Popover.Content>
    </Popover.Root>
  )
}
