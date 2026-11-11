import { Activity, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Hash, MessageCircle, Plus } from 'lucide-react'
import { TemplateDialog } from '@wegent/collaboration/templates'
import {
  CollaborationApp,
  createCollaborationTranslator,
  IssueCreate,
  CollaborationFilesAdapter,
  type CollaborationIssue,
  type CollaborationView,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { ChatGroup, ChatGroupApi, ChatGroupMember } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { CollaborationViewSwitcher } from './CollaborationViewSwitcher'
import { createGroupWorkspaceApi, groupBoardContext } from './groupWorkspaceApi'
import { GroupConversation } from './GroupConversation'
import { GroupMembersSettings } from './GroupMembersSettings'

export interface GroupSource {
  store: 'local' | 'cloud'
  groups: ChatGroupApi
  workspace: SharedWorkspaceApi
  chat?: ProjectChatClient
}
type Entry = { source: GroupSource; group: ChatGroup; scope: string }
type NavEntry = {
  scope: string
  store: GroupSource['store']
  id: string
  group_id: string
  title: string
  status: string
}
const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus'

export function CollaborationGroupsSurface({
  sources,
  search,
  locale,
  footer,
  onNavigate,
  onReady,
  onConnectCloud,
  accountScope,
  onBackToBoard,
}: {
  sources: GroupSource[]
  search: string
  locale: 'zh-CN' | 'en'
  footer?: ReactNode
  onNavigate(search: string): void
  onReady(): void
  onConnectCloud?: () => void
  accountScope: string
  onBackToBoard?(): void
}) {
  const { t } = useTranslation('collaboration')
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const leaveGuard = useRef<((action: () => void) => void) | null>(null)
  const registerLeaveGuard = useCallback((guard: ((action: () => void) => void) | null) => {
    leaveGuard.current = guard
  }, [])
  const requestNavigate = (nextSearch: string) => {
    const action = () => onNavigate(nextSearch)
    if (leaveGuard.current) leaveGuard.current(action)
    else action()
  }
  const params = useMemo(() => new URLSearchParams(search), [search])
  const store = params.get('groupStore') ?? 'local'
  const groupId = params.get('groupId')
  const threadId = params.get('threadId')
  const tab = params.get('groupTab') ?? 'chat'
  const [cachedEntries, setEntries] = useState<Entry[]>([])
  const [cachedNavigation, setNavigation] = useState<NavEntry[]>([])
  const [catalogScope, setCatalogScope] = useState(accountScope)
  const [catalogPending, setCatalogLoading] = useState(true)
  const [catalogFailure, setCatalogError] = useState<string | null>(null)
  const catalogLoading = catalogScope !== accountScope || catalogPending
  const catalogError = catalogScope === accountScope ? catalogFailure : null
  const entries = useMemo(
    () =>
      cachedEntries.filter(
        entry => entry.scope === (entry.source.store === 'local' ? 'local' : accountScope)
      ),
    [cachedEntries, accountScope]
  )
  const navigation = useMemo(
    () =>
      cachedNavigation.filter(
        entry => entry.scope === (entry.store === 'local' ? 'local' : accountScope)
      ),
    [cachedNavigation, accountScope]
  )
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const [creating, setCreating] = useState<'group' | 'thread' | null>(null)
  const [filter, setFilter] = useState('unfinished')
  const [noticeState, setNotice] = useState<{ owner: string; message: string } | null>(null)
  const source = sources.find(source => source.store === store)
  const api = useMemo(
    () =>
      source && groupId
        ? createGroupWorkspaceApi(source.workspace, source.groups, groupId, source.store, refresh)
        : null,
    [source, groupId, refresh]
  )
  const owner = `${store === 'local' ? 'local' : accountScope}:${store}:${groupId ?? ''}`
  const notice = noticeState?.owner === owner ? noticeState.message : null
  const [snapshot, setSnapshot] = useState<{
    owner: string
    group: ChatGroup
    members: ChatGroupMember[]
    items: CollaborationIssue[]
  } | null>(null)
  const [loadFailure, setLoadFailure] = useState<{
    owner: string
    revision: number
    message: string
  } | null>(null)
  const loadError =
    loadFailure?.owner === owner && loadFailure.revision === revision ? loadFailure.message : null
  const current = snapshot?.owner === owner ? snapshot : null
  useEffect(() => {
    const interval = window.setInterval(refresh, 10_000)
    const releases: Array<() => void> = []
    let active = true
    for (const source of sources) {
      const subscribe = source.chat?.subscribeLoopItemChanges
      if (subscribe)
        void subscribe(refresh)
          .then(release => {
            if (active) releases.push(release)
            else release()
          })
          .catch(cause => console.warn('[Collaboration groups] Change subscription failed', cause))
    }
    return () => {
      active = false
      window.clearInterval(interval)
      releases.forEach(release => release())
    }
  }, [sources, refresh])
  const navigate = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search)
    if ('threadId' in patch || 'groupId' in patch || 'groupTab' in patch) {
      next.delete('commentId')
      next.delete('focusRequest')
    }
    next.set('collaborationView', 'groups')
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    requestNavigate(`?${next.toString()}`)
  }
  useEffect(() => {
    let active = true
    void Promise.all(
      sources.map(async source => {
        const [groups, nav] = await Promise.allSettled([
          source.groups.list(),
          source.groups.navigation(),
        ])
        return { source, groups, nav }
      })
    ).then(results => {
      if (!active) return
      setEntries(previous =>
        results.flatMap(result =>
          result.groups.status === 'fulfilled'
            ? result.groups.value.items.map(group => ({
                source: result.source,
                group,
                scope: result.source.store === 'local' ? 'local' : accountScope,
              }))
            : previous.filter(
                entry =>
                  entry.source.store === result.source.store &&
                  entry.scope === (result.source.store === 'local' ? 'local' : accountScope)
              )
        )
      )
      setNavigation(previous =>
        results.flatMap(result =>
          result.nav.status === 'fulfilled'
            ? result.nav.value.items.map(entry => ({
                ...entry,
                store: result.source.store,
                scope: result.source.store === 'local' ? 'local' : accountScope,
              }))
            : previous.filter(
                entry =>
                  entry.store === result.source.store &&
                  entry.scope === (result.source.store === 'local' ? 'local' : accountScope)
              )
        )
      )
      setCatalogError(
        results
          .flatMap(result => [result.groups, result.nav])
          .filter(result => result.status === 'rejected')
          .map(result => String(result.reason))
          .join('\n') || null
      )
      setCatalogLoading(false)
      setCatalogScope(accountScope)
      onReady()
    })
    return () => {
      active = false
    }
  }, [sources, revision, onReady, accountScope])
  useEffect(() => {
    if (!api || !source || !groupId) return
    let active = true
    void Promise.all([source.groups.get(groupId), api.issues.list(groupId)])
      .then(([info, items]) => {
        if (active) setSnapshot({ owner, ...info, items })
      })
      .catch(cause => {
        if (active)
          setLoadFailure({
            owner,
            revision,
            message: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [api, source, groupId, owner, revision])
  const thread = threadId ? current?.items.find(item => item.id === threadId) : null
  const boardContext = current
    ? groupBoardContext(current.group, store === 'local' ? 'local' : 'cloud')
    : null
  const openThread = (id: string) =>
    navigate({ threadId: id, groupTab: tab === 'board' ? 'board' : 'chat' })
  const returnToGroup = () => navigate({ threadId: null, groupTab: 'chat' })
  const returnToBoard =
    onBackToBoard ??
    (tab === 'board' ? () => navigate({ threadId: null, groupTab: 'board' }) : undefined)
  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-1"
      data-testid="collaboration-groups"
    >
      <aside
        className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar"
        data-testid="collaboration-group-sidebar"
      >
        <CollaborationViewSwitcher
          value="groups"
          onChange={view => view === 'projects' && requestNavigate('?collaborationView=projects')}
        />
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-medium text-text-muted">{t('groupList')}</span>
          <button
            type="button"
            data-testid="group-create-open"
            aria-label={t('newGroup')}
            onClick={() => setCreating('group')}
            className="rounded p-1 text-text-muted hover:bg-hover"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2" aria-label={t('groups')}>
          {catalogLoading && (
            <p className="px-2 text-xs text-text-muted" role="status">
              {t('loading')}
            </p>
          )}
          <ul className="space-y-1">
            {entries.map(entry => {
              const selected = entry.group.id === groupId && entry.source.store === store
              const threads = navigation.filter(
                thread => thread.group_id === entry.group.id && thread.store === entry.source.store
              )
              return (
                <li key={`${entry.source.store}:${entry.group.id}`}>
                  <button
                    type="button"
                    data-testid={`group-nav-${entry.group.id}`}
                    className={`flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text-primary hover:bg-hover ${selected && !threadId ? 'bg-hover' : ''}`}
                    onClick={() =>
                      navigate({
                        groupId: entry.group.id,
                        groupStore: entry.source.store,
                        threadId: null,
                        groupTab: 'chat',
                      })
                    }
                  >
                    <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
                    <Hash className="h-4 w-4 shrink-0 text-text-muted" />
                    <span className="truncate">{entry.group.name}</span>
                  </button>
                  <ul>
                    {threads.map(thread => (
                      <li key={thread.id}>
                        <button
                          type="button"
                          data-testid={`thread-nav-${thread.id}`}
                          className={`ml-5 flex h-[30px] w-[calc(100%-1.25rem)] items-center gap-2 rounded-md px-2 text-left text-sm text-text-muted hover:bg-hover ${selected && thread.id === threadId ? 'bg-hover text-text-primary' : ''}`}
                          onClick={() =>
                            navigate({
                              groupId: entry.group.id,
                              groupStore: entry.source.store,
                              threadId: thread.id,
                              groupTab: 'chat',
                            })
                          }
                        >
                          <MessageCircle className="h-4 w-4 shrink-0" />
                          <span className="truncate">{thread.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        </nav>
        {onConnectCloud && (
          <button
            type="button"
            data-testid="group-connect-cloud"
            className="mx-3 mb-3 rounded-md border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover"
            onClick={onConnectCloud}
          >
            {t('connectCloud')}
          </button>
        )}
        {footer}
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {(catalogError || notice) && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 border-b border-border px-6 py-2 text-sm text-destructive"
          >
            <span>{notice || catalogError}</span>
            <button
              type="button"
              data-testid="group-retry"
              onClick={() => {
                setNotice(null)
                refresh()
              }}
            >
              {t('retry')}
            </button>
          </div>
        )}
        {!groupId && catalogLoading ? (
          <p role="status" className="p-6 text-sm text-text-muted">
            {t('loading')}
          </p>
        ) : !groupId && catalogError && entries.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">{t('loadFailed')}</p>
        ) : !groupId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <MessageCircle className="mb-2 h-8 w-8 text-text-muted" />
            <h1 className="text-heading-lg text-text-primary">
              {t(entries.length ? 'selectGroup' : 'emptyTitle')}
            </h1>
            <p className="max-w-md text-sm text-text-muted">{t('emptyHint')}</p>
            <Button
              data-testid="group-empty-create"
              disabled={sources.length === 0}
              onClick={() => setCreating('group')}
            >
              {t('newGroup')}
            </Button>
          </div>
        ) : loadError ? (
          <div role="alert" className="p-6 text-sm text-destructive">
            {loadError}
            <Button data-testid="group-load-retry" onClick={refresh}>
              {t('retry')}
            </Button>
          </div>
        ) : !current || !api || !source || !boardContext ? (
          <p role="status" className="p-6 text-sm text-text-muted">
            {t('loading')}
          </p>
        ) : (
          <>
            {threadId &&
              (thread ? (
                <GroupConversation
                  registerLeaveGuard={registerLeaveGuard}
                  focusedCommentId={params.get('commentId')}
                  onClearFocus={() => navigate({ commentId: null, focusRequest: null })}
                  focusRequestKey={params.get('focusRequest')}
                  key={`${owner}:${thread.id}`}
                  group={current.group}
                  project={boardContext}
                  item={thread}
                  items={current.items}
                  api={api}
                  catalog={source.workspace}
                  members={current.members}
                  groups={source.groups}
                  chat={source.chat}
                  locale={locale}
                  onBack={returnToGroup}
                  onBackToBoard={returnToBoard}
                  onOpenThread={openThread}
                  onChanged={refresh}
                />
              ) : (
                <div role="alert" className="p-6 text-sm text-text-muted">
                  {t('emptyThreads')}
                  <Button data-testid="thread-missing-back" onClick={returnToGroup}>
                    {current.group.name}
                  </Button>
                </div>
              ))}
            <Activity mode={threadId ? 'hidden' : 'visible'}>
              <div className="flex h-full min-h-0 flex-col">
                <header className="shrink-0 border-b border-border px-6 pt-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h1 className="text-heading-lg truncate text-text-primary">
                        {current.group.name}
                      </h1>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('members', { count: current.members.length })}
                        {current.group.description ? ` · ${current.group.description}` : ''}
                      </p>
                    </div>
                    {tab !== 'board' &&
                      current.group.status === 'active' &&
                      current.group.role !== 'Viewer' && (
                        <Button
                          data-testid="group-start-thread"
                          onClick={() => setCreating('thread')}
                        >
                          <Plus className="h-4 w-4" />
                          {t('newThread')}
                        </Button>
                      )}
                  </div>
                  <nav className="mt-4 flex gap-5" aria-label={current.group.name}>
                    {(['chat', 'threads', 'board', 'files', 'settings'] as const).map(value => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`group-tab-${value}`}
                        aria-current={tab === value ? 'page' : undefined}
                        className={`border-b-2 pb-3 text-sm ${tab === value ? 'border-text-primary text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}
                        onClick={() => navigate({ groupTab: value, threadId: null })}
                      >
                        {t(value)}
                      </button>
                    ))}
                  </nav>
                </header>
                <div className="relative min-h-0 flex-1">
                  {tab === 'chat' && (
                    <GroupConversation
                      key={owner}
                      focusedCommentId={params.get('commentId')}
                      onClearFocus={() => navigate({ commentId: null, focusRequest: null })}
                      focusRequestKey={params.get('focusRequest')}
                      group={current.group}
                      project={boardContext}
                      item={null}
                      items={current.items}
                      api={api}
                      catalog={source.workspace}
                      members={current.members}
                      groups={source.groups}
                      chat={source.chat}
                      locale={locale}
                      onBack={returnToGroup}
                      onOpenThread={openThread}
                      onChanged={refresh}
                    />
                  )}
                  {tab === 'threads' && (
                    <div className="h-full overflow-y-auto px-6 py-5">
                      <div className="mb-4 flex gap-1">
                        {['unfinished', 'all', 'completed'].map(value => (
                          <button
                            key={value}
                            type="button"
                            data-testid={`thread-filter-${value}`}
                            aria-pressed={filter === value}
                            className={`rounded-md px-3 py-1 text-sm hover:bg-hover ${filter === value ? 'bg-hover text-text-primary' : 'text-text-muted'}`}
                            onClick={() => setFilter(value)}
                          >
                            {t(value)}
                          </button>
                        ))}
                      </div>
                      <ul>
                        {current.items
                          .filter(
                            item =>
                              filter === 'all' ||
                              (filter === 'completed') === (item.status === 'completed')
                          )
                          .map(item => (
                            <li key={item.id}>
                              <button
                                type="button"
                                data-testid={`thread-list-${item.id}`}
                                onClick={() => openThread(item.id)}
                                className="flex w-full items-center gap-3 border-b border-border py-4 text-left hover:bg-hover"
                              >
                                <MessageCircle className="h-4 w-4 text-text-muted" />
                                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                                  {item.title}
                                </span>
                                <span className="text-xs text-text-muted">
                                  {translate(`todo.status_${item.status}`, item.status)}
                                </span>
                              </button>
                            </li>
                          ))}
                      </ul>
                      {current.items.length === 0 && (
                        <p className="py-16 text-center text-sm text-text-muted">
                          {t('emptyThreads')}
                        </p>
                      )}
                    </div>
                  )}
                  {tab === 'files' && (
                    <div className="h-full overflow-y-auto">
                      <CollaborationFilesAdapter api={api} project={boardContext} locale={locale} />
                    </div>
                  )}
                  {tab === 'board' && (
                    <CollaborationApp
                      key={owner}
                      api={api}
                      initialProject={boardContext}
                      locale={locale}
                      showProjectBack={false}
                      showProjectHeading={false}
                      enabledStandardViews={['board', 'table']}
                      parentGroupingEnabled
                      refreshProjectRequestKey={revision}
                      host={{
                        capabilities: {
                          automation: false,
                          dingtalkAitable: false,
                          projectLocation: source.store,
                        },
                        location: {
                          projectId: groupId,
                          issueId: null,
                          view: (params.get('boardView') ?? 'board') as CollaborationView,
                        },
                        navigate: next =>
                          next.issueId
                            ? openThread(next.issueId)
                            : next.view === 'manage'
                              ? navigate({ groupTab: 'settings' })
                              : navigate({
                                  groupTab: next.view === 'files' ? 'files' : 'board',
                                  boardView: next.view,
                                }),
                        notify: message => setNotice({ owner, message }),
                      }}
                      renderIssueDetail={() => null}
                      renderIssueCreate={form => (
                        <IssueCreate
                          {...form}
                          defaults={{
                            tags: [],
                            parent: null,
                            status: boardContext.board_config?.statuses?.[0]?.id ?? 'inbox',
                            ...form.defaults,
                            draftScope: `group-board:${source.store === 'local' ? 'local' : accountScope}:${source.store}:${groupId}:${form.defaults?.draftScope ?? ''}`,
                          }}
                        />
                      )}
                    />
                  )}
                  {tab === 'settings' && (
                    <GroupSettings
                      key={`${owner}:${current.group.version}`}
                      group={current.group}
                      members={current.members}
                      groups={source.groups}
                      directory={source.workspace.members}
                      shared={source.store === 'cloud'}
                      onChanged={refresh}
                    />
                  )}
                </div>
              </div>
            </Activity>
          </>
        )}
      </main>
      {creating && (
        <CreateGroupOrThread
          kind={creating}
          sources={sources}
          source={source}
          api={api}
          group={current?.group}
          onClose={() => setCreating(null)}
          onCreated={(createdSource, id) => {
            setCreating(null)
            refresh()
            if (creating === 'group')
              navigate({ groupStore: createdSource, groupId: id, threadId: null, groupTab: 'chat' })
            else openThread(id)
          }}
        />
      )}
    </section>
  )
}

function CreateGroupOrThread({
  kind,
  sources,
  source,
  api,
  group,
  onClose,
  onCreated,
}: {
  kind: 'group' | 'thread'
  sources: GroupSource[]
  source?: GroupSource
  api: SharedWorkspaceApi | null
  group?: ChatGroup
  onClose(): void
  onCreated(source: GroupSource['store'], id: string): void
}) {
  const { t } = useTranslation('collaboration')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [store, setStore] = useState(
    source?.store ?? (sources.some(source => source.store === 'cloud') ? 'cloud' : 'local')
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <TemplateDialog
      title={t(kind === 'group' ? 'newGroup' : 'newThread')}
      description={t(kind === 'group' ? 'emptyHint' : 'threadDescription')}
      closeLabel={t('close')}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="space-y-4"
        data-testid={`create-${kind}-dialog`}
        onSubmit={async event => {
          event.preventDefault()
          if (busy || !name.trim()) return
          setBusy(true)
          setError(null)
          try {
            if (kind === 'group') {
              const target = sources.find(source => source.store === store)
              if (!target) throw new Error(t('readOnly'))
              const result = await target.groups.create({ name: name.trim(), description })
              onCreated(store, result.group.id)
            } else {
              if (!api || !group || !source) throw new Error(t('readOnly'))
              const thread = await api.issues.create(group.id, {
                title: name.trim(),
                description,
              })
              onCreated(source.store, thread.id)
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t(kind === 'group' ? 'groupName' : 'threadTitle')}</span>
          <input
            autoFocus
            required
            maxLength={255}
            data-testid={`create-${kind}-name`}
            className={fieldClass}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t(kind === 'group' ? 'groupDescription' : 'threadDescription')}</span>
          <textarea
            data-testid={`create-${kind}-description`}
            className={fieldClass}
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {kind === 'group' && (
          <>
            <label className="block space-y-2 text-sm text-text-primary">
              <span>{t('storage')}</span>
              <select
                data-testid="create-group-store"
                className={fieldClass}
                value={store}
                onChange={event => setStore(event.target.value as GroupSource['store'])}
              >
                {sources.map(source => (
                  <option key={source.store} value={source.store}>
                    {t(source.store)}
                  </option>
                ))}
              </select>
            </label>
            {store === 'local' && <p className="text-xs text-text-muted">{t('localHint')}</p>}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="create-group-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            data-testid={`create-${kind}-submit`}
            disabled={busy || !name.trim()}
          >
            {t('create')}
          </Button>
        </div>
      </form>
    </TemplateDialog>
  )
}

function GroupSettings({
  group,
  members,
  groups,
  directory,
  shared,
  onChanged,
}: {
  group: ChatGroup
  members: ChatGroupMember[]
  groups: ChatGroupApi
  directory: SharedWorkspaceApi['members']
  shared: boolean
  onChanged(): void
}) {
  const { t } = useTranslation('collaboration')
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const manage = group.role === 'Owner' || group.role === 'Maintainer'
  return (
    <div className="h-full overflow-y-auto p-6">
      <form
        className="max-w-xl space-y-5"
        onSubmit={async event => {
          event.preventDefault()
          if (!manage || busy) return
          setBusy(true)
          setError(null)
          try {
            await groups.update(group.id, {
              name,
              description,
              version: group.version,
              status: group.status,
            })
            onChanged()
          } catch (cause) {
            setError(String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t('groupName')}</span>
          <input
            data-testid="group-settings-name"
            className={fieldClass}
            required
            disabled={!manage}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t('groupDescription')}</span>
          <textarea
            data-testid="group-settings-description"
            className={fieldClass}
            disabled={!manage}
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {manage && (
          <Button
            data-testid="group-settings-save"
            type="submit"
            disabled={
              busy || !name.trim() || (name === group.name && description === group.description)
            }
          >
            {t('save')}
          </Button>
        )}
      </form>
      <div className="mt-8 max-w-xl border-t border-border pt-6">
        <GroupMembersSettings
          group={group}
          members={members}
          groups={groups}
          directory={directory}
          shared={shared}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}
