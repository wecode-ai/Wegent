// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { KeyIcon, PlusIcon, CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiKeyApis, ApiKey, ApiKeyCreated } from '@/apis/api-keys'
import { cn } from '@/lib/utils'

interface ApiKeySelectionStepProps {
  apiKeys: ApiKey[]
  loading: boolean
  selectedKeyId: number | null
  newlyCreatedKey: ApiKeyCreated | null
  onSelectKey: (keyId: number | null, newKey?: ApiKeyCreated) => void
  onRefreshKeys: () => void
}

export function ApiKeySelectionStep({
  apiKeys,
  loading,
  selectedKeyId,
  newlyCreatedKey,
  onSelectKey,
  onRefreshKeys,
}: ApiKeySelectionStepProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
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
      setCreateDialogOpen(false)
      setKeyName('')
      toast({
        title: t('common:api_keys.create_success'),
      })
      // Auto-select the newly created key
      onSelectKey(created.id, created)
      onRefreshKeys()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:api_keys.errors.create_failed'),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsCreating(false)
    }
  }

  const handleSelectExistingKey = (key: ApiKey) => {
    // Skip inactive keys
    if (!key.is_active) return
    // Clear newly created key when selecting an existing key
    onSelectKey(key.id, undefined)
  }

  // Check if selected key is an existing one (not newly created)
  const isExistingKeySelected = selectedKeyId !== null && selectedKeyId !== newlyCreatedKey?.id

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-sm text-text-secondary">{t('common:device_setup.step1.description')}</p>

      {/* Loading State */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      )}

      {/* Empty State */}
      {!loading && apiKeys.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <KeyIcon className="w-12 h-12 text-text-muted mb-4" />
          <p className="text-text-muted">{t('common:device_setup.step1.no_keys')}</p>
        </div>
      )}

      {/* API Key List */}
      {!loading && apiKeys.length > 0 && (
        <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
          {apiKeys.map(apiKey => (
            <Card
              key={apiKey.id}
              className={cn(
                'p-3 transition-all',
                apiKey.is_active ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                selectedKeyId === apiKey.id
                  ? 'border-primary bg-primary/5'
                  : apiKey.is_active
                    ? 'hover:bg-hover'
                    : ''
              )}
              onClick={() => handleSelectExistingKey(apiKey)}
              aria-disabled={!apiKey.is_active}
              title={!apiKey.is_active ? t('common:api_keys.status_disabled') : undefined}
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                    selectedKeyId === apiKey.id ? 'border-primary bg-primary' : 'border-border'
                  )}
                >
                  {selectedKeyId === apiKey.id && <CheckIcon className="w-3 h-3 text-white" />}
                </div>
                <KeyIcon className="w-4 h-4 flex-shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-medium truncate',
                        apiKey.is_active ? 'text-text-primary' : 'text-text-muted'
                      )}
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
                  <div className="text-xs text-text-muted mt-0.5">
                    {t('common:api_keys.created_at')}: {formatDate(apiKey.created_at)}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Warning for existing key selection */}
      {isExistingKeySelected && (
        <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-md">
          <ExclamationTriangleIcon className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
          <p className="text-sm text-warning">
            {t('common:device_setup.step1.existing_key_warning')}
          </p>
        </div>
      )}

      {/* Create New Key Button */}
      {!loading && (
        <Button variant="outline" className="w-full" onClick={() => setCreateDialogOpen(true)}>
          <PlusIcon className="w-4 h-4 mr-2" />
          {t('common:device_setup.step1.create_new')}
        </Button>
      )}

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
              placeholder={t('common:device_setup.step1.key_name_placeholder')}
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !isCreating && handleCreate()}
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
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={isCreating || !keyName.trim()}
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
    </div>
  )
}

export default ApiKeySelectionStep
