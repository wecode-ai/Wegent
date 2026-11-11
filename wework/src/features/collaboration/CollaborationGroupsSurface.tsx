import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { ChevronDown, Hash, MessageCircle, Plus } from 'lucide-react'
import {
  CollaborationApp,
  createCollaborationTranslator,
  collaborationMessages,
  IssueCreate,
  CollaborationFilesAdapter,
  type CollaborationIssue,
  type CollaborationProject,
  type CollaborationView,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { ChatGroup, ChatGroupApi, ChatGroupMember } from '@/api/chatGroups'
import type { DeviceCommandApi } from '@/api/environment'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { CollaborationViewSwitcher } from './CollaborationViewSwitcher'
import { createGroupWorkspaceApi, groupBoardContext } from './groupWorkspaceApi'
import { GroupConversation } from './GroupConversation'
import { CreateGroupOrThread, GroupSettings } from './GroupManagementDialogs'
import { ThreadCreateDialog } from './ThreadCreateDialog'
import { ThreadArchiveDialog } from './ThreadArchiveDialog'
import type { ThreadActionContext, ThreadArchivePreparationContext } from './threadActions'

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
  renderBoardIssueCard,
  renderThreadActions,
  onThreadActionContext,
  onPrepareThreadArchive,
  changeRequestApi,
}: {
  sources: GroupSource[]
  search: string
  locale: 'zh-CN' | 'en'
  footer?: ReactNode
  onNavigate(search: string, relatedThreadId?: string): void
  onReady(): void
  onConnectCloud?: () => void
  accountScope: string
  changeRequestApi?: DeviceCommandApi
  onBackToBoard?(): void
  renderThreadActions?(context: ThreadActionContext): ReactNode
  onThreadActionContext?(context: ThreadActionContext | null): void
  onPrepareThreadArchive?(context: ThreadArchivePreparationContext): Promise<void>
  renderBoardIssueCard?(
    project: CollaborationProject,
    context: Parameters<
      NonNullable<ComponentProps<typeof CollaborationApp>['renderBoardIssueCard']>
    >[0]
  ): ReactNode
}) {
  const { t } = useTranslation('collaboration')
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const leaveGuard = useRef<((action: () => void) => void) | null>(null)
  const registerLeaveGuard = useCallback((guard: ((action: () => void) => void) | null) => {
    leaveGuard.current = guard
  }, [])
  const requestLeave = useCallback((action: () => void) => {
    if (leaveGuard.current) leaveGuard.current(action)
    else action()
  }, [])
  const requestNavigate = (nextSearch: string, relatedThreadId?: string) => {
    requestLeave(() => {
      if (relatedThreadId) onNavigate(nextSearch, relatedThreadId)
      else onNavigate(nextSearch)
    })
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
  const childScope = `${accountScope}:${owner}:${threadId ?? ''}`
  const [childDraft, setChildDraft] = useState<{
    owner: string
    parent: CollaborationIssue
    classificationProject?: CollaborationProject
  } | null>(null)
  const currentChild = childDraft?.owner === childScope ? childDraft : null
  if (childDraft && !currentChild) setChildDraft(null)
  const [archiveTarget, setArchiveTarget] = useState<{
    owner: string
    item: CollaborationIssue
  } | null>(null)
  const currentArchive = archiveTarget?.owner === childScope ? archiveTarget : null
  if (archiveTarget && !currentArchive) setArchiveTarget(null)
  const childBinding = useRef({
    scope: childScope,
    draft: childDraft,
    archive: archiveTarget,
    mounted: true,
  })
  useLayoutEffect(() => {
    childBinding.current = {
      scope: childScope,
      draft: childDraft,
      archive: archiveTarget,
      mounted: true,
    }
    return () => {
      childBinding.current.mounted = false
    }
  }, [childScope, childDraft, archiveTarget])
  const ownsChild = () =>
    childBinding.current.mounted &&
    childBinding.current.scope === childScope &&
    childBinding.current.draft === currentChild
  const ownsArchive = () =>
    childBinding.current.mounted &&
    childBinding.current.scope === childScope &&
    childBinding.current.archive === currentArchive
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
  const navigate = (patch: Record<string, string | null>, relatedThreadId?: string) => {
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
    requestNavigate(`?${next.toString()}`, relatedThreadId)
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
  const boardGroup = current?.group
  const boardContext = useMemo(
    () =>
      boardGroup ? groupBoardContext(boardGroup, store === 'local' ? 'local' : 'cloud') : null,
    [boardGroup, store]
  )
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
                  changeRequestApi={changeRequestApi}
                  members={current.members}
                  groups={source.groups}
                  chat={source.chat}
                  locale={locale}
                  onBack={returnToGroup}
                  onBackToBoard={returnToBoard}
                  onOpenThread={openThread}
                  onOpenRelatedThread={id =>
                    navigate({ threadId: id, groupTab: 'chat' }, thread.id)
                  }
                  onCreateChild={(parent, classificationProject) =>
                    setChildDraft({ owner: childScope, parent, classificationProject })
                  }
                  accountScope={accountScope}
                  renderThreadActions={renderThreadActions}
                  onThreadActionContext={onThreadActionContext}
                  requestLeave={requestLeave}
                  onArchiveThread={item =>
                    requestLeave(() => setArchiveTarget({ owner: childScope, item }))
                  }
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
                      accountScope={accountScope}
                      focusedCommentId={params.get('commentId')}
                      onClearFocus={() => navigate({ commentId: null, focusRequest: null })}
                      focusRequestKey={params.get('focusRequest')}
                      group={current.group}
                      project={boardContext}
                      item={null}
                      items={current.items}
                      api={api}
                      catalog={source.workspace}
                      changeRequestApi={changeRequestApi}
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
                      issueArchiveEnabled
                      onPrepareIssueArchive={
                        source.store === 'local' && onPrepareThreadArchive
                          ? item => onPrepareThreadArchive({ item, api, sourceStore: source.store })
                          : undefined
                      }
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
                      renderBoardIssueCard={
                        renderBoardIssueCard
                          ? context => renderBoardIssueCard(boardContext, context)
                          : undefined
                      }
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
      {currentArchive && api && current && source && (
        <ThreadArchiveDialog
          key={`${childScope}:${currentArchive.item.id}`}
          item={currentArchive.item}
          items={current.items}
          api={api}
          locale={locale}
          onPrepare={
            source.store === 'local' && onPrepareThreadArchive
              ? item => onPrepareThreadArchive({ item, api, sourceStore: source.store })
              : undefined
          }
          onClose={() => {
            if (ownsArchive()) setArchiveTarget(null)
          }}
          onArchived={() => {
            if (!ownsArchive()) return
            setArchiveTarget(null)
            refresh()
            if (onBackToBoard) onBackToBoard()
            else navigate({ threadId: null, groupTab: 'board' })
          }}
        />
      )}
      {currentChild && source && current && (
        <ThreadCreateDialog
          key={`${childScope}:${currentChild.parent.id}`}
          api={source.workspace}
          groups={source.groups}
          store={source.store}
          locale={locale}
          accountScope={accountScope}
          form={{
            api: source.workspace,
            project: currentChild.classificationProject,
            allIssues: current.items,
            defaults: {
              status: 'inbox',
              parent: currentChild.parent,
              tags: [],
              draftScope: `child:${currentChild.parent.id}`,
            },
            messages: collaborationMessages[locale],
            translate,
            onClose: () => {
              if (ownsChild()) setChildDraft(null)
            },
            onError: () => {
              if (ownsChild()) setNotice({ owner, message: t('threadCreateFailed') })
            },
            onCreated: created => {
              if (!ownsChild()) return
              setChildDraft(null)
              refresh()
              navigate({ threadId: created.id, groupTab: 'chat' }, currentChild.parent.id)
            },
          }}
        />
      )}
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
