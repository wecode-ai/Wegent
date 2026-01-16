// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { KeyIcon, TrashIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiKeyApis, ApiKey, ApiKeyCreated } from '@/apis/api-keys'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const ApiKeyList: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<ApiKey | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // Created key display state
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null)
  const [showCreatedDialog, setShowCreatedDialog] = useState(false)
  const [copied, setCopied] = useState(false)

  const fetchApiKeys = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiKeyApis.getApiKeys()
      setApiKeys(response.items || [])
    } catch (error) {
      console.error('Failed to fetch API keys:', error)
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchApiKeys()
  }, [fetchApiKeys])

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const isNeverExpires = (dateString: string) => {
    const date = new Date(dateString)
    return date.getFullYear() >= 9999
  }

  const handleCreate = async () => {
    if (!keyName.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.name_required'),
      })
      return
    }

    setIsCreating(true)
    try {
      const created = await apiKeyApis.createApiKey({ name: keyName.trim() })
      setCreatedKey(created)
      setCreateDialogOpen(false)
      setKeyName('')
      setShowCreatedDialog(true)
      toast({
        title: t('common:api_keys.create_success'),
      })
      fetchApiKeys()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmKey) return

    setIsDeleting(true)
    try {
      await apiKeyApis.deleteApiKey(deleteConfirmKey.id)
      toast({
        title: t('common:api_keys.delete_success'),
      })
      setDeleteConfirmKey(null)
      fetchApiKeys()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCopyKey = async () => {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({
        variant: 'destructive',
        title: 'Failed to copy',
      })
    }
  }

  const handleCloseCreatedDialog = () => {
    setShowCreatedDialog(false)
    setCreatedKey(null)
    setCopied(false)
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('common:api_keys.title')}
        </h2>
        <p className="text-sm text-text-muted mb-1">{t('common:api_keys.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}
        {/* Empty State */}
        {!loading && apiKeys.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <KeyIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:api_keys.no_keys')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('common:api_keys.no_keys_description')}
            </p>
          </div>
        )}

        {/* API Key List */}
        {!loading && apiKeys.length > 0 && (
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
            {apiKeys.map(apiKey => (
              <Card key={apiKey.id} className="p-4 bg-base hover:bg-hover transition-colors">
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <KeyIcon className="w-5 h-5 flex-shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium truncate ${apiKey.is_active ? 'text-text-primary' : 'text-text-muted'}`}
                        >
                          {apiKey.name}
                        </span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
                          {apiKey.key_prefix}
                        </code>
                        {!apiKey.is_active && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-error/10 text-error">
                            {t('common:api_keys.status_disabled')}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-1">
                        <span>
                          {t('common:api_keys.created_at')}: {formatDate(apiKey.created_at)}
                        </span>
                        <span>
                          {t('common:api_keys.last_used')}: {formatDate(apiKey.last_used_at)}
                        </span>
                        <span>
                          {t('common:api_keys.expires_at')}:{' '}
                          {isNeverExpires(apiKey.expires_at)
                            ? t('common:api_keys.never_expires')
                            : formatDate(apiKey.expires_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => setDeleteConfirmKey(apiKey)}
                      title={t('common:actions.delete')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setCreateDialogOpen(true)}>
                {t('common:api_keys.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create API Key Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:api_keys.create')}</DialogTitle>
            <DialogDescription>{t('common:api_keys.description')}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium text-text-primary">
              {t('common:api_keys.name')}
            </label>
            <Input
              className="mt-2"
              placeholder={t('common:api_keys.name_placeholder')}
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={isCreating}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || !keyName.trim()}>
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

      {/* Created Key Display Dialog */}
      <Dialog open={showCreatedDialog} onOpenChange={handleCloseCreatedDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:api_keys.create_success')}</DialogTitle>
            <DialogDescription className="text-warning font-medium">
              {t('common:api_keys.warning_save_key')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium text-text-primary">
              {t('common:api_keys.key')}
            </label>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 bg-muted p-3 rounded text-sm font-mono break-all">
                {createdKey?.key}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopyKey}
                title={t('common:api_keys.copy')}
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
            <Button onClick={handleCloseCreatedDialog}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmKey}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmKey(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:api_keys.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:api_keys.delete_confirm_message', { name: deleteConfirmKey?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-error hover:bg-error/90"
            >
              {isDeleting ? (
                <div className="flex items-center">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {t('common:actions.deleting')}
                </div>
              ) : (
                t('common:actions.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ApiKeyList
