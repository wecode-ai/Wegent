// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import {
  ResourceCardIcon,
  getResourceCardActionsClassName,
  getResourceCardBodyClassName,
  getResourceCardClassName,
  getResourceGridClassName,
} from '@/components/common/resourceCardLayout'
import {
  CommandLineIcon,
  PencilIcon,
  TrashIcon,
  GlobeAltIcon,
  LinkSlashIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useGroupPermissions } from '@/hooks/useGroupPermissions'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
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
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import { getReferencedBotNames } from '@/features/resource-library/capabilityReferenceErrors'
import {
  buildGroupDisplayNameMap,
  filterResourceLibraryItemsByGroups,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
  type ResourceCreateRequest,
} from '@/features/resource-library/components/ResourceCreateButton'
import { UnbindInUseDialog } from '@/features/resource-library/components/UnbindInUseDialog'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'

interface ShellListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
  onEditResource?: (namespace: string) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  groupFilter?: string[]
  sortMode?: ResourceLibrarySortMode
  createRequest?: ResourceCreateRequest
  onCreateRequestClose?: () => void
  creationOnly?: boolean
  hideCreateActions?: boolean
  compact?: boolean
}

/**
 * Displays a list of Shell (runtime environment) resources grouped by ownership.
 * Supports CRUD operations with group-role-based permission controls.
 *
 * @param props.scope - Current scope context (personal/group/all)
 * @param props.groupName - Current group name when scope is 'group'
 * @param props.groupRoleMap - Map of group namespace to user's role
 */
