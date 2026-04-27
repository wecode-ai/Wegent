// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { listPublishedApps, type PublishedApp } from '@wecode/api/published-apps'
import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function formatUnixTimestamp(value: number): string {
  if (!value) {
    return '-'
  }
  return new Date(value * 1000).toLocaleString()
}

function getStatusVariant(app: PublishedApp): 'success' | 'warning' | 'secondary' {
  if (app.is_online && app.ready) {
    return 'success'
  }
  if (app.status === 'running') {
    return 'warning'
  }
  return 'secondary'
}

function PublishedAppStatus({ app }: { app: PublishedApp }) {
  const { t } = useTranslation('wecode')
  const labels = [
    app.status === 'running' ? t('published_apps.status.running') : app.status,
    app.ready ? t('published_apps.status.ready') : null,
    app.is_online ? t('published_apps.status.online') : null,
  ].filter(Boolean)

  return (
    <Badge variant={getStatusVariant(app)} className="capitalize">
      {labels.join(' / ')}
    </Badge>
  )
}

export default function PublishedAppsPage() {
  const { t } = useTranslation('wecode')
  const { user, isLoading: isUserLoading } = useUser()
  const [apps, setApps] = useState<PublishedApp[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadApps = useCallback(async () => {
    if (!user?.user_name) {
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const data = await listPublishedApps(user.user_name)
      setApps(data.apps)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('published_apps.errors.load_failed'))
      setApps([])
      setTotal(0)
    } finally {
      setIsLoading(false)
    }
  }, [t, user?.user_name])

  useEffect(() => {
    if (!isUserLoading) {
      loadApps()
    }
  }, [isUserLoading, loadApps])

  const loading = isUserLoading || isLoading

  return (
    <div className="space-y-4" data-testid="published-apps-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{t('published_apps.title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t('published_apps.description', { username: user?.user_name || '-' })}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {t('published_apps.summary', { count: total })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={loadApps}
          disabled={loading || !user?.user_name}
          className="h-11 min-w-[44px] sm:h-10"
          data-testid="refresh-published-apps-button"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t('published_apps.refresh')}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card padding="none" className="overflow-hidden">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-text-muted">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            <span className="text-sm">{t('published_apps.loading')}</span>
          </div>
        ) : apps.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center px-4 text-center">
            <p className="text-sm font-medium text-text-primary">{t('published_apps.empty')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('published_apps.empty_hint')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('published_apps.columns.name')}</TableHead>
                <TableHead>{t('published_apps.columns.status')}</TableHead>
                <TableHead>{t('published_apps.columns.env')}</TableHead>
                <TableHead>{t('published_apps.columns.namespace')}</TableHead>
                <TableHead>{t('published_apps.columns.pod')}</TableHead>
                <TableHead>{t('published_apps.columns.created_at')}</TableHead>
                <TableHead>{t('published_apps.columns.last_check_at')}</TableHead>
                <TableHead className="text-right">{t('published_apps.columns.action')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map(app => (
                <TableRow key={`${app.namespace}/${app.app_name}`}>
                  <TableCell className="font-medium">{app.app_name}</TableCell>
                  <TableCell>
                    <PublishedAppStatus app={app} />
                  </TableCell>
                  <TableCell>{app.env || '-'}</TableCell>
                  <TableCell>{app.namespace || '-'}</TableCell>
                  <TableCell className="max-w-[280px] truncate" title={app.pod_name}>
                    {app.pod_name || '-'}
                  </TableCell>
                  <TableCell>{formatUnixTimestamp(app.created_at)}</TableCell>
                  <TableCell>{formatUnixTimestamp(app.last_check_at)}</TableCell>
                  <TableCell className="text-right">
                    {app.app_url ? (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={app.app_url}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`open-published-app-${app.app_name}-link`}
                        >
                          <ExternalLink className="h-4 w-4" />
                          {t('published_apps.actions.open')}
                        </a>
                      </Button>
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
