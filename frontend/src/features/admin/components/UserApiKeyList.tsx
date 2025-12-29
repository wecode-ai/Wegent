// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { KeyIcon, TrashIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { adminApis, AdminUserApiKey } from '@/apis/admin';

const UserApiKeyList: React.FC = () => {
  const { t } = useTranslation('admin');
  const { toast } = useToast();
  const [apiKeys, setApiKeys] = useState<AdminUserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<AdminUserApiKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [togglingKeyId, setTogglingKeyId] = useState<number | null>(null);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 20;

  const fetchApiKeys = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminApis.getUserApiKeys(page, limit, includeInactive, searchQuery || undefined);
      setApiKeys(response.items || []);
      setTotal(response.total);
    } catch (error) {
      console.error('Failed to fetch user API keys:', error);
      toast({
        variant: 'destructive',
        title: t('user_api_keys.errors.load_failed'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast, t, page, includeInactive, searchQuery]);

  useEffect(() => {
    fetchApiKeys();
  }, [fetchApiKeys]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const isNeverExpires = (dateString: string) => {
    const date = new Date(dateString);
    return date.getFullYear() >= 9999;
  };

  const handleToggleStatus = async (apiKey: AdminUserApiKey) => {
    setTogglingKeyId(apiKey.id);
    try {
      const updated = await adminApis.toggleUserApiKeyStatus(apiKey.id);
      setApiKeys(prev => prev.map(k => (k.id === updated.id ? updated : k)));
      toast({
        title: updated.is_active
          ? t('user_api_keys.enabled_success')
          : t('user_api_keys.disabled_success'),
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('user_api_keys.errors.toggle_failed'),
        description: (error as Error).message,
      });
    } finally {
      setTogglingKeyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmKey) return;

    setIsDeleting(true);
    try {
      await adminApis.deleteUserApiKey(deleteConfirmKey.id);
      toast({
        title: t('user_api_keys.delete_success'),
      });
      setDeleteConfirmKey(null);
      fetchApiKeys();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('user_api_keys.errors.delete_failed'),
        description: (error as Error).message,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSearch = () => {
    setPage(1);
    fetchApiKeys();
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('user_api_keys.title')}
        </h2>
        <p className="text-sm text-text-muted mb-1">{t('user_api_keys.description')}</p>
      </div>

      {/* Search and Filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px] flex gap-2">
          <Input
            placeholder={t('user_api_keys.search_placeholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="flex-1"
          />
          <Button variant="outline" size="icon" onClick={handleSearch}>
            <MagnifyingGlassIcon className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-inactive"
            checked={includeInactive}
            onCheckedChange={(checked: boolean) => {
              setIncludeInactive(checked);
              setPage(1);
            }}
          />
          <label htmlFor="include-inactive" className="text-sm text-text-secondary cursor-pointer">
            {t('user_api_keys.show_disabled')}
          </label>
        </div>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[60vh] flex flex-col overflow-y-auto custom-scrollbar">
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
            <p className="text-text-muted">{t('user_api_keys.no_keys')}</p>
          </div>
        )}

        {/* API Key List */}
        {!loading && apiKeys.length > 0 && (
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
            {apiKeys.map(apiKey => (
              <Card
                key={apiKey.id}
                className={`p-4 bg-base hover:bg-hover transition-colors ${!apiKey.is_active ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <KeyIcon
                      className={`w-5 h-5 flex-shrink-0 ${apiKey.is_active ? 'text-primary' : 'text-text-muted'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-text-primary truncate">
                          {apiKey.name}
                        </span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
                          {apiKey.key_prefix}
                        </code>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                          {apiKey.user_name}
                        </span>
                        {!apiKey.is_active && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-text-muted">
                            {t('user_api_keys.status_disabled')}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-1">
                        <span>
                          {t('user_api_keys.created_at')}: {formatDate(apiKey.created_at)}
                        </span>
                        <span>
                          {t('user_api_keys.last_used')}: {formatDate(apiKey.last_used_at)}
                        </span>
                        <span>
                          {t('user_api_keys.expires_at')}:{' '}
                          {isNeverExpires(apiKey.expires_at)
                            ? t('user_api_keys.never_expires')
                            : formatDate(apiKey.expires_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <Switch
                      checked={apiKey.is_active}
                      onCheckedChange={() => handleToggleStatus(apiKey)}
                      disabled={togglingKeyId === apiKey.id}
                      title={
                        apiKey.is_active
                          ? t('user_api_keys.disable')
                          : t('user_api_keys.enable')
                      }
                    />
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
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-text-muted">
            {t('common:common.page_info', { current: page, total: totalPages })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('common:common.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              {t('common:common.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmKey}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmKey(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('user_api_keys.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('user_api_keys.delete_confirm_message', {
                name: deleteConfirmKey?.name,
                user: deleteConfirmKey?.user_name,
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
  );
};

export default UserApiKeyList;
