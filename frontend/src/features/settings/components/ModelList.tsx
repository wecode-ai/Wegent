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
  CpuChipIcon,
  PencilIcon,
  TrashIcon,
  BeakerIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import ModelEditDialog from './ModelEditDialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { modelApis, ModelCRD, UnifiedModel, ModelCategoryType } from '@/apis/models'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

// Model category type filter options
const MODEL_CATEGORY_FILTER_OPTIONS: { value: ModelCategoryType | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'models.all_category_types' },
  { value: 'llm', labelKey: 'models.model_category_type_llm' },
  // { value: 'tts', labelKey: 'models.model_category_type_tts' },
  // { value: 'stt', labelKey: 'models.model_category_type_stt' },
  { value: 'embedding', labelKey: 'models.model_category_type_embedding' },
  { value: 'rerank', labelKey: 'models.model_category_type_rerank' },
]

// Badge variant mapping for model category types
// Note: Using 'default' for rerank since ResourceListItem tags don't support 'secondary'
const MODEL_CATEGORY_BADGE_VARIANT: Record<
  string,
  'default' | 'success' | 'info' | 'warning' | 'error'
> = {
  llm: 'default',
  tts: 'success',
  stt: 'info',
  embedding: 'warning',
  rerank: 'default',
}

// Unified display model interface
interface DisplayModel {
  name: string // Unique identifier (ID)
  displayName: string // Human-readable name (falls back to name if not set)
  modelType: string // Provider type: 'openai' | 'claude'
  modelId: string
  isPublic: boolean
  isGroup: boolean // Whether it's a group resource
  namespace: string // Resource namespace (group name or 'default')
  config: Record<string, unknown> // Full config from unified API
  modelCategoryType: ModelCategoryType // Model category type: llm, tts, stt, embedding, rerank
}

interface ModelListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>
  onEditResource?: (namespace: string) => void
}

