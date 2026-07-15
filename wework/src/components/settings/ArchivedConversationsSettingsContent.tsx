import { Check, ChevronDown, Folder, ListFilter, Loader2, Search, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ArchivedConversationItem, ArchivedConversationsListRequest } from '@/types/api'

export type ArchivedSourceFilter = NonNullable<ArchivedConversationsListRequest['source']>
export type ArchivedSortFilter = NonNullable<ArchivedConversationsListRequest['sort']>

export interface ArchivedProjectGroup {
  key: string
  name: string
  items: ArchivedConversationItem[]
}

interface ArchivedProjectOption {
  key: string
  name: string
  count: number
}

interface ArchivedConversationsFiltersProps {
  search: string
  source: ArchivedSourceFilter
  sort: ArchivedSortFilter
  projectKey: string
  projects: ArchivedProjectOption[]
  onSearchChange: (value: string) => void
  onSourceChange: (value: ArchivedSourceFilter) => void
  onSortChange: (value: ArchivedSortFilter) => void
  onProjectChange: (value: string) => void
}

interface ArchivedConversationGroupsProps {
  groups: ArchivedProjectGroup[]
  showHeaders: boolean
  busyKey: string | null
  onDelete: (item: ArchivedConversationItem) => void
  onDeleteProject: (group: ArchivedProjectGroup) => void
  onUnarchive: (item: ArchivedConversationItem) => void
}

interface ArchiveDropdownProps {
  testId: string
  ariaLabel: string
  icon: ReactNode
  label: ReactNode
  menuClassName?: string
  triggerClassName?: string
  children: (close: () => void) => ReactNode
}

