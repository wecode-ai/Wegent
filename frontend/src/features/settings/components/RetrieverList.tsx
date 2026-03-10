// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import '@/features/common/scrollbar.css'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
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
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

interface RetrieverListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>
  onEditResource?: (namespace: string) => void
}

const RetrieverList: React.FC<RetrieverListProps> = ({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
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
  const { groupRetrievers, userRetrievers, publicRetrievers } = React.useMemo(() => {
    const group: UnifiedRetriever[] = []
    const user: UnifiedRetriever[] = []
    const publicList: UnifiedRetriever[] = []

    for (const retriever of retrievers) {
      if (retriever.type === 'group') {
        group.push(retriever)
      } else if (retriever.type === 'public') {
        publicList.push(retriever)
      } else {
        user.push(retriever)
      }
    }

    return {
      groupRetrievers: group,
      userRetrievers: user,
      publicRetrievers: publicList,
    }
  }, [retrievers])

  const totalRetrievers = groupRetrievers.length + userRetrievers.length + publicRetrievers.length

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

  const canCreateInAnyGroup =
    groupRoleMap &&
    Array.from(groupRoleMap.values()).some(role => role === 'Owner' || role === 'Maintainer')

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
    fetchRetrievers()
  }

  const handleCreate = () => {
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

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('common:retrievers.title')}
        </h2>
        <p className="text-sm text-text-muted mb-1">{t('common:retrievers.description')}</p>
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
        {!loading && totalRetrievers === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CircleStackIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:retrievers.no_retrievers')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('common:retrievers.no_retrievers_hint')}
            </p>
          </div>
        )}

        {/* Retriever List - Categorized */}
        {!loading && totalRetrievers > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 p-1">
              {/* User Retrievers Section */}
              {userRetrievers.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('common:retrievers.my_retrievers')} ({userRetrievers.length})
                  </h3>
                  <div className="space-y-3">
                    {userRetrievers.map(retriever => (
                      <Card
                        key={`user-${retriever.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={retriever.name}
                            displayName={retriever.displayName || undefined}
                            showId={true}
                            icon={<CircleStackIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'storage-type',
                                label: getStorageTypeLabel(retriever.storageType),
                                variant: 'default',
                                className: 'capitalize',
                              },
                            ]}
                          />
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
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
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEdit(retriever)}
                              title={t('common:retrievers.edit')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hover:text-error"
                              onClick={() => setDeleteConfirmRetriever(retriever)}
                              title={t('common:retrievers.delete')}
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

              {/* Group Retrievers Section */}
              {groupRetrievers.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('common:retrievers.group_retrievers')} ({groupRetrievers.length})
                  </h3>
                  <div className="space-y-3">
                    {groupRetrievers.map(retriever => (
                      <Card
                        key={`group-${retriever.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={retriever.name}
                            displayName={retriever.displayName || undefined}
                            showId={true}
                            icon={<CircleStackIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'storage-type',
                                label: getStorageTypeLabel(retriever.storageType),
                                variant: 'default',
                                className: 'capitalize',
                              },
                            ]}
                          >
                            <Tag variant="success" className="text-xs">
                              {t('common:retrievers.group')}
                            </Tag>
                          </ResourceListItem>
                          {/* Action buttons for group resources */}
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                            {canEditGroupResource(retriever.namespace) && (
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
                            {canDeleteGroupResource(retriever.namespace) && (
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
                </div>
              )}

              {/* Public Retrievers Section */}
              {publicRetrievers.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('retrievers.public_retrievers')} ({publicRetrievers.length})
                  </h3>
                  <div className="space-y-3">
                    {publicRetrievers.map(retriever => (
                      <Card
                        key={`public-${retriever.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={retriever.name}
                            displayName={retriever.displayName || undefined}
                            showId={true}
                            isPublic={true}
                            publicLabel={t('retrievers.public')}
                            icon={<GlobeAltIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'storage-type',
                                label: getStorageTypeLabel(retriever.storageType),
                                variant: 'default',
                                className: 'capitalize',
                              },
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
              <UnifiedAddButton onClick={handleCreate}>
                {t('common:retrievers.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Retriever Edit/Create Dialog */}
      <RetrieverEditDialog
        open={dialogOpen}
        retriever={editingRetriever}
        onClose={handleEditClose}
        toast={toast}
        scope={scope}
        groupName={groupName}
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
    </div>
  )
}

export default RetrieverList
