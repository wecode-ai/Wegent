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
  CpuChipIcon,
  PencilIcon,
  TrashIcon,
  BeakerIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useGroupPermissions } from '@/hooks/useGroupPermissions'
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
  modelApis,
  ModelCRD,
  UnifiedModel,
  ModelCategoryType,
  type TestConnectionRequest,
} from '@/apis/models'
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
  sourceType: UnifiedModel['type']
  namespace: string // Resource namespace (group name or 'default')
  config: Record<string, unknown> // Full config from unified API
  modelCategoryType: ModelCategoryType // Model category type: llm, tts, stt, embedding, rerank
  created_at?: string | null
  updated_at?: string | null
}

interface ModelListProps {
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

type ModelProviderType = TestConnectionRequest['provider_type']

function getTestConnectionProviderType(
  modelProvider: string | undefined,
  protocol?: string
): ModelProviderType {
  if (protocol === 'openai-responses' || protocol === 'gemini-deep-research') {
    return protocol
  }

  if (modelProvider === 'claude') {
    return 'anthropic'
  }

  if (
    modelProvider === 'openai' ||
    modelProvider === 'anthropic' ||
    modelProvider === 'gemini' ||
    modelProvider === 'custom'
  ) {
    return modelProvider
  }

  return 'openai'
}

function buildTestConnectionRequest(
  model: ModelCRD,
  fallbackCategoryType: ModelCategoryType
): TestConnectionRequest {
  const env = model.spec.modelConfig.env
  const customHeaders = env.custom_headers

  return {
    provider_type: getTestConnectionProviderType(env.model, model.spec.protocol),
    model_id: env.model_id,
    api_key: env.api_key,
    base_url: env.base_url || undefined,
    custom_headers:
      customHeaders && Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    model_category_type: model.spec.modelType || fallbackCategoryType,
  }
}

/**
 * Displays a list of Model resources grouped by ownership (user, group, public).
 * Supports CRUD operations with group-role-based permission controls.
 *
 * @param props.scope - Current scope context (personal/group/all)
 * @param props.groupName - Current group name when scope is 'group'
 * @param props.groupRoleMap - Map of group namespace to user's role
 */
const ModelList: React.FC<ModelListProps> = ({
  scope,
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
  const [unifiedModels, setUnifiedModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [editingModel, setEditingModel] = useState<ModelCRD | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<DisplayModel | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [testingModelName, setTestingModelName] = useState<string | null>(null)
  const [loadingModelName, setLoadingModelName] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<ModelCategoryType | 'all'>('all')
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })

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
  const sourceFilteredModels = React.useMemo(() => {
    if (sourceFilter === 'personal') {
      return unifiedModels.filter(model => model.type === 'user')
    }
    if (sourceFilter === 'group') {
      return unifiedModels.filter(model => model.type === 'group')
    }
    if (sourceFilter === 'system') {
      return unifiedModels.filter(model => model.type === 'public')
    }
    return unifiedModels
  }, [unifiedModels, sourceFilter])

  const groupDisplayNames = React.useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getModelSource = React.useCallback((model: DisplayModel): ResourceLibrarySortSource => {
    if (model.sourceType === 'public') return 'system'
    if (model.sourceType === 'group') return 'group'
    return 'personal'
  }, [])

  const displayModels = React.useMemo(() => {
    const mappedModels = sourceFilteredModels.map(model => {
      const config = (model.config as Record<string, unknown>) || {}
      const env = (config?.env as Record<string, unknown>) || {}
      const isPublic = model.type === 'public'
      const isGroup = model.type === 'group'

      return {
        name: model.name,
        displayName: model.displayName || model.name,
        modelType: model.provider || (env.model as string) || 'claude',
        modelId: model.modelId || (env.model_id as string) || '',
        isPublic,
        isGroup,
        sourceType: model.type,
        namespace: model.namespace || 'default',
        config,
        modelCategoryType: (model.modelCategoryType as ModelCategoryType) || 'llm',
        created_at: model.created_at,
        updated_at: model.updated_at,
      }
    })

    return sortResourceLibraryItems(mappedModels, {
      sortMode,
      groupDisplayNames,
      getSource: getModelSource,
      getName: model => model.name,
      getDisplayName: model => model.displayName,
      getNamespace: model => model.namespace,
      getCreatedAt: model => model.created_at,
      getUpdatedAt: model => model.updated_at,
      getStableId: model => `${model.sourceType}-${model.namespace}-${model.name}`,
    })
  }, [sourceFilteredModels, sortMode, groupDisplayNames, getModelSource])

  const totalModels = displayModels.length

  const { canEditGroupResource, canDeleteGroupResource } = useGroupPermissions({
    scope,
    groupName,
    groupRoleMap,
  })
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
      const modelCRD = await modelApis.getModel(displayModel.name, displayModel.namespace)
      const result = await modelApis.testConnection(
        buildTestConnectionRequest(modelCRD, displayModel.modelCategoryType)
      )

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
    setCreateTarget({ scope: 'personal' })
    fetchModels()
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
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

  const getSourceLabel = (displayModel: DisplayModel) => {
    if (displayModel.isPublic) return t('common:models.public')
    if (displayModel.isGroup) return t('common:models.group')
    return t('common:models.my_models')
  }

  const canEditModel = (displayModel: DisplayModel) => {
    if (displayModel.isPublic) return false
    if (displayModel.isGroup) return canEditGroupResource(displayModel.namespace)
    return true
  }

  const canDeleteModel = (displayModel: DisplayModel) => {
    if (displayModel.isPublic) return false
    if (displayModel.isGroup) return canDeleteGroupResource(displayModel.namespace)
    return true
  }

  const createAction = hasResourceCreateTargets({ scope, groupName, sourceFilter, groups }) ? (
    <ResourceCreateButton
      label={t('common:models.create')}
      scope={scope}
      groupName={groupName}
      sourceFilter={sourceFilter}
      groups={groups}
      onCreate={handleCreate}
      data-testid="create-model-button"
    />
  ) : null

  const categoryFilterControls = (
    <div
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      data-testid="model-category-filter"
    >
      <span className="text-xs font-medium text-text-muted">
        {t('common:models.filter_by_category_type')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {MODEL_CATEGORY_FILTER_OPTIONS.map(option => (
          <Button
            key={option.value}
            type="button"
            variant={categoryFilter === option.value ? 'primary' : 'outline'}
            aria-pressed={categoryFilter === option.value}
            onClick={() => setCategoryFilter(option.value)}
            className="h-11 min-w-[44px] px-4 lg:h-9"
            data-testid={`model-category-filter-${option.value}`}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>
    </div>
  )

  const filters = (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex min-w-0 flex-col gap-3">
        {sourceControls}
        {categoryFilterControls}
      </div>
      {sortControls}
    </div>
  )

  return (
    <>
      <ResourceManagementLayout
        title={t('common:models.title')}
        description={t('common:models.description')}
        actions={createAction}
        filters={filters}
        titleTestId="model-management-title"
      >
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && totalModels === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('common:models.no_models')}</p>
            <p className="text-sm text-text-muted mt-1">{t('common:models.no_models_hint')}</p>
          </div>
        )}

        {!loading && totalModels > 0 && (
          <div className="space-y-3" data-testid="model-list-items">
            {displayModels.map(displayModel => (
              <Card
                key={`${displayModel.sourceType}-${displayModel.namespace}-${displayModel.name}`}
                className="overflow-hidden bg-base p-3 transition-colors hover:bg-hover sm:p-4"
              >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <ResourceListItem
                    name={displayModel.name}
                    displayName={displayModel.displayName}
                    showId={true}
                    isPublic={displayModel.isPublic}
                    publicLabel={t('common:models.public')}
                    icon={
                      displayModel.isPublic ? (
                        <GlobeAltIcon className="w-5 h-5 text-primary" />
                      ) : (
                        <CpuChipIcon className="w-5 h-5 text-primary" />
                      )
                    }
                    tags={[
                      {
                        key: 'source',
                        label: getSourceLabel(displayModel),
                        variant: displayModel.isPublic
                          ? 'info'
                          : displayModel.isGroup
                            ? 'success'
                            : 'default',
                      },
                      ...(displayModel.isGroup
                        ? [
                            {
                              key: 'namespace',
                              label: displayModel.namespace,
                              variant: 'info' as const,
                            },
                          ]
                        : []),
                      {
                        key: 'category',
                        label: t(`models.model_category_type_${displayModel.modelCategoryType}`),
                        variant:
                          MODEL_CATEGORY_BADGE_VARIANT[displayModel.modelCategoryType] || 'default',
                      },
                      {
                        key: 'provider',
                        label: getProviderLabel(displayModel.modelType),
                        variant: 'default',
                        className: 'capitalize',
                      },
                      ...(displayModel.modelId
                        ? [
                            {
                              key: 'model-id',
                              label: displayModel.modelId,
                              variant: 'info' as const,
                              className: 'hidden sm:inline-flex',
                            },
                          ]
                        : []),
                    ]}
                  />
                  <div className="flex flex-shrink-0 items-center gap-1 self-end sm:ml-3 sm:self-auto">
                    {!displayModel.isPublic && !displayModel.isGroup && (
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
                    )}
                    {canEditModel(displayModel) && (
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
                    {canDeleteModel(displayModel) && (
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
        )}
      </ResourceManagementLayout>

      {/* Model Edit/Create Dialog */}
      <ModelEditDialog
        open={dialogOpen}
        model={editingModel}
        onClose={handleEditClose}
        toast={toast}
        groupName={createTarget.scope === 'group' ? createTarget.groupName : groupName}
        scope={editingModel ? (scope === 'group' ? 'group' : 'personal') : createTarget.scope}
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
    </>
  )
}

export default ModelList
