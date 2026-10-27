import { Bot, Check, Info, Plus, Search, SearchX } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { CollaborationTranslate } from '../i18n'
import { Button } from '../markdown/Button'
import type { CollaborationOwnedAgent } from '../types'

export function ProjectAgentPicker({
  agents,
  addedTeamIds,
  selectedId,
  loading,
  loadError,
  error,
  busy,
  scope,
  translate: t,
  onSelect,
  onRetry,
  onCreate,
  onClose,
  onAdd,
}: {
  agents: CollaborationOwnedAgent[]
  addedTeamIds: Set<number>
  selectedId: string
  loading: boolean
  loadError: string | null
  error: string | null
  busy: boolean
  scope: 'project' | 'workspace'
  translate: CollaborationTranslate
  onSelect(id: string): void
  onRetry(): void
  onCreate?: () => void
  onClose(): void
  onAdd(): void
}) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleAgents = useMemo(
    () =>
      agents.filter((agent) =>
        `${agent.name} ${agent.owner_name}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      ),
    [agents, normalizedQuery],
  )
  const selected = agents.find(
    (agent) => String(agent.team_id ?? agent.id) === selectedId,
  )
  const alreadyAdded = (agent: CollaborationOwnedAgent) =>
    agent.team_id != null && addedTeamIds.has(agent.team_id)
  const canAdd = Boolean(
    selected && !alreadyAdded(selected) && !loading && !loadError && !busy,
  )

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-5 pb-4 pt-1">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 text-text-muted keyboard:focus-within:ring-2 keyboard:focus-within:ring-focus/20 md:h-9">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <input
            ref={searchRef}
            type="search"
            data-testid="project-agent-search"
            aria-label={t('todo.agent_picker_search', '搜索智能体')}
            placeholder={t('todo.agent_picker_search', '搜索智能体')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>
        {onCreate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="project-agent-mode-create"
            onClick={onCreate}
            disabled={busy}
            className="h-11 shrink-0 gap-1.5 rounded-lg text-text-secondary disabled:opacity-40 md:h-9"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t('todo.create_agent', '新建智能体')}
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-between px-5 pb-2 text-xs text-text-muted">
        <span>
          {loading
            ? t('todo.agent_picker_loading', '正在加载智能体…')
            : t('todo.agent_picker_list', '选择一个智能体')}
        </span>
        {!loading && !loadError ? <span>{visibleAgents.length}</span> : null}
      </div>
      <div
        className="h-72 min-h-0 shrink overflow-y-auto overscroll-contain px-3 pb-3"
        data-testid="project-agent-picker-content"
        aria-busy={loading}
      >
        {loading ? (
          <div role="status" data-testid="project-agent-candidates-loading">
            <span className="sr-only">
              {t('todo.agent_picker_loading', '正在加载智能体…')}
            </span>
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                aria-hidden="true"
                className="flex h-16 items-center gap-3 rounded-lg px-3 motion-safe:animate-pulse"
              >
                <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 rounded bg-muted" />
                  <div className="h-2.5 w-1/2 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div
            role="alert"
            data-testid="project-agent-candidates-error"
            className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center"
          >
            <Bot aria-hidden="true" className="mb-1 h-6 w-6 text-text-muted" />
            <p className="text-sm font-medium text-text-primary">
              {t('todo.agent_picker_load_failed', '无法加载智能体')}
            </p>
            <p className="max-w-full break-words text-xs text-text-muted">
              {loadError}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="project-agent-candidates-retry"
              onClick={() => {
                searchRef.current?.focus()
                onRetry()
              }}
              className="mt-2 min-h-11 rounded-lg md:min-h-8"
            >
              {t('common.retry', '重试')}
            </Button>
          </div>
        ) : visibleAgents.length ? (
          <div
            role="radiogroup"
            aria-label={t('todo.agent_picker_list', '选择一个智能体')}
            data-testid="project-agent-wegent-team"
            className="space-y-1"
          >
            {visibleAgents.map((agent) => {
              const id = String(agent.team_id ?? agent.id)
              const added = alreadyAdded(agent)
              const checked = id === selectedId
              return (
                <label
                  key={id}
                  className={`flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 ${added || busy ? 'cursor-default' : 'cursor-pointer hover:bg-muted/60'} ${checked ? 'bg-muted' : ''} keyboard:focus-within:ring-2 keyboard:focus-within:ring-inset keyboard:focus-within:ring-focus/20`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium text-text-secondary"
                  >
                    {agent.name.trim().slice(0, 1).toUpperCase() || (
                      <Bot className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-base font-medium text-text-primary"
                      title={agent.name}
                    >
                      {agent.name}
                    </span>
                    <span
                      title={agent.owner_name}
                      className="mt-0.5 block truncate text-xs text-text-muted"
                    >
                      {agent.owner_type === 'workspace'
                        ? t('todo.agent_picker_shared', '空间共享')
                        : t('todo.agent_picker_personal', '我的智能体')}
                      {agent.owner_name ? ` · ${agent.owner_name}` : ''}
                    </span>
                  </span>
                  {added ? (
                    <span className="text-xs text-text-muted">
                      {t('todo.agent_picker_added', '已添加')}
                    </span>
                  ) : (
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-text-primary bg-text-primary text-background' : 'border-border'}`}
                    >
                      {checked ? (
                        <Check aria-hidden="true" className="h-3 w-3" />
                      ) : null}
                    </span>
                  )}
                  <input
                    type="radio"
                    name="project-agent-candidate"
                    className="sr-only"
                    data-testid={`project-agent-option-${id}`}
                    aria-label={agent.name}
                    value={id}
                    checked={checked}
                    disabled={added || busy}
                    onChange={() => onSelect(id)}
                  />
                </label>
              )
            })}
          </div>
        ) : (
          <div
            data-testid="project-agent-wegent-empty"
            className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center"
          >
            {normalizedQuery ? (
              <SearchX
                aria-hidden="true"
                className="mb-1 h-6 w-6 text-text-muted"
              />
            ) : (
              <Bot
                aria-hidden="true"
                className="mb-1 h-6 w-6 text-text-muted"
              />
            )}
            <p className="text-sm font-medium text-text-primary">
              {normalizedQuery
                ? t('todo.agent_picker_no_match', '没有匹配的智能体')
                : t('todo.agent_picker_empty', '还没有可添加的智能体')}
            </p>
            <p className="text-xs text-text-muted">
              {normalizedQuery
                ? t(
                    'todo.agent_picker_try_search',
                    '试试其他名称，或清除搜索。',
                  )
                : onCreate
                  ? t(
                      'todo.agent_picker_create_hint',
                      '新建一个智能体，让它协助处理任务。',
                    )
                  : t(
                      'todo.agent_picker_share_hint',
                      '请让空间管理员共享智能体后再添加。',
                    )}
            </p>
            {normalizedQuery ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="project-agent-search-clear"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="mt-2 min-h-11 rounded-lg md:min-h-8"
              >
                {t('todo.agent_picker_clear_search', '清除搜索')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {error ? (
        <p
          role="alert"
          className="px-5 pb-3 text-xs text-destructive"
          data-testid="project-agent-dialog-error"
        >
          {error}
        </p>
      ) : null}
      <footer className="shrink-0 border-t border-border px-5 pb-4 pt-3">
        <p className="mb-4 flex items-start gap-2 text-xs leading-5 text-text-muted">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {scope === 'workspace'
              ? t(
                  'todo.agent_picker_workspace_share',
                  '添加后空间内项目可复用此智能体。原定义和私人凭据仍按原权限管理。',
                )
              : t(
                  'todo.add_project_agent_description',
                  '添加后会共享到父空间并向项目成员开放使用。原定义和私人凭据仍按原权限管理。',
                )}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p
            aria-live="polite"
            title={selected?.name}
            className="w-full min-w-0 truncate text-xs text-text-secondary sm:w-auto sm:flex-1"
            data-testid="project-agent-selection-summary"
          >
            {selected
              ? t('todo.agent_picker_selected', '已选择：{{name}}', {
                  name: selected.name,
                })
              : t('todo.agent_picker_select_hint', '选择智能体后即可添加')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="project-agent-dialog-cancel"
            disabled={busy}
            onClick={onClose}
            className="h-11 shrink-0 rounded-lg text-text-secondary disabled:opacity-40 md:h-9"
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="project-agent-wegent-create"
            disabled={!canAdd}
            onClick={onAdd}
            className="h-11 shrink-0 rounded-lg px-4 hover:opacity-90 disabled:opacity-40 md:h-9"
            style={{
              color:
                'var(--collaboration-primary-foreground, rgb(var(--color-bg-base)))',
              backgroundColor:
                'var(--collaboration-primary-background, rgb(var(--color-text-primary)))',
            }}
          >
            {busy
              ? t('todo.agent_picker_adding', '添加中…')
              : scope === 'workspace'
                ? t('todo.add_to_workspace', '加入空间')
                : t('todo.add_to_project', '加入项目')}
          </Button>
        </div>
      </footer>
    </div>
  )
}
