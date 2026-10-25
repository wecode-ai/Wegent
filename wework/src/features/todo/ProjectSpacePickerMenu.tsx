import { Check, Folder, LayoutDashboard, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { CloudProject } from '@/api/deliveries'
import { useOutsideClick } from '@/components/chat/composer/useOutsideClick'
import { useAnchoredPortalMenu } from '@/hooks/useAnchoredPortalMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { projectKey, sameProjectSpace } from './projectSpaceSelection'
import {
  projectSpacePickerEntries,
  searchProjectSpaceEntries,
  sortProjectSpaceEntries,
  type ProjectSpacePickerOrder,
} from './projectSpacePickerModel'

interface ProjectSpacePickerMenuProps {
  projects: CloudProject[]
  project?: CloudProject | null
  triggerRef: RefObject<HTMLButtonElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onSelect: (project: CloudProject) => void
  onRemoveProject?: () => void
}

export function ProjectSpacePickerMenu({
  projects,
  project,
  triggerRef,
  containerRef,
  onClose,
  onSelect,
  onRemoveProject,
}: ProjectSpacePickerMenuProps) {
  const { t, i18n } = useTranslation('common')
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [groupKey, setGroupKey] = useState<string | null>(null)
  const [order, setOrder] = useState<ProjectSpacePickerOrder>('name-asc')
  const [activeKey, setActiveKey] = useState(project ? projectKey(project) : '')
  const outsideRefs = useMemo(() => [menuRef], [])
  const layout = useAnchoredPortalMenu(true, triggerRef, menuRef, { align: 'start' })
  useOutsideClick(containerRef, true, onClose, outsideRefs)

  const localLabel = t('workbench.project_picker_local', '本地项目')
  const cloudLabel = t('workbench.project_picker_cloud', '云端项目')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const entries = useMemo(
    () => projectSpacePickerEntries(projects, { local: localLabel, cloud: cloudLabel }),
    [cloudLabel, localLabel, projects]
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
  const activeIndex = Math.max(
    0,
    visible.findIndex(entry => entry.key === activeKey)
  )

  useEffect(() => {
    const trigger = triggerRef.current
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      trigger?.focus()
    }
  }, [triggerRef])

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, visible])

  const choose = (option: CloudProject) => {
    onClose()
    onSelect(option)
  }

  const selectGroup = (key: string | null) => {
    setGroupKey(key)
    setActiveKey('')
    inputRef.current?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="work-item-context-menu"
      style={{
        left: layout?.left ?? 0,
        top: layout?.top ?? 0,
        maxHeight: Math.min(520, layout?.maxHeight ?? 520),
        visibility: layout ? 'visible' : 'hidden',
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      className="fixed z-system-popover flex w-[40rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl bg-background text-text-primary shadow-xl ring-1 ring-foreground/10"
    >
      <header className="shrink-0 px-4 pb-3 pt-4">
        <h2 id={titleId} className="text-base font-medium">
          {t('workbench.project_picker_title', '加入项目空间')}
        </h2>
        <div className="mt-3 flex gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border px-2 keyboard:focus-within:ring-1 keyboard:focus-within:ring-blue-500/70 max-md:h-11">
            <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={visible.length ? `${listId}-${activeIndex}` : undefined}
              aria-label={t('workbench.project_picker_search', '搜索项目名称、空间或标识…')}
              placeholder={t('workbench.project_picker_search', '搜索项目名称、空间或标识…')}
              data-testid="project-space-picker-search"
              value={query}
              onChange={event => {
                setQuery(event.target.value)
                setActiveKey('')
              }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return
                if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
                event.preventDefault()
                event.stopPropagation()
                if (!visible.length) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  const delta = event.key === 'ArrowDown' ? 1 : -1
                  const index = (activeIndex + delta + visible.length) % visible.length
                  setActiveKey(visible[index].key)
                } else if (event.key === 'Enter') {
                  choose(visible[activeIndex].project)
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
            />
            {query ? (
              <button
                type="button"
                data-testid="project-space-picker-clear-search"
                aria-label={t('workbench.project_picker_clear_search', '清空搜索')}
                title={t('workbench.project_picker_clear_search', '清空搜索')}
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted max-md:h-11 max-md:w-11"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <select
            data-testid="project-space-picker-sort"
            aria-label={t('workbench.project_picker_sort', '项目排序')}
            value={order}
            onChange={event => {
              setOrder(event.target.value as ProjectSpacePickerOrder)
              setActiveKey('')
            }}
            className="h-8 max-w-32 shrink-0 rounded-lg border border-border bg-background px-2 text-sm focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-blue-500/70 max-md:h-11"
          >
            <option value="name-asc" className="bg-background text-text-primary">
              {t('workbench.project_picker_name_asc', '名称 A–Z')}
            </option>
            <option value="name-desc" className="bg-background text-text-primary">
              {t('workbench.project_picker_name_desc', '名称 Z–A')}
            </option>
          </select>
        </div>
      </header>
      <div className="flex h-80 min-h-0">
        <nav
          aria-label={t('workbench.project_picker_space', '所属空间')}
          className="w-40 shrink-0 overflow-y-auto border-r border-border p-1 max-md:w-28"
        >
          <div className="px-2 py-1 text-xs text-text-muted">
            {t('workbench.project_picker_space', '所属空间')}
          </div>
          {[{ key: null, label: t('workbench.project_picker_all', '全部空间') }, ...groups].map(
            group => (
              <button
                key={group.key ?? 'all'}
                type="button"
                data-testid="project-space-picker-group"
                data-group-key={group.key ?? 'all'}
                aria-pressed={groupKey === group.key}
                aria-label={group.label}
                title={group.label}
                onClick={() => selectGroup(group.key)}
                className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-blue-500/70 max-md:h-11 ${groupKey === group.key ? 'bg-muted font-medium' : ''}`}
              >
                {group.key === null ? (
                  <LayoutDashboard className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <span className="text-xs tabular-nums text-text-muted">
                  {group.key === null
                    ? matching.length
                    : matching.filter(entry => entry.group.key === group.key).length}
                </span>
              </button>
            )
          )}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col px-1">
          <div className="shrink-0 px-2 py-1 text-xs text-text-muted">
            {t('workbench.project_picker_projects', '项目')}
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('workbench.project_picker_projects', '项目')}
            className={`min-h-0 overflow-y-auto ${visible.length ? 'flex-1' : ''}`}
          >
            {visible.map(({ key, project: option, group }, index) => {
              const selected = sameProjectSpace(
                { projectStore: option.project_store, projectId: option.id },
                project ? { projectStore: project.project_store, projectId: project.id } : null
              )
              const label = `${option.name} · ${group.label} · ${option.project_key}`
              return (
                <button
                  key={key}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={label}
                  title={label}
                  tabIndex={-1}
                  data-active={index === activeIndex}
                  data-group-key={group.key}
                  data-project-space-key={key}
                  data-testid={`work-item-workspace-option-${String(option.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choose(option)}
                  className={`flex h-12 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted ${selected ? 'bg-muted' : ''} ${index === activeIndex ? 'ring-1 ring-inset ring-foreground/15' : ''}`}
                >
                  <LayoutDashboard
                    className="h-4 w-4 shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{option.name}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {option.project_key}
                    </span>
                  </span>
                  <span className="max-w-28 truncate text-xs text-text-muted max-md:max-w-16">
                    {group.label}
                  </span>
                  <span className="h-4 w-4 shrink-0">
                    {selected ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
                  </span>
                </button>
              )
            })}
          </div>
          {!visible.length ? (
            <div
              role="status"
              data-testid="project-space-picker-empty"
              className="flex flex-1 items-center justify-center px-3 py-8 text-center text-sm text-text-muted"
            >
              {t('workbench.project_picker_empty', '没有匹配的项目，试试其他关键词或空间')}
            </div>
          ) : null}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-1">
        {onRemoveProject ? (
          <button
            type="button"
            data-testid="clear-project-space-context-button"
            onClick={() => {
              onClose()
              onRemoveProject()
            }}
            className="flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-blue-500/70 max-md:h-11"
          >
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('workbench.clear_extra_project_space', '不加入其他项目空间')}
          </button>
        ) : null}
        <span className="ml-auto pr-2 text-xs text-text-muted max-md:hidden">
          {t('workbench.project_picker_keys', '↑↓ 选择 · Enter 确认 · Esc 关闭')}
        </span>
      </footer>
    </div>,
    document.body
  )
}