const ModelList: React.FC<ModelListProps> = ({
  scope,
  groupName,
  groupRoleMap,
  onEditResource,
}) => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [unifiedModels, setUnifiedModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [editingModel, setEditingModel] = useState<ModelCRD | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<DisplayModel | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [testingModelName, setTestingModelName] = useState<string | null>(null)
  const [loadingModelName, setLoadingModelName] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<ModelCategoryType | 'all'>('all')

  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      // Use unified API to get all models (both public and user-defined)
      // Pass category filter if not 'all'
      const modelCategoryTypeFilter = categoryFilter !== 'all' ? categoryFilter : undefined
      const unifiedResponse = await modelApis.getUnifiedModels(
        undefined,
        true,
        scope,
        groupName,
        modelCategoryTypeFilter
      )
      setUnifiedModels(unifiedResponse.data || [])
    } catch (error) {
      console.error('Failed to fetch models:', error)
      toast({
        variant: 'destructive',
        title: t('common:models.errors.load_models_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t, scope, groupName, categoryFilter])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Convert unified models to display format and categorize
  const { groupModels, publicModels, userModels } = React.useMemo(() => {
    const group: DisplayModel[] = []
    const publicList: DisplayModel[] = []
    const user: DisplayModel[] = []

    for (const model of unifiedModels) {
      const isPublic = model.type === 'public'
      const isGroup = model.type === 'group'

      // Extract config info from unified model
      const config = (model.config as Record<string, unknown>) || {}
      const env = (config?.env as Record<string, unknown>) || {}

      const displayModel: DisplayModel = {
        name: model.name,
        displayName: model.displayName || model.name,
        modelType: model.provider || (env.model as string) || 'claude',
        modelId: model.modelId || (env.model_id as string) || '',
        isPublic,
        isGroup,
        namespace: model.namespace || 'default',
        config,
        modelCategoryType: (model.modelCategoryType as ModelCategoryType) || 'llm',
      }

      if (isGroup) {
        group.push(displayModel)
      } else if (isPublic) {
        publicList.push(displayModel)
      } else {
        user.push(displayModel)
      }
    }

    return {
      groupModels: group,
      publicModels: publicList,
      userModels: user,
    }
  }, [unifiedModels])

  const totalModels = groupModels.length + publicModels.length + userModels.length

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

  // Check if user can create in the current group context
  // When scope is 'group', check the specific groupName; only Owner/Maintainer can create
  const canCreateInCurrentGroup = (() => {
    if (scope !== 'group' || !groupName || !groupRoleMap) return false
    const role = groupRoleMap.get(groupName)
    return role === 'Owner' || role === 'Maintainer'
  })()
  // Convert DisplayModel to ModelCRD for editing
  const convertToModelCRD = (displayModel: DisplayModel): ModelCRD => {
    const env = (displayModel.config?.env as Record<string, unknown>) || {}
    return {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: displayModel.name,
        namespace: displayModel.namespace || 'default',
        displayName:
          displayModel.displayName !== displayModel.name ? displayModel.displayName : undefined,
      },
      spec: {
        modelConfig: {
          env: {
            model: displayModel.modelType === 'openai' ? 'openai' : 'claude',
            model_id: displayModel.modelId,
            api_key: (env.api_key as string) || '',
            base_url: env.base_url as string | undefined,
            custom_headers: env.custom_headers as Record<string, string> | undefined,
          },
        },
      },
      status: {
        state: 'Available',
      },
    }
  }

  const handleTestConnection = async (displayModel: DisplayModel) => {
    if (displayModel.isPublic) {
      // Public models cannot be tested (no API key access)
      return
    }

    setTestingModelName(displayModel.name)
    try {
      const env = (displayModel.config?.env as Record<string, unknown>) || {}
      const apiKey = (env.api_key as string) || ''
      const customHeaders = (env.custom_headers as Record<string, string>) || undefined

      // Determine provider type
      let providerType: 'openai' | 'anthropic' | 'gemini' = 'anthropic'
      if (displayModel.modelType === 'openai') {
        providerType = 'openai'
      } else if (displayModel.modelType === 'gemini') {
        providerType = 'gemini'
      }

      // Test connection requires api_key
      // Pass model_category_type to use appropriate test method (e.g., embeddings for embedding models)
      const result = await modelApis.testConnection({
        provider_type: providerType,
        model_id: displayModel.modelId,
        api_key: apiKey,
        base_url: env.base_url as string | undefined,
        custom_headers: customHeaders,
        model_category_type: displayModel.modelCategoryType,
      })

      if (result.success) {
        toast({
          title: t('common:models.test_success'),
          description: result.message,
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('common:models.test_failed'),
          description: result.message,
        })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:models.test_failed'),
        description: (error as Error).message,
      })
    } finally {
      setTestingModelName(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirmModel) return

    setIsDeleting(true)
    try {
      // Use the model's actual namespace for deletion
      await modelApis.deleteModel(deleteConfirmModel.name, deleteConfirmModel.namespace)
      toast({
        title: t('common:models.delete_success'),
      })
      setDeleteConfirmModel(null)
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleEdit = async (displayModel: DisplayModel) => {
    if (displayModel.isPublic) return

    // Notify parent to update group selector if editing a group resource
    if (onEditResource && displayModel.namespace && displayModel.namespace !== 'default') {
      onEditResource(displayModel.namespace)
    }

    setLoadingModelName(displayModel.name)
    try {
      // Fetch the full CRD data for editing with correct namespace
      const modelCRD = await modelApis.getModel(displayModel.name, displayModel.namespace)
      setEditingModel(modelCRD)
      setDialogOpen(true)
    } catch (error) {
      // If fetch fails, construct from unified data
      console.warn('Failed to fetch model CRD, using unified data:', error)
      setEditingModel(convertToModelCRD(displayModel))
      setDialogOpen(true)
    } finally {
      setLoadingModelName(null)
    }
  }

  const handleEditClose = () => {
    setEditingModel(null)
    setDialogOpen(false)
    fetchModels()
  }

  const handleCreate = () => {
    setEditingModel(null)
    setDialogOpen(true)
  }

  const getProviderLabel = (modelType: string) => {
    switch (modelType) {
      case 'openai':
        return 'OpenAI'
      case 'gemini':
        return 'Gemini'
      default:
        return 'Anthropic'
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">
            {t('common:models.title')}
          </h2>
          <p className="text-sm text-text-muted mb-1">{t('common:models.description')}</p>
        </div>
        {/* Category Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">
            {t('common:models.filter_by_category_type')}:
          </span>
          <Select
            value={categoryFilter}
            onValueChange={(value: ModelCategoryType | 'all') => setCategoryFilter(value)}
          >
            <SelectTrigger className="w-48 bg-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_CATEGORY_FILTER_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
        {!loading && totalModels === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:models.no_models')}</p>
            <p className="text-sm text-text-muted mt-1">{t('common:models.no_models_hint')}</p>
          </div>
        )}

        {/* Model List - Categorized */}
        {!loading && totalModels > 0 && (
          <>
            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 p-1">
              {/* User Models Section - 我的模型放在最上面 */}
              {userModels.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('common:models.my_models')} ({userModels.length})
                  </h3>
                  <div className="space-y-3">
                    {userModels.map(displayModel => (
                      <Card
                        key={`user-${displayModel.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={displayModel.name}
                            displayName={displayModel.displayName}
                            showId={true}
                            icon={<CpuChipIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'category',
                                label: t(
                                  `models.model_category_type_${displayModel.modelCategoryType}`
                                ),
                                variant:
                                  MODEL_CATEGORY_BADGE_VARIANT[displayModel.modelCategoryType] ||
                                  'default',
                              },
                              {
                                key: 'provider',
                                label: getProviderLabel(displayModel.modelType),
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'model-id',
                                label: displayModel.modelId,
                                variant: 'info',
                                className: 'hidden sm:inline-flex',
                              },
                            ]}
                          />
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleTestConnection(displayModel)}
                              disabled={testingModelName === displayModel.name}
                              title={t('common:models.test_connection')}
                            >
                              {testingModelName === displayModel.name ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <BeakerIcon className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEdit(displayModel)}
                              disabled={loadingModelName === displayModel.name}
                              title={t('common:models.edit')}
                            >
                              {loadingModelName === displayModel.name ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <PencilIcon className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hover:text-error"
                              onClick={() => setDeleteConfirmModel(displayModel)}
                              title={t('common:models.delete')}
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

              {/* Group Models Section */}
              {groupModels.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('common:models.group_models')} ({groupModels.length})
                  </h3>
                  <div className="space-y-3">
                    {groupModels.map(displayModel => (
                      <Card
                        key={`group-${displayModel.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={displayModel.name}
                            displayName={displayModel.displayName}
                            showId={true}
                            icon={<CpuChipIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'category',
                                label: t(
                                  `models.model_category_type_${displayModel.modelCategoryType}`
                                ),
                                variant:
                                  MODEL_CATEGORY_BADGE_VARIANT[displayModel.modelCategoryType] ||
                                  'default',
                              },
                              {
                                key: 'provider',
                                label: getProviderLabel(displayModel.modelType),
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'model-id',
                                label: displayModel.modelId,
                                variant: 'info',
                                className: 'hidden sm:inline-flex',
                              },
                            ]}
                          >
                            <Tag variant="success" className="text-xs">
                              {t('common:models.group')}
                            </Tag>
                          </ResourceListItem>
                          {/* Action buttons for group resources */}
                          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                            {canEditGroupResource(displayModel.namespace) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleEdit(displayModel)}
                                disabled={loadingModelName === displayModel.name}
                                title={t('common:models.edit')}
                              >
                                {loadingModelName === displayModel.name ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <PencilIcon className="w-4 h-4" />
                                )}
                              </Button>
                            )}
                            {canDeleteGroupResource(displayModel.namespace) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:text-error"
                                onClick={() => setDeleteConfirmModel(displayModel)}
                                title={t('common:models.delete')}
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

              {/* Public Models Section */}
              {publicModels.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-secondary px-2">
                    {t('common:models.public_models')} ({publicModels.length})
                  </h3>
                  <div className="space-y-3">
                    {publicModels.map(displayModel => (
                      <Card
                        key={`public-${displayModel.name}`}
                        className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <ResourceListItem
                            name={displayModel.name}
                            displayName={displayModel.displayName}
                            showId={true}
                            isPublic={true}
                            publicLabel={t('common:models.public')}
                            icon={<GlobeAltIcon className="w-5 h-5 text-primary" />}
                            tags={[
                              {
                                key: 'category',
                                label: t(
                                  `models.model_category_type_${displayModel.modelCategoryType}`
                                ),
                                variant:
                                  MODEL_CATEGORY_BADGE_VARIANT[displayModel.modelCategoryType] ||
                                  'default',
                              },
                              {
                                key: 'provider',
                                label: getProviderLabel(displayModel.modelType),
                                variant: 'default',
                                className: 'capitalize',
                              },
                              {
                                key: 'model-id',
                                label: displayModel.modelId,
                                variant: 'info',
                                className: 'hidden sm:inline-flex',
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
        {!loading && (scope === 'personal' || canCreateInCurrentGroup) && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={handleCreate}>
                {t('common:models.create')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Model Edit/Create Dialog */}
      <ModelEditDialog
        open={dialogOpen}
        model={editingModel}
        onClose={handleEditClose}
        toast={toast}
        groupName={groupName}
        scope={scope === 'all' || scope === undefined ? 'personal' : scope}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteConfirmModel}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmModel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common:models.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('common:models.delete_confirm_message', { name: deleteConfirmModel?.name })}
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

export default ModelList
