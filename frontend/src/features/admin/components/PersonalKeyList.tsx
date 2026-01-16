// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { KeyIcon, TrashIcon, UserIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
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
import { adminApis, AdminPersonalKey } from '@/apis/admin'

const PersonalKeyList: React.FC<{ showHeader?: boolean }> = ({ showHeader = true }) => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [personalKeys, setPersonalKeys] = useState<AdminPersonalKey[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<AdminPersonalKey | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [togglingKeyId, setTogglingKeyId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const fetchPersonalKeys = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPersonalKeys(1, 100, debouncedSearch || undefined)
      setPersonalKeys(response.items || [])
    } catch (error) {
      console.error('Failed to fetch personal keys:', error)
      toast({
        variant: 'destructive',
        title: t('personal_keys.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t, debouncedSearch])

  useEffect(() => {
    fetchPersonalKeys()
  }, [fetchPersonalKeys])

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

  const handleToggleStatus = async (personalKey: AdminPersonalKey) => {
    setTogglingKeyId(personalKey.id)
    try {
      const updated = await adminApis.togglePersonalKeyStatus(personalKey.id)
      setPersonalKeys(prev => prev.map(k => (k.id === updated.id ? updated : k)))
      toast({
        title: updated.is_active
          ? t('personal_keys.enabled_success')
          : t('personal_keys.disabled_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('personal_keys.errors.toggle_failed'),
        description: (error as Error).message,
      })
    } finally {
      setTogglingKeyId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmKey) return

    setIsDeleting(true)
    try {
      await adminApis.deletePersonalKey(deleteConfirmKey.id)
      toast({
        title: t('personal_keys.delete_success'),
      })
      setDeleteConfirmKey(null)
      fetchPersonalKeys()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('personal_keys.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      {showHeader && (
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">
            {t('personal_keys.title')}
          </h2>
          <p className="text-sm text-text-muted mb-1">{t('personal_keys.description')}</p>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-muted" />
        <Input
          placeholder={t('personal_keys.search_placeholder')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
        />
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
        {!loading && personalKeys.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <KeyIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('personal_keys.no_keys')}</p>
          </div>
        )}

        {/* Personal Key List */}
        {!loading && personalKeys.length > 0 && (
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
            {personalKeys.map(personalKey => (
              <Card
                key={personalKey.id}
                className={`p-4 bg-base hover:bg-hover transition-colors ${!personalKey.is_active ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <KeyIcon
                      className={`w-5 h-5 flex-shrink-0 ${personalKey.is_active ? 'text-primary' : 'text-text-muted'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-text-primary truncate">
                          {personalKey.name}
                        </span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
                          {personalKey.key_prefix}
                        </code>
                        {!personalKey.is_active && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-text-muted">
                            {t('personal_keys.status_disabled')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-sm text-text-secondary mt-0.5">
                        <UserIcon className="w-3 h-3" />
                        <span>{personalKey.user_name}</span>
                      </div>
                      {personalKey.description && (
                        <p className="text-sm text-text-muted mt-0.5 truncate">
                          {personalKey.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-1">
                        <span>
                          {t('personal_keys.created_at')}: {formatDate(personalKey.created_at)}
                        </span>
                        <span>
                          {t('personal_keys.last_used')}: {formatDate(personalKey.last_used_at)}
                        </span>
                        <span>
                          {t('personal_keys.expires_at')}:{' '}
                          {isNeverExpires(personalKey.expires_at)
                            ? t('personal_keys.never_expires')
                            : formatDate(personalKey.expires_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <Switch
                      checked={personalKey.is_active}
                      onCheckedChange={() => handleToggleStatus(personalKey)}
                      disabled={togglingKeyId === personalKey.id}
                      title={
                        personalKey.is_active
                          ? t('personal_keys.disable')
                          : t('personal_keys.enable')
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => setDeleteConfirmKey(personalKey)}
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
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmKey}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmKey(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('personal_keys.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('personal_keys.delete_confirm_message', {
                name: deleteConfirmKey?.name,
                owner: deleteConfirmKey?.user_name,
              })}
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

export default PersonalKeyList
