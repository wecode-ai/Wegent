import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Bell, Bot, ClipboardCheck, type LucideIcon } from 'lucide-react'
import { createHttpClient } from '@/api/http'
import {
  createNotificationsApi,
  type WeworkInbox,
  type WeworkNotification,
  type WeworkNotificationPayload,
} from '@/api/notifications'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useTranslation } from '@/hooks/useTranslation'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { Tooltip } from '@/components/ui/tooltip'
import { AnchorPopover } from '@/features/todo/AnchorPopover'
import { cn } from '@/lib/utils'
import { openWeworkScheme } from './schemeEvents'

/** The glyph that tells the kinds of notification apart at a glance. */
function notificationKindIcon(kind: string): LucideIcon {
  if (kind === 'mention') return AtSign
  if (kind === 'assignment') return ClipboardCheck
  if (kind === 'execution') return Bot
  return Bell
}

export function NotificationCenter() {
  const connection = useContext(CloudConnectionContext)
  const { t } = useTranslation('common')
  if (!connection?.token || !connection.apiBaseUrl)
    return (
      <Tooltip label={t('notifications.connect')} side="bottom">
        <button
          type="button"
          data-testid="wework-notifications-button"
          disabled
          aria-label={t('notifications.connect')}
          className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        >
          <Bell className="h-4 w-4" />
        </button>
      </Tooltip>
    )
  return (
    <ConnectedNotificationCenter
      key={`${connection.apiBaseUrl}:${connection.user?.id}`}
      baseUrl={connection.apiBaseUrl}
      token={connection.token}
    />
  )
}

function ConnectedNotificationCenter({ baseUrl, token }: { baseUrl: string; token: string }) {
  const { t } = useTranslation('common')
  const api = useMemo(
    () =>
      createNotificationsApi(
        createHttpClient({
          baseUrl,
          getToken: () => token,
          redirectOnUnauthorized: false,
        })
      ),
    [baseUrl, token]
  )
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [inbox, setInbox] = useState<WeworkInbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)
  const refresh = useCallback(() => {
    const id = ++requestId.current
    return api.list().then(
      result => {
        if (id !== requestId.current) return
        setInbox(result)
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

  const close = useCallback(() => {
    anchor?.focus()
    setAnchor(null)
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
  const openNotification = (notification: WeworkNotification) =>
    void mutate(async () => {
      const read = await api.read(notification.id)
      setInbox(
        current =>
          current && {
            ...current,
            items: current.items.map(item => (item.id === read.id ? read : item)),
            unread_count: Math.max(0, current.unread_count - (notification.read_at ? 0 : 1)),
          }
      )
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

  return (
    <>
      <Tooltip label={t('notifications.title')} side="bottom">
        <button
          type="button"
          data-testid="wework-notifications-button"
          className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, 'relative')}
          aria-label={t('notifications.title')}
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          onClick={event => setAnchor(anchor ? null : event.currentTarget)}
        >
          <Bell className="h-4 w-4" />
          {Boolean(inbox?.unread_count) && (
            <span
              data-testid="wework-notifications-unread"
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-text-primary px-1 text-xs text-background"
            >
              {inbox!.unread_count > 99 ? '99+' : inbox!.unread_count}
            </span>
          )}
        </button>
      </Tooltip>
      {anchor && (
        <AnchorPopover
          anchor={anchor}
          title={t('notifications.title')}
          testId="wework-notifications-popover"
          onClose={close}
        >
          <div className="flex justify-end gap-2 p-2">
            <button
              data-testid="wework-notifications-refresh"
              className="text-sm hover:underline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t('notifications.refresh')}
            </button>
            <button
              data-testid="wework-notifications-read-all"
              className="text-sm hover:underline disabled:opacity-50"
              disabled={busy || !inbox?.unread_count}
              onClick={() =>
                void mutate(async () => {
                  await api.readAll()
                  await refresh()
                })
              }
            >
              {t('notifications.read_all')}
            </button>
          </div>
          {error && (
            <p role="alert" className="px-2 py-2 text-sm text-status-error">
              {t('notifications.failed')} {error}
            </p>
          )}
          {!inbox && !error && (
            <p role="status" className="p-2 text-sm text-text-secondary">
              {t('notifications.loading')}
            </p>
          )}
          {inbox?.items.length === 0 && (
            <p className="p-2 text-sm text-text-secondary">{t('notifications.empty')}</p>
          )}
          {inbox && inbox.items.length > 0 && (
            <div className="flex flex-col gap-1.5 px-1 pb-1">
              {inbox.items.map(notification => {
                const summary = summaryParts(notification.payload).join(' · ')
                const unread = !notification.read_at
                const KindIcon = notificationKindIcon(notification.kind)
                return (
                  <button
                    key={notification.id}
                    data-testid={`wework-notification-${notification.id}`}
                    data-unread={unread ? 'true' : undefined}
                    disabled={busy}
                    className={cn(
                      'block w-full rounded-xl border p-2.5 text-left transition-colors disabled:opacity-50',
                      unread
                        ? 'border-primary/35 bg-primary/[0.06] hover:bg-primary/[0.1]'
                        : 'border-border/60 bg-background hover:bg-muted/60'
                    )}
                    onClick={() => openNotification(notification)}
                  >
                    <span className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          'mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full',
                          unread ? 'bg-primary/10 text-primary' : 'bg-muted text-text-muted'
                        )}
                      >
                        <KindIcon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-text-primary">
                          {notification.title}
                        </span>
                        {summary && (
                          <span
                            data-testid={`wework-notification-summary-${notification.id}`}
                            className="mt-0.5 block text-xs text-text-secondary"
                          >
                            {summary}
                          </span>
                        )}
                      </span>
                      {unread && (
                        <span
                          aria-hidden
                          className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-primary"
                        />
                      )}
                    </span>
                    {notification.body && (
                      <span
                        data-testid={`wework-notification-body-${notification.id}`}
                        className="mt-2 block whitespace-pre-wrap text-sm text-text-primary"
                      >
                        {notification.body}
                      </span>
                    )}
                    {notification.payload.replyPreview && (
                      <span className="mt-2 block border-l-2 border-border pl-2 text-xs text-text-secondary">
                        {t('notifications.in_reply_to', {
                          preview: notification.payload.replyPreview,
                        })}
                      </span>
                    )}
                    <span className="mt-2 block text-xs text-text-secondary">
                      {unread && `${t('notifications.unread')} · `}
                      {new Date(notification.created_at).toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {inbox?.next_offset != null && (
            <button
              data-testid="wework-notifications-more"
              className="w-full p-2 text-sm hover:bg-muted"
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  const page = await api.list(inbox.next_offset!)
                  setInbox(
                    current =>
                      current && {
                        ...page,
                        items: [
                          ...current.items,
                          ...page.items.filter(
                            item => !current.items.some(existing => existing.id === item.id)
                          ),
                        ],
                      }
                  )
                })
              }
            >
              {t('notifications.more')}
            </button>
          )}
        </AnchorPopover>
      )}
    </>
  )
}
