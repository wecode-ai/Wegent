// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
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
import { CpuChipIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Loader2, PlusIcon } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { adminApis, AdminPublicModel, AdminPublicModelCreate } from '@/apis/admin'
import { ModelCRD, ModelCategoryType } from '@/apis/models'
import ModelEditDialog, {
  ModelFormData,
  ModelInitialData,
} from '@/features/settings/components/ModelEditDialog'

const SetupModelStep: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [loading, setLoading] = useState(true)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AdminPublicModel | null>(null)
  const [editingModelData, setEditingModelData] = useState<ModelInitialData | null>(null)
  const [editingModelId, setEditingModelId] = useState<number | null>(null)

  // Fetch existing public models
  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPublicModels(1, 100)
      setModels(response.items)
    } catch (error) {
      console.error('Failed to fetch models:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Convert AdminPublicModel to ModelInitialData for editing
  const convertToInitialData = (model: AdminPublicModel): ModelInitialData => {
    const json = model.json as Record<string, unknown>
    const spec = json?.spec as Record<string, unknown>
    const metadata = json?.metadata as Record<string, unknown>
    const modelConfig = spec?.modelConfig as Record<string, unknown>
    const env = modelConfig?.env as Record<string, unknown>

    const modelType = env?.model as string
    let providerType: string
    if (spec?.protocol === 'openai-responses') {
      providerType = 'openai-responses'
    } else if (modelType === 'claude') {
      providerType = 'anthropic'
    } else {
      providerType = modelType || 'openai'
    }

    return {
      name: model.name,
      displayName: (metadata?.displayName as string) || '',
      modelCategoryType: (spec?.modelType as ModelCategoryType) || 'llm',
      providerType,
      modelId: env?.model_id as string,
      apiKey: (env?.api_key as string) || '',
      baseUrl: (env?.base_url as string) || '',
      customHeaders: env?.custom_headers as Record<string, string>,
      protocol: spec?.protocol as string,
      contextWindow: spec?.contextWindow as number | undefined,
      maxOutputTokens: spec?.maxOutputTokens as number | undefined,
    }
  }

  // Custom save handler for admin API
  const handleSaveModel = async (
    _formData: ModelFormData,
    modelCRD: ModelCRD
  ): Promise<boolean> => {
    try {
      // Convert ModelCRD to Record<string, unknown> for admin API
      const modelJson = modelCRD as unknown as Record<string, unknown>

      if (editingModelId !== null) {
        // Update existing model
        await adminApis.updatePublicModel(editingModelId, {
          name: modelCRD.metadata.name,
          json: modelJson,
        })
        toast({ title: t('admin:setup_wizard.model_step.model_updated') })
      } else {
        // Create new model
        const createData: AdminPublicModelCreate = {
          name: modelCRD.metadata.name,
          namespace: 'default',
          json: modelJson,
        }
        await adminApis.createPublicModel(createData)
        toast({ title: t('admin:setup_wizard.model_step.model_added') })
      }
      fetchModels()
      return true
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          editingModelId !== null
            ? t('admin:public_models.errors.update_failed')
            : t('admin:public_models.errors.create_failed'),
        description: (error as Error).message,
      })
      return false
    }
  }

  const handleDeleteModel = async () => {
    if (!selectedModel) return

    try {
      await adminApis.deletePublicModel(selectedModel.id)
      toast({ title: t('admin:setup_wizard.model_step.model_deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedModel(null)
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.delete_failed'),
        description: (error as Error).message,
      })
    }
  }

  const openEditDialog = (model: AdminPublicModel) => {
    setEditingModelData(convertToInitialData(model))
    setEditingModelId(model.id)
    setIsAddDialogOpen(true)
  }

  const openAddDialog = () => {
    setEditingModelData(null)
    setEditingModelId(null)
    setIsAddDialogOpen(true)
  }

  const handleCloseDialog = () => {
    setIsAddDialogOpen(false)
    setEditingModelData(null)
    setEditingModelId(null)
  }

  const getModelProvider = (json: Record<string, unknown>): string => {
    const spec = json?.spec as Record<string, unknown>
    const modelConfig = spec?.modelConfig as Record<string, unknown>
    const env = modelConfig?.env as Record<string, unknown>
    const model = env?.model as string
    if (model === 'openai') return 'OpenAI'
    if (model === 'claude') return 'Anthropic'
    if (model === 'gemini') return 'Gemini'
    return model || 'Unknown'
  }

  const getModelId = (json: Record<string, unknown>): string => {
    const spec = json?.spec as Record<string, unknown>
    const modelConfig = spec?.modelConfig as Record<string, unknown>
    const env = modelConfig?.env as Record<string, unknown>
    return (env?.model_id as string) || 'N/A'
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-text-primary">
          {t('admin:setup_wizard.model_step.title')}
        </h3>
        <p className="text-sm text-text-muted mt-1">
          {t('admin:setup_wizard.model_step.description')}
        </p>
      </div>

      {/* Model List */}
      <div className="bg-base border border-border rounded-md p-3 min-h-[200px] max-h-[300px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:setup_wizard.model_step.no_models')}</p>
            <p className="text-xs text-text-muted mt-1">
              {t('admin:setup_wizard.model_step.add_first_model')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {models.map(model => (
              <Card
                key={model.id}
                className="p-3 bg-surface hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <CpuChipIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary truncate">
                          {model.display_name || model.name}
                        </span>
                        <Tag variant="info" className="text-xs">
                          {getModelProvider(model.json)}
                        </Tag>
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">{getModelId(model.json)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEditDialog(model)}
                    >
                      <PencilIcon className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:text-error"
                      onClick={() => {
                        setSelectedModel(model)
                        setIsDeleteDialogOpen(true)
                      }}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add Button */}
      <div className="flex justify-center">
        <Button variant="outline" onClick={openAddDialog} className="gap-2">
          <PlusIcon className="w-4 h-4" />
          {t('admin:setup_wizard.model_step.add_model')}
        </Button>
      </div>

      {/* Add/Edit Model Dialog - Reusing ModelEditDialog */}
      <ModelEditDialog
        open={isAddDialogOpen}
        initialData={editingModelData}
        onClose={handleCloseDialog}
        toast={toast}
        onSave={handleSaveModel}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:public_models.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:public_models.confirm.delete_message', { name: selectedModel?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin:common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteModel} className="bg-error hover:bg-error/90">
              {t('admin:common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default SetupModelStep
