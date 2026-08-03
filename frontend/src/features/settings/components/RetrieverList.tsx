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
  CircleStackIcon,
  PencilIcon,
  TrashIcon,
  BeakerIcon,
  GlobeAltIcon,
  LinkSlashIcon,
} from '@heroicons/react/24/outline'
import { Loader2, MoreHorizontal } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useGroupPermissions } from '@/hooks/useGroupPermissions'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import RetrieverEditDialog from './RetrieverEditDialog'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
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
import { getReferencedKnowledgeBaseNames } from '@/features/resource-library/capabilityReferenceErrors'
import {
  buildGroupDisplayNameMap,
  filterResourceLibraryItemsByGroups,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import { matchesResourceSearch } from '@/features/resource-library/resourceSearch'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
  type ResourceCreateRequest,
} from '@/features/resource-library/components/ResourceCreateButton'
import { UnbindInUseDialog } from '@/features/resource-library/components/UnbindInUseDialog'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'

interface RetrieverListProps {
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
  searchQuery?: string
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
  groupFilter,
  sortMode = 'default',
  createRequest,
  onCreateRequestClose,
  creationOnly = false,
  hideCreateActions = false,
  compact = false,
  searchQuery = '',
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
  const [referencedKnowledgeBaseNames, setReferencedKnowledgeBaseNames] = useState<string[]>([])
  const [checkingReferenceUsageName, setCheckingReferenceUsageName] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [testingRetrieverName, setTestingRetrieverName] = useState<string | null>(null)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const handledCreateRequestId = useRef<number | null>(null)
  const externalCreateRequestActiveRef = useRef(false)

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
    let filteredRetrievers = retrievers
    if (sourceFilter === 'personal') {
      filteredRetrievers = retrievers.filter(retriever => retriever.type === 'user')
    } else if (sourceFilter === 'group') {
      filteredRetrievers = retrievers.filter(retriever => retriever.type === 'group')
    } else if (sourceFilter === 'system') {
      filteredRetrievers = retrievers.filter(retriever => retriever.type === 'public')
    } else if (sourceFilter === 'mine') {
      filteredRetrievers = retrievers.filter(retriever => retriever.type !== 'public')
    }

