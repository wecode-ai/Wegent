import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bell, CheckCircle2, ChevronRight, UsersRound } from 'lucide-react'
import { createHttpClient } from '@/api/http'
import {
  createNotificationsApi,
  type WeworkInbox,
  type WeworkNotification,
  type WeworkNotificationCategory,
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
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import { openWeworkScheme } from './schemeEvents'

type InboxCategory = 'tasks' | WeworkNotificationCategory
const CLOUD_CATEGORIES: WeworkNotificationCategory[] = ['collaboration', 'general']

function notificationTitle(notification: WeworkNotification, t: (key: string) => string): string {
  return notification.kind === 'assignment'
    ? t('notifications.assignment_title')
    : notification.title
}

function notificationBody(
  notification: WeworkNotification,
  t: (key: string, values?: Record<string, string>) => string
): string {
  return notification.kind === 'assignment'
    ? t('notifications.assignment_body', {
        assigner: notification.payload.assignerName,
        project: notification.payload.projectName,
        item: notification.payload.itemTitle,
      })
    : notification.body
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
  title,
  body,
  timestamp,
  unread,
  unreadLabel,
  busy,
  onClick,
}: {
  testId: string
  title: string
  body: string
  timestamp: number
  unread: boolean
  unreadLabel: string
  busy: boolean
  onClick: () => void
}) {
  const time = formatNotificationTime(timestamp)
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      className={cn(
        'block min-h-16 w-full border-b border-border/60 px-2 py-2 text-left last:border-b-0 hover:bg-muted disabled:opacity-50',
        unread && 'bg-muted/30'
      )}
      onClick={onClick}
    >
      <span className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-1.5">
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', unread && 'bg-focus')} />
        <span className="min-w-0 truncate text-sm font-medium">
          {unread && <span className="sr-only">{unreadLabel}：</span>}
          {title}
        </span>
        {time && (
          <time className="text-xs text-text-tertiary" dateTime={new Date(timestamp).toISOString()}>
            {time}
          </time>
        )}
      </span>
      <span
        className="ml-3 mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-text-secondary"
        title={body}
      >
        {body}
      </span>
    </button>
  )
}

export function NotificationCenter() {
  const connection = useContext(CloudConnectionContext)
  return (
    <ConnectedNotificationCenter
      key={`${connection?.apiBaseUrl ?? ''}:${connection?.user?.id ?? ''}`}
      baseUrl={connection?.apiBaseUrl ?? null}
      token={connection?.token ?? null}
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
}: {
  baseUrl: string | null
  token: string | null
}) {
  const { t } = useTranslation('common')
  const taskSource = useNotificationTaskSource()
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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [category, setCategory] = useState<InboxCategory | null>(null)
  const [inboxes, setInboxes] = useState<Record<WeworkNotificationCategory, WeworkInbox | null>>({
    collaboration: null,
    general: null,
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)
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
      if (read.url) {
        if (!openWeworkScheme(read.url)) throw new Error(t('notifications.invalid_link'))
        close()
      }
    })
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
        ? notificationBody(inboxes.collaboration.items[0], t)
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
        ? notificationTitle(inboxes.general.items[0], t)
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
          title={selectedCategoryRow?.title ?? t('notifications.title')}
          testId="wework-notifications-popover"
          onClose={close}
          wide
          header={
            <div className="flex h-12 items-center gap-2 border-b border-border/60 px-2 md:px-3">
              {category && (
                <button
                  type="button"
                  data-testid="wework-notifications-back"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus md:h-7 md:w-7"
                  aria-label={t('notifications.back')}
                  onClick={() => setCategory(null)}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-base font-semibold">
                  {selectedCategoryRow?.title ?? t('notifications.title')}
                </span>
                <span className="hidden shrink-0 text-xs text-text-secondary sm:inline">
                  {t('notifications.total_unread', {
                    count: selectedCategoryRow?.unread ?? unreadCount,
                  })}
                </span>
              </span>
              <button
                type="button"
                data-testid="wework-notifications-refresh"
                className="min-h-11 text-xs text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:min-h-0"
                disabled={busy || !api}
                onClick={() => void refresh()}
              >
                {t('notifications.refresh')}
              </button>
              {!category && (
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
          {!category ? (
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
                  testId={'wework-notification-' + notification.id}
                  title={notificationTitle(notification, t)}
                  body={notificationBody(notification, t)}
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
