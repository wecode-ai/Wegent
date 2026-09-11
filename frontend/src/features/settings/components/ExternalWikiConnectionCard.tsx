// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ExternalLink as BookExternalLink, Loader2, Plus, Trash2 } from 'lucide-react'

import { wikiApis, type WikiConnection, type WikiConnectionSummary } from '@/apis/wiki'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export default function ExternalWikiConnectionCard() {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [connection, setConnection] = useState<WikiConnection | null>(null)
  const [connections, setConnections] = useState<WikiConnectionSummary[]>([])
  const [connectionId, setConnectionId] = useState('legacy-default')
  const [displayName, setDisplayName] = useState('Wiki')
  const [connectorType, setConnectorType] = useState('wikijs')
  const [siteUrl, setSiteUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [defaultLocale, setDefaultLocale] = useState('')
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        try {
          const response = await wikiApis.listConnections()
          setConnections(response.connections)
          const current = response.connections[0]
          if (current) applyConnection(current)
          else resetNewConnection()
        } catch {
          const current = await wikiApis.getConnection()
          setConnection(current)
          setConnectorType(current.connector_type || 'wikijs')
          setSiteUrl(current.site_url)
          setDefaultLocale(current.default_locale || '')
          setEnabled(current.enabled)
        }
      } catch {
        toast({ variant: 'destructive', title: t('wiki.load_failed') })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [toast, t])

  const applyConnection = (current: WikiConnectionSummary) => {
    setConnection(current)
    setConnectionId(current.id)
    setDisplayName(current.display_name)
    setConnectorType(current.connector_type || 'wikijs')
    setSiteUrl(current.site_url)
    setDefaultLocale(current.default_locale || '')
    setEnabled(current.enabled)
    setApiKey('')
  }

  const resetNewConnection = () => {
    setConnection(null)
    setConnectionId('')
    setDisplayName('')
    setConnectorType('wikijs')
    setSiteUrl('')
    setDefaultLocale('')
    setEnabled(true)
    setApiKey('')
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      const payload = {
        connector_type: connectorType,
        site_url: siteUrl.trim(),
        // Keep the stored key when the user did not retype it.
        api_key: apiKey.trim(),
        default_locale: defaultLocale.trim() || null,
        enabled,
      }
      const saved =
        connectionId === 'legacy-default'
          ? await wikiApis.updateConnection(payload)
          : connectionId
            ? await wikiApis.updateNamedConnection(connectionId, {
                ...payload,
                display_name: displayName.trim(),
              })
            : await wikiApis.createConnection({
                ...payload,
                display_name: displayName.trim(),
              })
      setConnection(saved)
      setSiteUrl(saved.site_url)
      setApiKey('')
      try {
        const response = await wikiApis.listConnections()
        setConnections(response.connections)
        const selected = response.connections.find(
          item => item.id === ('id' in saved ? saved.id : connectionId)
        )
        if (selected) applyConnection(selected)
      } catch {
        // The legacy endpoint remains usable when multi-connection is disabled.
      }
      toast({ title: t('wiki.save_success') })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('wiki.save_failed'),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!connectionId) return
    try {
      setDeleting(true)
      await wikiApis.deleteConnection(connectionId)
      const response = await wikiApis.listConnections()
      setConnections(response.connections)
      if (response.connections[0]) applyConnection(response.connections[0])
      else resetNewConnection()
      setDeleteDialogOpen(false)
      toast({ title: t('wiki.delete_success') })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('wiki.delete_failed'),
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleTest = async () => {
    try {
      setTesting(true)
      const result = await wikiApis.testConnection({
        connection_id: connectionId || undefined,
        connector_type: connectorType,
        site_url: siteUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        default_locale: defaultLocale.trim() || null,
      })
      toast({
        variant: result.ok ? undefined : 'destructive',
        title: result.ok
          ? t('wiki.test_ok', { version: result.version || '' })
          : result.message || t('wiki.test_failed'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('wiki.test_failed'),
      })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-base p-4 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('wiki.loading')}
      </div>
    )
  }

  const canSave =
    !!siteUrl.trim() &&
    (connectionId === 'legacy-default' || !!displayName.trim()) &&
    (!enabled || !!apiKey.trim() || !!connection?.api_key_masked)

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-base p-4"
      data-testid="wiki-connection-card"
    >
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-base font-medium text-text-primary">
          <BookExternalLink className="h-4 w-4" />
          {t('wiki.title')}
        </h3>
        <p className="text-sm text-text-muted">{t('wiki.description')}</p>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={connectionId}
          onChange={event => {
            const selected = connections.find(item => item.id === event.target.value)
            if (selected) applyConnection(selected)
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
          data-testid="wiki-connection-select"
        >
          {!connectionId && <option value="">{t('wiki.new_connection')}</option>}
          {connections.map(item => (
            <option key={item.id} value={item.id}>
              {item.display_name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          onClick={resetNewConnection}
          data-testid="wiki-add-connection-button"
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('wiki.add_connection')}
        </Button>
      </div>

      {connectionId !== 'legacy-default' && (
        <div className="space-y-1.5">
          <Label htmlFor="wiki-display-name">{t('wiki.name_label')}</Label>
          <Input
            id="wiki-display-name"
            value={displayName}
            onChange={event => setDisplayName(event.target.value)}
            data-testid="wiki-display-name-input"
          />
        </div>
      )}

      <div className="flex items-center justify-between rounded-md border border-border/70 bg-surface px-3 py-2.5">
        <div className="space-y-0.5 pr-4">
          <Label htmlFor="wiki-enabled" className="text-sm font-medium">
            {t('wiki.enable_label')}
          </Label>
          <p className="text-xs text-text-muted">{t('wiki.enable_hint')}</p>
        </div>
        <Switch
          id="wiki-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid="wiki-enabled-switch"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiki-connector-type">{t('wiki.connector_label')}</Label>
        <select
          id="wiki-connector-type"
          className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary"
          value={connectorType}
          onChange={event => setConnectorType(event.target.value)}
          data-testid="wiki-connector-type-select"
        >
          {(connection?.available_connectors || [{ type: 'wikijs', display_name: 'Wiki.js' }]).map(
            option => (
              <option key={option.type} value={option.type}>
                {option.display_name}
              </option>
            )
          )}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiki-site-url">{t('wiki.url_label')}</Label>
        <Input
          id="wiki-site-url"
          value={siteUrl}
          onChange={event => setSiteUrl(event.target.value)}
          placeholder={t('wiki.url_placeholder')}
          data-testid="wiki-site-url-input"
        />
        <p className="text-xs text-text-muted">{t('wiki.url_hint')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiki-api-key">{t('wiki.api_key_label')}</Label>
        <Input
          id="wiki-api-key"
          type="password"
          value={apiKey}
          onChange={event => setApiKey(event.target.value)}
          placeholder={
            connection?.api_key_masked
              ? t('wiki.api_key_masked_placeholder', {
                  masked: connection.api_key_masked,
                })
              : t('wiki.api_key_placeholder')
          }
          data-testid="wiki-api-key-input"
        />
        <p className="text-xs text-text-muted">{t('wiki.api_key_hint')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiki-default-locale">{t('wiki.locale_label')}</Label>
        <Input
          id="wiki-default-locale"
          value={defaultLocale}
          onChange={event => setDefaultLocale(event.target.value)}
          placeholder={t('wiki.locale_placeholder')}
          data-testid="wiki-default-locale-input"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="outline"
          type="button"
          onClick={handleTest}
          disabled={testing || !siteUrl.trim()}
          data-testid="wiki-test-connection-button"
        >
          {testing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('wiki.testing')}
            </>
          ) : (
            t('wiki.test')
          )}
        </Button>
        {connectionId && (
          <Button
            variant="outline"
            type="button"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={deleting}
            data-testid="wiki-delete-connection-button"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('wiki.delete')}
          </Button>
        )}
        <Button
          variant="primary"
          type="button"
          onClick={handleSave}
          disabled={saving || !canSave}
          data-testid="wiki-save-connection-button"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('wiki.saving')}
            </>
          ) : (
            t('wiki.save')
          )}
        </Button>
      </div>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={open => {
          if (!deleting) setDeleteDialogOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:wiki.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:wiki.delete_confirm_message', {
                name: displayName || 'Wiki',
              })}
              <span className="mt-2 block">{t('common:wiki.delete_reference_hint')}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-error hover:bg-error/90"
              disabled={deleting}
              onClick={event => {
                event.preventDefault()
                void handleDelete()
              }}
              data-testid="wiki-confirm-delete-connection-button"
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('wiki.deleting')}
                </>
              ) : (
                t('wiki.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
