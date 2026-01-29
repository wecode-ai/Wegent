// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
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
import { Loader2, RefreshCw, ChevronDown, Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EyeIcon, EyeSlashIcon, BeakerIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  modelApis,
  ModelCRD,
  ModelCategoryType,
  TTSConfig,
  STTConfig,
  EmbeddingConfig,
  RerankConfig,
  AvailableModel,
} from '@/apis/models'

// Model form data that can be used by callers
export interface ModelFormData {
  modelIdName: string
  displayName: string
  modelCategoryType: ModelCategoryType
  providerType: string
  modelId: string
  customModelId: string
  apiKey: string
  baseUrl: string
  customHeaders: string
  contextWindow?: number
  maxOutputTokens?: number
  // Type-specific configs
  ttsVoice?: string
  ttsSpeed?: number
  ttsOutputFormat?: 'mp3' | 'wav'
  sttLanguage?: string
  sttTranscriptionFormat?: 'text' | 'srt' | 'vtt'
  embeddingDimensions?: number
  embeddingEncodingFormat?: 'float' | 'base64'
  rerankTopN?: number
  rerankReturnDocuments?: boolean
}

// Initial data for editing (can be from ModelCRD or admin model JSON)
export interface ModelInitialData {
  name: string
  displayName?: string
  modelCategoryType?: ModelCategoryType
  providerType?: string
  modelId?: string
  apiKey?: string
  baseUrl?: string
  customHeaders?: Record<string, string>
  protocol?: string
  contextWindow?: number
  maxOutputTokens?: number
  // Type-specific configs
  ttsConfig?: TTSConfig
  sttConfig?: STTConfig
  embeddingConfig?: EmbeddingConfig
  rerankConfig?: RerankConfig
}

interface ModelEditDialogProps {
  open: boolean
  /**
   * Initial data for editing. If null, creates a new model.
   */
  initialData?: ModelInitialData | null
  /**
   * Legacy prop for backward compatibility - will be converted to initialData
   * @deprecated Use initialData instead
   */
  model?: ModelCRD | null
  onClose: () => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  /**
   * Custom save handler. If provided, will be called instead of default modelApis.
   * Return true if save was successful, false otherwise.
   */
  onSave?: (formData: ModelFormData, modelCRD: ModelCRD) => Promise<boolean>
  /**
   * Group name for group scope models
   */
  groupName?: string
  /**
   * Scope for the model (personal or group)
   */
  scope?: 'personal' | 'group'
}

// Model category type options
const MODEL_CATEGORY_OPTIONS: { value: ModelCategoryType; labelKey: string }[] = [
  { value: 'llm', labelKey: 'models.model_category_type_llm' },
  // { value: 'tts', labelKey: 'models.model_category_type_tts' },
  // { value: 'stt', labelKey: 'models.model_category_type_stt' },
  { value: 'embedding', labelKey: 'models.model_category_type_embedding' },
  { value: 'rerank', labelKey: 'models.model_category_type_rerank' },
]

// Protocol options by model category type
const PROTOCOL_BY_CATEGORY: Record<
  ModelCategoryType,
  { value: string; label: string; hint?: string }[]
