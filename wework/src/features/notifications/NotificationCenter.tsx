import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  AtSign,
  Bell,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Settings2,
  type LucideIcon,
  UsersRound,
} from 'lucide-react'
import { createHttpClient } from '@/api/http'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import {
  createNotificationsApi,
  type WeworkInbox,
  type WeworkNotification,
  type WeworkNotificationCategory,
  type WeworkNotificationChannel,
  type WeworkNotificationPreferenceCategory,
  type WeworkNotificationPreferences,
  type WeworkNotificationPayload,
} from '@/api/notifications'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useTranslation } from '@/hooks/useTranslation'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { Tooltip } from '@/components/ui/tooltip'
import { AnchorPopover } from '@/features/todo/AnchorPopover'
import { syncNotificationUnreadCount } from '@/desktop/trayNavigation'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import {
  useIssueDispatchNotificationAction,
  useNotificationTaskSource,
} from './NotificationTaskSourceContext'
import { openWeworkScheme } from './schemeEvents'
import {
  cacheNotificationPreferences,
  migrateLegacyTaskSystemNotification,
  OPEN_NOTIFICATION_SETTINGS_EVENT,
  readCachedNotificationPreferences,
} from './notificationPreferences'

type InboxCategory = 'tasks' | WeworkNotificationCategory
const CLOUD_CATEGORIES: WeworkNotificationCategory[] = ['collaboration', 'general']

/** The glyph that tells the kinds of notification apart at a glance. */
const KIND_ICONS: Record<string, LucideIcon> = {
  mention: AtSign,
  assignment: ClipboardCheck,
  execution: Bot,
}

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

function formatNotificationTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === today.getFullYear()
      ? { month: 'numeric', day: 'numeric' }
      : { year: 'numeric', month: 'numeric', day: 'numeric' }
  )
}

