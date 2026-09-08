import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { createHttpClient } from '@/api/http'
import {
  createNotificationsApi,
  type WeworkInbox,
  type WeworkNotification,
} from '@/api/notifications'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useTranslation } from '@/hooks/useTranslation'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { Tooltip } from '@/components/ui/tooltip'
import { AnchorPopover } from '@/features/todo/AnchorPopover'
import { cn } from '@/lib/utils'
import { openWeworkScheme } from './schemeEvents'

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
          {inbox?.items.map(notification => (
            <button
              key={notification.id}
              data-testid={`wework-notification-${notification.id}`}
              disabled={busy}
              className={cn(
                'block w-full rounded-lg p-2 text-left hover:bg-muted disabled:opacity-50',
                !notification.read_at && 'bg-muted/50'
              )}
              onClick={() => openNotification(notification)}
            >
              <span className="block text-sm font-medium">
                {notification.kind === 'assignment'
                  ? t('notifications.assignment_title')
                  : notification.title}
              </span>
              <span className="mt-1 block whitespace-pre-wrap text-sm text-text-primary">
                {notification.kind === 'assignment'
                  ? t('notifications.assignment_body', {
                      assigner: notification.payload.assignerName,
                      project: notification.payload.projectName,
                      item: notification.payload.itemTitle,
                    })
                  : notification.body}
              </span>
              <span className="mt-1 block text-xs text-text-secondary">
                {!notification.read_at && `${t('notifications.unread')} · `}
                {new Date(notification.created_at).toLocaleString()}
              </span>
            </button>
          ))}
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
