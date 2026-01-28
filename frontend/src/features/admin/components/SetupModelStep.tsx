// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  CpuChipIcon,
  PencilIcon,
  TrashIcon,
  EyeIcon,
  EyeSlashIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline'
import { Loader2, PlusIcon, RefreshCw, ChevronDown, Check } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  adminApis,
  AdminPublicModel,
  AdminPublicModelCreate,
} from '@/apis/admin'
import { modelApis, ModelCategoryType, AvailableModel } from '@/apis/models'

// Model category type options (only LLM for setup wizard)
const MODEL_CATEGORY_OPTIONS: { value: ModelCategoryType; labelKey: string }[] = [
  { value: 'llm', labelKey: 'common:models.model_category_type_llm' },
  { value: 'embedding', labelKey: 'common:models.model_category_type_embedding' },
  { value: 'rerank', labelKey: 'common:models.model_category_type_rerank' },
]

// Protocol options by model category type
const PROTOCOL_BY_CATEGORY: Record<
  ModelCategoryType,
  { value: string; label: string; hint?: string }[]
> = {
  llm: [
    { value: 'openai', label: 'OpenAI', hint: 'Chat Completions API' },
    { value: 'openai-responses', label: 'OpenAI Responses', hint: 'Responses API' },
    { value: 'anthropic', label: 'Anthropic', hint: 'Claude' },
    { value: 'gemini', label: 'Gemini', hint: 'Google' },
  ],
  tts: [],
  stt: [],
  embedding: [
    { value: 'openai', label: 'OpenAI Embeddings' },
    { value: 'cohere', label: 'Cohere Embed' },
    { value: 'jina', label: 'Jina AI' },
    { value: 'custom', label: 'Custom API' },
  ],
  rerank: [
    { value: 'cohere', label: 'Cohere Rerank' },
    { value: 'jina', label: 'Jina Reranker' },
    { value: 'custom', label: 'Custom API' },
  ],
}

const OPENAI_MODEL_OPTIONS = [
  { value: 'gpt-4o', label: 'gpt-4o (Recommended)' },
  { value: 'gpt-4-turbo', label: 'gpt-4-turbo' },
  { value: 'gpt-4', label: 'gpt-4' },
  { value: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo' },
  { value: 'custom', label: 'Custom...' },
]

const ANTHROPIC_MODEL_OPTIONS = [
  { value: 'claude-sonnet-4', label: 'claude-sonnet-4 (Recommended)' },
  { value: 'claude-opus-4', label: 'claude-opus-4' },
  { value: 'claude-haiku-4.5', label: 'claude-haiku-4.5' },
  { value: 'custom', label: 'Custom...' },
]

const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3-pro', label: 'gemini-3-pro (Recommended)' },
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  { value: 'custom', label: 'Custom...' },
]