> = {
  llm: [
    { value: 'openai', label: 'OpenAI', hint: 'Chat Completions API' },
    { value: 'openai-responses', label: 'OpenAI Responses', hint: 'Responses API' },
    { value: 'anthropic', label: 'Anthropic', hint: 'Claude Code' },
    { value: 'gemini', label: 'Gemini', hint: 'Google' },
  ],
  tts: [
    { value: 'openai', label: 'OpenAI TTS' },
    { value: 'azure', label: 'Azure Cognitive Services' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'custom', label: 'Custom API' },
  ],
  stt: [
    { value: 'openai', label: 'OpenAI Whisper' },
    { value: 'azure', label: 'Azure Speech Services' },
    { value: 'google', label: 'Google Cloud STT' },
    { value: 'custom', label: 'Custom API' },
  ],
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

const ModelEditDialog: React.FC<ModelEditDialogProps> = ({
  open,
  model,
  initialData,
  onClose,
  toast,
  onSave,
  groupName,
  scope,
}) => {
  const { t } = useTranslation()
  // Support both legacy model prop and new initialData prop
  const effectiveInitialData =
    initialData ||
    (model
      ? {
          name: model.metadata.name,
          displayName: model.metadata.displayName,
          modelCategoryType: model.spec.modelType,
          providerType: model.spec.modelConfig?.env?.model,
          modelId: model.spec.modelConfig?.env?.model_id,
          apiKey: model.spec.modelConfig?.env?.api_key,
          baseUrl: model.spec.modelConfig?.env?.base_url,
          customHeaders: model.spec.modelConfig?.env?.custom_headers,
          protocol: model.spec.protocol,
          contextWindow: model.spec.contextWindow,
          maxOutputTokens: model.spec.maxOutputTokens,
          ttsConfig: model.spec.ttsConfig,
          sttConfig: model.spec.sttConfig,
          embeddingConfig: model.spec.embeddingConfig,
          rerankConfig: model.spec.rerankConfig,
        }
      : null)
  const isEditing = !!effectiveInitialData
  const isGroupScope = scope === 'group'

  // Form state
  const [modelIdName, setModelIdName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modelCategoryType, setModelCategoryType] = useState<ModelCategoryType>('llm')
  const [providerType, setProviderType] = useState<string>('openai')
  const [modelId, setModelId] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customHeaders, setCustomHeaders] = useState('')
  const [customHeadersError, setCustomHeadersError] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  // LLM-specific config state
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined)
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(undefined)

  // Type-specific config state
  // TTS
  const [ttsVoice, setTtsVoice] = useState('')
  const [ttsSpeed, setTtsSpeed] = useState<number>(1.0)
  const [ttsOutputFormat, setTtsOutputFormat] = useState<'mp3' | 'wav'>('mp3')
  // STT
  const [sttLanguage, setSttLanguage] = useState('')
  const [sttTranscriptionFormat, setSttTranscriptionFormat] = useState<'text' | 'srt' | 'vtt'>(
    'text'
  )
  // Embedding
  const [embeddingDimensions, setEmbeddingDimensions] = useState<number | undefined>(undefined)
  const [embeddingEncodingFormat, setEmbeddingEncodingFormat] = useState<'float' | 'base64'>(
    'float'
  )
  // Rerank
  const [rerankTopN, setRerankTopN] = useState<number | undefined>(undefined)
  const [rerankReturnDocuments, setRerankReturnDocuments] = useState(true)

  // Fetch models state
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<AvailableModel[]>([])
  const [fetchError, setFetchError] = useState('')
  const [modelIdSearch, setModelIdSearch] = useState('')
  const [modelIdPopoverOpen, setModelIdPopoverOpen] = useState(false)

  // Model list cache (in-memory, expires after 5 minutes)
  const modelCacheRef = React.useRef<Map<string, { models: AvailableModel[]; timestamp: number }>>(
    new Map()
  )
  const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

  // Ref for dialog content to use as Popover container (fixes pointer-events issue in Dialog)
  const dialogContentRef = React.useRef<HTMLDivElement>(null)

  // Reset form when dialog opens/closes or initialData changes
  useEffect(() => {
    if (open) {
      if (effectiveInitialData) {
        setModelIdName(effectiveInitialData.name || '')
        setDisplayName(effectiveInitialData.displayName || '')
        // Set model category type
        setModelCategoryType(effectiveInitialData.modelCategoryType || 'llm')
        const modelType = effectiveInitialData.providerType
        const protocol = effectiveInitialData.protocol
        // Map model type to provider type
        // Check protocol first for openai-responses
        if (protocol === 'openai-responses') {
          setProviderType('openai-responses')
        } else if (modelType === 'claude') {
          setProviderType('anthropic')
        } else if (
          modelType === 'openai' ||
          modelType === 'gemini' ||
          modelType === 'cohere' ||
          modelType === 'jina' ||
          modelType === 'custom'
        ) {
          setProviderType(modelType)
        } else {
          setProviderType('openai') // Default fallback
        }
        setApiKey(effectiveInitialData.apiKey || '')
        setBaseUrl(effectiveInitialData.baseUrl || '')
        const headers = effectiveInitialData.customHeaders
        if (headers && Object.keys(headers).length > 0) {
          setCustomHeaders(JSON.stringify(headers, null, 2))
        } else {
          setCustomHeaders('')
        }
        // Load type-specific configs
        if (effectiveInitialData.ttsConfig) {
          setTtsVoice(effectiveInitialData.ttsConfig.voice || '')
          setTtsSpeed(effectiveInitialData.ttsConfig.speed || 1.0)
          setTtsOutputFormat(
            (effectiveInitialData.ttsConfig.output_format as 'mp3' | 'wav') || 'mp3'
          )
        }
        if (effectiveInitialData.sttConfig) {
          setSttLanguage(effectiveInitialData.sttConfig.language || '')
          setSttTranscriptionFormat(
            (effectiveInitialData.sttConfig.transcription_format as 'text' | 'srt' | 'vtt') ||
              'text'
          )
        }
        if (effectiveInitialData.embeddingConfig) {
          setEmbeddingDimensions(effectiveInitialData.embeddingConfig.dimensions)
          setEmbeddingEncodingFormat(
            (effectiveInitialData.embeddingConfig.encoding_format as 'float' | 'base64') || 'float'
          )
        }
        if (effectiveInitialData.rerankConfig) {
          setRerankTopN(effectiveInitialData.rerankConfig.top_n)
          setRerankReturnDocuments(effectiveInitialData.rerankConfig.return_documents ?? true)
        }
        // Load LLM-specific configs
        setContextWindow(effectiveInitialData.contextWindow)
        setMaxOutputTokens(effectiveInitialData.maxOutputTokens)
      } else {
        // Reset for new model
        setModelIdName('')
        setDisplayName('')
        setModelCategoryType('llm')
        setProviderType('openai')
        setModelId('')
        setCustomModelId('')
        setApiKey('')
        setBaseUrl('')
        setCustomHeaders('')
        // Reset type-specific configs
        setTtsVoice('')
        setTtsSpeed(1.0)
        setTtsOutputFormat('mp3')
        setSttLanguage('')
        setSttTranscriptionFormat('text')
        setEmbeddingDimensions(undefined)
        setEmbeddingEncodingFormat('float')
        setRerankTopN(undefined)
        setRerankReturnDocuments(true)
        // Reset LLM-specific configs
        setContextWindow(undefined)
        setMaxOutputTokens(undefined)
      }
      setCustomHeadersError('')
      setShowApiKey(false)
    }
  }, [open, effectiveInitialData])

  // Determine model options based on model category type and provider
  // For embedding/rerank, only show "Custom..." option since they don't use preset LLM models
  // For openai-responses, use the same model options as openai
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
      // Use fetched models + Custom option
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
    setFetchError('')
    setModelIdSearch('')
  }, [providerType, baseUrl])

  // Handle model category type change
  const handleModelCategoryTypeChange = (value: ModelCategoryType) => {
    setModelCategoryType(value)
    // Reset provider to first available option for new category
    const protocols = PROTOCOL_BY_CATEGORY[value]
    if (protocols && protocols.length > 0) {
      setProviderType(protocols[0].value)
    }
    // For embedding/rerank, automatically set to custom mode
    if (value === 'embedding' || value === 'rerank') {
      setModelId('custom')
      setCustomModelId('')
    } else {
      setModelId('')
      setCustomModelId('')
    }
  }

  // Set model ID when initialData changes
  useEffect(() => {
    if (effectiveInitialData?.modelId) {
      const id = effectiveInitialData.modelId
      const isPreset = modelOptions.some(opt => opt.value === id && opt.value !== 'custom')
      if (isPreset) {
        setModelId(id)
        setCustomModelId('')
      } else {
        setModelId('custom')
        setCustomModelId(id)
      }
    }
  }, [effectiveInitialData, modelOptions])
  const handleProviderChange = (value: string) => {
    setProviderType(value)
    setModelId('')
    setCustomModelId('')
    // Only set default base URL for LLM models
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

  const handleTestConnection = async () => {
    const finalModelId = modelId === 'custom' ? customModelId : modelId
    if (!finalModelId || !apiKey) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      })
      return
    }

    // Parse custom headers for test connection
    const parsedHeaders = validateCustomHeaders(customHeaders)
    if (parsedHeaders === null) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.custom_headers_invalid'),
      })
      return
    }

    setTesting(true)
    try {
      const result = await modelApis.testConnection({
        provider_type: providerType as 'openai' | 'anthropic' | 'gemini',
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

  const handleFetchModels = async () => {
    if (!apiKey.trim()) {
      setFetchError(t('common:models.fetch_error_no_api_key'))
      toast({
        variant: 'destructive',
        title: t('common:models.fetch_error_no_api_key'),
      })
      return
    }

    // Parse custom headers
    const parsedHeaders = validateCustomHeaders(customHeaders)
    if (parsedHeaders === null) {
      setFetchError(t('common:models.errors.custom_headers_invalid'))
      return
    }

    // Check cache
    const cacheKey = `${providerType}_${baseUrl || 'default'}`
    const cached = modelCacheRef.current.get(cacheKey)
    const now = Date.now()

    if (cached && now - cached.timestamp < CACHE_DURATION) {
      // Use cached models
      setFetchedModels(cached.models)
      setFetchError('')
      toast({
        title: t('common:models.fetch_success', { count: cached.models.length }),
      })
      return
    }

    setFetchingModels(true)
    setFetchError('')

    try {
      const result = await modelApis.fetchAvailableModels({
        provider_type: providerType as 'openai' | 'anthropic' | 'gemini' | 'custom',
        api_key: apiKey,
        base_url: baseUrl || undefined,
        custom_headers: Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
      })

      if (result.success && result.models) {
        // Cache the result
        modelCacheRef.current.set(cacheKey, {
          models: result.models,
          timestamp: now,
        })

        setFetchedModels(result.models)
        setFetchError('')

        toast({
          title: t('common:models.fetch_success', { count: result.models.length }),
        })
      } else {
        const errorMsg = result.message || t('common:models.fetch_failed')
        setFetchError(errorMsg)
        toast({
          variant: 'destructive',
          title: t('common:models.fetch_failed'),
          description: errorMsg,
        })
      }
    } catch (error) {
      const errorMsg = (error as Error).message
      setFetchError(errorMsg)

      // Map error to user-friendly message
      let userMessage = errorMsg
      if (errorMsg.includes('401') || errorMsg.includes('authentication')) {
        userMessage = t('common:models.fetch_error_auth')
      } else if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
        userMessage = t('common:models.fetch_error_network')
      }

      toast({
        variant: 'destructive',
        title: t('common:models.fetch_failed'),
        description: userMessage,
      })
    } finally {
      setFetchingModels(false)
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

  const handleCustomHeadersChange = (value: string) => {
    setCustomHeaders(value)
    validateCustomHeaders(value)
  }

  const handleSave = async () => {
    if (isGroupScope && !isEditing && !groupName) {
      toast({
        variant: 'destructive',
        title: '请先选择一个群组',
        description: '在群组模式下创建模型时必须选择目标群组',
      })
      return
    }

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
      // Build type-specific config based on modelCategoryType
      const ttsConfig: TTSConfig | undefined =
        modelCategoryType === 'tts'
          ? {
              voice: ttsVoice || undefined,
              speed: ttsSpeed,
              output_format: ttsOutputFormat,
            }
          : undefined

      const sttConfig: STTConfig | undefined =
        modelCategoryType === 'stt'
          ? {
              language: sttLanguage || undefined,
              transcription_format: sttTranscriptionFormat,
            }
          : undefined

      const embeddingConfig: EmbeddingConfig | undefined =
        modelCategoryType === 'embedding'
          ? {
              dimensions: embeddingDimensions,
              encoding_format: embeddingEncodingFormat,
            }
          : undefined

      const rerankConfig: RerankConfig | undefined =
        modelCategoryType === 'rerank'
          ? {
              top_n: rerankTopN,
              return_documents: rerankReturnDocuments,
            }
          : undefined

      // Map provider type to model field value
      // For LLM: openai -> openai, openai-responses -> openai, anthropic -> claude, gemini -> gemini
      // For embedding/rerank: use provider type directly (openai, cohere, jina, custom)
      let modelFieldValue = providerType
      if (modelCategoryType === 'llm') {
        if (providerType === 'anthropic') {
          modelFieldValue = 'claude'
        } else if (providerType === 'openai-responses') {
          // openai-responses uses openai as the model type, protocol distinguishes the API format
          modelFieldValue = 'openai'
        }
      }

      const modelCRD: ModelCRD = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelIdName.trim(),
          namespace: isGroupScope && groupName ? groupName : 'default',
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
          // Save protocol for openai-responses to distinguish from regular openai
          ...(providerType === 'openai-responses' && { protocol: 'openai-responses' }),
          // LLM-specific fields
          ...(modelCategoryType === 'llm' && contextWindow && { contextWindow }),
          ...(modelCategoryType === 'llm' && maxOutputTokens && { maxOutputTokens }),
          ...(ttsConfig && { ttsConfig }),
          ...(sttConfig && { sttConfig }),
          ...(embeddingConfig && { embeddingConfig }),
          ...(rerankConfig && { rerankConfig }),
        },
        status: {
          state: 'Available',
        },
      }

      // Build form data for custom onSave callback
      const formData: ModelFormData = {
        modelIdName: modelIdName.trim(),
        displayName: displayName.trim(),
        modelCategoryType,
        providerType,
        modelId: finalModelId,
        customModelId,
        apiKey,
        baseUrl,
        customHeaders,
        contextWindow,
        maxOutputTokens,
        ttsVoice,
        ttsSpeed,
        ttsOutputFormat,
        sttLanguage,
        sttTranscriptionFormat,
        embeddingDimensions,
        embeddingEncodingFormat,
        rerankTopN,
        rerankReturnDocuments,
      }

      // If custom onSave callback is provided, use it
      if (onSave) {
        const success = await onSave(formData, modelCRD)
        if (success) {
          onClose()
        }
      } else {
        // Default behavior: use modelApis for user models
        if (isEditing && model) {
          await modelApis.updateModel(model.metadata.name, modelCRD)
          toast({
            title: t('common:models.update_success'),
          })
        } else {
          await modelApis.createModel(modelCRD)
          toast({
            title: t('common:models.create_success'),
          })
        }
        onClose()
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing
          ? t('common:models.errors.update_failed')
          : t('common:models.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
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
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent ref={dialogContentRef} className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('common:models.edit_title') : t('common:models.create_title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Model Category Type Selector - New */}
          <div className="space-y-2">
            <Label htmlFor="modelCategoryType" className="text-sm font-medium">
              {t('common:models.model_category_type')} <span className="text-red-400">*</span>
            </Label>
            <Select
              value={modelCategoryType}
              onValueChange={(value: ModelCategoryType) => handleModelCategoryTypeChange(value)}
              disabled={isEditing}
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

          {/* Model ID and Display Name - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="modelIdName" className="text-sm font-medium">
                {t('common:models.model_id_name')} <span className="text-red-400">*</span>
              </Label>
              <Input
                id="modelIdName"
                value={modelIdName}
                onChange={e => setModelIdName(e.target.value)}
                placeholder="my-gpt-model"
                disabled={isEditing}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">
                {isEditing ? t('common:models.id_readonly_hint') : t('common:models.id_hint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm font-medium">
                {t('common:models.display_name')}
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('common:models.display_name_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('common:models.display_name_hint')}</p>
            </div>
          </div>

          {/* Provider Type and Model ID - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider_type" className="text-sm font-medium">
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
                <Label htmlFor="model_id" className="text-sm font-medium">
                  {t('common:models.model_id')} <span className="text-red-400">*</span>
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={fetchingModels || !apiKey.trim()}
                  className="h-7 px-2 text-xs"
                  title={
                    !apiKey.trim()
                      ? t('common:models.fetch_error_no_api_key')
                      : t('common:models.fetch_models')
                  }
                >
                  {fetchingModels ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      {t('common:models.fetching_models')}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-1 h-3 w-3" />
                      {t('common:models.fetch_models')}
                    </>
                  )}
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
                      placeholder={t('common:models.search_model_id', '搜索模型...')}
                      value={modelIdSearch}
                      onChange={e => setModelIdSearch(e.target.value)}
                      className="h-8"
                      autoFocus
                    />
                  </div>
                  <div className="p-1" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                    {filteredModelOptions.length === 0 ? (
                      <div className="py-4 text-center text-sm text-text-muted">
                        {t('common:branches.no_match', '没有找到匹配项')}
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
              {fetchError && <p className="text-xs text-error">{fetchError}</p>}
              {!apiKey.trim() && (
                <p className="text-xs text-text-muted">
                  {t('common:models.fetch_models_hint', '请先填写 API Key 后点击"加载模型"按钮')}
                </p>
              )}
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
            <Label htmlFor="api_key" className="text-sm font-medium">
              {t('common:models.api_key')} <span className="text-red-400">*</span>
            </Label>
            <div className="relative">
              <Input
                id="api_key"
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
            <Label htmlFor="base_url" className="text-sm font-medium">
              {t('common:models.base_url')}
            </Label>
            <Input
              id="base_url"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={baseUrlPlaceholder}
              className="bg-base"
            />
            <p className="text-xs text-text-muted">{t('common:models.base_url_hint')}</p>
          </div>

          {/* Custom Headers */}
          <div className="space-y-2">
            <Label htmlFor="custom_headers" className="text-sm font-medium">
              {t('common:models.custom_headers')}
            </Label>
            <Textarea
              id="custom_headers"
              value={customHeaders}
              onChange={e => handleCustomHeadersChange(e.target.value)}
              placeholder={`{\n  "X-Custom-Header": "value",\n  "Authorization": "Bearer token"\n}`}
              className={`bg-base font-mono text-sm min-h-[100px] ${customHeadersError ? 'border-error' : ''}`}
            />
            {customHeadersError && <p className="text-xs text-error">{customHeadersError}</p>}
            <p className="text-xs text-text-muted">{t('common:models.custom_headers_hint')}</p>
          </div>

          {/* LLM-specific fields - Context Window and Max Output Tokens */}
          {modelCategoryType === 'llm' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="context_window" className="text-sm font-medium">
                  {t('common:models.context_window')}
                </Label>
                <Input
                  id="context_window"
                  type="number"
                  value={contextWindow || ''}
                  onChange={e => setContextWindow(parseInt(e.target.value) || undefined)}
                  placeholder="128000"
                  className="bg-base"
                />
                <p className="text-xs text-text-muted">{t('common:models.context_window_hint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="max_output_tokens" className="text-sm font-medium">
                  {t('common:models.max_output_tokens')}
                </Label>
                <Input
                  id="max_output_tokens"
                  type="number"
                  value={maxOutputTokens || ''}
                  onChange={e => setMaxOutputTokens(parseInt(e.target.value) || undefined)}
                  placeholder="8192"
                  className="bg-base"
                />
                <p className="text-xs text-text-muted">
                  {t('common:models.max_output_tokens_hint')}
                </p>
              </div>
            </div>
          )}

          {/* TTS-specific fields */}
          {modelCategoryType === 'tts' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">TTS Configuration</h4>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tts_voice" className="text-sm font-medium">
                    {t('common:models.tts_voice')}
                  </Label>
                  <Input
                    id="tts_voice"
                    value={ttsVoice}
                    onChange={e => setTtsVoice(e.target.value)}
                    placeholder="alloy, echo, fable, onyx, nova, shimmer"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.tts_voice_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tts_speed" className="text-sm font-medium">
                    {t('common:models.tts_speed')}
                  </Label>
                  <Input
                    id="tts_speed"
                    type="number"
                    step="0.1"
                    min="0.25"
                    max="4.0"
                    value={ttsSpeed}
                    onChange={e => setTtsSpeed(parseFloat(e.target.value) || 1.0)}
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.tts_speed_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tts_output_format" className="text-sm font-medium">
                    {t('common:models.tts_output_format')}
                  </Label>
                  <Select
                    value={ttsOutputFormat}
                    onValueChange={(v: 'mp3' | 'wav') => setTtsOutputFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mp3">MP3</SelectItem>
                      <SelectItem value="wav">WAV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* STT-specific fields */}
          {modelCategoryType === 'stt' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">STT Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="stt_language" className="text-sm font-medium">
                    {t('common:models.stt_language')}
                  </Label>
                  <Input
                    id="stt_language"
                    value={sttLanguage}
                    onChange={e => setSttLanguage(e.target.value)}
                    placeholder="en, zh, es, fr, de, ja, ko"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.stt_language_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stt_format" className="text-sm font-medium">
                    {t('common:models.stt_transcription_format')}
                  </Label>
                  <Select
                    value={sttTranscriptionFormat}
                    onValueChange={(v: 'text' | 'srt' | 'vtt') => setSttTranscriptionFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="srt">SRT</SelectItem>
                      <SelectItem value="vtt">VTT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Embedding-specific fields */}
          {modelCategoryType === 'embedding' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">Embedding Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="embedding_dimensions" className="text-sm font-medium">
                    {t('common:models.embedding_dimensions')}
                  </Label>
                  <Input
                    id="embedding_dimensions"
                    type="number"
                    value={embeddingDimensions || ''}
                    onChange={e => setEmbeddingDimensions(parseInt(e.target.value) || undefined)}
                    placeholder="1536 (OpenAI), 768 (Cohere)"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">
                    {t('common:models.embedding_dimensions_hint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding_format" className="text-sm font-medium">
                    {t('common:models.embedding_encoding_format')}
                  </Label>
                  <Select
                    value={embeddingEncodingFormat}
                    onValueChange={(v: 'float' | 'base64') => setEmbeddingEncodingFormat(v)}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="float">Float</SelectItem>
                      <SelectItem value="base64">Base64</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Rerank-specific fields */}
          {modelCategoryType === 'rerank' && (
            <div className="space-y-4 p-4 bg-muted rounded-lg">
              <h4 className="text-sm font-medium text-text-secondary">Rerank Configuration</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rerank_top_n" className="text-sm font-medium">
                    {t('common:models.rerank_top_n')}
                  </Label>
                  <Input
                    id="rerank_top_n"
                    type="number"
                    value={rerankTopN || ''}
                    onChange={e => setRerankTopN(parseInt(e.target.value) || undefined)}
                    placeholder="Default: return all"
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.rerank_top_n_hint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rerank_return_docs" className="text-sm font-medium">
                    {t('common:models.rerank_return_documents')}
                  </Label>
                  <Select
                    value={rerankReturnDocuments ? 'true' : 'false'}
                    onValueChange={v => setRerankReturnDocuments(v === 'true')}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ModelEditDialog
