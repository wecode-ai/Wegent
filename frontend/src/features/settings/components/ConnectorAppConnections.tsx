// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cable, Loader2, RefreshCw, Search } from 'lucide-react'
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
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [apps, setApps] = useState<UserConnectorApp[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const activeRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const refreshesAwaitingCatalog = useRef(new Set<string>())
  const [authorizingSlug, setAuthorizingSlug] = useState<string | null>(null)
  const [disconnectingSlug, setDisconnectingSlug] = useState<string | null>(null)
  const [refreshingSlugs, setRefreshingSlugs] = useState<ReadonlySet<string>>(() => new Set())
  const [disconnectTarget, setDisconnectTarget] = useState<UserConnectorApp | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  useLayoutEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const loadApps = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    const settledRefreshes = [...refreshesAwaitingCatalog.current]
    setLoading(true)
    setLoadError(null)
    try {
      const fetched = await adminApis.getUserConnectorApps()
      if (generation !== loadGenerationRef.current) return
      setApps(sortConnectorAppsByConnection(fetched))
      if (settledRefreshes.length > 0) {
        settledRefreshes.forEach(slug => refreshesAwaitingCatalog.current.delete(slug))
        setRefreshingSlugs(slugs => {
          const next = new Set(slugs)
          settledRefreshes.forEach(slug => next.delete(slug))
          return next
        })
      }
    } catch (error) {
      if (generation !== loadGenerationRef.current) return
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : t('common:integrations.connector_apps.load_failed')
      )
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadApps()
    return () => {
      loadGenerationRef.current += 1
    }
  }, [loadApps])

  useEffect(() => {
    const refresh = () => void loadApps()
    window.addEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
  }, [loadApps])

  const authorize = async (app: UserConnectorApp) => {
    setAuthorizingSlug(app.slug)
    try {
      await authorizeConnectorApp(app.slug, { isCurrent: () => activeRef.current })
      if (!activeRef.current) return
      toast({ title: t('common:integrations.connector_apps.authorized') })
    } catch (error) {
      if (!activeRef.current || (error instanceof Error && error.name === 'AbortError')) return
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.authorization_failed'),
        description: connectorOAuthErrorMessage(t, error),
      })
    } finally {
      if (activeRef.current) setAuthorizingSlug(null)
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

  const refreshConnection = async (app: UserConnectorApp) => {
    setRefreshingSlugs(slugs => new Set(slugs).add(app.slug))
    try {
      const connection = await adminApis.refreshConnectorApp(app.slug)
      if (!activeRef.current) return
      // The backend probes the upstream, so only a clean result is a recovery.
      const recovered = connection.status === 'connected' && !connection.last_error
      toast({
        variant: recovered ? undefined : 'destructive',
        title: t(
          recovered
            ? 'common:integrations.connector_apps.refresh_succeeded'
            : 'common:integrations.connector_apps.refresh_failed'
        ),
        description: recovered ? undefined : (connection.last_error ?? undefined),
      })
    } catch (error) {
      if (!activeRef.current) return
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.refresh_failed'),
        description: (error as Error).message,
      })
    } finally {
      // A rejected refresh can revoke the stored grant even when the request fails.
      if (activeRef.current) refreshesAwaitingCatalog.current.add(app.slug)
      window.dispatchEvent(new CustomEvent(CONNECTOR_AUTHORIZATION_CHANGED_EVENT))
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
      {loadError ? (
        <div className="mb-3 space-y-2" role="alert" data-testid="connector-app-catalog-error">
          <p className="text-sm text-error">
            {t('common:integrations.connector_apps.load_failed')}: {loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadApps()}
            className="max-md:h-11"
            disabled={loading}
            data-testid="retry-connector-app-catalog"
          >
            {t('common:integrations.connector_apps.retry')}
          </Button>
        </div>
      ) : null}
      {loading && apps.length === 0 ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
      ) : apps.length === 0 && !loadError ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center">
          <Cable className="mx-auto mb-2 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-muted">{t('common:integrations.connector_apps.empty')}</p>
        </div>
      ) : apps.length > 0 ? (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('common:integrations.connector_apps.search_placeholder')}
              className="pl-9 max-md:h-11"
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
            const { status, last_error: lastError, external_account_name: account } = app.connection
            const connected = status === 'connected'
            const oauth = app.auth_type === 'oauth2'
            const needsRenewal = oauth && status === 'expired' && app.can_refresh
            const showRefresh = needsRenewal || (oauth && connected && Boolean(lastError))
            const showDisconnect = (connected && app.auth_type !== 'none') || needsRenewal
            const refreshing = refreshingSlugs.has(app.slug)
            const disconnecting = disconnectingSlug === app.slug
            const statusVariant =
              status === 'expired'
                ? 'warning'
                : status === 'error' || (connected && lastError)
                  ? 'error'
                  : connected
                    ? 'success'
                    : 'default'
            return (
              <div
                key={app.slug}
                className="flex flex-col gap-3 rounded-md border border-border/70 bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`connector-app-connection-${app.slug}`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-fill-tertiary text-text-secondary">
                    <Cable className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words text-sm font-medium text-text-primary">
                        {app.name}
                      </span>
                      <Tag variant={statusVariant}>
                        {needsRenewal
                          ? t('common:integrations.connector_apps.refresh_needed')
                          : statusLabel(status)}
                      </Tag>
                    </div>
                    {app.description ? (
                      <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                        {app.description}
                      </p>
                    ) : null}
                    {(connected || needsRenewal) && account ? (
                      <p className="mt-1 break-words text-xs text-text-muted">
                        {t('common:integrations.connector_apps.account', { name: account })}
                      </p>
                    ) : null}
                    {needsRenewal ? (
                      <p className="mt-1 text-xs text-text-secondary">
                        {t('common:integrations.connector_apps.refresh_hint')}
                      </p>
                    ) : null}
                    {(connected || needsRenewal) && lastError ? (
                      <p className="mt-1 break-words text-xs text-error">
                        {t('common:integrations.connector_apps.upstream_error', {
                          message: lastError,
                        })}
                      </p>
                    ) : null}
                  </div>
                </div>
                {oauth && !connected && !needsRenewal ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void authorize(app)}
                    className="self-end max-md:h-11 sm:self-auto"
                    disabled={authorizingSlug === app.slug || refreshing || disconnecting}
                    data-testid={`authorize-connector-app-${app.slug}`}
                  >
                    {authorizingSlug === app.slug ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('common:integrations.connector_apps.authorize')}
                  </Button>
                ) : showDisconnect ? (
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {showRefresh ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-md:h-11"
                        onClick={() => void refreshConnection(app)}
                        disabled={refreshing || disconnecting}
                        data-testid={`retry-connector-app-${app.slug}`}
                      >
                        <RefreshCw
                          className={refreshing && !loadError ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
                          aria-hidden="true"
                        />
                        {t('common:integrations.connector_apps.refresh')}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-text-secondary hover:bg-fill-tertiary hover:text-error max-md:h-11"
                      onClick={() => setDisconnectTarget(app)}
                      disabled={refreshing || disconnecting}
                      data-testid={`disconnect-connector-app-${app.slug}`}
                    >
                      {disconnecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : null}
                      {t('common:integrations.connector_apps.disconnect')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
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