function ArchiveDropdown({
  testId,
  ariaLabel,
  icon,
  label,
  menuClassName,
  triggerClassName,
  children,
}: ArchiveDropdownProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-[13px] text-text-primary outline-none hover:bg-muted focus-visible:border-primary max-md:h-11',
          triggerClassName
        )}
      >
        <span className="shrink-0 text-text-secondary">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`${testId}-menu`}
          className={cn(
            'absolute right-0 top-[calc(100%+6px)] z-system-popover min-w-[240px] rounded-xl border border-border bg-popover p-1.5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.18)] ring-1 ring-black/5',
            menuClassName
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-muted">{children}</div>
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}

function MenuOption({
  testId,
  selected,
  icon,
  children,
  onSelect,
}: {
  testId: string
  selected: boolean
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] leading-[18px] text-text-primary hover:bg-muted max-md:h-11"
    >
      {icon && <span className="shrink-0 text-text-secondary">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
    </button>
  )
}

export function ArchivedConversationsFilters({
  search,
  source,
  sort,
  projectKey,
  projects,
  onSearchChange,
  onSourceChange,
  onSortChange,
  onProjectChange,
}: ArchivedConversationsFiltersProps) {
  const { t } = useTranslation('common')
  const sourceOptions: Array<{ value: ArchivedSourceFilter; label: string }> = [
    { value: 'all', label: t('workbench.archived_filter_all', '所有任务') },
    { value: 'local', label: t('workbench.archived_filter_local', '本地') },
    { value: 'cloud', label: t('workbench.archived_filter_cloud', '云端') },
  ]
  const sortOptions: Array<{ value: ArchivedSortFilter; label: string }> = [
    { value: 'updated', label: t('workbench.archived_sort_updated', '更新时间') },
    { value: 'created', label: t('workbench.archived_sort_created', '创建时间') },
    { value: 'alphabetical', label: t('workbench.archived_sort_alpha', '按字母顺序') },
  ]
  const selectedSource = sourceOptions.find(option => option.value === source) ?? sourceOptions[0]
  const selectedProject = projects.find(project => project.key === projectKey)

  return (
    <div
      data-testid="archived-filter-controls"
      className="sticky top-0 z-20 -mx-1 flex flex-col gap-2 bg-background px-1 py-3 md:flex-row md:items-center"
    >
      <label className="relative block min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          data-testid="archived-search-input"
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          placeholder={t('workbench.archived_search_placeholder', '搜索已归档任务')}
          className="h-8 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[13px] outline-none focus:border-primary max-md:h-11"
        />
      </label>

      <ArchiveDropdown
        testId="archived-filter-menu"
        ariaLabel={t('workbench.archived_filter_menu_aria', '筛选和排序已归档任务')}
        icon={<ListFilter className="h-4 w-4" />}
        label={selectedSource.label}
        triggerClassName="md:w-[150px]"
      >
        {close => (
          <>
            <MenuSectionLabel>{t('workbench.archived_filter_type_label', '类型')}</MenuSectionLabel>
            {sourceOptions.map(option => (
              <MenuOption
                key={option.value}
                testId={`archived-source-option-${option.value}`}
                selected={source === option.value}
                onSelect={() => {
                  onSourceChange(option.value)
                  close()
                }}
              >
                {option.label}
              </MenuOption>
            ))}
            <MenuSeparator />
            <MenuSectionLabel>{t('workbench.archived_sort_label', '排序方式')}</MenuSectionLabel>
            {sortOptions.map(option => (
              <MenuOption
                key={option.value}
                testId={`archived-sort-option-${option.value}`}
                selected={sort === option.value}
                onSelect={() => {
                  onSortChange(option.value)
                  close()
                }}
              >
                {option.label}
              </MenuOption>
            ))}
          </>
        )}
      </ArchiveDropdown>

      <ArchiveDropdown
        testId="archived-project-filter"
        ariaLabel={t('workbench.archived_project_filter_aria', '按项目筛选已归档任务')}
        icon={<Folder className="h-4 w-4" />}
        label={selectedProject?.name ?? t('workbench.archived_project_all', '所有项目')}
        triggerClassName="md:w-[190px]"
        menuClassName="max-h-[360px] overflow-y-auto md:min-w-[280px]"
      >
        {close => (
          <>
            <MenuOption
              testId="archived-project-option-all"
              selected={projectKey === 'all'}
              icon={<Folder className="h-4 w-4" />}
              onSelect={() => {
                onProjectChange('all')
                close()
              }}
            >
              {t('workbench.archived_project_all', '所有项目')}
            </MenuOption>
            {projects.length > 0 && <MenuSeparator />}
            {projects.map(project => (
              <MenuOption
                key={project.key}
                testId={`archived-project-option-${sanitizeTestId(project.key)}`}
                selected={projectKey === project.key}
                icon={<Folder className="h-4 w-4" />}
                onSelect={() => {
                  onProjectChange(project.key)
                  close()
                }}
              >
                {project.name}
              </MenuOption>
            ))}
          </>
        )}
      </ArchiveDropdown>
    </div>
  )
}

export function ArchivedConversationGroups({
  groups,
  showHeaders,
  busyKey,
  onDelete,
  onDeleteProject,
  onUnarchive,
}: ArchivedConversationGroupsProps) {
  const { t } = useTranslation('common')

  return (
    <div className="space-y-7">
      {groups.map(group => (
        <section key={group.key} data-testid={`archived-group-${sanitizeTestId(group.key)}`}>
          {showHeaders && (
            <div className="mb-2 flex h-8 items-center justify-between gap-3 px-0.5 text-sm">
              <h2 className="flex min-w-0 items-center gap-2 font-medium text-text-primary">
                <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="truncate">{group.name}</span>
              </h2>
              <div className="flex shrink-0 items-center gap-1 text-text-muted">
                <span data-testid={`archived-group-count-${sanitizeTestId(group.key)}`}>
                  {t('workbench.archived_group_count', '{{count}} 个任务', {
                    count: group.items.length,
                  })}
                </span>
                <ActionMenu
                  ariaLabel={t('workbench.archived_project_actions', '项目操作')}
                  testId={`archived-project-actions-${sanitizeTestId(group.key)}`}
                  placement="bottom-end"
                  triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                  items={[
                    {
                      label: t('workbench.archived_delete_project', '删除此项目中的全部任务'),
                      icon: Trash2,
                      danger: true,
                      disabled: busyKey !== null,
                      testId: `archived-delete-project-${sanitizeTestId(group.key)}`,
                      onSelect: () => onDeleteProject(group),
                    },
                  ]}
                />
              </div>
            </div>
          )}

          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/45">
            {group.items.map(item => {
              const suffix = itemTestId(item)
              const rowBusy = busyKey === `delete:${item.id}` || busyKey === `unarchive:${item.id}`
              const deleteLabel = t('workbench.archived_delete_tooltip', '删除已归档任务')
              const deviceLabel =
                item.source === 'cloud' ? item.deviceAddress || item.deviceId : null

              return (
                <div
                  key={item.id}
                  data-testid={`archived-item-${suffix}`}
                  className="flex min-h-[72px] items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {item.title}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                      <span className="truncate">
                        {formatArchivedTime(item.updatedAt || item.createdAt)}
                      </span>
                      {deviceLabel && (
                        <>
                          <span aria-hidden="true">•</span>
                          <span className="truncate">{deviceLabel}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`archived-delete-button-${suffix}`}
                      aria-label={deleteLabel}
                      title={deleteLabel}
                      onClick={() => onDelete(item)}
                      disabled={busyKey !== null}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45 max-md:h-11 max-md:w-11"
                    >
                      {busyKey === `delete:${item.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      data-testid={`archived-unarchive-button-${suffix}`}
                      onClick={() => onUnarchive(item)}
                      disabled={busyKey !== null}
                      className="flex h-8 items-center justify-center rounded-md bg-muted px-3 text-[13px] text-text-primary hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-45 max-md:h-11"
                    >
                      {rowBusy && busyKey === `unarchive:${item.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        t('workbench.archived_unarchive', '取消归档')
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function itemTestId(item: ArchivedConversationItem) {
  return sanitizeTestId(`${item.deviceId}-${item.taskId}`)
}

function sanitizeTestId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function formatArchivedTime(value?: string | null) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}