function NotificationFeedRow({
  testId,
  kind,
  title,
  body,
  summary,
  replyPreview,
  timestamp,
  unread,
  unreadLabel,
  busy,
  onClick,
}: {
  testId: string
  /** Names the notification's glyph; a source without kinds shows none. */
  kind?: string
  title: string
  body: string
  /** The board, item and state the notification points at. */
  summary?: string
  /** The comment this notification answered, when it answered one. */
  replyPreview?: string
  timestamp: number
  unread: boolean
  unreadLabel: string
  busy: boolean
  onClick: () => void
}) {
  const time = formatNotificationTime(timestamp)
  const KindIcon = kind ? (KIND_ICONS[kind] ?? Bell) : null
  return (
    <button
      type="button"
      data-testid={testId}
      data-unread={unread ? 'true' : undefined}
      disabled={busy}
      className={cn(
        'block min-h-16 w-full border-b border-border/60 px-2 py-2 text-left last:border-b-0 hover:bg-muted disabled:opacity-50',
        unread && 'bg-muted/30'
      )}
      onClick={onClick}
    >
      <span className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-1.5">
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', unread && 'bg-focus')} />
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {unread && <span className="sr-only">{unreadLabel}：</span>}
          {KindIcon && (
            <KindIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          )}
          <span className="truncate">{title}</span>
        </span>
        {time && (
          <time className="text-xs text-text-tertiary" dateTime={new Date(timestamp).toISOString()}>
            {time}
          </time>
        )}
      </span>
      {summary && (
        <span
          data-testid={`${testId}-summary`}
          className="ml-3 mt-0.5 block truncate text-xs text-text-secondary"
        >
          {summary}
        </span>
      )}
      {body && (
        <span
          data-testid={`${testId}-body`}
          className="ml-3 mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-text-secondary"
          title={body}
        >
          {body}
        </span>
      )}
      {replyPreview && (
        <span
          data-testid={`${testId}-reply`}
          className="ml-3 mt-1 block border-l-2 border-border pl-2 text-xs text-text-secondary"
        >
          {replyPreview}
        </span>
      )}
    </button>
  )
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

function taskTimestamp(item: RuntimeTaskReminderItem): number {
  const value = item.task.completedAt ?? item.task.updatedAt ?? item.task.createdAt
  if (value == null) return 0
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
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
  const issueDispatchAction = useIssueDispatchNotificationAction()
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
  const accountKey = `${baseUrl ?? 'local'}:${userId ?? 'anonymous'}`
  const [preferences, setPreferences] = useState<WeworkNotificationPreferences>(() =>
    readCachedNotificationPreferences(accountKey)
  )
  const [taskImSessionKey, setTaskImSessionKey] = useState<string | null>(null)
  const [inboxes, setInboxes] = useState<Record<WeworkNotificationCategory, WeworkInbox | null>>({
    collaboration: null,
    general: null,
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)
  const preferenceRequestId = useRef(0)
  const refreshPreferences = useCallback(async () => {
    const id = ++preferenceRequestId.current
    try {
      await migrateLegacyTaskSystemNotification(accountKey, async () => {
        if (api) {
          await api.updatePreferences({
            category: 'tasks',
            channel: 'system',
            enabled: true,
          })
        }
        if (id !== preferenceRequestId.current) {
          throw new Error('Stale notification preference migration')
        }
        const current = readCachedNotificationPreferences(accountKey)
        const migrated = {
          ...current,
          tasks: { ...current.tasks, system: true },
        }
        cacheNotificationPreferences(accountKey, migrated)
        setPreferences(migrated)
      })
    } catch (cause) {
      if (id !== preferenceRequestId.current) return
      console.error('[Wework] Failed to migrate legacy task notification setting', cause)
    }
    if (!api || !runtimeApi || id !== preferenceRequestId.current) return

    const next = await api.getPreferences()
    let taskIm: boolean | null | undefined
    let taskImSession: string | null | undefined
    try {
      const imSettings = await runtimeApi.getImNotificationSettings()
      taskIm = imSettings.global.enabled
      taskImSession = imSettings.global.sessionKey ?? null
    } catch (cause) {
      console.error('[Wework] Failed to load task IM notification settings', cause)
    }
    if (id !== preferenceRequestId.current) return
    if (taskImSession !== undefined) setTaskImSessionKey(taskImSession)
    setPreferences(current => {
      const merged = {
        ...next,
        tasks: {
          ...next.tasks,
          im: taskIm === undefined ? current.tasks.im : taskIm,
        },
      }
      cacheNotificationPreferences(accountKey, merged)
      return merged
    })
  }, [accountKey, api, runtimeApi])
  const openSettings = useCallback(() => {
    if (!buttonRef.current) return
    setAnchor(buttonRef.current)
    setCategory(null)
    setSettingsOpen(true)
    void refreshPreferences().catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [refreshPreferences])
  const refresh = useCallback(() => {
    if (!api) return Promise.resolve()
    const id = ++requestId.current
    return Promise.all(CLOUD_CATEGORIES.map(cloudCategory => api.list(0, cloudCategory))).then(
      ([collaboration, general]) => {
        if (id !== requestId.current) return
        setInboxes({ collaboration, general })
        setError(null)
      },
      cause => {
        if (id === requestId.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
  }, [api])

  useEffect(() => {
    const requests = requestId
    void refresh()
    const timer = window.setInterval(() => {
      if (!anchor) void refresh()
    }, 15000)
    const onFocus = () => {
      if (!anchor) void refresh()
    }
    window.addEventListener('focus', onFocus)
    const onNotification = () => void refresh()
    window.addEventListener('wework-notifications-changed', onNotification)
    return () => {
      requests.current++
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('wework-notifications-changed', onNotification)
    }
  }, [refresh, anchor])

  useEffect(() => {
    cacheNotificationPreferences(accountKey, readCachedNotificationPreferences(accountKey))
  }, [accountKey])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshPreferences().catch(cause => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshPreferences])

  useEffect(() => {
    window.addEventListener(OPEN_NOTIFICATION_SETTINGS_EVENT, openSettings)
    return () => window.removeEventListener(OPEN_NOTIFICATION_SETTINGS_EVENT, openSettings)
  }, [openSettings])

  const unreadTasks = useMemo(
    () => taskSource?.items.filter(item => taskSource.unreadTaskKeys.has(item.key)) ?? [],
    [taskSource]
  )
  const cloudUnreadCount = CLOUD_CATEGORIES.reduce(
    (count, cloudCategory) => count + (inboxes[cloudCategory]?.unread_count ?? 0),
    0
  )
  const unreadCount = unreadTasks.length + cloudUnreadCount
  useEffect(() => {
    if (getDesktopWindowLabel() !== 'main') return
    syncNotificationUnreadCount(unreadCount)
    return () => syncNotificationUnreadCount(0)
  }, [unreadCount])
  const sortedTasks = useMemo(
    () => [...unreadTasks].sort((a, b) => taskTimestamp(b) - taskTimestamp(a)),
    [unreadTasks]
  )

  const close = useCallback(() => {
    anchor?.focus()
    setAnchor(null)
    setCategory(null)
    setSettingsOpen(false)
  }, [anchor])
  const mutate = async (action: () => Promise<void>) => {
    if (busy) return
    requestId.current++
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
  const openNotification = (
    notification: WeworkNotification,
    cloudCategory: WeworkNotificationCategory
  ) =>
    void mutate(async () => {
      if (!api) return
      const read = await api.read(notification.id)
      setInboxes(current => {
        const inbox = current[cloudCategory]
        if (!inbox) return current
        return {
          ...current,
          [cloudCategory]: {
            ...inbox,
            items: inbox.items.map(item => (item.id === read.id ? read : item)),
            unread_count: Math.max(0, inbox.unread_count - (notification.read_at ? 0 : 1)),
          },
        }
      })
      if (read.payload.action === 'create_personal_task') {
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
        } = read.payload
        if (
          !issueDispatchAction ||
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
          throw new Error(t('notifications.invalid_link'))
        }
        await issueDispatchAction({
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
        })
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
    navigateTo(buildRuntimeTaskRoute(item.address))
    close()
  }
  const readAll = () =>
    void mutate(async () => {
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
      preferenceRequestId.current++
      if (preferenceCategory === 'tasks' && channel === 'im') {
        if (!runtimeApi || (!taskImSessionKey && enabled)) {
          throw new Error(t('notifications.im_target_required'))
        }
        const settings = await runtimeApi.updateGlobalImNotification({
          enabled,
          sessionKey: taskImSessionKey,
        })
        const next = {
          ...preferences,
          tasks: { ...preferences.tasks, im: settings.global.enabled },
        }
        setTaskImSessionKey(settings.global.sessionKey ?? null)
        setPreferences(next)
        cacheNotificationPreferences(accountKey, next)
        return
      }
      if (preferenceCategory === 'tasks' && !api) {
        const next = {
          ...preferences,
          tasks: { ...preferences.tasks, [channel]: enabled },
        }
        setPreferences(next)
        cacheNotificationPreferences(accountKey, next)
        return
      }
      if (!api) return
      const updated = await api.updatePreferences({
        category: preferenceCategory,
        channel,
        enabled,
      })
      const next = {
        ...updated,
        tasks: { ...updated.tasks, im: preferences.tasks.im },
      }
      setPreferences(next)
      cacheNotificationPreferences(accountKey, next)
      await refresh()
    })

  const selectedCloudCategory =
    category === 'collaboration' || category === 'general' ? category : null
  const selectedCloudInbox = selectedCloudCategory ? inboxes[selectedCloudCategory] : null
  const categoryRows = [
    {
      id: 'tasks' as const,
      title: t('notifications.category_tasks'),
      preview: sortedTasks[0]?.task.title,
      timestamp: sortedTasks[0] ? taskTimestamp(sortedTasks[0]) : 0,
      unread: unreadTasks.length,
      icon: CheckCircle2,
    },
    {
      id: 'collaboration' as const,
      title: t('notifications.category_collaboration'),
      preview: inboxes.collaboration?.items[0]
        ? notificationPreview(inboxes.collaboration.items[0])
        : api && !inboxes.collaboration && !error
          ? t('notifications.loading')
          : undefined,
      timestamp: inboxes.collaboration?.items[0]
        ? cloudTimestamp(inboxes.collaboration.items[0].created_at)
        : 0,
      unread: inboxes.collaboration?.unread_count ?? 0,
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
        <button
          ref={buttonRef}
          type="button"
          data-testid="wework-notifications-button"
          className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, 'relative')}
          aria-label={
            unreadCount > 0
              ? t('notifications.title_with_count', { count: unreadCount })
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
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-text-primary px-1 text-xs text-background"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
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
                <button
                  type="button"
                  data-testid="wework-notifications-back"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus md:h-7 md:w-7"
                  aria-label={t('notifications.back')}
                  onClick={() => {
                    setCategory(null)
                    setSettingsOpen(false)
                  }}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
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
                <button
                  type="button"
                  data-testid="wework-notifications-refresh"
                  className="min-h-11 text-xs text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-0"
                  disabled={busy || !api}
                  onClick={() => void refresh()}
                >
                  {t('notifications.refresh')}
                </button>
              )}
              {!category && !settingsOpen && (
                <button
                  type="button"
                  data-testid="wework-notifications-read-all"
                  className="min-h-11 text-xs text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-0"
                  disabled={busy || unreadCount === 0}
                  onClick={readAll}
                >
                  {t('notifications.read_all')}
                </button>
              )}
              {!category && !settingsOpen && (
                <button
                  type="button"
                  data-testid="wework-notifications-settings"
                  className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus md:h-7 md:w-7"
                  aria-label={t('notifications.settings')}
                  onClick={openSettings}
                >
                  <Settings2 className="h-4 w-4" />
                </button>
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
            <NotificationSettings
              preferences={preferences}
              isDisabled={(preferenceCategory, channel) =>
                busy || (preferenceCategory === 'tasks' ? channel === 'im' && !runtimeApi : !api)
              }
              connected={Boolean(api)}
              onChange={updatePreference}
              t={t}
            />
          ) : !category ? (
            <div data-testid="wework-notifications-categories">
              {categoryRows.map(row => {
                const Icon = row.icon
                return (
                  <button
                    key={row.id}
                    type="button"
                    data-testid={'wework-notifications-category-' + row.id}
                    className="flex min-h-16 w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus"
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
                        <span className="text-xs text-text-tertiary">
                          {formatNotificationTime(row.timestamp)}
                        </span>
                      )}
                      {row.unread > 0 ? (
                        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-text-primary px-1 text-xs text-background">
                          {row.unread > 99 ? '99+' : row.unread}
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
                      )}
                    </span>
                  </button>
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
              {selectedCloudInbox?.items.map(notification => (
                <NotificationFeedRow
                  key={notification.id}
                  testId={
                    notification.payload.action === 'create_personal_task'
                      ? 'issue-dispatch-notification-create-task'
                      : 'wework-notification-' + notification.id
                  }
                  kind={notification.kind}
                  title={notification.title}
                  body={notification.body}
                  summary={summaryParts(notification.payload).join(' · ')}
                  replyPreview={
                    notification.payload.replyPreview
                      ? t('notifications.in_reply_to', {
                          preview: notification.payload.replyPreview,
                        })
                      : undefined
                  }
                  timestamp={cloudTimestamp(notification.created_at)}
                  unread={!notification.read_at}
                  unreadLabel={t('notifications.unread')}
                  busy={busy}
                  onClick={() =>
                    selectedCloudCategory && openNotification(notification, selectedCloudCategory)
                  }
                />
              ))}
              {selectedCloudInbox?.next_offset != null && selectedCloudCategory && (
                <button
                  type="button"
                  data-testid="wework-notifications-more"
                  className="w-full p-3 text-sm text-text-secondary hover:bg-muted"
                  disabled={busy}
                  onClick={() => loadMore(selectedCloudCategory)}
                >
                  {t('notifications.more')}
                </button>
              )}
            </div>
          )}
        </AnchorPopover>
      )}
    </>
  )
}
