// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import '@wecode/i18n'
import { AlertCircle, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import {
  deletePublishedAppAdmin,
  listAllPublishedApps,
  type PublishedApp,
} from '@wecode/api/published-apps'
import { useWecodeTranslation } from '@wecode/i18n/useWecodeTranslation'
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

function getTaskId(app: PublishedApp): string {
  const value = app.task_id ?? app.taskid ?? app.taskId
  return value == null || value === '' ? '' : String(value)
}

function formatDomain(appUrl: string): string {
  if (!appUrl) {
    return '-'
  }

  try {
    return new URL(appUrl).host
  } catch {
    return appUrl
  }
}

function getStatusVariant(app: PublishedApp): 'success' | 'secondary' {
  if (app.is_online) {
    return 'success'
  }
  return 'secondary'
}

function PublishedAppStatus({ app }: { app: PublishedApp }) {
  const { t } = useWecodeTranslation()
  const label = app.is_online
    ? t('published_apps.status.online')
    : t('published_apps.status.offline')

  return (
    <Badge variant={getStatusVariant(app)} className="capitalize">
      {label}
    </Badge>
  )
}

export default function AdminPublishedAppsPage() {
  const { t } = useWecodeTranslation()
  const translateRef = useRef(t)
  const [apps, setApps] = useState<PublishedApp[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    translateRef.current = t
  }, [t])

  const loadApps = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await listAllPublishedApps()
      setApps(data.apps)
      setTotal(data.total)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('admin_published_apps.errors.load_failed')
      setError(message)
      setApps([])
      setTotal(0)
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadApps()
  }, [loadApps])

  const handleDeleteApp = useCallback(
    async (appName: string, username: string) => {
      if (
        !window.confirm(
          translateRef.current('admin_published_apps.confirm_delete', { appName, username })
        )
      ) {
        return
      }

      const key = `${username}/${appName}`
      setDeletingKey(key)
      setError(null)
      try {
        await deletePublishedAppAdmin(appName, username)
        await loadApps()
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : translateRef.current('admin_published_apps.errors.delete_failed')
        setError(message)
      } finally {
        setDeletingKey(null)
      }
    },
    [loadApps]
  )

  return (
    <div className="space-y-4" data-testid="admin-published-apps-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            {t('admin_published_apps.title')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t('admin_published_apps.description')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {t('admin_published_apps.summary', { count: total })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={loadApps}
          disabled={isLoading}
          className="h-11 min-w-[44px] sm:h-10"
          data-testid="refresh-admin-published-apps-button"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t('admin_published_apps.refresh')}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card padding="none" className="overflow-hidden">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-text-muted">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            <span className="text-sm">{t('admin_published_apps.loading')}</span>
          </div>
        ) : apps.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center px-4 text-center">
            <p className="text-sm font-medium text-text-primary">
              {t('admin_published_apps.empty')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin_published_apps.columns.username')}</TableHead>
                  <TableHead>{t('admin_published_apps.columns.name')}</TableHead>
                  <TableHead>{t('admin_published_apps.columns.task_id')}</TableHead>
                  <TableHead>{t('admin_published_apps.columns.domain')}</TableHead>
                  <TableHead>{t('admin_published_apps.columns.created_at')}</TableHead>
                  <TableHead>{t('admin_published_apps.columns.status')}</TableHead>
                  <TableHead className="text-right">
                    {t('admin_published_apps.columns.action')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map(app => {
                  const taskId = getTaskId(app)
                  const key = `${app.username}/${app.app_name}/${taskId}`
                  const deletingThisApp = deletingKey === `${app.username}/${app.app_name}`

                  return (
                    <TableRow key={key}>
                      <TableCell>{app.username}</TableCell>
                      <TableCell className="font-medium">{app.app_name}</TableCell>
                      <TableCell>{taskId || '-'}</TableCell>
                      <TableCell className="max-w-[360px] truncate" title={app.app_url}>
                        {formatDomain(app.app_url)}
                      </TableCell>
                      <TableCell>{formatUnixTimestamp(app.created_at)}</TableCell>
                      <TableCell>
                        <PublishedAppStatus app={app} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteApp(app.app_name, app.username)}
                            disabled={deletingThisApp}
                            data-testid={`admin-delete-app-${app.username}-${app.app_name}-button`}
                          >
                            {deletingThisApp ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                            {deletingThisApp
                              ? t('admin_published_apps.actions.deleting')
                              : t('admin_published_apps.actions.delete')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}
