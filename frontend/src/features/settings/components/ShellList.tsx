// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import { CommandLineIcon, PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import ShellEditDialog from './ShellEditDialog'
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
import { shellApis, UnifiedShell } from '@/apis/shells'
import type { BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
} from '@/features/resource-library/components/ResourceCreateButton'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'

interface ShellListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
  onEditResource?: (namespace: string) => void
  sourceControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
}

const ShellList: React.FC<ShellListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
  sourceControls,
  sourceFilter = 'all',
  groups = [],
}) => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [shells, setShells] = useState<UnifiedShell[]>([])
  const [loading, setLoading] = useState(true)
  const [editingShell, setEditingShell] = useState<UnifiedShell | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmShell, setDeleteConfirmShell] = useState<UnifiedShell | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })

  const fetchShells = useCallback(async () => {
    setLoading(true)
    try {
      const response = await shellApis.getUnifiedShells(scope, groupName)
      setShells(response.data || [])
    } catch (error) {
      console.error('Failed to fetch shells:', error)
      toast({
        variant: 'destructive',
        title: t('common:shells.errors.load_shells_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t, scope, groupName])

  useEffect(() => {
    fetchShells()
  }, [fetchShells, scope, groupName])

  // Categorize shells by type
  const sourceFilteredShells = React.useMemo(() => {
    if (sourceFilter === 'personal') {
      return shells.filter(shell => shell.type === 'user')
    }
    if (sourceFilter === 'group') {
      return shells.filter(shell => shell.type === 'group')
    }
    if (sourceFilter === 'system') {
      return shells.filter(shell => shell.type === 'public')
    }
    return shells
  }, [shells, sourceFilter])

  const totalShells = sourceFilteredShells.length

  // Helper function to check permissions for a specific group resource
  const canEditGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
  }

  const canDeleteGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer'
  }

  const handleDelete = async () => {
    if (!deleteConfirmShell) return

    setIsDeleting(true)
    try {
      await shellApis.deleteShell(deleteConfirmShell.name)
      toast({
        title: t('common:shells.delete_success'),
      })
      setDeleteConfirmShell(null)
      fetchShells()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:shells.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleEdit = (shell: UnifiedShell) => {
    if (shell.type === 'public') return

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && shell.namespace && shell.namespace !== 'default') {
      onEditResource(shell.namespace)
    }

    setEditingShell(shell)
    setDialogOpen(true)
  }

  const handleEditClose = () => {
    setEditingShell(null)
    setDialogOpen(false)
    setCreateTarget({ scope: 'personal' })
    fetchShells()
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setEditingShell(null)
    setDialogOpen(true)
  }

  const getExecutionTypeLabel = (executionType?: string | null) => {
    if (executionType === 'local_engine') return 'Local Engine'
    if (executionType === 'external_api') return 'External API'
    return executionType || 'Unknown'
  }

  const getSourceLabel = (shell: UnifiedShell) => {
    if (shell.type === 'public') return t('common:shells.public')
    if (shell.type === 'group') return t('common:shells.group')
    return t('common:shells.my_shells')
  }

  const canEditShell = (shell: UnifiedShell) => {
    if (shell.type === 'public') return false
    if (shell.type === 'group') return canEditGroupResource(shell.namespace || 'default')
    return true
  }

  const canDeleteShell = (shell: UnifiedShell) => {
    if (shell.type === 'public') return false
    if (shell.type === 'group') return canDeleteGroupResource(shell.namespace || 'default')
    return true
  }

  const createAction = hasResourceCreateTargets({ scope, groupName, sourceFilter, groups }) ? (
    <ResourceCreateButton
      label={t('common:shells.create')}
      scope={scope}
      groupName={groupName}
      sourceFilter={sourceFilter}
      groups={groups}
      onCreate={handleCreate}
      data-testid="create-shell-button"
    />
  ) : null

  return (
    <>
      <ResourceManagementLayout
        title={t('common:shells.title')}
        description={t('common:shells.description')}
        actions={createAction}
        filters={sourceControls}
      >
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && totalShells === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CommandLineIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:shells.no_shells')}</p>
            <p className="text-sm text-text-muted mt-1">{t('common:shells.no_shells_hint')}</p>
          </div>
        )}

        {!loading && totalShells > 0 && (
          <div className="space-y-3" data-testid="shell-list-items">
            {sourceFilteredShells.map(shell => (
              <Card
                key={`${shell.type}-${shell.namespace || 'default'}-${shell.name}`}
                className="overflow-hidden bg-base p-3 transition-colors hover:bg-hover sm:p-4"
              >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <ResourceListItem
                    name={shell.name}
                    displayName={shell.displayName || undefined}
                    showId={true}
                    isPublic={shell.type === 'public'}
                    publicLabel={t('common:shells.public')}
                    icon={
                      shell.type === 'public' ? (
                        <GlobeAltIcon className="w-5 h-5 text-primary" />
                      ) : (
                        <CommandLineIcon className="w-5 h-5 text-primary" />
                      )
                    }
                    tags={[
                      {
                        key: 'source',
                        label: getSourceLabel(shell),
                        variant:
                          shell.type === 'public'
                            ? 'info'
                            : shell.type === 'group'
                              ? 'success'
                              : 'default',
                      },
                      ...(shell.type === 'group' && shell.namespace
                        ? [
                            {
                              key: 'namespace',
                              label: shell.namespace,
                              variant: 'info' as const,
                            },
                          ]
                        : []),
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
                              className: 'hidden md:inline-flex text-xs truncate max-w-[200px]',
                            },
                          ]
                        : []),
                    ]}
                  />
                  <div className="flex flex-shrink-0 items-center gap-1 self-end sm:ml-3 sm:self-auto">
                    {canEditShell(shell) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleEdit(shell)}
                        title={t('common:shells.edit')}
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                    )}
                    {canDeleteShell(shell) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-error"
                        onClick={() => setDeleteConfirmShell(shell)}
                        title={t('common:shells.delete')}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </ResourceManagementLayout>

      {/* Shell Edit/Create Dialog */}
      <ShellEditDialog
        open={dialogOpen}
        shell={editingShell}
        onClose={handleEditClose}
        toast={toast}
        scope={editingShell ? scope : createTarget.scope}
        groupName={createTarget.scope === 'group' ? createTarget.groupName : groupName}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmShell}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmShell(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:shells.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:shells.delete_confirm_message', { name: deleteConfirmShell?.name })}
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
                  {t('common:actions.deleting')}
                </div>
              ) : (
                t('common:actions.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default ShellList