    return filterResourceLibraryItemsByGroups(
      filteredRetrievers,
      groupFilter,
      retriever => retriever.namespace
    ).filter(retriever =>
      matchesResourceSearch(
        searchQuery,
        retriever.name,
        retriever.displayName,
        retriever.description,
        retriever.storageType
      )
    )
  }, [retrievers, sourceFilter, groupFilter, searchQuery])

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
      if (deleteConfirmRetriever.isReference && deleteConfirmRetriever.listingId) {
        await resourceLibraryApi.uninstallListing(
          deleteConfirmRetriever.listingId,
          deleteConfirmRetriever.namespace
        )
      } else {
        await retrieverApis.deleteRetriever(
          deleteConfirmRetriever.name,
          deleteConfirmRetriever.namespace
        )
      }
      toast({
        title: t(
          deleteConfirmRetriever.isReference
            ? 'common:actions.unbind_success'
            : 'common:retrievers.delete_success'
        ),
      })
      setDeleteConfirmRetriever(null)
      fetchRetrievers()
    } catch (error) {
      const referencedKnowledgeBaseNames = getReferencedKnowledgeBaseNames(error)
      toast({
        variant: 'destructive',
        title: t(
          deleteConfirmRetriever.isReference
            ? 'common:actions.unbind_failed'
            : 'common:retrievers.errors.delete_failed'
        ),
        description:
          referencedKnowledgeBaseNames.length > 0
            ? t('common:actions.unbind_retriever_in_use_message', {
                names: referencedKnowledgeBaseNames.join('、'),
              })
            : (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleUnbindRequest = async (retriever: UnifiedRetriever) => {
    if (!retriever.listingId || checkingReferenceUsageName) return

    setCheckingReferenceUsageName(retriever.name)
    try {
      const usage = await resourceLibraryApi.getReferenceUsage(
        retriever.listingId,
        retriever.namespace
      )
      setReferencedKnowledgeBaseNames(
        usage.referenced_knowledge_bases.map(knowledgeBase => knowledgeBase.name)
      )
      setDeleteConfirmRetriever(retriever)
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

  const handleEdit = (retriever: UnifiedRetriever) => {
    if (retriever.isReference) return

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && retriever.namespace && retriever.namespace !== 'default') {
      onEditResource(retriever.namespace)
    }

    setEditingRetriever(retriever)
    setDialogOpen(true)
  }

  const handleEditClose = () => {
    const shouldNotifyCreateRequestClose = externalCreateRequestActiveRef.current
    externalCreateRequestActiveRef.current = false
    setEditingRetriever(null)
    setDialogOpen(false)
    setCreateTarget({ scope: 'personal' })
    fetchRetrievers()
    if (shouldNotifyCreateRequestClose) onCreateRequestClose?.()
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setEditingRetriever(null)
    setDialogOpen(true)
  }

  useEffect(() => {
    if (!createRequest || handledCreateRequestId.current === createRequest.id) return
    handledCreateRequestId.current = createRequest.id
    externalCreateRequestActiveRef.current = true
    handleCreate(createRequest.target)
  }, [createRequest])

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
    if (retriever.type === 'public' || retriever.isReference) return false
    if (retriever.type === 'group') return canEditGroupResource(retriever.namespace)
    return true
  }

  const canDeleteRetriever = (retriever: UnifiedRetriever) => {
    if (retriever.type === 'public' || retriever.isReference) return false
    if (retriever.type === 'group') return canDeleteGroupResource(retriever.namespace)
    return true
  }

  const canUnbindRetriever = (retriever: UnifiedRetriever) =>
    retriever.isReference === true &&
    !!retriever.listingId &&
    (retriever.type === 'user' || canEditGroupResource(retriever.namespace))

  const hasRetrieverActions = (retriever: UnifiedRetriever) =>
    canEditRetriever(retriever) || canDeleteRetriever(retriever) || canUnbindRetriever(retriever)

  const createAction =
    !hideCreateActions && hasResourceCreateTargets({ scope, groupName, sourceFilter, groups }) ? (
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
      {!creationOnly && (
        <ResourceManagementLayout
          title={t('common:retrievers.title')}
          description={t('common:retrievers.description')}
          actions={createAction}
          filters={filters}
          hideHeader={compact}
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
                {t(
                  hideCreateActions
                    ? 'resource-library:empty.create_retriever'
                    : 'common:retrievers.no_retrievers_hint'
                )}
              </p>
            </div>
          )}

          {!loading && totalRetrievers > 0 && (
            <div className={getResourceGridClassName(compact)} data-testid="retriever-list-items">
              {sortedRetrievers.map(retriever => (
                <Card
                  key={`${retriever.type}-${retriever.namespace}-${retriever.name}`}
                  className={cn(getResourceCardClassName(compact), compact && 'min-w-0 gap-2')}
                  data-testid={`retriever-card-${retriever.type}-${retriever.name}`}
                >
                  <div className={getResourceCardBodyClassName(compact)}>
                    <ResourceListItem
                      cardLayout={compact}
                      name={retriever.name}
                      displayName={retriever.displayName || undefined}
                      description={retriever.description}
                      showId={!compact}
                      isPublic={retriever.type === 'public'}
                      publicLabel={t('retrievers.public')}
                      icon={
                        <ResourceCardIcon compact={compact}>
                          {retriever.type === 'public' ? (
                            <GlobeAltIcon className="w-5 h-5 text-primary" />
                          ) : (
                            <CircleStackIcon className="w-5 h-5 text-primary" />
                          )}
                        </ResourceCardIcon>
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
                    {!compact && hasRetrieverActions(retriever) && (
                      <div
                        className={cn(
                          'flex flex-shrink-0 items-center gap-1',
                          getResourceCardActionsClassName(compact),
                          compact && 'justify-end'
                        )}
                        data-testid={`retriever-card-actions-${retriever.type}-${retriever.name}`}
                      >
                        {retriever.type !== 'public' && !retriever.isReference && (
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
                        {canUnbindRetriever(retriever) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => void handleUnbindRequest(retriever)}
                            disabled={checkingReferenceUsageName === retriever.name}
                            title={t('common:actions.unbind')}
                            data-testid={`unbind-retriever-${retriever.name}-button`}
                          >
                            {checkingReferenceUsageName === retriever.name ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <LinkSlashIcon className="w-4 h-4" />
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {compact && hasRetrieverActions(retriever) && (
                    <div
                      className={cn(
                        'relative z-20 flex min-w-0 flex-shrink-0 items-center justify-end gap-1.5',
                        getResourceCardActionsClassName(true)
                      )}
                      data-testid={`retriever-card-actions-${retriever.type}-${retriever.name}`}
                    >
                      {retriever.type !== 'public' && !retriever.isReference && (
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                          onClick={() => handleTestConnection(retriever)}
                          disabled={testingRetrieverName === retriever.name}
                          title={t('common:retrievers.test_connection')}
                          aria-label={t('common:retrievers.test_connection')}
                          data-testid={`test-retriever-${retriever.name}-button`}
                        >
                          {testingRetrieverName === retriever.name ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <BeakerIcon className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      {canEditRetriever(retriever) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-11 min-w-0 flex-1 gap-2 px-3 text-xs md:h-8"
                          onClick={() => handleEdit(retriever)}
                          title={t('common:retrievers.edit')}
                          aria-label={t('common:retrievers.edit')}
                          data-testid={`edit-retriever-${retriever.name}-button`}
                        >
                          <PencilIcon className="h-4 w-4" />
                          <span>{t('common:actions.edit')}</span>
                        </Button>
                      )}
                      {canUnbindRetriever(retriever) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-11 min-w-0 flex-1 gap-2 px-3 text-xs md:h-8"
                          onClick={() => void handleUnbindRequest(retriever)}
                          disabled={checkingReferenceUsageName === retriever.name}
                          title={t('common:actions.unbind')}
                          aria-label={t('common:actions.unbind')}
                          data-testid={`unbind-retriever-${retriever.name}-button`}
                        >
                          {checkingReferenceUsageName === retriever.name ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <LinkSlashIcon className="h-4 w-4" />
                          )}
                          <span>{t('common:actions.unbind')}</span>
                        </Button>
                      )}
                      {canDeleteRetriever(retriever) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                              aria-label={t('common:actions.more_actions')}
                              data-testid={`retriever-more-actions-${retriever.name}-button`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            {canDeleteRetriever(retriever) && (
                              <DropdownMenuItem
                                danger
                                onClick={() => setDeleteConfirmRetriever(retriever)}
                                data-testid={`delete-retriever-${retriever.name}-button`}
                              >
                                <TrashIcon className="mr-2 h-4 w-4" />
                                {t('common:retrievers.delete')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </ResourceManagementLayout>
      )}

      {/* Retriever Edit/Create Dialog */}
      <RetrieverEditDialog
        open={dialogOpen}
        retriever={editingRetriever}
        onClose={handleEditClose}
        toast={toast}
        scope={editingRetriever ? scope : createTarget.scope}
        groupName={editingRetriever ? groupName : createTarget.groupName}
        publicationGroups={groups}
      />

      <UnbindInUseDialog
        open={!!deleteConfirmRetriever && referencedKnowledgeBaseNames.length > 0}
        onOpenChange={open => {
          if (!open) {
            setDeleteConfirmRetriever(null)
            setReferencedKnowledgeBaseNames([])
          }
        }}
        consumerType="knowledge-base"
        consumerNames={referencedKnowledgeBaseNames}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmRetriever && referencedKnowledgeBaseNames.length === 0}
        onOpenChange={open => {
          if (!open && !isDeleting) {
            setDeleteConfirmRetriever(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                deleteConfirmRetriever?.isReference
                  ? 'common:actions.unbind_confirm_title'
                  : 'common:retrievers.delete_confirm_title'
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                deleteConfirmRetriever?.isReference
                  ? 'common:actions.unbind_confirm_message'
                  : 'common:retrievers.delete_confirm_message',
                { name: deleteConfirmRetriever?.name }
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
                    deleteConfirmRetriever?.isReference
                      ? 'common:actions.unbinding'
                      : 'common:actions.deleting'
                  )}
                </div>
              ) : (
                t(
                  deleteConfirmRetriever?.isReference
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

export default RetrieverList
