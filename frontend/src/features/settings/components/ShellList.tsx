// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import { CommandLineIcon, PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import ShellEdit from './ShellEdit';
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
import { shellApis, UnifiedShell } from '@/apis/shells';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';

const ShellList: React.FC = () => {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [shells, setShells] = useState<UnifiedShell[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingShell, setEditingShell] = useState<UnifiedShell | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmShell, setDeleteConfirmShell] = useState<UnifiedShell | null>(null);

  const fetchShells = useCallback(async () => {
    setLoading(true);
    try {
      const response = await shellApis.getUnifiedShells();
      setShells(response.data || []);
    } catch (error) {
      console.error('Failed to fetch shells:', error);
      toast({
        variant: 'destructive',
        title: t('shells.errors.load_shells_failed'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    fetchShells();
  }, [fetchShells]);

  const handleDelete = async () => {
    if (!deleteConfirmShell) return;

    try {
      await shellApis.deleteShell(deleteConfirmShell.name);
      toast({
        title: t('shells.delete_success'),
      });
      setDeleteConfirmShell(null);
      fetchShells();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('shells.errors.delete_failed'),
        description: (error as Error).message,
      });
    }
  };

  const handleEdit = (shell: UnifiedShell) => {
    if (shell.type === 'public') return;
    setEditingShell(shell);
  };

  const handleEditClose = () => {
    setEditingShell(null);
    setIsCreating(false);
    fetchShells();
  };

  const getExecutionTypeLabel = (executionType?: string | null) => {
    if (executionType === 'local_engine') return 'Local Engine';
    if (executionType === 'external_api') return 'External API';
    return executionType || 'Unknown';
  };

  if (editingShell || isCreating) {
    return <ShellEdit shell={editingShell} onClose={handleEditClose} toast={toast} />;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('shells.title')}</h2>
        <p className="text-sm text-text-muted mb-1">{t('shells.description')}</p>
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
        {!loading && shells.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CommandLineIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('shells.no_shells')}</p>
            <p className="text-sm text-text-muted mt-1">{t('shells.no_shells_hint')}</p>
          </div>
        )}

        {/* Shell List */}
        {!loading && shells.length > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
              {shells.map(shell => {
                const isPublic = shell.type === 'public';
                return (
                  <Card
                    key={`${shell.type}-${shell.name}`}
                    className={`p-4 bg-base hover:bg-hover transition-colors ${isPublic ? 'border-l-2 border-l-primary' : ''}`}
                  >
                    <div className="flex items-center justify-between min-w-0">
                      <div className="flex items-center space-x-3 min-w-0 flex-1">
                        {isPublic ? (
                          <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                        ) : (
                          <CommandLineIcon className="w-5 h-5 text-primary flex-shrink-0" />
                        )}
                        <div className="flex flex-col justify-center min-w-0 flex-1">
                          <div className="flex items-center space-x-2 min-w-0">
                            <h3 className="text-base font-medium text-text-primary mb-0 truncate">
                              {shell.displayName || shell.name}
                            </h3>
                            {isPublic && (
                              <Tag variant="info" className="text-xs">
                                {t('shells.public')}
                              </Tag>
                            )}
                          </div>
                          {/* Show ID if different from display name */}
                          {!isPublic && shell.displayName && shell.displayName !== shell.name && (
                            <p className="text-xs text-text-muted truncate">ID: {shell.name}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 min-w-0">
                            <Tag variant="default" className="capitalize">
                              {shell.shellType}
                            </Tag>
                            <Tag variant="info" className="hidden sm:inline-flex text-xs">
                              {getExecutionTypeLabel(shell.executionType)}
                            </Tag>
                            {shell.baseImage && (
                              <Tag
                                variant="default"
                                className="hidden md:inline-flex text-xs truncate max-w-[200px]"
                              >
                                {shell.baseImage}
                              </Tag>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                        {/* Only show action buttons for user's own shells */}
                        {!isPublic && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEdit(shell)}
                              title={t('shells.edit')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hover:text-error"
                              onClick={() => setDeleteConfirmShell(shell)}
                              title={t('shells.delete')}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setIsCreating(true)}>
                {t('shells.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmShell} onOpenChange={() => setDeleteConfirmShell(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('shells.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('shells.delete_confirm_message', { name: deleteConfirmShell?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-error hover:bg-error/90">
              {t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ShellList;
