import { createHttpClient } from '@/api/http'
import type {
  WeworkInbox,
  WeworkNotification,
  WeworkNotificationCategory,
  WeworkNotificationChannel,
  WeworkNotificationPayload,
  WeworkNotificationPreferenceCategory,
  WeworkNotificationPreferences,
} from '@/api/notifications'
import { createNotificationsApi } from '@/api/notifications'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { Tooltip } from '@/components/ui/tooltip'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { AnchorPopover } from '@/features/todo/AnchorPopover'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Settings2,
  UsersRound,
} from 'lucide-react'
import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { requestIssueDispatch } from './issueDispatch'
import { createNotificationCenterFeed } from './notificationCenterFeed'
import { createNotificationCenterSummary, taskTimestamp } from './notificationCenterSummary'
import type { NotificationFeedRowProps } from './NotificationFeedRow'
import { NotificationFeedRow } from './NotificationFeedRow'
import {
  mergeNotificationPreferences,
  notificationPreferenceAccountKey,
  OPEN_NOTIFICATION_SETTINGS_EVENT,
} from './notificationPreferences'
import type { IssueDispatchPersonalTaskAction } from './NotificationTaskSourceContext'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import { formatNotificationTime } from './notificationTime'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import { openWeworkScheme } from './schemeEvents'
import { StandInNotificationProcessing } from './StandInNotificationProcessing'
import { standInStartFailureCopy, type StandInNotification } from './standInNotifications'
import { useStandInNotifications } from './useStandInNotifications'

type InboxCategory = 'tasks' | WeworkNotificationCategory

/**
 * The preview line a category entry shows for its latest cloud notification.
 *
 * Every kind's copy is built by the backend, so this only picks the line that
 * reads better in a compact row: the body when there is one — a comment, a run
 * result — and the title otherwise, which is all a board state change has.
 */
function notificationPreview(notification: WeworkNotification): string {
  return notification.body || notification.title
}

/**
 * The personal task an assignment notification asks its reader to open.
 *
 * The notification names the Issue and the assignment, so the reader arrives
 * wherever they clicked it from; anything less cannot be turned into a task.
 */
function issueDispatchRequest(
  payload: WeworkNotificationPayload
): IssueDispatchPersonalTaskAction | null {
  const {
    projectId,
    itemId,
    issueId,
    dispatchTaskId,
    idempotencyKey,
    humanAssignmentId,
    dispatchId,
    roundId,
    assignmentId,
    taskTitle,
    instructions,
    workflowStageId,
  } = payload
  if (
    !projectId ||
    !itemId ||
    !issueId ||
    !dispatchTaskId ||
    !idempotencyKey ||
    !humanAssignmentId ||
    !dispatchId ||
    !roundId ||
    !assignmentId ||
    !taskTitle ||
    !instructions
  ) {
    return null
  }
  return {
    projectId,
    itemId,
    issueId,
    dispatchTaskId,
    idempotencyKey,
    humanAssignmentId,
    dispatchId,
    roundId,
    assignmentId,
    taskTitle,
    instructions,
    workflowStageId,
  }
}

function NotificationSettings({
  preferences,
  isDisabled,
  connected,
  onChange,
  t,
}: {
  preferences: WeworkNotificationPreferences
  isDisabled: (
    category: WeworkNotificationPreferenceCategory,
    channel: WeworkNotificationChannel
  ) => boolean
  connected: boolean
  onChange: (
    category: WeworkNotificationPreferenceCategory,
    channel: WeworkNotificationChannel,
    enabled: boolean
  ) => void
  t: (key: string) => string
}) {
  const categories: Array<{
    id: WeworkNotificationPreferenceCategory
    title: string
  }> = [
    { id: 'tasks', title: t('notifications.category_tasks') },
    { id: 'stand_in', title: t('notifications.category_stand_in') },
    { id: 'collaboration', title: t('notifications.category_collaboration') },
    { id: 'general', title: t('notifications.category_general') },
  ]
  const channelLabels: Record<WeworkNotificationChannel, string> = {
    in_app: t('notifications.channel_in_app'),
    system: t('notifications.channel_system'),
    im: t('notifications.channel_im'),
  }

  return (
    <div data-testid="wework-notifications-settings-panel" className="divide-y divide-border/60">
      {categories.map(category => (
        <section key={category.id} className="px-3 py-3">
          <h3 className="text-sm font-medium">{category.title}</h3>
          <div className="mt-2 space-y-2">
            {(Object.keys(channelLabels) as WeworkNotificationChannel[]).flatMap(channel => {
              const enabled = preferences[category.id][channel]
              if (enabled == null) return []
              const label = channelLabels[channel]
              return [
                <label
                  key={channel}
                  className="flex min-h-9 items-center justify-between gap-3 rounded-md px-2 hover:bg-muted/60"
                >
                  <span className="text-sm text-text-secondary">{label}</span>
                  <SettingsSwitch
                    data-testid={`wework-notifications-setting-${category.id}-${channel}`}
                    checked={enabled}
                    disabled={isDisabled(category.id, channel)}
                    aria-label={`${category.title} · ${label}`}
                    onCheckedChange={checked => onChange(category.id, channel, checked)}
                  />
                </label>,
              ]
            })}
          </div>
        </section>
      ))}
      {!connected && (
        <p className="px-3 py-2 text-xs text-text-secondary">
          {t('notifications.settings_requires_cloud')}
        </p>
      )}
    </div>
  )
}

