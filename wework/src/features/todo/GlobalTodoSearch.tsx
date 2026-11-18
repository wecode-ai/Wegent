import { useLayoutEffect, useRef, useState } from 'react'
import type { IssueReferenceResult, IssueReferenceLookup } from './resolveIssueReference'
import { Cloud, Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { columns } from './todoShared'
import { projectKey, type LocatedProjectSpace } from './projectSpaceSelection'
import { emptyTaskSearchFilters, matchesIssueReference, searchTasks } from './taskSearch'

interface GlobalTodoSearchProps {
  lookupScope?: unknown
  referenceOnly?: boolean
  projects: LocatedProjectSpace[]
  projectItems: Record<string, CloudLoopItem[]>
  projectMembers: Record<string, CloudProjectMember[]>
  query: string
  onQueryChange: (query: string) => void
  onClose: () => void
  onResolveReference?: (reference: string) => Promise<IssueReferenceLookup>
  onSelectProject: (project: LocatedProjectSpace) => void
  onSelectItem: (project: LocatedProjectSpace, item: CloudLoopItem) => void
}

export function GlobalTodoSearch({
  lookupScope,
  referenceOnly = false,
  projects,
  projectItems,
  projectMembers,
  query,
  onQueryChange,
  onClose,
  onResolveReference,
  onSelectProject,
  onSelectItem,
}: GlobalTodoSearchProps) {
  const { t } = useTranslation('common')
  const [lookup, setLookup] = useState<{
    query: string
    scope: unknown
    busy: boolean
    error?: string
    matches?: IssueReferenceResult[]
  }>({ query, scope: lookupScope, busy: false })
  if (lookup.query !== query || lookup.scope !== lookupScope) {
    setLookup({ query, scope: lookupScope, busy: false })
  }
  const revision = useRef(0)
  // Invalidate during commit before native input can submit a lookup.
  useLayoutEffect(() => {
    revision.current += 1
    return () => {
      revision.current += 1
    }
  }, [query, lookupScope])
  const trimmedQuery = query.trim()
  const fullReference = /^.+-\d+$/u.test(trimmedQuery)
    ? trimmedQuery.replace(/[a-z]/g, letter => letter.toUpperCase())
    : null
  const currentLookup = lookup?.query === query && lookup.scope === lookupScope ? lookup : null
  async function openReference() {
    if (!fullReference || !onResolveReference || currentLookup?.busy) return
    const requestRevision = revision.current
    setLookup({ query, scope: lookupScope, busy: true })
    try {
      const { matches, failures } = await onResolveReference(fullReference)
      if (revision.current !== requestRevision) return
      if (
        failures.length === 0 &&
        matches.length === 1 &&
        matches[0].item.can_view_detail !== false
      ) {
        onSelectItem(matches[0].project, matches[0].item)
      }
      const error =
        failures.length > 0
          ? failures
              .map(
                failure =>
                  `${t(failure.location === 'local' ? 'workbench.global_search_source_local' : 'workbench.global_search_source_cloud')}: ${failure.message}`
              )
              .join('; ')
          : matches.length === 0
            ? t('workbench.global_search_reference_missing')
            : undefined
      setLookup({ query, scope: lookupScope, busy: false, matches, error })
    } catch (error) {
      if (revision.current !== requestRevision) return
      setLookup({
        query,
        scope: lookupScope,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const normalizedQuery = trimmedQuery.toLocaleLowerCase()
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
          projectItems[projectKey(project)] ?? [],
          normalizedQuery,
          emptyTaskSearchFilters,
          projectMembers[projectKey(project)] ?? [],
          undefined,
          project.project_key
        )
          .slice(0, 20)
          .map(result => ({ ...result, project }))
      )
    : []
  const exactResults = taskResults.filter(({ item, project }) =>
    matchesIssueReference(item, normalizedQuery, project.project_key)
  )

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
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              if (fullReference && onResolveReference) {
                event.preventDefault()
                void openReference()
                return
              }
              if (exactResults.length !== 1) return
              const { item, project } = exactResults[0]
              if (item.can_view_detail === false) return
              event.preventDefault()
              onSelectItem(project, item)
            }}
            placeholder={t(
              referenceOnly
                ? 'workbench.global_search_reference_placeholder'
                : 'workbench.global_search_placeholder'
            )}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-text-muted"
          />
          {fullReference && onResolveReference && (
            <button
              type="button"
              data-testid="cloud-global-search-open-issue"
              disabled={currentLookup?.busy}
              onClick={() => void openReference()}
              className="shrink-0 rounded-lg px-3 py-1 text-sm text-foreground hover:bg-muted disabled:opacity-50"
            >
              {t(
                currentLookup?.busy
                  ? 'workbench.global_search_opening_issue'
                  : 'workbench.global_search_open_issue'
              )}
            </button>
          )}
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
          {currentLookup?.error && (
            <p role="alert" className="px-3 py-2 text-sm text-text-muted">
              {t('workbench.global_search_lookup_failed')} {currentLookup.error}
            </p>
          )}
          {currentLookup?.matches?.map(({ project, item }) => (
            <button
              key={projectKey(project)}
              type="button"
              data-testid={`cloud-global-search-direct-${projectKey(project)}`}
              disabled={item.can_view_detail === false}
              onClick={() => onSelectItem(project, item)}
              className="flex w-full gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-60"
            >
              {t(
                project.location === 'local'
                  ? 'workbench.global_search_source_local'
                  : 'workbench.global_search_source_cloud'
              )}{' '}
              · {project.name} · {item.id} · {item.title}
            </button>
          ))}
          {!normalizedQuery || referenceOnly ? (
            <p className="px-4 py-12 text-center text-sm text-text-muted">
              {t(
                referenceOnly
                  ? 'workbench.global_search_reference_hint'
                  : 'workbench.global_search_hint'
              )}
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
                      key={projectKey(project)}
                      type="button"
                      onClick={() => onSelectProject(project)}
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
                      key={`${projectKey(project)}:${item.id}`}
                      type="button"
                      data-testid={`cloud-global-search-result-${item.id}`}
                      disabled={item.can_view_detail === false}
                      onClick={() => onSelectItem(project, item)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted/60 disabled:cursor-default disabled:opacity-60"
                    >
                      <span className="w-40 shrink-0 truncate font-mono text-xs leading-5 text-text-muted">
                        {project.project_key}-{item.sequence_number}
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