const ShellList: React.FC<ShellListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
  sourceControls,
  sortControls,
  sourceFilter = 'all',
  groups = [],
  groupFilter,
  sortMode = 'default',
  createRequest,
  onCreateRequestClose,
  creationOnly = false,
  hideCreateActions = false,
  compact = false,
}) => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [shells, setShells] = useState<UnifiedShell[]>([])
  const [loading, setLoading] = useState(true)
  const [editingShell, setEditingShell] = useState<UnifiedShell | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmShell, setDeleteConfirmShell] = useState<UnifiedShell | null>(null)
  const [referencedBotNames, setReferencedBotNames] = useState<string[]>([])
  const [checkingReferenceUsageName, setCheckingReferenceUsageName] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const handledCreateRequestId = useRef<number | null>(null)
  const externalCreateRequestActiveRef = useRef(false)

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
    let filteredShells = shells
    if (sourceFilter === 'personal') {
      filteredShells = shells.filter(shell => shell.type === 'user')
    } else if (sourceFilter === 'group') {
      filteredShells = shells.filter(shell => shell.type === 'group')
    } else if (sourceFilter === 'system') {
      filteredShells = shells.filter(shell => shell.type === 'public')
    }

    return filterResourceLibraryItemsByGroups(filteredShells, groupFilter, shell => shell.namespace)
  }, [shells, sourceFilter, groupFilter])

  const groupDisplayNames = React.useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getShellSource = React.useCallback((shell: UnifiedShell): ResourceLibrarySortSource => {
    if (shell.type === 'public') return 'system'
    if (shell.type === 'group') return 'group'
    return 'personal'
  }, [])

  const sortedShells = React.useMemo(
    () =>
      sortResourceLibraryItems(sourceFilteredShells, {
        sortMode,
        groupDisplayNames,
        getSource: getShellSource,
        getName: shell => shell.name,
        getDisplayName: shell => shell.displayName,
        getNamespace: shell => shell.namespace || 'default',
        getCreatedAt: shell => shell.created_at,
        getUpdatedAt: shell => shell.updated_at,
        getStableId: shell => `${shell.type}-${shell.namespace || 'default'}-${shell.name}`,
      }),
    [sourceFilteredShells, sortMode, groupDisplayNames, getShellSource]
  )

  const totalShells = sortedShells.length

  const { canEditGroupResource, canDeleteGroupResource } = useGroupPermissions({
    scope,
    groupName,
    groupRoleMap,
  })

  const handleDelete = async () => {
    if (!deleteConfirmShell) return

    setIsDeleting(true)
    try {
      if (deleteConfirmShell.isReference && deleteConfirmShell.listingId) {
        await resourceLibraryApi.uninstallListing(
          deleteConfirmShell.listingId,
          deleteConfirmShell.namespace
        )
      } else {
        await shellApis.deleteShell(deleteConfirmShell.name)
      }
      toast({
        title: t(
          deleteConfirmShell.isReference
            ? 'common:actions.unbind_success'
            : 'common:shells.delete_success'
        ),
      })
      setDeleteConfirmShell(null)
      fetchShells()
    } catch (error) {
      const referencedBotNames = getReferencedBotNames(error)
      toast({
        variant: 'destructive',
        title: t(
          deleteConfirmShell.isReference
            ? 'common:actions.unbind_failed'
            : 'common:shells.errors.delete_failed'
        ),
        description:
          referencedBotNames.length > 0
            ? t('common:actions.unbind_in_use_message', {
                names: referencedBotNames.join('、'),
              })
            : (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleUnbindRequest = async (shell: UnifiedShell) => {
    if (!shell.listingId || checkingReferenceUsageName) return

    setCheckingReferenceUsageName(shell.name)
    try {
      const usage = await resourceLibraryApi.getReferenceUsage(
        shell.listingId,
        shell.namespace || 'default'
      )
      setReferencedBotNames(usage.referenced_bots.map(bot => bot.name))
      setDeleteConfirmShell(shell)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:actions.unbind_failed'),
        description: (error as Error).message,
      })
    } finally {
      setCheckingReferenceUsageName(null)
    }
  }

  const handleEdit = (shell: UnifiedShell) => {
    if (shell.type === 'public' || shell.isReference) return

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && shell.namespace && shell.namespace !== 'default') {
      onEditResource(shell.namespace)
    }

    setEditingShell(shell)
    setDialogOpen(true)
  }

  const handleEditClose = () => {
    const shouldNotifyCreateRequestClose = externalCreateRequestActiveRef.current
    externalCreateRequestActiveRef.current = false
    setEditingShell(null)
    setDialogOpen(false)
    setCreateTarget({ scope: 'personal' })
    fetchShells()
    if (shouldNotifyCreateRequestClose) onCreateRequestClose?.()
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setEditingShell(null)
    setDialogOpen(true)
  }

  useEffect(() => {
    if (!createRequest || handledCreateRequestId.current === createRequest.id) return
    handledCreateRequestId.current = createRequest.id
    externalCreateRequestActiveRef.current = true
    handleCreate(createRequest.target)
  }, [createRequest])

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
    if (shell.type === 'public' || shell.isReference) return false
    if (shell.type === 'group') return canEditGroupResource(shell.namespace || 'default')
    return true
  }

  const shouldShowShellType = (shell: UnifiedShell) =>
    shell.shellType.toLocaleLowerCase() !== (shell.displayName || shell.name).toLocaleLowerCase()

  const canDeleteShell = (shell: UnifiedShell) => {
    if (shell.type === 'public' || shell.isReference) return false
    if (shell.type === 'group') return canDeleteGroupResource(shell.namespace || 'default')
    return true
  }

  const canUnbindShell = (shell: UnifiedShell) =>
    shell.isReference === true &&
    !!shell.listingId &&
    (shell.type === 'user' || canEditGroupResource(shell.namespace || 'default'))

  const hasShellActions = (shell: UnifiedShell) =>
    canEditShell(shell) || canDeleteShell(shell) || canUnbindShell(shell)

  const createAction =
    !hideCreateActions && hasResourceCreateTargets({ scope, groupName, sourceFilter, groups }) ? (
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

  const filters =
    sourceControls || sortControls ? (
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">{sourceControls}</div>
        {sortControls}
      </div>
    ) : null

  return (
    <>
      {!creationOnly && (
        <ResourceManagementLayout
          title={t('common:shells.title')}
          description={t('common:shells.description')}
          actions={createAction}
          filters={filters}
          hideHeader={compact}
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
              <p className="text-sm text-text-muted mt-1">
                {t(
                  hideCreateActions
                    ? 'resource-library:empty.create_shell'
                    : 'common:shells.no_shells_hint'
                )}
              </p>
            </div>
          )}

          {!loading && totalShells > 0 && (
            <div className={getResourceGridClassName(compact)} data-testid="shell-list-items">
              {sortedShells.map(shell => (
                <Card
                  key={`${shell.type}-${shell.namespace || 'default'}-${shell.name}`}
                  className={getResourceCardClassName(compact)}
                  data-testid={`shell-card-${shell.type}-${shell.name}`}
                >
                  <div className={getResourceCardBodyClassName(compact)}>
                    <ResourceListItem
                      cardLayout={compact}
                      name={shell.name}
                      displayName={shell.displayName || undefined}
                      showId={true}
                      isPublic={shell.type === 'public'}
                      publicLabel={t('common:shells.public')}
                      icon={
                        <ResourceCardIcon compact={compact}>
                          {shell.type === 'public' ? (
                            <GlobeAltIcon className="w-5 h-5 text-primary" />
                          ) : (
                            <CommandLineIcon className="w-5 h-5 text-primary" />
                          )}
                        </ResourceCardIcon>
                      }
                      tags={[
                        ...(shell.type !== 'public'
                          ? [
                              {
                                key: 'source',
                                label: getSourceLabel(shell),
                                variant:
                                  shell.type === 'group'
                                    ? ('success' as const)
                                    : ('default' as const),
                              },
                            ]
                          : []),
                        ...(shell.type === 'group' && shell.namespace
                          ? [
                              {
                                key: 'namespace',
                                label: shell.namespace,
                                variant: 'info' as const,
                              },
                            ]
                          : []),
                        ...(shouldShowShellType(shell)
                          ? [
                              {
                                key: 'shell-type',
                                label: shell.shellType,
                                variant: 'default' as const,
                                className: 'capitalize',
                              },
                            ]
                          : []),
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
                    {hasShellActions(shell) && (
                      <div
                        className={cn(
                          'flex flex-shrink-0 items-center gap-1',
                          getResourceCardActionsClassName(compact),
                          compact && 'justify-end'
                        )}
                        data-testid={`shell-card-actions-${shell.type}-${shell.name}`}
                      >
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
                        {canUnbindShell(shell) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => void handleUnbindRequest(shell)}
                            disabled={checkingReferenceUsageName === shell.name}
                            title={t('common:actions.unbind')}
                            data-testid={`unbind-shell-${shell.name}-button`}
                          >
                            {checkingReferenceUsageName === shell.name ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <LinkSlashIcon className="w-4 h-4" />
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </ResourceManagementLayout>
      )}

      {/* Shell Edit/Create Dialog */}
      <ShellEditDialog
        open={dialogOpen}
        shell={editingShell}
        onClose={handleEditClose}
        toast={toast}
        scope={editingShell ? scope : createTarget.scope}
        groupName={createTarget.scope === 'group' ? createTarget.groupName : groupName}
        publicationGroups={groups}
      />

      <UnbindInUseDialog
        open={!!deleteConfirmShell && referencedBotNames.length > 0}
        onOpenChange={open => {
          if (!open) {
            setDeleteConfirmShell(null)
            setReferencedBotNames([])
          }
        }}
        consumerType="agent"
        consumerNames={referencedBotNames}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmShell && referencedBotNames.length === 0}
        onOpenChange={open => {
          if (!open && !isDeleting) {
            setDeleteConfirmShell(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                deleteConfirmShell?.isReference
                  ? 'common:actions.unbind_confirm_title'
                  : 'common:shells.delete_confirm_title'
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                deleteConfirmShell?.isReference
                  ? 'common:actions.unbind_confirm_message'
                  : 'common:shells.delete_confirm_message',
                { name: deleteConfirmShell?.name }
              )}
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
                  {t(
                    deleteConfirmShell?.isReference
                      ? 'common:actions.unbinding'
                      : 'common:actions.deleting'
                  )}
                </div>
              ) : (
                t(
                  deleteConfirmShell?.isReference
                    ? 'common:actions.unbind'
                    : 'common:actions.delete'
                )
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default ShellList
