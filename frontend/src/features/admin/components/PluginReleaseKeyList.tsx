// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useCallback, useEffect, useState } from 'react'
import { ClipboardDocumentIcon, CheckIcon, KeyIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { adminApis, PluginReleaseKey, PluginReleaseKeyCreated } from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

const toLocalDateTimeValue = (date: Date) => {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localTime.toISOString().slice(0, 16)
}

const PluginReleaseKeyList: React.FC<{ showHeader?: boolean }> = ({ showHeader = true }) => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [releaseKeys, setReleaseKeys] = useState<PluginReleaseKey[]>([])
  const [loading, setLoading] = useState(true)
  const [togglingKeyId, setTogglingKeyId] = useState<number | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [keyDescription, setKeyDescription] = useState('')
  const [hasExpiry, setHasExpiry] = useState(false)
  const [expiresAt, setExpiresAt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<PluginReleaseKeyCreated | null>(null)
  const [showCreatedDialog, setShowCreatedDialog] = useState(false)
  const [copied, setCopied] = useState(false)

  const fetchReleaseKeys = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPluginReleaseKeys()
      setReleaseKeys(response.items || [])
    } catch (error) {
      console.error('Failed to fetch plugin release keys:', error)
      toast({
        variant: 'destructive',
        title: t('plugin_release_keys.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void fetchReleaseKeys()
  }, [fetchReleaseKeys])

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  const isNeverExpires = (dateString: string) => new Date(dateString).getFullYear() >= 9999

  const handleCreate = async () => {
    if (!keyName.trim()) {
      toast({ variant: 'destructive', title: t('plugin_release_keys.errors.name_required') })
      return
    }

    let expiry: Date | undefined
    if (hasExpiry) {
      expiry = new Date(expiresAt)
      if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
        toast({ variant: 'destructive', title: t('plugin_release_keys.errors.expiry_future') })
        return
      }
    }

    setIsCreating(true)
    try {
      const created = await adminApis.createPluginReleaseKey({
        name: keyName.trim(),
        description: keyDescription.trim() || undefined,
        ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
      })
      setCreatedKey(created)
      setCreateDialogOpen(false)
      setKeyName('')
      setKeyDescription('')
      setHasExpiry(false)
      setExpiresAt('')
      setShowCreatedDialog(true)
      toast({ title: t('plugin_release_keys.create_success') })
      void fetchReleaseKeys()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('plugin_release_keys.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsCreating(false)
    }
  }

  const handleToggleStatus = async (releaseKey: PluginReleaseKey) => {
    setTogglingKeyId(releaseKey.id)
    try {
      const updated = await adminApis.togglePluginReleaseKeyStatus(releaseKey.id)
      setReleaseKeys(previous => previous.map(key => (key.id === updated.id ? updated : key)))
      toast({
        title: updated.isActive
          ? t('plugin_release_keys.enabled_success')
          : t('plugin_release_keys.disabled_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('plugin_release_keys.errors.toggle_failed'),
        description: (error as Error).message,
      })
    } finally {
      setTogglingKeyId(null)
    }
  }

  const handleCopyKey = async () => {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ variant: 'destructive', title: t('plugin_release_keys.errors.copy_failed') })
    }
  }

  const handleCloseCreatedDialog = () => {
    setShowCreatedDialog(false)
    setCreatedKey(null)
    setCopied(false)
  }

  return (
    <div className="space-y-3" data-testid="plugin-release-key-list">
      {showHeader && (
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">
            {t('plugin_release_keys.title')}
          </h2>
          <p className="text-sm text-text-muted mb-1">{t('plugin_release_keys.description')}</p>
        </div>
      )}

      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && releaseKeys.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <KeyIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('plugin_release_keys.no_keys')}</p>
          </div>
        )}

        {!loading && releaseKeys.length > 0 && (
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
            {releaseKeys.map(releaseKey => (
              <Card
                key={releaseKey.id}
                className={`p-4 bg-base hover:bg-hover transition-colors ${!releaseKey.isActive ? 'opacity-60' : ''}`}
                data-testid={`plugin-release-key-row-${releaseKey.id}`}
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <KeyIcon
                      className={`w-5 h-5 flex-shrink-0 ${releaseKey.isActive ? 'text-primary' : 'text-text-muted'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary truncate">
                          {releaseKey.name}
                        </span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
                          {releaseKey.keyPrefix}
                        </code>
                        {!releaseKey.isActive && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-text-muted">
                            {t('plugin_release_keys.status_disabled')}
                          </span>
                        )}
                      </div>
                      {releaseKey.description && (
                        <p className="text-sm text-text-muted mt-0.5 truncate">
                          {releaseKey.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-1">
                        {releaseKey.createdBy && (
                          <span>
                            {t('plugin_release_keys.created_by')}: {releaseKey.createdBy}
                          </span>
                        )}
                        <span>
                          {t('plugin_release_keys.created_at')}: {formatDate(releaseKey.createdAt)}
                        </span>
                        <span>
                          {t('plugin_release_keys.last_used')}: {formatDate(releaseKey.lastUsedAt)}
                        </span>
                        <span>
                          {t('plugin_release_keys.expires_at')}:{' '}
                          {isNeverExpires(releaseKey.expiresAt)
                            ? t('plugin_release_keys.never_expires')
                            : formatDate(releaseKey.expiresAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <Switch
                      checked={releaseKey.isActive}
                      onCheckedChange={() => void handleToggleStatus(releaseKey)}
                      disabled={togglingKeyId === releaseKey.id}
                      title={
                        releaseKey.isActive
                          ? t('plugin_release_keys.disable')
                          : t('plugin_release_keys.enable')
                      }
                      data-testid={`plugin-release-key-toggle-${releaseKey.id}`}
                    />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton
                onClick={() => setCreateDialogOpen(true)}
                data-testid="plugin-release-key-create-button"
              >
                {t('plugin_release_keys.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent data-testid="plugin-release-key-create-dialog">
          <DialogHeader>
            <DialogTitle>{t('plugin_release_keys.create')}</DialogTitle>
            <DialogDescription>{t('plugin_release_keys.description')}</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary" htmlFor="release-key-name">
                {t('plugin_release_keys.name')}
              </label>
              <Input
                id="release-key-name"
                className="mt-2"
                placeholder={t('plugin_release_keys.name_placeholder')}
                value={keyName}
                onChange={event => setKeyName(event.target.value)}
                data-testid="plugin-release-key-name-input"
              />
            </div>
            <div>
              <label
                className="text-sm font-medium text-text-primary"
                htmlFor="release-key-description"
              >
                {t('plugin_release_keys.description_label')}
              </label>
              <Textarea
                id="release-key-description"
                className="mt-2"
                placeholder={t('plugin_release_keys.description_placeholder')}
                value={keyDescription}
                onChange={event => setKeyDescription(event.target.value)}
                rows={3}
                data-testid="plugin-release-key-description-input"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="release-key-has-expiry"
                  checked={hasExpiry}
                  onCheckedChange={checked => setHasExpiry(checked === true)}
                  data-testid="plugin-release-key-has-expiry-checkbox"
                />
                <label
                  className="text-sm font-medium text-text-primary"
                  htmlFor="release-key-has-expiry"
                >
                  {t('plugin_release_keys.use_expiry')}
                </label>
              </div>
              {hasExpiry && (
                <Input
                  id="release-key-expires-at"
                  type="datetime-local"
                  className="mt-2"
                  min={toLocalDateTimeValue(new Date())}
                  value={expiresAt}
                  onChange={event => setExpiresAt(event.target.value)}
                  data-testid="plugin-release-key-expires-input"
                />
              )}
              <p className="mt-1 text-xs text-text-muted">{t('plugin_release_keys.expiry_hint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={isCreating}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={isCreating || !keyName.trim() || (hasExpiry && !expiresAt)}
              data-testid="plugin-release-key-create-submit"
            >
              {isCreating ? (
                <div className="flex items-center">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {t('common:actions.creating')}
                </div>
              ) : (
                t('common:actions.create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreatedDialog} onOpenChange={handleCloseCreatedDialog}>
        <DialogContent data-testid="plugin-release-key-created-dialog">
          <DialogHeader>
            <DialogTitle>{t('plugin_release_keys.create_success')}</DialogTitle>
            <DialogDescription className="text-warning font-medium">
              {t('plugin_release_keys.warning_save_key')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium text-text-primary">
              {t('plugin_release_keys.key')}
            </label>
            <div className="mt-2 flex items-center gap-2">
              <code
                className="flex-1 bg-muted p-3 rounded text-sm font-mono break-all"
                data-testid="plugin-release-key-created-value"
              >
                {createdKey?.key}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void handleCopyKey()}
                title={t('common:actions.copy')}
                data-testid="plugin-release-key-copy-button"
              >
                {copied ? (
                  <CheckIcon className="w-4 h-4 text-success" />
                ) : (
                  <ClipboardDocumentIcon className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="primary" onClick={handleCloseCreatedDialog}>
              {t('common:actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default PluginReleaseKeyList
