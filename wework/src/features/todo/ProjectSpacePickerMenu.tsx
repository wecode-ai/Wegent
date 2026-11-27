import type { CloudProject } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Folder, LayoutDashboard, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  projectSpacePickerEntries,
  searchProjectSpaceEntries,
  sortProjectSpaceEntries,
  type ProjectSpacePickerOrder,
} from './projectSpacePickerModel'
import { projectKey } from './projectSpaceSelection'

interface ProjectSpacePickerMenuProps {
  projects: CloudProject[]
  project?: CloudProject | null
  anchor: HTMLButtonElement | null
  onClose: () => void
  onSelect: (project: CloudProject) => void
  onRemoveProject?: () => void
}

export function ProjectSpacePickerMenu({
  projects,
  project,
  anchor,
  onClose,
  onSelect,
  onRemoveProject,
}: ProjectSpacePickerMenuProps) {
  const { t, i18n } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [groupKey, setGroupKey] = useState<string | null>(null)
  const [groupByWorkspace, setGroupByWorkspace] = useState(false)
  const [order, setOrder] = useState<ProjectSpacePickerOrder>('name-asc')
  const localLabel = t('workbench.project_picker_local', '本地项目')
  const cloudLabel = t('workbench.project_picker_cloud', '云端项目')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const entries = useMemo(
    () =>
      projectSpacePickerEntries(
        projects,
        { local: localLabel, cloud: cloudLabel },
        groupByWorkspace ? 'workspace' : 'storage'
      ),
    [cloudLabel, localLabel, projects, groupByWorkspace]
  )
  const groups = useMemo(
    () =>
      [...new Map(entries.map(entry => [entry.group.key, entry.group])).values()].sort(
        (left, right) => left.label.localeCompare(right.label, locale)
      ),
    [entries, locale]
  )
  const matching = useMemo(() => searchProjectSpaceEntries(entries, query), [entries, query])
  const visible = useMemo(
    () =>
      sortProjectSpaceEntries(
        matching.filter(entry => groupKey === null || entry.group.key === groupKey),
        order,
        locale
      ),
    [groupKey, locale, matching, order]
  )
  const selectGroup = (key: string | null) => setGroupKey(key)
  return (
    <SearchableSelect
      hideTrigger
      activateSelected
      autoHighlight="always"
      anchor={anchor}
      open
      onOpenChange={next => {
        if (!next) onClose()
      }}
      value={project ? projectKey(project) : ''}
      query={query}
      onSearchChange={setQuery}
      filter={false}
      options={visible.map(({ key, project: option, group }) => ({
        value: key,
        label: option.name,
        accessibleLabel: `${option.name} · ${group.label} · ${option.project_key}`,
        description: `${option.project_key} · ${group.label}`,
        searchText: `${option.name} ${option.project_key} ${group.label}`,
        testId: `work-item-workspace-option-${String(option.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
        attributes: { 'data-project-space-key': key, 'data-group-key': group.key },
        icon: <LayoutDashboard aria-hidden="true" className="h-4 w-4" />,
      }))}
      testId="project-space-picker-trigger"
      menuTestId="work-item-context-menu"
      searchTestId="project-space-picker-search"
      clearSearch={{
        label: t('workbench.project_picker_clear_search', '清空搜索'),
        testId: 'project-space-picker-clear-search',
      }}
      accessibleLabel={t('workbench.project_picker_title', '加入项目空间')}
      searchPlaceholder={t('workbench.project_picker_search', '搜索项目名称、空间或标识…')}
      emptyLabel={t('workbench.project_picker_empty', '没有匹配的项目，试试其他关键词或空间')}
      emptyTestId="project-space-picker-empty"
      contentClassName="w-[min(40rem,calc(100vw-1rem))]"
      header={
        <div className="flex items-center justify-between gap-3 px-2 pb-2">
          <h2 className="text-base font-medium">
            {t('workbench.project_picker_title', '加入项目空间')}
          </h2>
          <SelectField<ProjectSpacePickerOrder>
            testId="project-space-picker-sort"
            accessibleLabel={t('workbench.project_picker_sort', '项目排序')}
            value={order}
            onChange={setOrder}
            options={[
              { value: 'name-asc', label: t('workbench.project_picker_name_asc', '名称 A–Z') },
              { value: 'name-desc', label: t('workbench.project_picker_name_desc', '名称 Z–A') },
            ]}
          />
        </div>
      }
      renderOptions={list => (
        <div className="flex min-h-0">
          <nav
            aria-label={
              groupByWorkspace
                ? t('workbench.project_picker_space')
                : t('workbench.project_picker_projects')
            }
            className="w-40 shrink-0 overflow-y-auto border-r border-border p-1 max-md:w-28"
          >
            <div className="px-2 py-1 text-xs text-text-secondary">
              {groupByWorkspace
                ? t('workbench.project_picker_space')
                : t('workbench.project_picker_projects')}
            </div>
            {[
              {
                key: null,
                label: groupByWorkspace
                  ? t('workbench.project_picker_all')
                  : t('workbench.project_picker_all_projects'),
              },
              ...groups,
            ].map(group => (
              <ControlButton
                variant="unstyled"
                key={group.key ?? 'all'}
                type="button"
                data-testid="project-space-picker-group"
                data-group-key={group.key ?? 'all'}
                aria-pressed={groupKey === group.key}
                aria-label={group.label}
                title={group.label}
                onClick={() => selectGroup(group.key)}
                className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70 max-md:h-11  wework:keyboard:focus-visible:ring-blue-500/70 ${groupKey === group.key ? 'bg-muted font-medium' : ''}`}
              >
                {group.key === null ? (
                  <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <span className="text-xs tabular-nums text-text-secondary">
                  {group.key === null
                    ? matching.length
                    : matching.filter(entry => entry.group.key === group.key).length}
                </span>
              </ControlButton>
            ))}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="project-space-picker-toggle-workspaces"
              aria-pressed={groupByWorkspace}
              onClick={() => {
                setGroupByWorkspace(value => !value)
                selectGroup(null)
              }}
              className="mt-2 min-h-9 w-full rounded-lg px-2 text-left text-sm text-text-secondary hover:bg-muted max-md:min-h-11"
            >
              {t(
                groupByWorkspace
                  ? 'workbench.project_picker_by_location'
                  : 'workbench.project_picker_by_workspace'
              )}
            </ControlButton>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">{list}</div>
        </div>
      )}
      actions={
        onRemoveProject
          ? [
              {
                testId: 'clear-project-space-context-button',
                label: t('workbench.clear_extra_project_space', '不加入其他项目空间'),
                icon: <X aria-hidden="true" className="h-4 w-4" />,
                onSelect: () => {
                  onClose()
                  onRemoveProject()
                },
              },
            ]
          : []
      }
      onChange={key => {
        const option = entries.find(entry => entry.key === key)
        if (option) {
          onClose()
          onSelect(option.project)
        }
      }}
    />
  )
}