export function NotificationCenter() {
  const connection = useContext(CloudConnectionContext)
  return (
    <ConnectedNotificationCenter
      key={`${connection?.apiBaseUrl ?? ''}:${connection?.user?.id ?? ''}`}
      baseUrl={connection?.apiBaseUrl ?? null}
      token={connection?.token ?? null}
      userId={connection?.user?.id ?? null}
    />
  )
}

function cloudTimestamp(value: string): number {
  // The inbox API currently serializes UTC datetimes without a timezone suffix.
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`
  return new Date(normalized).getTime()
}

function markInboxRead(inbox: WeworkInbox | null): WeworkInbox | null {
  if (!inbox) return null
  return {
    ...inbox,
    unread_count: 0,
    items: inbox.items.map(item => ({
      ...item,
      read_at: item.read_at ?? new Date().toISOString(),
    })),
  }
}

function ConnectedNotificationCenter({
  baseUrl,
  token,
  userId,
}: {
  baseUrl: string | null
  token: string | null
  userId: number | null
}) {
  const { t } = useTranslation('common')
  const taskSource = useNotificationTaskSource()
  const interactions = useRuntimeInteractions()
  const api = useMemo(
    () =>
      baseUrl && token
        ? createNotificationsApi(
            createHttpClient({
              baseUrl,
              getToken: () => token,
              redirectOnUnauthorized: false,
            })
          )
        : null,
    [baseUrl, token]
  )
  const runtimeApi = useMemo(
    () =>
      baseUrl && token
        ? createRuntimeWorkApi(
            createHttpClient({
              baseUrl,
              getToken: () => token,
              redirectOnUnauthorized: false,
            })
          )
        : null,
    [baseUrl, token]
  )
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [category, setCategory] = useState<InboxCategory | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const accountKey = notificationPreferenceAccountKey(baseUrl, userId)
  const [feed] = useState(() => createNotificationCenterFeed(accountKey))
  const subscribeFeed = useCallback(
    (listener: () => void) =>
      feed.subscribe(listener, { api, runtimeApi, paused: Boolean(anchor) }),
    [feed, api, runtimeApi, anchor]
  )
  const { preferences, inboxes, error, busy } = useSyncExternalStore(
    subscribeFeed,
    feed.getSnapshot
  )
  const { setPreferences, setInboxes, setError, setBusy, refresh, refreshPreferences } = feed
  const openSettings = useCallback(() => {
    if (!buttonRef.current) return
    setAnchor(buttonRef.current)
    setCategory(null)
    setSettingsOpen(true)
    void refreshPreferences()
  }, [refreshPreferences])
  useDOMEvent('window', 'focus', () => {
    if (!anchor) void refresh()
  })
  useDOMEvent('window', 'wework-notifications-changed', () => {
    void refresh()
  })
  useDOMEvent('window', OPEN_NOTIFICATION_SETTINGS_EVENT, openSettings)

  const collaboration = useStandInNotifications(
    inboxes.collaboration,
    taskSource,
    accountKey,
    preferences.collaboration.in_app,
    preferences.collaboration.system === true,
    userId
  )
  const [summary] = useState(createNotificationCenterSummary)
  const subscribeSummary = useCallback(
    (listener: () => void) =>
      summary.subscribe(listener, {
        taskSource,
        collaborationUnreadCount: collaboration.unreadCount,
        generalInbox: inboxes.general,
      }),
    [summary, taskSource, collaboration.unreadCount, inboxes.general]
  )
  const { unreadTasks, sortedTasks, cloudUnreadCount, taskUnreadCount, unreadCount } =
    useSyncExternalStore(subscribeSummary, summary.getSnapshot)

  const close = useCallback(() => {
    anchor?.focus()
    setAnchor(null)
    setCategory(null)
    setSettingsOpen(false)
  }, [anchor])
  const mutate = async (action: () => Promise<void>) => {
    if (busy) return
    feed.invalidateRequests()
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const markNotificationRead = async (
    notification: StandInNotification,
    cloudCategory: WeworkNotificationCategory
  ): Promise<StandInNotification> => {
    if (notification.synthetic) {
      collaboration.markRead([notification])
      return notification
    }
    if (!api) throw new Error(t('notifications.cloud_unavailable'))
    const saved = await api.read(notification.id)
    setInboxes(current => {
      const inbox = current[cloudCategory]
      if (!inbox) return current
      return {
        ...current,
        [cloudCategory]: {
          ...inbox,
          items: inbox.items.map(item => (item.id === saved.id ? saved : item)),
          unread_count: Math.max(0, inbox.unread_count - (notification.read_at ? 0 : 1)),
        },
      }
    })
    collaboration.markRead([notification])
    return {
      ...saved,
      payload: { ...saved.payload, standIn: notification.payload.standIn },
      url: notification.payload.standIn ? notification.url : saved.url,
    }
  }
  const openNotification = (
    notification: StandInNotification,
    cloudCategory: WeworkNotificationCategory
  ) =>
    void mutate(async () => {
      const read = await markNotificationRead(notification, cloudCategory)
      if (read.payload.action === 'create_personal_task' && !read.payload.standIn) {
        const request = issueDispatchRequest(read.payload)
        if (!request) {
          throw new Error(t('notifications.invalid_link'))
        }
        // The project's board answers this, so the click switches to the Issue
        // first and leaves the dispatch waiting for the board that shows it.
        if (!openWeworkScheme(read.url ?? weworkIssueScheme(request.projectId, request.itemId))) {
          throw new Error(t('notifications.invalid_link'))
        }
        requestIssueDispatch(request)
        close()
        return
      }
      if (read.url) {
        if (!openWeworkScheme(read.url)) throw new Error(t('notifications.invalid_link'))
        close()
      }
    })

  /** The board, item key, state and deadline a notification points at. */
  function summaryParts(payload: WeworkNotificationPayload): string[] {
    const parts: string[] = []
    if (payload.projectName) parts.push(payload.projectName)
    if (payload.itemKey) parts.push(payload.itemKey)
    if (payload.itemStatus) parts.push(payload.itemStatus)
    const priority = priorityLabel(payload.itemPriority)
    if (priority) parts.push(priority)
    const due = dueLabel(payload.itemDueAt)
    if (due) parts.push(due)
    return parts
  }

  function priorityLabel(priority?: string): string | null {
    if (!priority || priority === 'none') return null
    const keys: Record<string, string> = {
      urgent: 'todo.priority_urgent',
      high: 'todo.priority_high',
      medium: 'todo.priority_normal',
      low: 'todo.priority_low',
    }
    const key = keys[priority]
    return key ? `${t('todo.priority')} ${t(key)}` : `${t('todo.priority')} ${priority}`
  }

  function dueLabel(dueAt?: string): string | null {
    if (!dueAt) return null
    const due = new Date(dueAt)
    if (Number.isNaN(due.getTime())) return null
    return `${t('todo.due_date')} ${due.toLocaleDateString()}`
  }

  const openTask = (item: RuntimeTaskReminderItem) => {
    taskSource?.markRuntimeTaskRead(item.address)
    openWeworkScheme(weworkTaskScheme(item.address))
    close()
  }
  const readAll = () =>
    void mutate(async () => {
      collaboration.markRead(collaboration.items)
      if (api && cloudUnreadCount) {
        await api.readAll()
        setInboxes(current => ({
          collaboration: markInboxRead(current.collaboration),
          general: markInboxRead(current.general),
        }))
      }
      for (const item of unreadTasks) taskSource?.markRuntimeTaskRead(item.address)
      await refresh()
    })

  const loadMore = (cloudCategory: WeworkNotificationCategory) =>
    void mutate(async () => {
      if (!api) return
      const currentInbox = inboxes[cloudCategory]
      if (currentInbox?.next_offset == null) return
      const page = await api.list(currentInbox.next_offset, cloudCategory)
      setInboxes(current => {
        const inbox = current[cloudCategory]
        if (!inbox) return current
        return {
          ...current,
          [cloudCategory]: {
            ...page,
            items: [
              ...inbox.items,
              ...page.items.filter(item => !inbox.items.some(existing => existing.id === item.id)),
            ],
          },
        }
      })
    })

  const updatePreference = (
    preferenceCategory: WeworkNotificationPreferenceCategory,
    channel: WeworkNotificationChannel,
    enabled: boolean
  ) =>
    void mutate(async () => {
      feed.invalidatePreferences()
      if (preferenceCategory === 'tasks' && channel === 'im') {
        if (!runtimeApi) throw new Error(t('notifications.im_requires_cloud'))
        const settings = await runtimeApi.updateGlobalImNotification({
          enabled,
        })
        const next = {
          ...preferences,
          tasks: { ...preferences.tasks, im: settings.global.enabled },
        }
        setPreferences(next)
        feed.cachePreferences(next)
        return
      }
      if ((preferenceCategory === 'tasks' || preferenceCategory === 'stand_in') && !api) {
        const next = {
          ...preferences,
          [preferenceCategory]: { ...preferences[preferenceCategory], [channel]: enabled },
        }
        setPreferences(next)
        feed.cachePreferences(next)
        return
      }
      if (!api) return
      const updated = await api.updatePreferences({
        category: preferenceCategory,
        channel,
        enabled,
      })
      const next = {
        ...mergeNotificationPreferences({
          ...updated,
          stand_in: updated.stand_in ?? preferences.stand_in,
        }),
        tasks: { ...updated.tasks, im: preferences.tasks.im },
      }
      setPreferences(next)
      feed.cachePreferences(next)
      await refresh()
    })

  const selectedCloudCategory =
    category === 'collaboration' || category === 'general' ? category : null
  const selectedCloudInbox =
    selectedCloudCategory === 'collaboration'
      ? { items: collaboration.items, next_offset: inboxes.collaboration?.next_offset ?? null }
      : selectedCloudCategory
        ? inboxes[selectedCloudCategory]
        : null
  const categoryRows = [
    {
      id: 'tasks' as const,
      title: t('notifications.category_tasks'),
      preview: sortedTasks[0]?.task.title,
      timestamp: sortedTasks[0] ? taskTimestamp(sortedTasks[0]) : 0,
      unread: taskUnreadCount,
      icon: CheckCircle2,
    },
    {
      id: 'collaboration' as const,
      title: t('notifications.category_collaboration'),
      preview: collaboration.items[0]
        ? notificationPreview(collaboration.items[0])
        : api && !inboxes.collaboration && !error
          ? t('notifications.loading')
          : undefined,
      timestamp: collaboration.items[0] ? collaboration.timestamp(collaboration.items[0]) : 0,
      unread: collaboration.unreadCount,
      icon: UsersRound,
    },
    {
      id: 'general' as const,
      title: t('notifications.category_general'),
      preview: inboxes.general?.items[0]
        ? notificationPreview(inboxes.general.items[0])
        : api && !inboxes.general && !error
          ? t('notifications.loading')
          : undefined,
      timestamp: inboxes.general?.items[0]
        ? cloudTimestamp(inboxes.general.items[0].created_at)
        : 0,
      unread: inboxes.general?.unread_count ?? 0,
      icon: Bell,
    },
  ]
  const selectedCategoryRow = categoryRows.find(row => row.id === category)

  return (
    <>
      <Tooltip label={t('notifications.title')} side="bottom">
        <ControlButton
          variant="unstyled"
          ref={buttonRef}
          type="button"
          data-testid="wework-notifications-button"
          className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, 'relative')}
          aria-label={
            unreadCount > 0
              ? t('notifications.title_with_count', { count: unreadCount })
              : interactions?.pending.length
                ? t('interactions.title_with_count', { count: interactions.pending.length })
                : t('notifications.title')
          }
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          onClick={event => {
            if (anchor) close()
            else setAnchor(event.currentTarget)
          }}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              data-testid="wework-notifications-unread"
              className="absolute right-0 top-0 min-w-4 rounded-full bg-text-primary px-1 text-xs text-background"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
          {unreadCount === 0 && Boolean(interactions?.pending.length) && (
            <span
              data-testid="wework-notifications-pending-indicator"
              className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-text-primary"
            />
          )}
        </ControlButton>
      </Tooltip>
      {anchor && (
        <AnchorPopover
          anchor={anchor}
          title={
            settingsOpen
              ? t('notifications.settings')
              : (selectedCategoryRow?.title ?? t('notifications.title'))
          }
          testId="wework-notifications-popover"
          onClose={close}
          wide
          header={
            <div className="flex h-12 items-center gap-2 border-b border-border/60 px-2 md:px-3">
              {(category || settingsOpen) && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="wework-notifications-back"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:h-7 md:w-7"
                  aria-label={t('notifications.back')}
                  onClick={() => {
                    setCategory(null)
                    setSettingsOpen(false)
                  }}
                >
                  <ArrowLeft className="h-4 w-4" />
                </ControlButton>
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-base font-semibold">
                  {settingsOpen
                    ? t('notifications.settings')
                    : (selectedCategoryRow?.title ?? t('notifications.title'))}
                </span>
                <span className="hidden shrink-0 text-xs text-text-secondary sm:inline">
                  {t('notifications.total_unread', {
                    count: settingsOpen
                      ? unreadCount
                      : (selectedCategoryRow?.unread ?? unreadCount),
                  })}
                </span>
              </span>
              {!settingsOpen && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="wework-notifications-read-all"
                  className="min-h-11 text-xs text-text-secondary hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:min-h-0"
                  disabled={busy || unreadCount === 0}
                  onClick={readAll}
                >
                  <span className="text-xs">{t('notifications.read_all')}</span>
                </ControlButton>
              )}
              {!settingsOpen && (
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="button"
                  data-testid="wework-notifications-refresh"
                  aria-label={t('notifications.refresh')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border-l border-border text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:h-7 md:w-7"
                  disabled={busy || !api}
                  onClick={() => void refresh()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </ControlButton>
              )}
              {!category && !settingsOpen && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="wework-notifications-settings"
                  className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:h-7 md:w-7"
                  aria-label={t('notifications.settings')}
                  onClick={openSettings}
                >
                  <Settings2 className="h-4 w-4" />
                </ControlButton>
              )}
            </div>
          }
        >
          {error && (
            <p role="alert" className="px-3 py-2 text-sm text-status-error">
              {t('notifications.failed')} {error}
            </p>
          )}
          {!api && (
            <p className="px-3 py-2 text-xs text-text-secondary">
              {t('notifications.cloud_unavailable')}
            </p>
          )}
          {settingsOpen ? (
            <>
              <NotificationSettings
                preferences={preferences}
                isDisabled={(preferenceCategory, channel) =>
                  busy ||
                  (preferenceCategory === 'tasks' || preferenceCategory === 'stand_in'
                    ? channel === 'im' && !runtimeApi
                    : !api)
                }
                connected={Boolean(api)}
                onChange={updatePreference}
                t={t}
              />
            </>
          ) : !category ? (
            <div data-testid="wework-notifications-categories">
              {interactions && (
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="button"
                  data-testid="wework-notifications-pending"
                  onClick={() => {
                    close()
                    interactions.open()
                  }}
                  className="flex min-h-16 w-full items-center gap-3 border-b border-border/60 px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t('interactions.title')}</span>
                    <span className="mt-0.5 block truncate text-xs text-text-secondary">
                      {interactions.pending[0]?.question || t('interactions.empty')}
                    </span>
                  </span>
                  <span
                    data-testid="notification-pending-count"
                    className="text-sm text-text-secondary"
                  >
                    {interactions.pending.length}
                  </span>
                  <ChevronRight className="h-4 w-4" />
                </ControlButton>
              )}
              {categoryRows.map(row => {
                const Icon = row.icon
                return (
                  <ControlButton
                    variant="outline"
                    size="sm"
                    key={row.id}
                    type="button"
                    data-testid={'wework-notifications-category-' + row.id}
                    className="flex min-h-16 w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus"
                    onClick={() => setCategory(row.id)}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{row.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-text-secondary">
                        {row.preview ?? t('notifications.empty_category')}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {row.timestamp > 0 && (
                        <span className="text-xs text-text-secondary">
                          {formatNotificationTime(row.timestamp)}
                        </span>
                      )}
                      {row.unread > 0 ? (
                        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-text-primary px-1 text-xs text-background">
                          {row.unread > 99 ? '99+' : row.unread}
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                      )}
                    </span>
                  </ControlButton>
                )
              })}
            </div>
          ) : category === 'tasks' ? (
            <div data-testid="wework-notifications-task-list">
              {sortedTasks.length === 0 && (
                <p className="p-3 text-sm text-text-secondary">
                  {t('notifications.empty_category')}
                </p>
              )}
              {sortedTasks.map(item => (
                <NotificationFeedRow
                  key={item.key}
                  testId={'wework-notification-task-' + item.task.taskId}
                  title={item.task.title}
                  body={t('notifications.task_completed', { project: item.projectName })}
                  timestamp={taskTimestamp(item)}
                  unread
                  unreadLabel={t('notifications.unread')}
                  busy={busy}
                  onClick={() => openTask(item)}
                />
              ))}
            </div>
          ) : (
            <div data-testid={'wework-notifications-' + category + '-list'}>
              {api && !selectedCloudInbox && !error && (
                <p role="status" className="p-3 text-sm text-text-secondary">
                  {t('notifications.loading')}
                </p>
              )}
              {selectedCloudInbox?.items.length === 0 && (
                <p className="p-3 text-sm text-text-secondary">
                  {t('notifications.empty_category')}
                </p>
              )}
              {selectedCloudInbox?.items.map(notification => {
                const rowProps: NotificationFeedRowProps = {
                  testId:
                    notification.payload.action === 'create_personal_task'
                      ? 'issue-dispatch-notification-create-task'
                      : 'wework-notification-' + notification.id,
                  kind: notification.kind,
                  title:
                    notification.kind === 'issue_dispatch_assignment'
                      ? notification.payload.taskTitle || notification.title
                      : notification.title,
                  body: notification.body,
                  summary: summaryParts(notification.payload).join(' · '),
                  replyPreview: notification.payload.replyPreview
                    ? t('notifications.in_reply_to', { preview: notification.payload.replyPreview })
                    : undefined,
                  timestamp:
                    selectedCloudCategory === 'collaboration'
                      ? collaboration.timestamp(notification)
                      : cloudTimestamp(notification.created_at),
                  unread:
                    selectedCloudCategory === 'collaboration'
                      ? collaboration.isUnread(notification)
                      : !notification.read_at,
                  unreadLabel: t('notifications.unread'),
                  busy,
                  onClick: () =>
                    selectedCloudCategory && openNotification(notification, selectedCloudCategory),
                  ...(notification.payload.action === 'stand_in_start_failed' &&
                    standInStartFailureCopy(
                      t,
                      notification.payload.itemTitle ?? notification.title,
                      notification.payload.failureCode
                    )),
                }
                return notification.kind === 'issue_dispatch_assignment' ? (
                  <StandInNotificationProcessing
                    key={notification.id}
                    notification={notification}
                    rowProps={rowProps}
                    services={taskSource?.services}
                    userId={userId ?? taskSource?.userId ?? null}
                    onChanged={async () => {
                      if (selectedCloudCategory)
                        await markNotificationRead(notification, selectedCloudCategory)
                      await refresh()
                    }}
                  />
                ) : (
                  <NotificationFeedRow key={notification.id} {...rowProps} />
                )
              })}
              {selectedCloudInbox?.next_offset != null && selectedCloudCategory && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="wework-notifications-more"
                  className="w-full p-3 text-sm text-text-secondary hover:bg-muted"
                  disabled={busy}
                  onClick={() => loadMore(selectedCloudCategory)}
                >
                  {t('notifications.more')}
                </ControlButton>
              )}
            </div>
          )}
        </AnchorPopover>
      )}
    </>
  )
}
