import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ArchivedConversationItem, ArchivedConversationsListRequest } from '@/types/api'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  MenuSeparator as UiMenuSeparator,
} from '@wegent/collaboration/controls/MenuParts'
import { controlOption, controlPopup, controlTrigger } from '@wegent/collaboration/controls/recipes'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { Check, ChevronDown, Folder, ListFilter, Loader2, Search, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'

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
  allowProjectDelete?: boolean
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
  const theme = useCollaborationPortalTheme()

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<button type="button" />}
        data-testid={testId}
        aria-label={ariaLabel}
        className={cn(controlTrigger, 'w-full', triggerClassName)}
      >
        <span className="shrink-0 text-text-secondary">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
      </MenuTrigger>
      <MenuContent
        {...theme}
        aria-label={ariaLabel}
        align="end"
        sideOffset={4}
        collisionPadding={8}
        data-testid={testId + '-menu'}
        className={cn(controlPopup, 'min-w-60', menuClassName)}
      >
        {children(() => setOpen(false))}
      </MenuContent>
    </Menu>
  )
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <MenuGroupLabel className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-muted">
      {children}
    </MenuGroupLabel>
  )
}

function MenuSeparator() {
  return <UiMenuSeparator className="my-1 h-px bg-border" />
}

function MenuOption({
  testId,
  value,
  selected,
  icon,
  children,
}: {
  testId: string
  value: string
  selected: boolean
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <MenuRadioItem
      value={value}
      render={<button type="button" />}
      data-testid={testId}
      className={controlOption}
    >
      {icon && <span className="shrink-0 text-text-secondary">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
    </MenuRadioItem>
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
        <ControlInput
          data-testid="archived-search-input"
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          placeholder={t('workbench.archived_search_placeholder', '搜索已归档任务')}
          className="w-full pl-9"
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
            <MenuRadioGroup
              value={source}
              onValueChange={next => {
                const option = sourceOptions.find(option => option.value === next)
                if (option) onSourceChange(option.value)
                close()
              }}
            >
              <MenuSectionLabel>
                {t('workbench.archived_filter_type_label', '类型')}
              </MenuSectionLabel>
              {sourceOptions.map(option => (
                <MenuOption
                  key={option.value}
                  value={option.value}
                  testId={`archived-source-option-${option.value}`}
                  selected={source === option.value}
                >
                  {option.label}
                </MenuOption>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuRadioGroup
              value={sort}
              onValueChange={next => {
                const option = sortOptions.find(option => option.value === next)
                if (option) onSortChange(option.value)
                close()
              }}
            >
              <MenuSectionLabel>{t('workbench.archived_sort_label', '排序方式')}</MenuSectionLabel>
              {sortOptions.map(option => (
                <MenuOption
                  key={option.value}
                  value={option.value}
                  testId={`archived-sort-option-${option.value}`}
                  selected={sort === option.value}
                >
                  {option.label}
                </MenuOption>
              ))}
            </MenuRadioGroup>
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
          <MenuRadioGroup
            value={projectKey}
            onValueChange={next => {
              onProjectChange(next)
              close()
            }}
          >
            <MenuOption
              value="all"
              testId="archived-project-option-all"
              selected={projectKey === 'all'}
              icon={<Folder className="h-4 w-4" />}
            >
              {t('workbench.archived_project_all', '所有项目')}
            </MenuOption>
            {projects.length > 0 && <MenuSeparator />}
            {projects.map(project => (
              <MenuOption
                key={project.key}
                value={project.key}
                testId={`archived-project-option-${sanitizeTestId(project.key)}`}
                selected={projectKey === project.key}
                icon={<Folder className="h-4 w-4" />}
              >
                {project.name}
              </MenuOption>
            ))}
          </MenuRadioGroup>
        )}
      </ArchiveDropdown>
    </div>
  )
}

export function ArchivedConversationGroups({
  allowProjectDelete = true,
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
                  density="compact"
                  triggerClassName="flex items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                  items={[
                    {
                      label: t('workbench.archived_delete_project', '删除此项目中的全部任务'),
                      icon: Trash2,
                      danger: true,
                      disabled: busyKey !== null || !allowProjectDelete,
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
                    <DeleteIconButton
                      type="button"
                      data-testid={`archived-delete-button-${suffix}`}
                      aria-label={deleteLabel}
                      title={deleteLabel}
                      onClick={() => onDelete(item)}
                      disabled={busyKey !== null}
                      pending={busyKey === `delete:${item.id}`}
                    />
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid={`archived-unarchive-button-${suffix}`}
                      onClick={() => onUnarchive(item)}
                      disabled={busyKey !== null}
                      className="flex h-8 items-center justify-center rounded-md bg-muted px-3 text-sm text-text-primary hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-45 max-md:h-11"
                    >
                      {rowBusy && busyKey === `unarchive:${item.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        t('workbench.archived_unarchive', '取消归档')
                      )}
                    </ControlButton>
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

function formatArchivedTime(value?: string | number | null) {
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
