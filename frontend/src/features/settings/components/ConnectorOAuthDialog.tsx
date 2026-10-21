// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { adminApis, type UserConnectorApp } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tag } from '@/components/ui/tag'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  authorizeConnectorApp,
  connectorOAuthErrorMessage,
} from '@/features/settings/connectorOAuth'

interface ConnectorOAuthDialogProps {
  open: boolean
  slug: string
  onOpenChange: (open: boolean) => void
  onAuthorized?: () => void
}

/**
 * Authorization dialog opened from a conversation link
 * (`wegent://modal/connector-oauth?slug=...`).
 */
export default function ConnectorOAuthDialog({
  open,
  slug,
  onOpenChange,
  onAuthorized,
}: ConnectorOAuthDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [app, setApp] = useState<UserConnectorApp | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [authorizing, setAuthorizing] = useState(false)

  const loadApp = useCallback(async () => {
    if (!slug) return
    setLoading(true)
    setLoadError(null)
    try {
      const apps = await adminApis.getUserConnectorApps()
      setApp(apps.find(candidate => candidate.slug === slug) ?? null)
    } catch (error) {
      setApp(null)
      setLoadError((error as Error).message)
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.load_failed'),
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }, [slug, t, toast])

  useEffect(() => {
    if (!open) return
    setApp(null)
    setLoadError(null)
    void loadApp()
  }, [open, loadApp])

  const authorize = async () => {
    if (!app) return
    setAuthorizing(true)
    try {
      await authorizeConnectorApp(app.slug)
      toast({ title: t('common:integrations.connector_apps.authorized') })
      onAuthorized?.()
      onOpenChange(false)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:integrations.connector_apps.authorization_failed'),
        description: connectorOAuthErrorMessage(t, error),
      })
    } finally {
      setAuthorizing(false)
    }
  }

  const connected = app?.connection.status === 'connected'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="connector-oauth-dialog">
        <DialogHeader>
          <DialogTitle>
            {app
              ? t('common:integrations.connector_apps.dialog_title', { name: app.name })
              : t('common:integrations.connector_apps.title')}
          </DialogTitle>
          <DialogDescription>
            {t('common:integrations.connector_apps.dialog_description')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        ) : loadError ? (
          <div className="space-y-3 py-2" data-testid="connector-oauth-load-error">
            <p className="break-words text-sm text-error">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadApp()}
              data-testid="retry-connector-oauth-load"
            >
              {t('common:integrations.connector_apps.retry')}
            </Button>
          </div>
        ) : !app ? (
          <p className="py-4 text-sm text-text-muted" data-testid="connector-oauth-unavailable">
            {t('common:integrations.connector_apps.unavailable')}
          </p>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text-primary">{app.name}</span>
              <Tag variant={connected ? 'success' : 'default'}>
                {t(`common:integrations.connector_apps.status.${app.connection.status}`)}
              </Tag>
            </div>
            {app.description ? (
              <p className="text-sm text-text-secondary">{app.description}</p>
            ) : null}
            {connected && app.connection.external_account_name ? (
              <p className="text-xs text-text-muted">
                {t('common:integrations.connector_apps.account', {
                  name: app.connection.external_account_name,
                })}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="connector-oauth-cancel"
          >
            {t('common:actions.close')}
          </Button>
          {app && !connected ? (
            <Button
              variant="primary"
              onClick={() => void authorize()}
              disabled={authorizing}
              data-testid="connector-oauth-authorize"
            >
              {authorizing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('common:integrations.connector_apps.authorize')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
