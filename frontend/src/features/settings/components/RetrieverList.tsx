// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import {
  CircleStackIcon,
  PencilIcon,
  TrashIcon,
  BeakerIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useGroupPermissions } from '@/hooks/useGroupPermissions'
import { useTranslation } from '@/hooks/useTranslation'
import RetrieverEditDialog from './RetrieverEditDialog'
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
import { retrieverApis, UnifiedRetriever } from '@/apis/retrievers'
import type { BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import {
  buildGroupDisplayNameMap,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
} from '@/features/resource-library/components/ResourceCreateButton'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'

interface RetrieverListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
  onEditResource?: (namespace: string) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  sortMode?: ResourceLibrarySortMode
}

/**
 * Displays a list of Retriever (knowledge base retriever) resources grouped by ownership.
 * Unlike other List components, allows creation in personal/all scope if the user
 * has Owner or Maintainer role in any group, because Retrievers must belong to a group.
 *
 * @param props.scope - Current scope context (personal/group/all)
 * @param props.groupName - Current group name when scope is 'group'
 * @param props.groupRoleMap - Map of group namespace to user's role
 */
const RetrieverList: React.FC<RetrieverListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
  sourceControls,
  sortControls,
  sourceFilter = 'all',
  groups = [],
  sortMode = 'default',
}) => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [retrievers, setRetrievers] = useState<UnifiedRetriever[]>([])
  const [loading, setLoading] = useState(true)
  const [editingRetriever, setEditingRetriever] = useState<UnifiedRetriever | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmRetriever, setDeleteConfirmRetriever] = useState<UnifiedRetriever | null>(
    null
  )
  const [isDeleting, setIsDeleting] = useState(false)
  const [testingRetrieverName, setTestingRetrieverName] = useState<string | null>(null)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })

  const fetchRetrievers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await retrieverApis.getUnifiedRetrievers(scope, groupName)
      setRetrievers(response.data || [])
    } catch (error) {
      console.error('Failed to fetch retrievers:', error)
      toast({
        variant: 'destructive',
        title: t('common:retrievers.errors.load_retrievers_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t, scope, groupName])

  useEffect(() => {
    fetchRetrievers()
  }, [fetchRetrievers, scope, groupName])

  // Categorize retrievers by type
  const sourceFilteredRetrievers = React.useMemo(() => {
    if (sourceFilter === 'personal') {
      return retrievers.filter(retriever => retriever.type === 'user')
    }
    if (sourceFilter === 'group') {
      return retrievers.filter(retriever => retriever.type === 'group')
    }
    if (sourceFilter === 'system') {
      return retrievers.filter(retriever => retriever.type === 'public')
    }
    return retrievers
  }, [retrievers, sourceFilter])

  const groupDisplayNames = React.useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getRetrieverSource = React.useCallback(
    (retriever: UnifiedRetriever): ResourceLibrarySortSource => {
      if (retriever.type === 'public') return 'system'
      if (retriever.type === 'group') return 'group'
      return 'personal'
    },
    []
  )

  const sortedRetrievers = React.useMemo(
    () =>
      sortResourceLibraryItems(sourceFilteredRetrievers, {
        sortMode,
        groupDisplayNames,
        getSource: getRetrieverSource,
        getName: retriever => retriever.name,
        getDisplayName: retriever => retriever.displayName,
        getNamespace: retriever => retriever.namespace,
        getCreatedAt: retriever => retriever.created_at,
        getUpdatedAt: retriever => retriever.updated_at,
        getStableId: retriever => `${retriever.type}-${retriever.namespace}-${retriever.name}`,
      }),
    [sourceFilteredRetrievers, sortMode, groupDisplayNames, getRetrieverSource]
  )

  const totalRetrievers = sortedRetrievers.length

  const { canEditGroupResource, canDeleteGroupResource } = useGroupPermissions({
    scope,
    groupName,
    groupRoleMap,
  })

  const handleTestConnection = async (retriever: UnifiedRetriever) => {
    setTestingRetrieverName(retriever.name)
    try {
      // Fetch full retriever config
      const fullRetriever = await retrieverApis.getRetriever(retriever.name, retriever.namespace)
      const storageConfig = fullRetriever.spec.storageConfig

      const result = await retrieverApis.testConnection({
        storage_type: storageConfig.type as 'elasticsearch' | 'qdrant',
        url: storageConfig.url,
        username: storageConfig.username,
        password: storageConfig.password,
        api_key: storageConfig.apiKey,
      })

      if (result.success) {
        toast({
          title: t('common:retrievers.test_success'),
          description: result.message,
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('common:retrievers.test_failed'),
          description: result.message,
        })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:retrievers.test_failed'),
        description: (error as Error).message,
      })
    } finally {
      setTestingRetrieverName(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmRetriever) return

    setIsDeleting(true)
    try {
      await retrieverApis.deleteRetriever(
        deleteConfirmRetriever.name,
        deleteConfirmRetriever.namespace
      )
      toast({
        title: t('common:retrievers.delete_success'),
      })
      setDeleteConfirmRetriever(null)
      fetchRetrievers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:retrievers.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleEdit = (retriever: UnifiedRetriever) => {
    // Notify parent to update group selector if editing a group resource
    if (onEditResource && retriever.namespace && retriever.namespace !== 'default') {
      onEditResource(retriever.namespace)
    }

    setEditingRetriever(retriever)
    setDialogOpen(true)
  }

  const handleEditClose = () => {
    setEditingRetriever(null)
    setDialogOpen(false)
    setCreateTarget({ scope: 'personal' })
    fetchRetrievers()
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setEditingRetriever(null)
    setDialogOpen(true)
  }

  const getStorageTypeLabel = (storageType: string) => {
    switch (storageType) {
      case 'elasticsearch':
        return 'Elasticsearch'
      case 'qdrant':
        return 'Qdrant'
      default:
        return storageType
    }
  }

  const getSourceLabel = (retriever: UnifiedRetriever) => {
    if (retriever.type === 'public') return t('retrievers.public')
    if (retriever.type === 'group') return t('common:retrievers.group')
    return t('common:retrievers.my_retrievers')
  }

  const canEditRetriever = (retriever: UnifiedRetriever) => {
    if (retriever.type === 'public') return false
    if (retriever.type === 'group') return canEditGroupResource(retriever.namespace)
    return true
  }

  const canDeleteRetriever = (retriever: UnifiedRetriever) => {
    if (retriever.type === 'public') return false
    if (retriever.type === 'group') return canDeleteGroupResource(retriever.namespace)
    return true
  }

  const createAction = hasResourceCreateTargets({ scope, groupName, sourceFilter, groups }) ? (
    <ResourceCreateButton
      label={t('common:retrievers.create')}
      scope={scope}
      groupName={groupName}
      sourceFilter={sourceFilter}
      groups={groups}
      onCreate={handleCreate}
      data-testid="create-retriever-button"
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
      <ResourceManagementLayout
        title={t('common:retrievers.title')}
        description={t('common:retrievers.description')}
        actions={createAction}
        filters={filters}
      >
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && totalRetrievers === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CircleStackIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:retrievers.no_retrievers')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('common:retrievers.no_retrievers_hint')}
            </p>
          </div>
        )}

        {!loading && totalRetrievers > 0 && (
          <div className="space-y-3" data-testid="retriever-list-items">
            {sortedRetrievers.map(retriever => (
              <Card
                key={`${retriever.type}-${retriever.namespace}-${retriever.name}`}
                className="overflow-hidden bg-base p-3 transition-colors hover:bg-hover sm:p-4"
              >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <ResourceListItem
                    name={retriever.name}
                    displayName={retriever.displayName || undefined}
                    description={retriever.description}
                    showId={true}
                    isPublic={retriever.type === 'public'}
                    publicLabel={t('retrievers.public')}
                    icon={
                      retriever.type === 'public' ? (
                        <GlobeAltIcon className="w-5 h-5 text-primary" />
                      ) : (
                        <CircleStackIcon className="w-5 h-5 text-primary" />
                      )
                    }
                    tags={[
                      {
                        key: 'source',
                        label: getSourceLabel(retriever),
                        variant:
                          retriever.type === 'public'
                            ? 'info'
                            : retriever.type === 'group'
                              ? 'success'
                              : 'default',
                      },
                      ...(retriever.type === 'group'
                        ? [
                            {
                              key: 'namespace',
                              label: retriever.namespace,
                              variant: 'info' as const,
                            },
                          ]
                        : []),
                      {
                        key: 'storage-type',
                        label: getStorageTypeLabel(retriever.storageType),
                        variant: 'default',
                        className: 'capitalize',
                      },
                    ]}
                  />
                  <div className="flex flex-shrink-0 items-center gap-1 self-end sm:ml-3 sm:self-auto">
                    {retriever.type !== 'public' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleTestConnection(retriever)}
                        disabled={testingRetrieverName === retriever.name}
                        title={t('common:retrievers.test_connection')}
                      >
                        {testingRetrieverName === retriever.name ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <BeakerIcon className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                    {canEditRetriever(retriever) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleEdit(retriever)}
                        title={t('common:retrievers.edit')}
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                    )}
                    {canDeleteRetriever(retriever) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-error"
                        onClick={() => setDeleteConfirmRetriever(retriever)}
                        title={t('common:retrievers.delete')}
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

      {/* Retriever Edit/Create Dialog */}
      <RetrieverEditDialog
        open={dialogOpen}
        retriever={editingRetriever}
        onClose={handleEditClose}
        toast={toast}
        scope={editingRetriever ? scope : createTarget.scope}
        groupName={editingRetriever ? groupName : createTarget.groupName}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmRetriever}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmRetriever(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:retrievers.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:retrievers.delete_confirm_message', {
                name: deleteConfirmRetriever?.name,
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

export default RetrieverList
