import { Cloud, Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { columns } from './todoShared'
import { emptyTaskSearchFilters, searchTasks } from './taskSearch'

interface SearchProject {
  id: string
  name: string
  project_key: string
  description: string
}

interface GlobalTodoSearchProps {
  projects: SearchProject[]
  projectItems: Record<string, CloudLoopItem[]>
  projectMembers: Record<string, CloudProjectMember[]>
  query: string
  onQueryChange: (query: string) => void
  onClose: () => void
  onSelectProject: (projectId: string) => void
  onSelectItem: (projectId: string, item: CloudLoopItem) => void
}

export function GlobalTodoSearch({
  projects,
  projectItems,
  projectMembers,
  query,
  onQueryChange,
  onClose,
  onSelectProject,
  onSelectItem,
}: GlobalTodoSearchProps) {
  const { t } = useTranslation('common')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingProjects = normalizedQuery
    ? projects.filter(project =>
        `${project.name} ${project.project_key} ${project.description}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      )
    : []
  const taskResults = normalizedQuery
    ? projects.flatMap(project =>
        searchTasks(
          projectItems[project.id] ?? [],
          normalizedQuery,
          emptyTaskSearchFilters,
          projectMembers[project.id] ?? []
        )
          .slice(0, 20)
          .map(result => ({ ...result, project }))
      )
    : []

  return (
    <div
      data-testid="cloud-global-search"
      className="fixed inset-0 z-modal flex items-start justify-center bg-black/35 px-6 pt-[12vh] backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section className="w-[680px] max-w-full overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="flex h-14 items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            autoFocus
            data-testid="cloud-global-search-input"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('workbench.global_search_placeholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('workbench.global_search_close')}
            data-testid="cloud-global-search-close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[560px] overflow-y-auto p-2">
          {!normalizedQuery ? (
            <p className="px-4 py-12 text-center text-sm text-text-muted">
              {t('workbench.global_search_hint')}
            </p>
          ) : matchingProjects.length === 0 && taskResults.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-text-muted">
              {t('workbench.global_search_no_results')}
            </p>
          ) : (
            <>
              {matchingProjects.length > 0 && (
                <section>
                  <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-text-muted">
                    {t('workbench.global_search_projects')}
                  </h3>
                  {matchingProjects.map(project => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => onSelectProject(project.id)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted/60"
                    >
                      <Cloud className="h-4 w-4 shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {project.project_key}
                      </span>
                    </button>
                  ))}
                </section>
              )}
              {taskResults.length > 0 && (
                <section className="mt-2">
                  <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-text-muted">
                    {t('workbench.global_search_tasks')}
                  </h3>
                  {taskResults.slice(0, 50).map(({ item, parentPath, project }) => (
                    <button
                      key={`${project.id}:${item.id}`}
                      type="button"
                      data-testid={`cloud-global-search-result-${item.id}`}
                      disabled={item.can_view_detail === false}
                      onClick={() => onSelectItem(project.id, item)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted/60 disabled:cursor-default disabled:opacity-60"
                    >
                      <span className="w-40 shrink-0 truncate font-mono text-xs leading-5 text-text-muted">
                        {item.id}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm leading-5">{item.title}</span>
                        <span className="block truncate text-xs leading-4 text-text-muted">
                          {project.name}
                          {item.can_view_detail === false
                            ? ' · 仅创建人可查看详情'
                            : parentPath.length > 0
                              ? ` · ${parentPath.join(' / ')}`
                              : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {columns.find(column => column.status === item.status)?.label}
                      </span>
                    </button>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
        <footer className="flex h-9 items-center gap-2 border-t border-border px-4 text-xs text-text-muted">
          <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-xs leading-none text-text-secondary">
            esc
          </kbd>
          <span>{t('workbench.global_search_esc_to_close')}</span>
        </footer>
      </section>
    </div>
  )
}
