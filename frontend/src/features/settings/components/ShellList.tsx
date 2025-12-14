// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ResourceListItem } from '@/components/common/ResourceListItem';
import { Tag } from '@/components/ui/tag';
import { CommandLineIcon, PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';
import ShellEditDialog from './ShellEditDialog';
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

interface ShellListProps {
  scope?: 'personal' | 'group' | 'all';
  groupName?: string;
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>;
  onEditResource?: (namespace: string) => void;
}

const ShellList: React.FC<ShellListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
}) => {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [shells, setShells] = useState<UnifiedShell[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingShell, setEditingShell] = useState<UnifiedShell | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirmShell, setDeleteConfirmShell] = useState<UnifiedShell | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchShells = useCallback(async () => {
    setLoading(true);
    try {
      const response = await shellApis.getUnifiedShells(scope, groupName);
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
  }, [toast, t, scope, groupName]);

  useEffect(() => {
    fetchShells();
  }, [fetchShells, scope, groupName]);

  // Categorize shells by type
  const { groupShells, publicShells, userShells } = React.useMemo(() => {
    const group: UnifiedShell[] = [];
    const publicList: UnifiedShell[] = [];
    const user: UnifiedShell[] = [];

    for (const shell of shells) {
      if (shell.type === 'group') {
        group.push(shell);
      } else if (shell.type === 'public') {
        publicList.push(shell);
      } else {
        user.push(shell);
      }
    }

    return {
      groupShells: group,
      publicShells: publicList,
      userShells: user,
    };
  }, [shells]);

  const totalShells = groupShells.length + publicShells.length + userShells.length;

  // Helper function to check permissions for a specific group resource
  const canEditGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false;
    const role = groupRoleMap.get(namespace);
    return role === 'Owner' || role === 'Maintainer' || role === 'Developer';
  };

  const canDeleteGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false;
    const role = groupRoleMap.get(namespace);
    return role === 'Owner' || role === 'Maintainer';
  };

  const canCreateInAnyGroup =
    groupRoleMap &&
    Array.from(groupRoleMap.values()).some(role => role === 'Owner' || role === 'Maintainer');

  const handleDelete = async () => {
    if (!deleteConfirmShell) return;

    setIsDeleting(true);
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
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEdit = (shell: UnifiedShell) => {
    if (shell.type === 'public') return;

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && shell.namespace && shell.namespace !== 'default') {
      onEditResource(shell.namespace);
    }

    setEditingShell(shell);
    setDialogOpen(true);
  };

  const handleEditClose = () => {
    setEditingShell(null);
    setDialogOpen(false);
    fetchShells();
  };

  const handleCreate = () => {
    setEditingShell(null);
    setDialogOpen(true);
  };

  const getExecutionTypeLabel = (executionType?: string | null) => {
    if (executionType === 'local_engine') return 'Local Engine';
    if (executionType === 'external_api') return 'External API';
    return executionType || 'Unknown';
  };

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
        {!loading && totalShells === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CommandLineIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('shells.no_shells')}</p>
            <p className="text-sm text-text-muted mt-1">{t('shells.no_shells_hint')}</p>
          </div>
        )}

        {/* Shell List - Categorized */}
        {!loading && totalShells > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 p-1">
              {/* User Shells Section - 我的执行器放在最上面 */}
              {userShells.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('shells.my_shells')} ({userShells.length})
                  </h3>
                  <div className="space-y-3">
                    {userShells.map(shell => (
                      <Card
                        key={`user-${shell.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={shell.name}
                            displayName={shell.displayName || undefined}
                            showId={true}
                            icon={<CommandLineIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'shell-type',
                                label: shell.shellType,
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'execution-type',
                                label: getExecutionTypeLabel(shell.executionType),
                                variant: 'info',
                                className: 'hidden sm:inline-flex text-xs',
                              },
                              ...(shell.baseImage
                                ? [
                                    {
                                      key: 'base-image',
                                      label: shell.baseImage,
                                      variant: 'default' as const,
                                      className:
                                        'hidden md:inline-flex text-xs truncate max-w-[200px]',
                                    },
                                  ]
                                : []),
                            ]}
                          />
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
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
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Group Shells Section */}
              {groupShells.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('shells.group_shells')} ({groupShells.length})
                  </h3>
                  <div className="space-y-3">
                    {groupShells.map(shell => (
                      <Card
                        key={`group-${shell.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={shell.name}
                            displayName={shell.displayName || undefined}
                            showId={true}
                            icon={<CommandLineIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'shell-type',
                                label: shell.shellType,
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'execution-type',
                                label: getExecutionTypeLabel(shell.executionType),
                                variant: 'info',
                                className: 'hidden sm:inline-flex text-xs',
                              },
                              ...(shell.baseImage
                                ? [
                                    {
                                      key: 'base-image',
                                      label: shell.baseImage,
                                      variant: 'default' as const,
                                      className:
                                        'hidden md:inline-flex text-xs truncate max-w-[200px]',
                                    },
                                  ]
                                : []),
                            ]}
                          >
                            <Tag variant="success" className="text-xs">
                              {t('shells.group')}
                            </Tag>
                          </ResourceListItem>
                          {/* Action buttons for group resources */}
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                            {canEditGroupResource(shell.namespace || 'default') && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleEdit(shell)}
                                title={t('shells.edit')}
                              >
                                <PencilIcon className="w-4 h-4" />
                              </Button>
                            )}
                            {canDeleteGroupResource(shell.namespace || 'default') && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:text-error"
                                onClick={() => setDeleteConfirmShell(shell)}
                                title={t('shells.delete')}
                              >
                                <TrashIcon className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Public Shells Section */}
              {publicShells.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('shells.public_shells')} ({publicShells.length})
                  </h3>
                  <div className="space-y-3">
                    {publicShells.map(shell => (
                      <Card
                        key={`public-${shell.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={shell.name}
                            displayName={shell.displayName || undefined}
                            showId={true}
                            isPublic={true}
                            publicLabel={t('shells.public')}
                            icon={<GlobeAltIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'shell-type',
                                label: shell.shellType,
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'execution-type',
                                label: getExecutionTypeLabel(shell.executionType),
                                variant: 'info',
                                className: 'hidden sm:inline-flex text-xs',
                              },
                              ...(shell.baseImage
                                ? [
                                    {
                                      key: 'base-image',
                                      label: shell.baseImage,
                                      variant: 'default' as const,
                                      className:
                                        'hidden md:inline-flex text-xs truncate max-w-[200px]',
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Add Button */}
        {!loading && (scope === 'personal' || canCreateInAnyGroup) && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={handleCreate}>{t('shells.create')}</UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Shell Edit/Create Dialog */}
      <ShellEditDialog
        open={dialogOpen}
        shell={editingShell}
        onClose={handleEditClose}
        toast={toast}
        scope={scope}
        groupName={groupName}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmShell}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmShell(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('shells.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('shells.delete_confirm_message', { name: deleteConfirmShell?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-error hover:bg-error/90"
            >
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('actions.deleting')}
                </div>
              ) : (
                t('actions.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ShellList;
