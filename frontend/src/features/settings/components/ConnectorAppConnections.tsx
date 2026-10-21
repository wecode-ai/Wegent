// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Cable, Loader2, Search } from 'lucide-react'
import { adminApis, type UserConnectorApp } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tag } from '@/components/ui/tag'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  authorizeConnectorApp,
  CONNECTOR_AUTHORIZATION_CHANGED_EVENT,
  connectorOAuthErrorMessage,
} from '@/features/settings/connectorOAuth'
import { sortConnectorAppsByConnection } from '@/features/settings/connectorAppOrder'
import { matchesConnectorAppQuery } from '@/features/settings/connectorAppSearch'

export default function ConnectorAppConnections() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [apps, setApps] = useState<UserConnectorApp[]>([])
  const [loading, setLoading] = useState(true)
  const [authorizingSlug, setAuthorizingSlug] = useState<string | null>(null)
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null)
  const [retryingSlug, setRetryingSlug] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<UserConnectorApp | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const loadApps = useCallback(async () => {
    setLoading(true)
    try {
      const fetched = await adminApis.getUserConnectorApps()
      setApps(sortConnectorAppsByConnection(fetched))
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.load_failed'),
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void loadApps()
  }, [loadApps])

  useEffect(() => {
    const refresh = () => void loadApps()
    window.addEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
  }, [loadApps])

  const authorize = async (app: UserConnectorApp) => {
    setAuthorizingSlug(app.slug)
    try {
      await authorizeConnectorApp(app.slug)
      toast({ title: t('common:integrations.connector_apps.authorized') })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.authorization_failed'),
        description: connectorOAuthErrorMessage(t, error),
      })
    } finally {
      setAuthorizingSlug(null)
    }
  }

  const statusLabel = (status: UserConnectorApp['connection']['status']) =>
    t(`common:integrations.connector_apps.status.${status}`)

  const visibleApps = apps.filter(app => matchesConnectorAppQuery(app, searchQuery))

  const disconnect = async () => {
    const app = disconnectTarget
    if (!app) return
    setDisconnectingSlug(app.slug)
    try {
      await adminApis.disconnectConnectorApp(app.slug)
      toast({ title: t('common:integrations.connector_apps.disconnected') })
      setDisconnectTarget(null)
      window.dispatchEvent(new CustomEvent(CONNECTOR_AUTHORIZATION_CHANGED_EVENT))
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.disconnect_failed'),
        description: (error as Error).message,
      })
    } finally {
      setDisconnectingSlug(null)
    }
  }

  const retryConnection = async (app: UserConnectorApp) => {
    setRetryingSlug(app.slug)
    try {
      const connection = await adminApis.refreshConnectorApp(app.slug)
      toast({
        title: t(
          connection.status === 'connected'
            ? 'common:integrations.connector_apps.retry_succeeded'
            : 'common:integrations.connector_apps.retry_failed'
        ),
      })
      window.dispatchEvent(new CustomEvent(CONNECTOR_AUTHORIZATION_CHANGED_EVENT))
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.retry_failed'),
        description: (error as Error).message,
      })
    } finally {
      setRetryingSlug(null)
    }
  }

  return (
    <Card className="p-6" data-testid="connector-app-connections">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-text-primary">
          {t('common:integrations.connector_apps.title')}
        </h3>
        <p className="mt-1 text-sm text-text-muted">
          {t('common:integrations.connector_apps.description')}
        </p>
      </div>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center">
          <Cable className="mx-auto mb-2 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-muted">{t('common:integrations.connector_apps.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('common:integrations.connector_apps.search_placeholder')}
              className="pl-9"
              data-testid="search-connector-app-connections"
            />
          </div>
          {visibleApps.length === 0 ? (
            <p
              className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-text-muted"
              data-testid="connector-app-connections-search-empty"
            >
              {t('common:integrations.connector_apps.search_empty')}
            </p>
          ) : null}
          {visibleApps.map(app => {
            const connected = app.connection.status === 'connected'
            return (
              <div
                key={app.slug}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                data-testid={`connector-app-connection-${app.slug}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">{app.name}</span>
                    <Tag variant={connected ? 'success' : 'default'}>
                      {statusLabel(app.connection.status)}
                    </Tag>
                  </div>
                  {app.description ? (
                    <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                      {app.description}
                    </p>
                  ) : null}
                  {connected && app.connection.last_error ? (
                    <p className="mt-1 line-clamp-2 text-xs text-error">
                      {t('common:integrations.connector_apps.upstream_error', {
                        message: app.connection.last_error,
                      })}
                    </p>
                  ) : null}
                  {connected && app.connection.external_account_name ? (
                    <p className="mt-1 text-xs text-text-muted">
                      {t('common:integrations.connector_apps.account', {
                        name: app.connection.external_account_name,
                      })}
                    </p>
                  ) : null}
                </div>
                {app.auth_type === 'oauth2' && !connected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void authorize(app)}
                    disabled={authorizingSlug === app.slug}
                    data-testid={`authorize-connector-app-${app.slug}`}
                  >
                    {authorizingSlug === app.slug ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {t('common:integrations.connector_apps.authorize')}
                  </Button>
                ) : connected ? (
                  <div className="flex shrink-0 gap-2">
                    {app.connection.last_error ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void retryConnection(app)}
                        disabled={retryingSlug === app.slug}
                        data-testid={`retry-connector-app-${app.slug}`}
                      >
                        {retryingSlug === app.slug ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        {t('common:integrations.connector_apps.retry')}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-error/40 text-error hover:bg-error/10 hover:text-error"
                      onClick={() => setDisconnectTarget(app)}
                      disabled={disconnectingSlug === app.slug}
                      data-testid={`disconnect-connector-app-${app.slug}`}
                    >
                      {disconnectingSlug === app.slug ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      {t('common:integrations.connector_apps.disconnect')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      <AlertDialog
        open={Boolean(disconnectTarget)}
        onOpenChange={open => {
          if (!open) setDisconnectTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('common:integrations.connector_apps.confirm_disconnect_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:integrations.connector_apps.confirm_disconnect', {
                name: disconnectTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-disconnect-connector">
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-disconnect-connector"
              onClick={() => void disconnect()}
            >
              {t('common:integrations.connector_apps.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