const SetupModelStep: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [loading, setLoading] = useState(true)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AdminPublicModel | null>(null)
  const [editingModel, setEditingModel] = useState<AdminPublicModel | null>(null)

  // Form state
  const [modelIdName, setModelIdName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modelCategoryType, setModelCategoryType] = useState<ModelCategoryType>('llm')
  const [providerType, setProviderType] = useState('openai')
  const [modelId, setModelId] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customHeaders, setCustomHeaders] = useState('')
  const [customHeadersError, setCustomHeadersError] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined)
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(undefined)

  // UI states
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<AvailableModel[]>([])
  const [modelIdSearch, setModelIdSearch] = useState('')
  const [modelIdPopoverOpen, setModelIdPopoverOpen] = useState(false)

  const dialogContentRef = React.useRef<HTMLDivElement>(null)

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

  // Get base model options
  const baseModelOptions =
    modelCategoryType === 'embedding' || modelCategoryType === 'rerank'
      ? [{ value: 'custom', label: 'Custom...' }]
      : providerType === 'openai' || providerType === 'openai-responses'
        ? OPENAI_MODEL_OPTIONS
        : providerType === 'gemini'
          ? GEMINI_MODEL_OPTIONS
          : ANTHROPIC_MODEL_OPTIONS

  // Merge fetched models with base options
  const modelOptions = React.useMemo(() => {
    if (fetchedModels.length > 0) {
      const fetchedOptions = fetchedModels.map(m => ({
        value: m.id,
        label: m.name || m.id,
      }))
      return [...fetchedOptions, { value: 'custom', label: 'Custom...' }]
    }
    return baseModelOptions
  }, [fetchedModels, baseModelOptions])

  // Filtered model options based on search
  const filteredModelOptions = React.useMemo(() => {
    if (!modelIdSearch.trim()) {
      return modelOptions
    }
    const searchLower = modelIdSearch.toLowerCase()
    return modelOptions.filter(
      option =>
        option.value.toLowerCase().includes(searchLower) ||
        option.label.toLowerCase().includes(searchLower)
    )
  }, [modelOptions, modelIdSearch])

  // Get available protocols for current category type
  const availableProtocols = PROTOCOL_BY_CATEGORY[modelCategoryType] || []

  // Clear fetched models when provider type or base URL changes
  useEffect(() => {
    setFetchedModels([])
    setModelIdSearch('')
  }, [providerType, baseUrl])

  const handleModelCategoryTypeChange = (value: ModelCategoryType) => {
    setModelCategoryType(value)
    const protocols = PROTOCOL_BY_CATEGORY[value]
    if (protocols && protocols.length > 0) {
      setProviderType(protocols[0].value)
    }
    if (value === 'embedding' || value === 'rerank') {
      setModelId('custom')
      setCustomModelId('')
    } else {
      setModelId('')
      setCustomModelId('')
    }
  }

  const handleProviderChange = (value: string) => {
    setProviderType(value)
    setModelId('')
    setCustomModelId('')
    if (modelCategoryType === 'llm') {
      if (value === 'openai' || value === 'openai-responses') {
        setBaseUrl('https://api.openai.com/v1')
      } else if (value === 'gemini') {
        setBaseUrl('https://generativelanguage.googleapis.com')
      } else {
        setBaseUrl('https://api.anthropic.com')
      }
    }
  }

  const validateCustomHeaders = (value: string): Record<string, string> | null => {
    if (!value.trim()) {
      setCustomHeadersError('')
      return {}
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setCustomHeadersError(t('common:models.errors.custom_headers_invalid_object'))
        return null
      }
      for (const [_key, val] of Object.entries(parsed)) {
        if (typeof val !== 'string') {
          setCustomHeadersError(t('common:models.errors.custom_headers_values_must_be_strings'))
          return null
        }
      }
      setCustomHeadersError('')
      return parsed as Record<string, string>
    } catch {
      setCustomHeadersError(t('common:models.errors.custom_headers_invalid_json'))
      return null
    }
  }

  // Normalize provider type for API calls
  const normalizeProviderType = (value: string): string => {
    if (value === 'openai-responses') return 'openai'
    return value
  }

  const handleFetchModels = async () => {
    if (!apiKey.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:models.fetch_error_no_api_key'),
      })
      return
    }

    const parsedHeaders = validateCustomHeaders(customHeaders)
    if (parsedHeaders === null) {
      return
    }

    const normalizedProvider = normalizeProviderType(providerType)

    setFetchingModels(true)
    try {
      const result = await modelApis.fetchAvailableModels({
        provider_type: normalizedProvider as 'openai' | 'anthropic' | 'gemini' | 'custom',
        api_key: apiKey,
        base_url: baseUrl || undefined,
        custom_headers: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
      })

      if (result.success && result.models) {
        setFetchedModels(result.models)
        toast({
          title: t('common:models.fetch_success', { count: result.models.length }),
        })
      } else {
        toast({
          variant: 'destructive',
          title: t('common:models.fetch_failed'),
          description: result.message,
        })
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:models.fetch_failed'),
        description: (error as Error).message,
      })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleTestConnection = async () => {
    const finalModelId = modelId === 'custom' ? customModelId : modelId
    if (!finalModelId || !apiKey) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      })
      return
    }

    const parsedHeaders = validateCustomHeaders(customHeaders)
    if (parsedHeaders === null) {
      return
    }

    const normalizedProvider = normalizeProviderType(providerType)

    // Check if provider is supported for test connection
    if (!['openai', 'anthropic', 'gemini'].includes(normalizedProvider)) {
      toast({
        variant: 'destructive',
        title: t('common:models.test_failed'),
        description: 'Test connection is not supported for this provider',
      })
      return
    }

    setTesting(true)
    try {
      const result = await modelApis.testConnection({
        provider_type: normalizedProvider as 'openai' | 'anthropic' | 'gemini',
        model_id: finalModelId,
        api_key: apiKey,
        base_url: baseUrl || undefined,
        custom_headers: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
        model_category_type: modelCategoryType,
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
      setTesting(false)
    }
  }

  const resetForm = () => {
    setModelIdName('')
    setDisplayName('')
    setModelCategoryType('llm')
    setProviderType('openai')
    setModelId('')
    setCustomModelId('')
    setApiKey('')
    setBaseUrl('')
    setCustomHeaders('')
    setCustomHeadersError('')
    setShowApiKey(false)
    setContextWindow(undefined)
    setMaxOutputTokens(undefined)
    setFetchedModels([])
    setEditingModel(null)
  }

  const handleSave = async () => {
    if (!modelIdName.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.id_required'),
      })
      return
    }

    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
    if (!nameRegex.test(modelIdName)) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.id_invalid'),
      })
      return
    }

    const finalModelId = modelId === 'custom' ? customModelId : modelId
    if (!finalModelId) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      })
      return
    }

    if (!apiKey.trim()) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.api_key_required'),
      })
      return
    }

    const parsedHeaders = validateCustomHeaders(customHeaders)
    if (parsedHeaders === null) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.custom_headers_invalid'),
      })
      return
    }

    setSaving(true)
    try {
      // Map provider type to model field value
      let modelFieldValue = providerType
      if (modelCategoryType === 'llm') {
        if (providerType === 'anthropic') {
          modelFieldValue = 'claude'
        } else if (providerType === 'openai-responses') {
          modelFieldValue = 'openai'
        }
      }

      // Build the CRD JSON structure
      const modelCRD = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelIdName.trim(),
          namespace: 'default',
          displayName: displayName.trim() || undefined,
        },
        spec: {
          modelConfig: {
            env: {
              model: modelFieldValue,
              model_id: finalModelId,
              api_key: apiKey,
              ...(baseUrl && { base_url: baseUrl }),
              ...(parsedHeaders &&
                Object.keys(parsedHeaders).length > 0 && { custom_headers: parsedHeaders }),
            },
          },
          modelType: modelCategoryType,
          ...(providerType === 'openai-responses' && { protocol: 'openai-responses' }),
          ...(modelCategoryType === 'llm' && contextWindow && { contextWindow }),
          ...(modelCategoryType === 'llm' && maxOutputTokens && { maxOutputTokens }),
        },
        status: {
          state: 'Available',
        },
      }

      const createData: AdminPublicModelCreate = {
        name: modelIdName.trim(),
        namespace: 'default',
        json: modelCRD,
      }

      if (editingModel) {
        await adminApis.updatePublicModel(editingModel.id, {
          name: modelIdName.trim(),
          json: modelCRD,
        })
        toast({ title: t('admin:setup_wizard.model_step.model_updated') })
      } else {
        await adminApis.createPublicModel(createData)
        toast({ title: t('admin:setup_wizard.model_step.model_added') })
      }

      setIsAddDialogOpen(false)
      resetForm()
      fetchModels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: editingModel
          ? t('admin:public_models.errors.update_failed')
          : t('admin:public_models.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
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
    setEditingModel(model)
    const json = model.json as Record<string, unknown>
    const spec = json?.spec as Record<string, unknown>
    const metadata = json?.metadata as Record<string, unknown>
    const modelConfig = spec?.modelConfig as Record<string, unknown>
    const env = modelConfig?.env as Record<string, unknown>

    setModelIdName(model.name)
    setDisplayName((metadata?.displayName as string) || '')
    setModelCategoryType((spec?.modelType as ModelCategoryType) || 'llm')

    const modelType = env?.model as string
    if (spec?.protocol === 'openai-responses') {
      setProviderType('openai-responses')
    } else if (modelType === 'claude') {
      setProviderType('anthropic')
    } else {
      setProviderType(modelType || 'openai')
    }

    const modelIdValue = env?.model_id as string
    if (modelIdValue) {
      const isPreset = baseModelOptions.some(opt => opt.value === modelIdValue && opt.value !== 'custom')
      if (isPreset) {
        setModelId(modelIdValue)
        setCustomModelId('')
      } else {
        setModelId('custom')
        setCustomModelId(modelIdValue)
      }
    }

    setApiKey((env?.api_key as string) || '')
    setBaseUrl((env?.base_url as string) || '')
    const headers = env?.custom_headers as Record<string, string>
    if (headers && Object.keys(headers).length > 0) {
      setCustomHeaders(JSON.stringify(headers, null, 2))
    }
    setContextWindow(spec?.contextWindow as number | undefined)
    setMaxOutputTokens(spec?.maxOutputTokens as number | undefined)

    setIsAddDialogOpen(true)
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

  const apiKeyPlaceholder =
    providerType === 'openai' || providerType === 'openai-responses'
      ? 'sk-...'
      : providerType === 'gemini'
        ? 'AIza...'
        : 'sk-ant-...'

  const baseUrlPlaceholder =
    providerType === 'openai' || providerType === 'openai-responses'
      ? 'https://api.openai.com/v1'
      : providerType === 'gemini'
        ? 'https://generativelanguage.googleapis.com'
        : 'https://api.anthropic.com'

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
                      <div className="text-xs text-text-muted mt-0.5">
                        {getModelId(model.json)}
                      </div>
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
        <Button
          variant="outline"
          onClick={() => {
            resetForm()
            setIsAddDialogOpen(true)
          }}
          className="gap-2"
        >
          <PlusIcon className="w-4 h-4" />
          {t('admin:setup_wizard.model_step.add_model')}
        </Button>
      </div>

      {/* Add/Edit Model Dialog */}
      <Dialog
        open={isAddDialogOpen}
        onOpenChange={open => {
          if (!open) {
            resetForm()
          }
          setIsAddDialogOpen(open)
        }}
      >
        <DialogContent ref={dialogContentRef} className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingModel
                ? t('admin:public_models.edit_model')
                : t('admin:setup_wizard.model_step.add_model')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Model Category Type Selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                {t('common:models.model_category_type')} <span className="text-red-400">*</span>
              </Label>
              <Select
                value={modelCategoryType}
                onValueChange={(value: ModelCategoryType) => handleModelCategoryTypeChange(value)}
                disabled={!!editingModel}
              >
                <SelectTrigger className="bg-base">
                  <SelectValue placeholder={t('common:models.select_model_category_type')} />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_CATEGORY_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model ID and Display Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('common:models.model_id_name')} <span className="text-red-400">*</span>
                </Label>
                <Input
                  value={modelIdName}
                  onChange={e => setModelIdName(e.target.value)}
                  placeholder="my-gpt-model"
                  disabled={!!editingModel}
                  className="bg-base"
                />
                <p className="text-xs text-text-muted">
                  {editingModel
                    ? t('common:models.id_readonly_hint')
                    : t('common:models.id_hint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('common:models.display_name')}</Label>
                <Input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder={t('common:models.display_name_placeholder')}
                  className="bg-base"
                />
              </div>
            </div>

            {/* Provider Type and Model ID */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('common:models.provider_type')} <span className="text-red-400">*</span>
                </Label>
                <Select value={providerType} onValueChange={handleProviderChange}>
                  <SelectTrigger className="bg-base">
                    <SelectValue placeholder={t('common:models.select_provider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProtocols.map(protocol => (
                      <SelectItem key={protocol.value} value={protocol.value}>
                        <div className="flex items-center gap-2">
                          <span>{protocol.label}</span>
                          {protocol.hint && (
                            <span className="text-xs text-text-muted">({protocol.hint})</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    {t('common:models.model_id')} <span className="text-red-400">*</span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleFetchModels}
                    disabled={fetchingModels || !apiKey.trim()}
                    className="h-7 px-2 text-xs"
                  >
                    {fetchingModels ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    {t('common:models.fetch_models')}
                  </Button>
                </div>
                <Popover open={modelIdPopoverOpen} onOpenChange={setModelIdPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={modelIdPopoverOpen}
                      className="w-full justify-between bg-base font-normal"
                    >
                      {modelId
                        ? modelOptions.find(option => option.value === modelId)?.label || modelId
                        : t('common:models.select_model_id')}
                      <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[--radix-popover-trigger-width] p-0"
                    align="start"
                    onOpenAutoFocus={e => e.preventDefault()}
                    container={dialogContentRef.current}
                  >
                    <div className="p-2 border-b">
                      <Input
                        placeholder={t('common:models.search_model_id', 'Search model...')}
                        value={modelIdSearch}
                        onChange={e => setModelIdSearch(e.target.value)}
                        className="h-8"
                        autoFocus
                      />
                    </div>
                    <div className="p-1" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                      {filteredModelOptions.length === 0 ? (
                        <div className="py-4 text-center text-sm text-text-muted">
                          {t('common:branches.no_match', 'No match found')}
                        </div>
                      ) : (
                        filteredModelOptions.map(option => (
                          <div
                            key={option.value}
                            className={cn(
                              'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground',
                              modelId === option.value && 'bg-accent'
                            )}
                            onClick={() => {
                              setModelId(option.value)
                              setModelIdPopoverOpen(false)
                              setModelIdSearch('')
                            }}
                          >
                            <Check
                              className={cn(
                                'mr-2 h-4 w-4',
                                modelId === option.value ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            {option.label}
                          </div>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
                {modelId === 'custom' && (
                  <Input
                    value={customModelId}
                    onChange={e => setCustomModelId(e.target.value)}
                    placeholder={t('common:models.custom_model_id_placeholder')}
                    className="mt-2 bg-base"
                  />
                )}
              </div>
            </div>

            {/* API Key */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                {t('common:models.api_key')} <span className="text-red-400">*</span>
              </Label>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={apiKeyPlaceholder}
                  className="bg-base pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <EyeSlashIcon className="w-4 h-4" />
                  ) : (
                    <EyeIcon className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('common:models.base_url')}</Label>
              <Input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder={baseUrlPlaceholder}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('common:models.base_url_hint')}</p>
            </div>

            {/* Custom Headers */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('common:models.custom_headers')}</Label>
              <Textarea
                value={customHeaders}
                onChange={e => {
                  setCustomHeaders(e.target.value)
                  validateCustomHeaders(e.target.value)
                }}
                placeholder={`{\n  "X-Custom-Header": "value"\n}`}
                className={`bg-base font-mono text-sm min-h-[80px] ${customHeadersError ? 'border-error' : ''}`}
              />
              {customHeadersError && <p className="text-xs text-error">{customHeadersError}</p>}
            </div>

            {/* LLM-specific fields */}
            {modelCategoryType === 'llm' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{t('common:models.context_window')}</Label>
                  <Input
                    type="number"
                    value={contextWindow || ''}
                    onChange={e => setContextWindow(parseInt(e.target.value) || undefined)}
                    placeholder="128000"
                    className="bg-base"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    {t('common:models.max_output_tokens')}
                  </Label>
                  <Input
                    type="number"
                    value={maxOutputTokens || ''}
                    onChange={e => setMaxOutputTokens(parseInt(e.target.value) || undefined)}
                    placeholder="8192"
                    className="bg-base"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !modelId || !apiKey}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <BeakerIcon className="w-4 h-4 mr-1" />
              {t('common:models.test_connection')}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  resetForm()
                  setIsAddDialogOpen(false)
                }}
              >
                {t('admin:common.cancel')}
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingModel ? t('admin:common.save') : t('admin:common.create')}
              </Button>
            </div>
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

export default SetupModelStep
