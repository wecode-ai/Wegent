import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Link2, Loader2, Monitor, Search } from 'lucide-react'
import { useState } from 'react'

export interface ExistingIssueTask {
  address: RuntimeTaskAddress
  title: string
}

export function IssueExistingTaskPicker({
  tasks,
  onSelect,
  deviceNamesById,
}: {
  deviceNamesById?: Readonly<Record<string, string>>
  tasks: ExistingIssueTask[]
  onSelect: (task: ExistingIssueTask) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const candidates = tasks.filter(task =>
    `${task.title} ${task.address.taskId}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )
  async function select(task: ExistingIssueTask) {
    setSelectedKey(`${task.address.deviceId}:${task.address.taskId}`)
    setPending(true)
    setError(null)
    try {
      await onSelect(task)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.link_existing_failed'))
    } finally {
      setPending(false)
      setSelectedKey(null)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (!pending) {
          setOpen(next)
          setQuery('')
          setError(null)
        }
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="issue-link-existing-task"
            className="task-detail-workspace-ghost-action"
          />
        }
      >
        <Link2 aria-hidden="true" className="h-4 w-4" />
        {t('todo.link_existing_task')}
      </PopoverTrigger>
      <>
        <PopoverContent
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={t('todo.link_existing_task')}
          data-testid="issue-existing-task-picker"
          className="z-system-popover flex max-h-[var(--available-height)] w-[min(384px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover p-2 text-text-primary shadow-lg"
        >
          <div className="px-2 pb-3 pt-2">
            <p className="text-base font-medium">{t('todo.link_existing_task')}</p>
            <p className="mt-1 text-xs text-text-muted">{t('todo.link_existing_hint')}</p>
          </div>
          <div className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border px-3">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            <ControlInput
              appearance="plain"
              aria-label={t('todo.search_existing_task')}
              placeholder={t('todo.search_existing_task')}
              data-testid="issue-existing-task-search"
              value={query}
              disabled={pending}
              onChange={event => setQuery(event.target.value)}
              className="h-11 min-w-0 flex-1 md:h-9"
            />
          </div>
          {error && (
            <p role="alert" className="p-2 text-sm text-destructive">
              {t('todo.link_existing_failed')} {error}
            </p>
          )}
          <div aria-busy={pending} className="min-h-0 max-h-72 overflow-y-auto overscroll-contain">
            {candidates.length === 0 && (
              <p role="status" className="p-3 text-sm text-text-muted">
                {query.trim() ? t('todo.no_existing_tasks') : t('todo.no_available_tasks')}
              </p>
            )}
            {candidates.map(task => (
              <ControlButton
                variant="unstyled"
                type="button"
                key={`${task.address.deviceId}:${task.address.taskId}`}
                data-testid={`issue-existing-task-${task.address.deviceId}-${task.address.taskId}`}
                disabled={pending}
                onClick={() => void select(task)}
                title={task.title}
                className="group flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-50"
              >
                <Monitor aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{task.title}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {deviceNamesById?.[task.address.deviceId] ?? t('todo.existing_task_device')}
                    {task.address.runtime ? ` · ${task.address.runtime}` : ''}
                  </span>
                </span>
                {pending && selectedKey === `${task.address.deviceId}:${task.address.taskId}` ? (
                  <Loader2
                    aria-label={t('todo.linking_task')}
                    className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <Link2
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                )}
              </ControlButton>
            ))}
          </div>
        </PopoverContent>
      </>
    </Popover>
  )
}
