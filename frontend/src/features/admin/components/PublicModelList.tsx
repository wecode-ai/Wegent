// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { CpuChipIcon, PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  adminApis,
  AdminPublicModel,
  AdminPublicModelCreate,
  AdminPublicModelUpdate,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const PublicModelList: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AdminPublicModel | null>(null)

  // Form states
  const [formData, setFormData] = useState<{
    name: string
    namespace: string
    config: string
    is_active: boolean
  }>({
    name: '',
    namespace: 'default',
    config: '{}',
    is_active: true,
  })
  const [configError, setConfigError] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchModels = useCallback(async () => {
    setLoading(true)
    try {
      // Use a larger limit to display all public models without pagination
      const response = await adminApis.getPublicModels(page, 100)
      setModels(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const validateConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setConfigError(t('admin:public_models.errors.config_required'))
      return null
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setConfigError(t('admin:public_models.errors.config_invalid_json'))
        return null
      }
      setConfigError('')
      return parsed as Record<string, unknown>
    } catch {
      setConfigError(t('admin:public_models.errors.config_invalid_json'))
      return null
    }
  }

  const handleCreateModel = async () => {
    if (!formData.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.name_required'),
      })
      return
    }

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const createData: AdminPublicModelCreate = {
        name: formData.name.trim(),
        namespace: formData.namespace.trim() || 'default',
        json: config,
      }
      await adminApis.createPublicModel(createData)
      toast({ title: t('admin:public_models.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateModel = async () => {
    if (!selectedModel) return

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const updateData: AdminPublicModelUpdate = {}
      if (formData.name !== selectedModel.name) {
        updateData.name = formData.name
      }
      if (formData.namespace !== selectedModel.namespace) {
        updateData.namespace = formData.namespace
      }
      updateData.json = config
      if (formData.is_active !== selectedModel.is_active) {
        updateData.is_active = formData.is_active
      }

      await adminApis.updatePublicModel(selectedModel.id, updateData)
      toast({ title: t('admin:public_models.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteModel = async () => {
    if (!selectedModel) return

    setSaving(true)
    try {
      await adminApis.deletePublicModel(selectedModel.id)
      toast({ title: t('admin:public_models.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedModel(null)
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_models.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      namespace: 'default',
      config: '{}',
      is_active: true,
    })
    setConfigError('')
    setSelectedModel(null)
  }

  const openEditDialog = (model: AdminPublicModel) => {
    setSelectedModel(model)
    setFormData({
      name: model.name,
      namespace: model.namespace,
      config: JSON.stringify(model.json, null, 2),
      is_active: model.is_active,
    })
    setIsEditDialogOpen(true)
  }

  const getModelProvider = (json: Record<string, unknown>): string => {
    const env = (json?.env as Record<string, unknown>) || {}
    const model = env?.model as string
    if (model === 'openai') return 'OpenAI'
    if (model === 'claude') return 'Anthropic'
    return 'Unknown'
  }

  const getModelId = (json: Record<string, unknown>): string => {
    const env = (json?.env as Record<string, unknown>) || {}
    return (env?.model_id as string) || 'N/A'
  }

  const getDisplayName = (model: AdminPublicModel): string => {
    // Use display_name from API response if available, otherwise fall back to name
    return model.display_name || model.name
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('admin:public_models.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('admin:public_models.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && models.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CpuChipIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:public_models.no_models')}</p>
          </div>
        )}

        {/* Model List */}
        {!loading && models.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {models.map(model => (
              <Card
                key={model.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {getDisplayName(model)}
                        </h3>
                        <Tag variant="info">{getModelProvider(model.json)}</Tag>
                        {model.is_active ? (
                          <Tag variant="success">{t('admin:public_models.status.active')}</Tag>
                        ) : (
                          <Tag variant="error">{t('admin:public_models.status.inactive')}</Tag>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                        <span>
                          {t('admin:public_models.form.name')}: {model.name}
                        </span>
                        <span>•</span>
                        <span>
                          {t('admin:public_models.model_id')}: {getModelId(model.json)}
                        </span>
                        <span>•</span>
                        <span>
                          {t('admin:public_models.namespace_label')}: {model.namespace}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(model)}
                      title={t('admin:public_models.edit_model')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedModel(model)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('admin:public_models.delete_model')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setIsCreateDialogOpen(true)}>
                {t('admin:public_models.create_model')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create Model Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('admin:public_models.create_model')}</DialogTitle>
            <DialogDescription>{t('admin:public_models.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('admin:public_models.form.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:public_models.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namespace">{t('admin:public_models.form.namespace')}</Label>
              <Input
                id="namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('admin:public_models.form.namespace_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="config">{t('admin:public_models.form.config')} *</Label>
              <Textarea
                id="config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('admin:public_models.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button onClick={handleCreateModel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Model Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('admin:public_models.edit_model')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('admin:public_models.form.name')}</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:public_models.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-namespace">{t('admin:public_models.form.namespace')}</Label>
              <Input
                id="edit-namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('admin:public_models.form.namespace_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-config">{t('admin:public_models.form.config')}</Label>
              <Textarea
                id="edit-config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('admin:public_models.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-active">{t('admin:public_models.columns.status')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_active
                    ? t('admin:public_models.status.active')
                    : t('admin:public_models.status.inactive')}
                </span>
                <Switch
                  id="edit-is-active"
                  checked={formData.is_active}
                  onCheckedChange={checked => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button onClick={handleUpdateModel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

export default PublicModelList
