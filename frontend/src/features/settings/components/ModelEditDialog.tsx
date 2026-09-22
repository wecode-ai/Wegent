// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { AlertTriangle, Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EyeIcon, EyeSlashIcon, BeakerIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { getModelCapabilitiesFromSpec } from '@/lib/model-capabilities'
import {
  modelApis,
  ModelCRD,
  ModelCategoryType,
  ModelCapabilities,
  TTSConfig,
  STTConfig,
  EmbeddingConfig,
  RerankConfig,
  VideoGenerationConfig,
  VideoCapabilities,
  AspectRatioOption,
  ResolutionOption,
  AvailableModel,
  UnifiedModel,
  VisionSidecarModelRef,
  ModelSpecConfig,
} from '@/apis/models'
import {
  ImageConfigSection,
  ImageConfigState,
  canEditModelSpecWithForm,
  extractThinkingConfig,
  formatModelSpec,
  getDefaultImageConfig,
  isModelConfigObject,
  mergeFormManagedSpec,
  toImageGenerationConfig,
  fromImageGenerationConfig,
  validateModelSpecJson,
  type ModelSpecValidationResult,
} from './model-config'
import { CodeMirrorEditor } from '@/components/common/CodeMirrorEditor'
import { useTheme } from '@/features/theme/ThemeProvider'
import {
  buildEmbeddingConfig,
  hasImageInputCapability,
} from '@/features/settings/utils/embedding-model-config'
import { CapabilityScopeSelector } from '@/features/resource-library/components/CapabilityScopeSelector'
import { useCapabilityPublicationScope } from '@/features/resource-library/useCapabilityPublicationScope'
import type { Group } from '@/types/group'
import {
  initialVisionSidecarSelection,
  selectedVisionSidecarRef,
  UNRESOLVED_VISION_SIDECAR_KEY,
  visionSidecarModelKey,
  visionSidecarModels,
} from '@/features/settings/utils/vision-sidecar-model'
import { preventSelectCloseFromStealingFocus } from '@/features/settings/utils/select-focus'

// Model form data that can be used by callers
export interface ModelFormData {
  modelIdName: string
  displayName: string
  modelGroup: string
  modelSubGroup: string
  modelCategoryType: ModelCategoryType
  providerType: string
  modelId: string
  customModelId: string
  apiKey: string
  baseUrl: string
  customHeaders: string
  contextWindow?: number
  maxOutputTokens?: number
  costIndex?: string
  // Type-specific configs
  ttsVoice?: string
  ttsSpeed?: number
  ttsOutputFormat?: 'mp3' | 'wav'
  sttLanguage?: string
  sttTranscriptionFormat?: 'text' | 'srt' | 'vtt'
  embeddingDimensions?: number
  embeddingEncodingFormat?: 'float' | 'base64'
  embeddingSupportsImageInput?: boolean
  rerankTopN?: number
  rerankReturnDocuments?: boolean
  supportsImageInput?: boolean
  supportsVideoInput?: boolean
  // Video-specific configs
  videoResolution?: string
  videoRatio?: string
  videoDuration?: number
  videoGenerateAudio?: boolean
  videoDraft?: boolean
  videoSeed?: number
  videoCameraFixed?: boolean
  videoWatermark?: boolean
  isWeworkAvailable?: boolean
  visionSidecarModel?: VisionSidecarModelRef
}

// Initial data for editing (can be from ModelCRD or admin model JSON)
export interface ModelInitialData {
  name: string
  displayName?: string
  modelGroup?: string
  modelSubGroup?: string
  modelCategoryType?: ModelCategoryType
  providerType?: string
  modelId?: string
  apiKey?: string
  baseUrl?: string
  customHeaders?: Record<string, string>
  protocol?: string
  contextWindow?: number
  maxOutputTokens?: number
  costIndex?: string
  // Type-specific configs
  ttsConfig?: TTSConfig
  sttConfig?: STTConfig
  embeddingConfig?: EmbeddingConfig
  rerankConfig?: RerankConfig
  modelCapabilities?: ModelCapabilities
  videoConfig?: VideoGenerationConfig
  imageConfig?: import('@/apis/models').ImageGenerationConfig
  thinkingConfig?: Record<string, unknown>
  isWeworkAvailable?: boolean
  visionSidecarModel?: VisionSidecarModelRef
  spec?: ModelSpecConfig
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
  publicationGroups?: Group[]
}

// Model category type options
const MODEL_CATEGORY_OPTIONS: { value: ModelCategoryType; labelKey: string }[] = [
  { value: 'llm', labelKey: 'models.model_category_type_llm' },
  // { value: 'tts', labelKey: 'models.model_category_type_tts' },
  // { value: 'stt', labelKey: 'models.model_category_type_stt' },
  { value: 'embedding', labelKey: 'models.model_category_type_embedding' },
  { value: 'rerank', labelKey: 'models.model_category_type_rerank' },
  { value: 'video', labelKey: 'models.model_category_type_video' },
  { value: 'image', labelKey: 'models.model_category_type_image' },
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
    { value: 'gemini-deep-research', label: 'Gemini Deep Research', hint: 'Long-form Research' },
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
  video: [
    { value: 'seedance', label: 'Seedance', hint: '火山引擎视频生成' },
    { value: 'runway', label: 'Runway', hint: 'Runway Gen-3' },
    { value: 'pika', label: 'Pika', hint: 'Pika Labs' },
    { value: 'custom', label: 'Custom API' },
  ],
  image: [
    { value: 'gpt-image', label: 'OpenAI GPT Image', hint: 'gpt-image-2' },
    { value: 'doubao', label: 'Doubao', hint: '豆包图像生成' },
    { value: 'stability', label: 'Stability AI', hint: 'Stable Diffusion' },
    { value: 'midjourney', label: 'Midjourney', hint: 'Midjourney API' },
    { value: 'custom', label: 'Custom API' },
  ],
}

// Seedance model options
const SEEDANCE_MODEL_OPTIONS = [
  { value: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5 (推荐)' },
  { value: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { value: 'doubao-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro' },
  { value: 'doubao-seedance-1-0-pro', label: 'Seedance 1.0 Pro' },
  { value: 'doubao-seedance-1-0-pro-fast', label: 'Seedance 1.0 Pro Fast' },
  { value: 'doubao-seedance-1-0-lite-t2v', label: 'Seedance 1.0 Lite (文生视频)' },
  { value: 'doubao-seedance-1-0-lite-i2v', label: 'Seedance 1.0 Lite (图生视频)' },
  { value: 'custom', label: 'Custom...' },
]

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

const GEMINI_DEEP_RESEARCH_MODEL_OPTIONS = [
  {
    value: 'deep-research-pro-preview-12-2025',
    label: 'deep-research-pro-preview-12-2025 (Recommended)',
  },
  { value: 'custom', label: 'Custom...' },
]

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const GPT_IMAGE_DEFAULT_MODEL = 'gpt-image-2'

const GPT_IMAGE_MODEL_OPTIONS = [
  { value: GPT_IMAGE_DEFAULT_MODEL, label: 'gpt-image-2 (Recommended)' },
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
  publicationGroups,
}) => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  // Support both legacy model prop and new initialData prop
  // Use useMemo to prevent re-creating the object on every render
  const effectiveInitialData = React.useMemo(() => {
    return (
      initialData ||
      (model
        ? {
            name: model.metadata.name,
            displayName: model.metadata.displayName,
            modelGroup: model.spec.modelGroup,
            modelSubGroup: model.spec.modelSubGroup,
            modelCategoryType: model.spec.modelType,
            providerType: model.spec.modelConfig?.env?.model,
            modelId: model.spec.modelConfig?.env?.model_id,
            apiKey: model.spec.modelConfig?.env?.api_key,
            baseUrl: model.spec.modelConfig?.env?.base_url,
            customHeaders: model.spec.modelConfig?.env?.custom_headers,
            protocol: model.spec.protocol,
            contextWindow: model.spec.modelConfig?.context_window,
            maxOutputTokens: model.spec.modelConfig?.max_output_tokens,
            costIndex: model.spec.costIndex,
            ttsConfig: model.spec.ttsConfig,
            sttConfig: model.spec.sttConfig,
            embeddingConfig: model.spec.embeddingConfig,
            rerankConfig: model.spec.rerankConfig,
            modelCapabilities: getModelCapabilitiesFromSpec(model.spec),
            videoConfig: model.spec.videoConfig,
            imageConfig: model.spec.imageConfig,
            thinkingConfig: extractThinkingConfig(model.spec.modelConfig?.env),
            isWeworkAvailable: model.spec.isWeworkAvailable,
            visionSidecarModel: model.spec.modelConfig?.visionSidecarModel,
            spec: model.spec,
          }
        : null)
    )
  }, [initialData, model])
  const isEditing = !!effectiveInitialData
  const isGroupScope = scope === 'group'
  const publicationNamespace =
    model?.metadata.namespace || (isGroupScope && groupName ? groupName : 'default')
  const publicationScope = useCapabilityPublicationScope({
    enabled: publicationGroups !== undefined,
    open,
    resourceType: 'model',
    sourceName: isEditing ? effectiveInitialData?.name : undefined,
    sourceNamespace: publicationNamespace,
    groups: publicationGroups || [],
    defaultTarget: publicationNamespace === 'default' ? 'personal' : 'team',
    defaultGroupNames: publicationNamespace === 'default' ? [] : [publicationNamespace],
  })

  // Form state
  const [modelIdName, setModelIdName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [modelGroup, setModelGroup] = useState('')
  const [modelSubGroup, setModelSubGroup] = useState('')
  const [modelCategoryType, setModelCategoryType] = useState<ModelCategoryType>('llm')
  const [providerType, setProviderType] = useState<string>('openai')
  const [modelId, setModelId] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customHeaders, setCustomHeaders] = useState('')
  const [customHeadersError, setCustomHeadersError] = useState('')
  const [editingMode, setEditingMode] = useState<'form' | 'json'>('form')
  const [rawSpec, setRawSpec] = useState<ModelSpecConfig>({
    modelConfig: { env: {} },
  } as ModelSpecConfig)
  const [modelSpecJson, setModelSpecJson] = useState('')
  const [modelSpecError, setModelSpecError] = useState('')
  const [modelSpecCannotUseForm, setModelSpecCannotUseForm] = useState(false)
  const [modelIdNameError, setModelIdNameError] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  // LLM-specific config state
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined)
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(undefined)
  const [costIndex, setCostIndex] = useState<string | undefined>(undefined)
  // Thinking/Reasoning config (JSON passthrough)
  const [thinkingConfigStr, setThinkingConfigStr] = useState('')
  const [thinkingConfigError, setThinkingConfigError] = useState('')

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
  const [embeddingSupportsImageInput, setEmbeddingSupportsImageInput] = useState(false)
  // Rerank
  const [rerankTopN, setRerankTopN] = useState<number | undefined>(undefined)
  const [rerankReturnDocuments, setRerankReturnDocuments] = useState(true)
  const [supportsImageInput, setSupportsImageInput] = useState(false)
  const [supportsVideoInput, setSupportsVideoInput] = useState(false)
  // Video
  const [videoGenerateAudio, setVideoGenerateAudio] = useState<boolean>(true)
  const [videoDraft, setVideoDraft] = useState<boolean>(false)
  const [videoSeed, setVideoSeed] = useState<number>(-1)
  const [videoCameraFixed, setVideoCameraFixed] = useState<boolean>(false)
  const [videoWatermark, setVideoWatermark] = useState<boolean>(false)
  const [videoDefaultResolution, setVideoDefaultResolution] = useState('720p')
  const [videoDefaultRatio, setVideoDefaultRatio] = useState('16:9')
  const [videoDefaultDuration, setVideoDefaultDuration] = useState(5)
  // Image - use ImageConfigState from extracted component
  const [imageConfig, setImageConfig] = useState<ImageConfigState>(getDefaultImageConfig())

  // Wework desktop client availability
  const [isWeworkAvailable, setIsWeworkAvailable] = useState(false)
  const [selectedVisionSidecarKey, setSelectedVisionSidecarKey] = useState('')
  const [unresolvedVisionSidecar, setUnresolvedVisionSidecar] =
    useState<VisionSidecarModelRef | null>(null)
  const [availableVisionModels, setAvailableVisionModels] = useState<UnifiedModel[]>([])
  const [loadingVisionModels, setLoadingVisionModels] = useState(false)
  const visionSidecarTriggerRef = React.useRef<HTMLButtonElement>(null)
  const visionSidecarContentRef = React.useRef<HTMLDivElement>(null)

  // Video capabilities state
  const [capRatios, setCapRatios] = useState<AspectRatioOption[]>([])
  const [capResolutions, setCapResolutions] = useState<ResolutionOption[]>([])
  const [capDurations, setCapDurations] = useState<number[]>([])
  const [customDuration, setCustomDuration] = useState<string>('')
  const [advancedCapabilities, setAdvancedCapabilities] = useState('')
  const [advancedCapabilitiesError, setAdvancedCapabilitiesError] = useState('')

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

  // Keep the Popover portal container stable across asynchronous form updates.
  const [dialogContentElement, setDialogContentElement] = useState<HTMLDivElement | null>(null)

  // Reset form when dialog opens/closes or initialData changes
  useEffect(() => {
    if (open) {
      if (effectiveInitialData) {
        setModelIdName(effectiveInitialData.name || '')
        setDisplayName(effectiveInitialData.displayName || '')
        setModelGroup(effectiveInitialData.modelGroup || '')
        setModelSubGroup(effectiveInitialData.modelSubGroup || '')
        // Set model category type
        const categoryType = effectiveInitialData.modelCategoryType || 'llm'
        setModelCategoryType(categoryType)
        const modelType = effectiveInitialData.providerType
        const protocol = effectiveInitialData.protocol
        // Map model type to provider type
        // For video models, use protocol directly as provider type (seedance, runway, pika, etc.)
        if ((categoryType === 'video' || categoryType === 'image') && protocol) {
          setProviderType(protocol)
        } else if (protocol === 'openai-responses') {
          // Check protocol first for openai-responses and gemini-deep-research
          setProviderType('openai-responses')
        } else if (protocol === 'gemini-deep-research') {
          setProviderType('gemini-deep-research')
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
          setEmbeddingSupportsImageInput(
            hasImageInputCapability(effectiveInitialData.embeddingConfig)
          )
        } else {
          setEmbeddingSupportsImageInput(false)
        }
        if (effectiveInitialData.rerankConfig) {
          setRerankTopN(effectiveInitialData.rerankConfig.top_n)
          setRerankReturnDocuments(effectiveInitialData.rerankConfig.return_documents ?? true)
        }
        setSupportsImageInput(effectiveInitialData.modelCapabilities?.supportsImage ?? false)
        setSupportsVideoInput(effectiveInitialData.modelCapabilities?.supportsVideo ?? false)
        // Load video-specific configs
        if (effectiveInitialData.videoConfig) {
          setVideoGenerateAudio(effectiveInitialData.videoConfig.generate_audio ?? true)
          setVideoDraft(effectiveInitialData.videoConfig.draft ?? false)
          setVideoSeed(effectiveInitialData.videoConfig.seed ?? -1)
          setVideoCameraFixed(effectiveInitialData.videoConfig.camera_fixed ?? false)
          setVideoWatermark(effectiveInitialData.videoConfig.watermark ?? false)
          setVideoDefaultResolution(effectiveInitialData.videoConfig.resolution ?? '720p')
          setVideoDefaultRatio(effectiveInitialData.videoConfig.ratio ?? '16:9')
          setVideoDefaultDuration(effectiveInitialData.videoConfig.duration ?? 5)
          // Load capabilities
          const caps = effectiveInitialData.videoConfig.capabilities
          if (caps) {
            setCapRatios(caps.aspect_ratios ?? [])
            setCapResolutions(caps.resolutions ?? [])
            setCapDurations(caps.durations_sec ?? [])
            const {
              aspect_ratios: _aspectRatios,
              resolutions: _resolutions,
              durations_sec: _durations,
              ...advanced
            } = caps
            setAdvancedCapabilities(
              Object.keys(advanced).length ? JSON.stringify(advanced, null, 2) : ''
            )
          } else {
            setCapRatios([])
            setCapResolutions([])
            setCapDurations([])
            setAdvancedCapabilities('')
          }
        }
        // Load image-specific configs
        if (effectiveInitialData.imageConfig) {
          setImageConfig(fromImageGenerationConfig(effectiveInitialData.imageConfig))
        }
        // Load LLM-specific configs
        setContextWindow(effectiveInitialData.contextWindow)
        setMaxOutputTokens(effectiveInitialData.maxOutputTokens)
        setCostIndex(effectiveInitialData.costIndex)
        // Load thinking config
        if (
          effectiveInitialData.thinkingConfig &&
          Object.keys(effectiveInitialData.thinkingConfig).length > 0
        ) {
          setThinkingConfigStr(JSON.stringify(effectiveInitialData.thinkingConfig, null, 2))
        } else {
          setThinkingConfigStr('')
        }
        setThinkingConfigError('')
        // Load wework availability
        setIsWeworkAvailable(effectiveInitialData.isWeworkAvailable ?? false)
        setSelectedVisionSidecarKey('')
        setUnresolvedVisionSidecar(null)
      } else {
        // Reset for new model
        setModelIdName('')
        setDisplayName('')
        setModelGroup('')
        setModelSubGroup('')
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
        setEmbeddingSupportsImageInput(false)
        setRerankTopN(undefined)
        setRerankReturnDocuments(true)
        setSupportsImageInput(false)
        setSupportsVideoInput(false)
        // Reset video-specific configs
        setVideoGenerateAudio(true)
        setVideoDraft(false)
        setVideoSeed(-1)
        setVideoCameraFixed(false)
        setVideoWatermark(false)
        setVideoDefaultResolution('720p')
        setVideoDefaultRatio('16:9')
        setVideoDefaultDuration(5)
        // Reset image-specific configs
        setImageConfig(getDefaultImageConfig())
        // Reset wework availability
        setIsWeworkAvailable(false)
        setSelectedVisionSidecarKey('')
        setUnresolvedVisionSidecar(null)
        setCostIndex(undefined)
        // Reset video capabilities
        setCapRatios([])
        setCapResolutions([])
        setCapDurations([])
        setCustomDuration('')
        setAdvancedCapabilities('')
        setAdvancedCapabilitiesError('')
        // Reset LLM-specific configs
        setContextWindow(undefined)
        setMaxOutputTokens(undefined)
        setThinkingConfigStr('')
        setThinkingConfigError('')
      }
      setCustomHeadersError('')
      setModelIdNameError('')
      setShowApiKey(false)
      const initialSpec =
        effectiveInitialData?.spec || ({ modelConfig: { env: {} } } as ModelSpecConfig)
      setRawSpec(initialSpec)
      setModelSpecJson(formatModelSpec(initialSpec))
      setModelSpecError('')
      const canUseForm = canEditModelSpecWithForm(initialSpec)
      setEditingMode(canUseForm ? 'form' : 'json')
      setModelSpecCannotUseForm(!canUseForm)
    }
  }, [open, effectiveInitialData])

  useEffect(() => {
    if (!open || modelCategoryType !== 'llm' || !isWeworkAvailable) {
      setAvailableVisionModels([])
      return
    }
    let cancelled = false
    setLoadingVisionModels(true)
    void modelApis
      .getUnifiedModels(undefined, true, 'all', undefined, 'llm')
      .then(response => {
        if (cancelled) return
        setAvailableVisionModels(response.data)
        const initialRef = rawSpec.modelConfig?.visionSidecarModel
        if (initialRef) {
          const selection = initialVisionSidecarSelection(response.data, initialRef)
          setSelectedVisionSidecarKey(selection.selectedKey)
          setUnresolvedVisionSidecar(selection.unresolvedRef)
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableVisionModels([])
      })
      .finally(() => {
        if (!cancelled) setLoadingVisionModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [isWeworkAvailable, modelCategoryType, open, rawSpec])

  const visionModelOptions = React.useMemo(
    () => visionSidecarModels(availableVisionModels, modelIdName),
    [availableVisionModels, modelIdName]
  )

  // Determine model options based on model category type and provider
  // For embedding/rerank/image, only show "Custom..." option since they don't use preset LLM models
  // For openai-responses, use the same model options as openai
  // For video models, use provider-specific options
  const baseModelOptions = React.useMemo(
    () =>
      modelCategoryType === 'embedding' || modelCategoryType === 'rerank'
        ? [{ value: 'custom', label: 'Custom...' }]
        : modelCategoryType === 'image'
          ? providerType === 'gpt-image'
            ? GPT_IMAGE_MODEL_OPTIONS
            : [{ value: 'custom', label: 'Custom...' }]
          : modelCategoryType === 'video'
            ? providerType === 'seedance'
              ? SEEDANCE_MODEL_OPTIONS
              : [{ value: 'custom', label: 'Custom...' }]
            : providerType === 'openai' || providerType === 'openai-responses'
              ? OPENAI_MODEL_OPTIONS
              : providerType === 'gemini'
                ? GEMINI_MODEL_OPTIONS
                : providerType === 'gemini-deep-research'
                  ? GEMINI_DEEP_RESEARCH_MODEL_OPTIONS
                  : ANTHROPIC_MODEL_OPTIONS,
    [modelCategoryType, providerType]
  )

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
    // For embedding/rerank/image, automatically set to custom mode
    // For video, reset model selection
    if (value === 'embedding' || value === 'rerank') {
      setModelId('custom')
      setCustomModelId('')
    } else if (value === 'image') {
      setModelId(GPT_IMAGE_DEFAULT_MODEL)
      setCustomModelId('')
      setBaseUrl(OPENAI_BASE_URL)
      setImageConfig(getDefaultImageConfig())
    } else if (value === 'video') {
      setModelId('')
      setCustomModelId('')
      // Reset video-specific configs to defaults
      setVideoGenerateAudio(true)
      setVideoDraft(false)
      setVideoSeed(-1)
      setVideoCameraFixed(false)
      setVideoWatermark(false)
      setCapRatios([])
      setCapResolutions([])
      setCapDurations([])
      setCustomDuration('')
    } else {
      setModelId('')
      setCustomModelId('')
    }
  }

  // Track if we've already initialized modelId from initialData
  // This prevents re-setting modelId when modelOptions changes after fetching
  const hasInitializedModelId = React.useRef(false)

  // Set model ID when initialData changes (only once per dialog open)
  useEffect(() => {
    if (effectiveInitialData?.modelId && !hasInitializedModelId.current) {
      const id = effectiveInitialData.modelId
      hasInitializedModelId.current = true
      // Set the model ID directly - it will be displayed even if not in options yet
      setModelId(id)
      setCustomModelId('')
    }
  }, [effectiveInitialData])

  // Reset initialization flag when dialog closes
  useEffect(() => {
    if (!open) {
      hasInitializedModelId.current = false
    }
  }, [open])
  const handleProviderChange = (value: string) => {
    setProviderType(value)
    setModelId('')
    setCustomModelId('')
    // Only set default base URL for LLM models
    if (modelCategoryType === 'llm') {
      if (value === 'openai' || value === 'openai-responses') {
        setBaseUrl(OPENAI_BASE_URL)
      } else if (value === 'gemini') {
        setBaseUrl('https://generativelanguage.googleapis.com')
      } else if (value === 'gemini-deep-research') {
        // Deep Research uses internal proxy - base_url will be set by backend
        setBaseUrl('')
      } else {
        setBaseUrl('https://api.anthropic.com')
      }
    } else if (modelCategoryType === 'video') {
      // Set default base URL for video providers
      if (value === 'seedance') {
        setBaseUrl('https://ark.cn-beijing.volces.com/api/v3')
      } else {
        setBaseUrl('')
      }
    } else if (modelCategoryType === 'image') {
      // Set default base URL for image providers
      if (value === 'gpt-image') {
        setBaseUrl(OPENAI_BASE_URL)
        setModelId(GPT_IMAGE_DEFAULT_MODEL)
        setImageConfig(getDefaultImageConfig())
      } else if (value === 'doubao') {
        setBaseUrl('https://ark.cn-beijing.volces.com/api/v3')
      } else {
        setBaseUrl('')
      }
    }
  }

  const runtimeProviderFromSpec = (spec: ModelSpecConfig, modelValue: string): string => {
    if (spec.protocol === 'openai-responses' || spec.protocol === 'gemini-deep-research') {
      return spec.protocol
    }
    if (modelValue === 'claude') return 'anthropic'
    return typeof spec.protocol === 'string' && spec.modelType !== 'llm'
      ? spec.protocol
      : modelValue
  }

  const getActiveRuntimeConfig = () => {
    if (editingMode === 'form') {
      const parsedHeaders = validateCustomHeaders(customHeaders)
      if (parsedHeaders === null) return null
      return {
        providerType,
        modelId: modelId === 'custom' ? customModelId : modelId,
        apiKey,
        baseUrl,
        customHeaders: parsedHeaders,
        modelCategoryType,
      }
    }

    const spec = parseModelSpec(modelSpecJson)
    const modelConfig = spec && isModelConfigObject(spec.modelConfig) ? spec.modelConfig : null
    const env = modelConfig && isModelConfigObject(modelConfig.env) ? modelConfig.env : null
    if (!spec || !env) {
      if (spec) setModelSpecError(t('common:models.errors.model_spec_runtime_required'))
      return null
    }
    const modelValue = typeof env.model === 'string' ? env.model : ''
    const headers = env.custom_headers
    if (
      headers !== undefined &&
      (!isModelConfigObject(headers) ||
        Object.values(headers).some(value => typeof value !== 'string'))
    ) {
      setModelSpecError(t('common:models.errors.model_spec_headers_invalid'))
      return null
    }
    const category = MODEL_CATEGORY_OPTIONS.some(option => option.value === spec.modelType)
      ? (spec.modelType as ModelCategoryType)
      : 'llm'
    return {
      providerType: runtimeProviderFromSpec(spec, modelValue),
      modelId: typeof env.model_id === 'string' ? env.model_id : '',
      apiKey: typeof env.api_key === 'string' ? env.api_key : '',
      baseUrl: typeof env.base_url === 'string' ? env.base_url : '',
      customHeaders: (headers || {}) as Record<string, string>,
      modelCategoryType: category,
    }
  }

  const handleTestConnection = async () => {
    const runtimeConfig = getActiveRuntimeConfig()
    if (!runtimeConfig) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_spec_invalid'),
      })
      return
    }
    if (!runtimeConfig.modelId || !runtimeConfig.apiKey) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.model_id_required'),
      })
      return
    }

    setTesting(true)
    try {
      const result = await modelApis.testConnection({
        provider_type: runtimeConfig.providerType as
          | 'openai'
          | 'anthropic'
          | 'gemini'
          | 'gemini-deep-research'
          | 'openai-responses'
          | 'gpt-image',
        model_id: runtimeConfig.modelId,
        api_key: runtimeConfig.apiKey,
        base_url: runtimeConfig.baseUrl || undefined,
        custom_headers:
          Object.keys(runtimeConfig.customHeaders).length > 0
            ? runtimeConfig.customHeaders
            : undefined,
        model_category_type: runtimeConfig.modelCategoryType,
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
    const runtimeConfig = getActiveRuntimeConfig()
    if (!runtimeConfig) {
      setFetchError(t('common:models.errors.model_spec_invalid'))
      return
    }
    if (!runtimeConfig.apiKey.trim()) {
      setFetchError(t('common:models.fetch_error_no_api_key'))
      toast({
        variant: 'destructive',
        title: t('common:models.fetch_error_no_api_key'),
      })
      return
    }

    // Check cache
    const cacheKey = `${runtimeConfig.providerType}_${runtimeConfig.baseUrl || 'default'}`
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
        provider_type: runtimeConfig.providerType as 'openai' | 'anthropic' | 'gemini' | 'custom',
        api_key: runtimeConfig.apiKey,
        base_url: runtimeConfig.baseUrl || undefined,
        custom_headers:
          Object.keys(runtimeConfig.customHeaders).length > 0
            ? runtimeConfig.customHeaders
            : undefined,
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

  const validateModelIdName = (value: string): boolean => {
    if (!value.trim()) {
      setModelIdNameError('')
      return false
    }
    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/
    if (!nameRegex.test(value)) {
      setModelIdNameError(t('common:models.errors.id_invalid'))
      return false
    }
    setModelIdNameError('')
    return true
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

  const validateThinkingConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setThinkingConfigError('')
      return {}
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setThinkingConfigError(t('common:models.errors.thinking_config_invalid_object'))
        return null
      }
      setThinkingConfigError('')
      // Unwrap if user provided {"thinking_config": {...}} wrapper —
      // the code already stores the value under the thinking_config key,
      // so we need the inner value to avoid double-nesting.
      const keys = Object.keys(parsed)
      if (
        keys.length === 1 &&
        (keys[0] === 'thinking_config' || keys[0] === 'thinkingConfig') &&
        typeof parsed[keys[0]] === 'object' &&
        parsed[keys[0]] !== null &&
        !Array.isArray(parsed[keys[0]])
      ) {
        return parsed[keys[0]] as Record<string, unknown>
      }
      return parsed as Record<string, unknown>
    } catch {
      setThinkingConfigError(t('common:models.errors.thinking_config_invalid_json'))
      return null
    }
  }

  const handleThinkingConfigChange = (value: string) => {
    setThinkingConfigStr(value)
    validateThinkingConfig(value)
  }

  const modelSpecValidationMessage = (result: ModelSpecValidationResult): string => {
    switch (result.error) {
      case 'invalid_json':
        return result.line && result.column
          ? t('common:models.errors.model_spec_invalid_json_location', {
              line: result.line,
              column: result.column,
            })
          : t('common:models.errors.model_spec_invalid_json')
      case 'invalid_object':
        return t('common:models.errors.model_spec_invalid_object')
      case 'invalid_model_config':
        return t('common:models.errors.model_spec_invalid_model_config')
      case 'unsafe_keys':
        return t('common:models.errors.model_spec_unsafe_keys', {
          keys: result.paths.join(', '),
        })
      default:
        return ''
    }
  }

  const parseModelSpec = (value: string): ModelSpecConfig | null => {
    const result = validateModelSpecJson(value)
    setModelSpecError(modelSpecValidationMessage(result))
    return result.value
  }

  const handleModelSpecChange = (value: string) => {
    setModelSpecJson(value)
    if (modelSpecError) setModelSpecError('')
  }

  const handleModelIdNameChange = (value: string) => {
    setModelIdName(value)
    validateModelIdName(value)
  }

  const buildManagedSpecFromForm = (
    parsedHeaders: Record<string, string>,
    parsedThinkingConfig: Record<string, unknown>,
    notifyOnError: boolean
  ): {
    spec: ModelSpecConfig
    videoConfig?: VideoGenerationConfig
    selectedVisionSidecar?: VisionSidecarModelRef
  } | null => {
    const ttsConfig: TTSConfig | undefined =
      modelCategoryType === 'tts'
        ? { voice: ttsVoice || undefined, speed: ttsSpeed, output_format: ttsOutputFormat }
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
        ? buildEmbeddingConfig({
            dimensions: embeddingDimensions,
            encodingFormat: embeddingEncodingFormat,
            supportsImageInput: embeddingSupportsImageInput,
          })
        : undefined
    const rerankConfig: RerankConfig | undefined =
      modelCategoryType === 'rerank'
        ? { top_n: rerankTopN, return_documents: rerankReturnDocuments }
        : undefined

    let parsedAdvancedCapabilities: VideoCapabilities = {}
    if (modelCategoryType === 'video' && advancedCapabilities.trim()) {
      try {
        const parsed: unknown = JSON.parse(advancedCapabilities)
        if (!isModelConfigObject(parsed)) throw new Error('Capabilities must be an object')
        parsedAdvancedCapabilities = parsed as VideoCapabilities
        setAdvancedCapabilitiesError('')
      } catch {
        setAdvancedCapabilitiesError(t('common:models.video_advanced_capabilities_invalid'))
        if (notifyOnError) {
          toast({
            variant: 'destructive',
            title: t('common:models.video_advanced_capabilities_invalid'),
          })
        }
        return null
      }
    }

    const hasCapabilities =
      capRatios.length > 0 ||
      capResolutions.length > 0 ||
      capDurations.length > 0 ||
      Object.keys(parsedAdvancedCapabilities).length > 0
    const capabilities = hasCapabilities
      ? {
          ...parsedAdvancedCapabilities,
          ...(capRatios.length > 0 && { aspect_ratios: capRatios }),
          ...(capResolutions.length > 0 && { resolutions: capResolutions }),
          ...(capDurations.length > 0 && { durations_sec: capDurations }),
        }
      : undefined
    const videoConfig: VideoGenerationConfig | undefined =
      modelCategoryType === 'video'
        ? {
            resolution: capResolutions.some(
              option => (option.value ?? option.label) === videoDefaultResolution
            )
              ? videoDefaultResolution
              : (capResolutions[0]?.value ?? capResolutions[0]?.label ?? '720p'),
            ratio: capRatios.some(option => option.value === videoDefaultRatio)
              ? videoDefaultRatio
              : (capRatios[0]?.value ?? '16:9'),
            duration: capDurations.includes(videoDefaultDuration)
              ? videoDefaultDuration
              : capDurations[0] || 5,
            generate_audio: videoGenerateAudio,
            draft: videoDraft,
            seed: videoSeed,
            camera_fixed: videoCameraFixed,
            watermark: videoWatermark,
            ...(capabilities && { capabilities }),
          }
        : undefined
    const imageGenerationConfig =
      modelCategoryType === 'image' ? toImageGenerationConfig(imageConfig) : undefined
    const rawModelCapabilities: ModelCapabilities = {
      ...(supportsImageInput && { supportsImage: true }),
      ...(supportsVideoInput && { supportsVideo: true }),
    }
    const modelCapabilities: ModelCapabilities | undefined =
      modelCategoryType === 'llm' && Object.keys(rawModelCapabilities).length > 0
        ? rawModelCapabilities
        : undefined
    const selectedVisionSidecar = selectedVisionSidecarRef(
      modelCategoryType === 'llm' && isWeworkAvailable,
      selectedVisionSidecarKey,
      availableVisionModels,
      unresolvedVisionSidecar
    )

    let modelFieldValue = providerType
    if (modelCategoryType === 'llm') {
      if (providerType === 'anthropic') modelFieldValue = 'claude'
      if (providerType === 'openai-responses') modelFieldValue = 'openai'
      if (providerType === 'gemini-deep-research') modelFieldValue = 'gemini'
    }
    const finalModelId = modelId === 'custom' ? customModelId : modelId
    const spec: ModelSpecConfig = {
      modelConfig: {
        env: {
          model: modelFieldValue,
          model_id: finalModelId,
          api_key: apiKey,
          ...(baseUrl && { base_url: baseUrl }),
          ...(Object.keys(parsedHeaders).length > 0 && { custom_headers: parsedHeaders }),
          ...(Object.keys(parsedThinkingConfig).length > 0 && {
            thinking_config: parsedThinkingConfig,
          }),
        },
        ...(modelCategoryType === 'llm' && contextWindow && { context_window: contextWindow }),
        ...(modelCategoryType === 'llm' &&
          maxOutputTokens && { max_output_tokens: maxOutputTokens }),
        ...(selectedVisionSidecar && { visionSidecarModel: selectedVisionSidecar }),
      },
      modelType: modelCategoryType,
      ...(providerType === 'openai' && {
        protocol: 'openai',
        apiFormat: 'chat/completions',
      }),
      ...(providerType === 'openai-responses' && {
        protocol: 'openai-responses',
        apiFormat: 'responses',
      }),
      ...(providerType === 'gemini-deep-research' && { protocol: 'gemini-deep-research' }),
      ...(modelCategoryType === 'video' && { protocol: providerType }),
      ...(modelCategoryType === 'image' && { protocol: providerType }),
      ...(modelCategoryType === 'llm' && costIndex && { costIndex }),
      ...(modelGroup.trim() && { modelGroup: modelGroup.trim() }),
      ...(modelSubGroup.trim() && { modelSubGroup: modelSubGroup.trim() }),
      ...(ttsConfig && { ttsConfig }),
      ...(sttConfig && { sttConfig }),
      ...(embeddingConfig && { embeddingConfig }),
      ...(rerankConfig && { rerankConfig }),
      ...(videoConfig && { videoConfig }),
      ...(imageGenerationConfig && { imageConfig: imageGenerationConfig }),
      ...(modelCapabilities && { modelCapabilities }),
      ...(isWeworkAvailable && { isWeworkAvailable: true }),
    }
    return { spec, videoConfig, selectedVisionSidecar: selectedVisionSidecar || undefined }
  }

  const hydrateFormFromSpec = (spec: ModelSpecConfig) => {
    const modelConfig = spec.modelConfig
    const env = modelConfig.env
    const category = MODEL_CATEGORY_OPTIONS.some(option => option.value === spec.modelType)
      ? (spec.modelType as ModelCategoryType)
      : 'llm'
    const modelValue = typeof env.model === 'string' ? env.model : ''
    const nextProvider = runtimeProviderFromSpec(spec, modelValue) || 'openai'

    setModelCategoryType(category)
    setProviderType(nextProvider)
    setModelId(typeof env.model_id === 'string' ? env.model_id : '')
    setCustomModelId('')
    setApiKey(typeof env.api_key === 'string' ? env.api_key : '')
    setBaseUrl(typeof env.base_url === 'string' ? env.base_url : '')
    setCustomHeaders(
      isModelConfigObject(env.custom_headers) ? JSON.stringify(env.custom_headers, null, 2) : ''
    )
    setThinkingConfigStr(
      extractThinkingConfig(env) ? JSON.stringify(extractThinkingConfig(env), null, 2) : ''
    )
    setContextWindow(
      typeof modelConfig.context_window === 'number' ? modelConfig.context_window : undefined
    )
    setMaxOutputTokens(
      typeof modelConfig.max_output_tokens === 'number' ? modelConfig.max_output_tokens : undefined
    )
    setCostIndex(typeof spec.costIndex === 'string' ? spec.costIndex : undefined)
    setModelGroup(typeof spec.modelGroup === 'string' ? spec.modelGroup : '')
    setModelSubGroup(typeof spec.modelSubGroup === 'string' ? spec.modelSubGroup : '')

    const nextTtsConfig = isModelConfigObject(spec.ttsConfig) ? spec.ttsConfig : {}
    setTtsVoice(typeof nextTtsConfig.voice === 'string' ? nextTtsConfig.voice : '')
    setTtsSpeed(typeof nextTtsConfig.speed === 'number' ? nextTtsConfig.speed : 1)
    setTtsOutputFormat(nextTtsConfig.output_format === 'wav' ? 'wav' : 'mp3')
    const nextSttConfig = isModelConfigObject(spec.sttConfig) ? spec.sttConfig : {}
    setSttLanguage(typeof nextSttConfig.language === 'string' ? nextSttConfig.language : '')
    setSttTranscriptionFormat(
      nextSttConfig.transcription_format === 'srt' || nextSttConfig.transcription_format === 'vtt'
        ? nextSttConfig.transcription_format
        : 'text'
    )
    const nextEmbeddingConfig = isModelConfigObject(spec.embeddingConfig)
      ? spec.embeddingConfig
      : {}
    setEmbeddingDimensions(
      typeof nextEmbeddingConfig.dimensions === 'number'
        ? nextEmbeddingConfig.dimensions
        : undefined
    )
    setEmbeddingEncodingFormat(
      nextEmbeddingConfig.encoding_format === 'base64' ? 'base64' : 'float'
    )
    setEmbeddingSupportsImageInput(hasImageInputCapability(nextEmbeddingConfig))
    const nextRerankConfig = isModelConfigObject(spec.rerankConfig) ? spec.rerankConfig : {}
    setRerankTopN(typeof nextRerankConfig.top_n === 'number' ? nextRerankConfig.top_n : undefined)
    setRerankReturnDocuments(
      typeof nextRerankConfig.return_documents === 'boolean'
        ? nextRerankConfig.return_documents
        : true
    )

    const nextVideoConfig = isModelConfigObject(spec.videoConfig) ? spec.videoConfig : {}
    setVideoGenerateAudio(
      typeof nextVideoConfig.generate_audio === 'boolean' ? nextVideoConfig.generate_audio : true
    )
    setVideoDraft(typeof nextVideoConfig.draft === 'boolean' ? nextVideoConfig.draft : false)
    setVideoSeed(typeof nextVideoConfig.seed === 'number' ? nextVideoConfig.seed : -1)
    setVideoCameraFixed(
      typeof nextVideoConfig.camera_fixed === 'boolean' ? nextVideoConfig.camera_fixed : false
    )
    setVideoWatermark(
      typeof nextVideoConfig.watermark === 'boolean' ? nextVideoConfig.watermark : false
    )
    setVideoDefaultResolution(
      typeof nextVideoConfig.resolution === 'string' ? nextVideoConfig.resolution : '720p'
    )
    setVideoDefaultRatio(typeof nextVideoConfig.ratio === 'string' ? nextVideoConfig.ratio : '16:9')
    setVideoDefaultDuration(
      typeof nextVideoConfig.duration === 'number' ? nextVideoConfig.duration : 5
    )
    const nextCapabilities = isModelConfigObject(nextVideoConfig.capabilities)
      ? nextVideoConfig.capabilities
      : {}
    setCapRatios(
      Array.isArray(nextCapabilities.aspect_ratios) ? nextCapabilities.aspect_ratios : []
    )
    setCapResolutions(
      Array.isArray(nextCapabilities.resolutions) ? nextCapabilities.resolutions : []
    )
    setCapDurations(
      Array.isArray(nextCapabilities.durations_sec) ? nextCapabilities.durations_sec : []
    )
    const {
      aspect_ratios: _aspectRatios,
      resolutions: _resolutions,
      durations_sec: _durations,
      ...advancedVideoCapabilities
    } = nextCapabilities
    setAdvancedCapabilities(
      Object.keys(advancedVideoCapabilities).length
        ? JSON.stringify(advancedVideoCapabilities, null, 2)
        : ''
    )
    setImageConfig(
      isModelConfigObject(spec.imageConfig)
        ? fromImageGenerationConfig(spec.imageConfig)
        : getDefaultImageConfig()
    )
    const nextModelCapabilities = getModelCapabilitiesFromSpec(spec)
    setSupportsImageInput(nextModelCapabilities.supportsImage ?? false)
    setSupportsVideoInput(nextModelCapabilities.supportsVideo ?? false)
    setIsWeworkAvailable(spec.isWeworkAvailable === true)

    const sidecar = isModelConfigObject(modelConfig.visionSidecarModel)
      ? (modelConfig.visionSidecarModel as unknown as VisionSidecarModelRef)
      : undefined
    if (sidecar) {
      const selection = initialVisionSidecarSelection(availableVisionModels, sidecar)
      setSelectedVisionSidecarKey(selection.selectedKey)
      setUnresolvedVisionSidecar(selection.unresolvedRef)
    } else {
      setSelectedVisionSidecarKey('')
      setUnresolvedVisionSidecar(null)
    }
    setCustomHeadersError('')
    setThinkingConfigError('')
    setAdvancedCapabilitiesError('')
  }

  const handleSwitchToJson = () => {
    const parsedHeaders = validateCustomHeaders(customHeaders)
    const parsedThinkingConfig = validateThinkingConfig(thinkingConfigStr)
    if (parsedHeaders === null || parsedThinkingConfig === null) return
    const managedForm = buildManagedSpecFromForm(parsedHeaders, parsedThinkingConfig, false)
    if (!managedForm) return

    const mergedSpec = mergeFormManagedSpec(rawSpec, managedForm.spec)
    setRawSpec(mergedSpec)
    setModelSpecJson(formatModelSpec(mergedSpec))
    setModelSpecError('')
    setModelSpecCannotUseForm(false)
    setEditingMode('json')
  }

  const handleSwitchToForm = () => {
    const spec = parseModelSpec(modelSpecJson)
    if (!spec) return
    if (!canEditModelSpecWithForm(spec)) {
      setModelSpecCannotUseForm(true)
      setModelSpecError(t('common:models.errors.model_spec_not_form_compatible'))
      return
    }

    setRawSpec(spec)
    hydrateFormFromSpec(spec)
    setModelSpecCannotUseForm(false)
    setModelSpecError('')
    setEditingMode('form')
  }

  const handleFormatModelSpec = () => {
    const spec = parseModelSpec(modelSpecJson)
    if (spec) setModelSpecJson(formatModelSpec(spec))
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

    if (!validateModelIdName(modelIdName)) {
      toast({
        variant: 'destructive',
        title: t('common:models.errors.id_invalid'),
      })
      return
    }

    const finalModelId = modelId === 'custom' ? customModelId : modelId
    let expertSpec: ModelSpecConfig | null = null
    let parsedHeaders: Record<string, string> = {}
    let parsedThinkingConfig: Record<string, unknown> = {}

    if (editingMode === 'json') {
      expertSpec = parseModelSpec(modelSpecJson)
      if (!expertSpec) {
        toast({
          variant: 'destructive',
          title: t('common:models.errors.model_spec_invalid'),
        })
        return
      }
    } else {
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

      const validatedHeaders = validateCustomHeaders(customHeaders)
      if (validatedHeaders === null) {
        toast({
          variant: 'destructive',
          title: t('common:models.errors.custom_headers_invalid'),
        })
        return
      }
      parsedHeaders = validatedHeaders

      const validatedThinkingConfig = validateThinkingConfig(thinkingConfigStr)
      if (validatedThinkingConfig === null) {
        toast({
          variant: 'destructive',
          title: t('common:models.errors.thinking_config_invalid_json'),
        })
        return
      }
      parsedThinkingConfig = validatedThinkingConfig
    }

    if (
      publicationGroups &&
      publicationScope.target === 'team' &&
      publicationScope.groupNames.length === 0
    ) {
      toast({
        variant: 'destructive',
        title: t('resource-library:new_capability.select_groups'),
      })
      return
    }

    setSaving(true)
    try {
      const managedForm =
        editingMode === 'form'
          ? buildManagedSpecFromForm(parsedHeaders, parsedThinkingConfig, true)
          : null
      if (editingMode === 'form' && !managedForm) return
      const savedSpec = expertSpec || mergeFormManagedSpec(rawSpec, managedForm!.spec)
      const savedSpecValidation = validateModelSpecJson(formatModelSpec(savedSpec))
      if (!savedSpecValidation.value) {
        const validationMessage = modelSpecValidationMessage(savedSpecValidation)
        setModelSpecError(validationMessage)
        toast({ variant: 'destructive', title: validationMessage })
        return
      }
      const modelCRD: ModelCRD = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelIdName.trim(),
          namespace: isGroupScope && groupName ? groupName : 'default',
          displayName: displayName.trim() || undefined,
        },
        spec: savedSpecValidation.value,
        status: {
          state: 'Available',
        },
      }

      // Build form data for custom onSave callback
      const formData: ModelFormData = {
        modelIdName: modelIdName.trim(),
        displayName: displayName.trim(),
        modelGroup: modelGroup.trim(),
        modelSubGroup: modelSubGroup.trim(),
        modelCategoryType,
        providerType,
        modelId: finalModelId,
        customModelId,
        apiKey,
        baseUrl,
        customHeaders,
        contextWindow,
        maxOutputTokens,
        costIndex,
        ttsVoice,
        ttsSpeed,
        ttsOutputFormat,
        sttLanguage,
        sttTranscriptionFormat,
        embeddingDimensions,
        embeddingEncodingFormat,
        embeddingSupportsImageInput,
        rerankTopN,
        rerankReturnDocuments,
        supportsImageInput,
        supportsVideoInput,
        // Video-specific configs (derive defaults from capabilities)
        videoResolution: managedForm?.videoConfig?.resolution,
        videoRatio: managedForm?.videoConfig?.ratio,
        videoDuration: managedForm?.videoConfig?.duration,
        videoGenerateAudio,
        videoDraft,
        videoSeed,
        videoCameraFixed,
        videoWatermark,
        isWeworkAvailable,
        visionSidecarModel: managedForm?.selectedVisionSidecar,
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
        } else {
          await modelApis.createModel(modelCRD)
        }
        if (publicationGroups) {
          await publicationScope.savePublicationScope({
            sourceName: modelCRD.metadata.name,
            sourceNamespace: modelCRD.metadata.namespace,
            displayName: modelCRD.metadata.displayName || modelCRD.metadata.name,
          })
        }
        toast({
          title: isEditing ? t('common:models.update_success') : t('common:models.create_success'),
        })
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
    providerType === 'openai' || providerType === 'openai-responses' || providerType === 'gpt-image'
      ? 'sk-...'
      : providerType === 'gemini' || providerType === 'gemini-deep-research'
        ? 'AIza...'
        : 'sk-ant-...'
  const baseUrlPlaceholder =
    providerType === 'openai' || providerType === 'openai-responses' || providerType === 'gpt-image'
      ? OPENAI_BASE_URL
      : providerType === 'gemini'
        ? 'https://generativelanguage.googleapis.com'
        : providerType === 'gemini-deep-research'
          ? 'Internal proxy (auto-configured)'
          : 'https://api.anthropic.com'

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent
        ref={setDialogContentElement}
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t('common:models.edit_title') : t('common:models.create_title')}
          </DialogTitle>
          <DialogDescription>{t('common:models.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Model ID and Display Name - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="modelIdName" className="text-sm font-medium">
                {t('common:models.model_id_name')} <span className="text-red-400">*</span>
              </Label>
              <Input
                id="modelIdName"
                data-testid="model-id-name-input"
                value={modelIdName}
                onChange={e => handleModelIdNameChange(e.target.value)}
                placeholder="my-gpt-model"
                disabled={isEditing}
                className={`bg-base ${modelIdNameError ? 'border-error' : ''}`}
              />
              {modelIdNameError && <p className="text-xs text-error">{modelIdNameError}</p>}
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

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {t('common:models.model_spec_config')}
                </p>
                <p className="text-xs text-text-muted">
                  {t('common:models.model_spec_config_hint')}
                </p>
              </div>
              <div
                role="tablist"
                aria-label={t('common:models.model_spec_mode')}
                className="inline-flex min-h-11 rounded-md bg-muted p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={editingMode === 'form'}
                  data-testid="model-spec-form-mode-button"
                  onClick={editingMode === 'json' ? handleSwitchToForm : undefined}
                  className={cn(
                    'min-h-9 rounded px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    editingMode === 'form'
                      ? 'bg-base text-text-primary shadow-sm'
                      : 'cursor-pointer text-text-muted hover:text-text-primary'
                  )}
                >
                  {t('common:models.model_spec_form_mode')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editingMode === 'json'}
                  data-testid="model-spec-json-mode-button"
                  onClick={editingMode === 'form' ? handleSwitchToJson : undefined}
                  className={cn(
                    'min-h-9 rounded px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    editingMode === 'json'
                      ? 'bg-base text-text-primary shadow-sm'
                      : 'cursor-pointer text-text-muted hover:text-text-primary'
                  )}
                >
                  {t('common:models.model_spec_json_mode')}
                </button>
              </div>
            </div>

            <p
              className="flex items-start gap-1.5 text-xs text-warning"
              data-testid="model-spec-switch-secret-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('common:models.model_spec_switch_secret_warning')}</span>
            </p>

            {editingMode === 'json' && (
              <div className="space-y-3" role="tabpanel">
                <div
                  className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary"
                  data-testid="model-spec-secret-warning"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p>{t('common:models.model_spec_secret_warning')}</p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label id="model-spec-json-label" className="text-sm font-medium">
                    {t('common:models.model_spec_json_label')}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="model-spec-load-models-button"
                      onClick={handleFetchModels}
                      disabled={fetchingModels}
                    >
                      {fetchingModels ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                      )}
                      {t('common:models.fetch_models')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="model-spec-format-button"
                      onClick={handleFormatModelSpec}
                    >
                      {t('common:models.model_spec_format')}
                    </Button>
                  </div>
                </div>
                <div
                  className={cn(
                    'overflow-hidden rounded-md border border-border',
                    modelSpecError && 'border-error'
                  )}
                >
                  <CodeMirrorEditor
                    value={modelSpecJson}
                    onChange={handleModelSpecChange}
                    onBlur={() => parseModelSpec(modelSpecJson)}
                    language="json"
                    theme={theme}
                    vimEnabled={false}
                    className="h-[420px]"
                    ariaLabel={t('common:models.model_spec_json_label')}
                    ariaDescribedBy={
                      modelSpecError
                        ? 'model-spec-json-hint model-spec-json-error'
                        : 'model-spec-json-hint'
                    }
                    ariaInvalid={Boolean(modelSpecError)}
                    dataTestId="model-spec-json-editor"
                  />
                </div>
                <p id="model-spec-json-hint" className="text-xs text-text-muted">
                  {t('common:models.model_spec_json_hint')}
                </p>
                {modelSpecError && (
                  <p
                    id="model-spec-json-error"
                    role="alert"
                    className={cn('text-xs text-error', modelSpecCannotUseForm && 'font-medium')}
                  >
                    {modelSpecError}
                  </p>
                )}
              </div>
            )}
          </div>

          {editingMode === 'form' && (
            <>
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="modelGroup" className="text-sm font-medium">
                    {t('common:models.model_group')}
                  </Label>
                  <Input
                    id="modelGroup"
                    data-testid="model-group-input"
                    value={modelGroup}
                    onChange={e => setModelGroup(e.target.value)}
                    placeholder={t('common:models.model_group_placeholder')}
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">{t('common:models.model_group_hint')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="modelSubGroup" className="text-sm font-medium">
                    {t('common:models.model_sub_group')}
                  </Label>
                  <Input
                    id="modelSubGroup"
                    data-testid="model-sub-group-input"
                    value={modelSubGroup}
                    onChange={e => setModelSubGroup(e.target.value)}
                    placeholder={t('common:models.model_sub_group_placeholder')}
                    className="bg-base"
                  />
                  <p className="text-xs text-text-muted">
                    {t('common:models.model_sub_group_hint')}
                  </p>
                </div>
              </div>

              {/* Wework availability toggle */}
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="wework-available" className="text-sm font-medium">
                    {t('common:models.wework_available')}
                  </Label>
                  <p className="text-xs text-text-muted">
                    {t('common:models.wework_available_hint')}
                  </p>
                </div>
                <Switch
                  id="wework-available"
                  data-testid="model-wework-available-switch"
                  checked={isWeworkAvailable}
                  onCheckedChange={checked => setIsWeworkAvailable(checked)}
                />
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
                        data-testid="model-id-select"
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
                      container={dialogContentElement}
                    >
                      <div className="p-2 border-b">
                        <Input
                          placeholder={t('common:models.search_model_id', '搜索模型...')}
                          value={modelIdSearch}
                          onChange={e => setModelIdSearch(e.target.value)}
                          className="h-8"
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
                      {t(
                        'common:models.fetch_models_hint',
                        '请先填写 API Key 后点击"加载模型"按钮'
                      )}
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

              {modelCategoryType === 'llm' && isWeworkAvailable && (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <Label htmlFor="vision-sidecar-model" className="text-sm font-medium">
                    {t('common:models.vision_sidecar_model')}
                  </Label>
                  <Select
                    value={selectedVisionSidecarKey || 'disabled'}
                    onValueChange={value =>
                      setSelectedVisionSidecarKey(value === 'disabled' ? '' : value)
                    }
                    disabled={loadingVisionModels}
                  >
                    <SelectTrigger
                      ref={visionSidecarTriggerRef}
                      id="vision-sidecar-model"
                      data-testid="vision-sidecar-model-select"
                      className="bg-base"
                    >
                      <SelectValue
                        placeholder={
                          loadingVisionModels
                            ? t('common:models.vision_sidecar_loading')
                            : t('common:models.vision_sidecar_disabled')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent
                      ref={visionSidecarContentRef}
                      onCloseAutoFocus={event =>
                        preventSelectCloseFromStealingFocus(
                          event,
                          document.activeElement,
                          visionSidecarTriggerRef.current,
                          visionSidecarContentRef.current
                        )
                      }
                    >
                      <SelectItem value="disabled">
                        {t('common:models.vision_sidecar_disabled')}
                      </SelectItem>
                      {unresolvedVisionSidecar && (
                        <SelectItem
                          value={UNRESOLVED_VISION_SIDECAR_KEY}
                          data-testid="vision-sidecar-model-unavailable-option"
                        >
                          {t('common:models.vision_sidecar_unavailable', {
                            modelName: unresolvedVisionSidecar.modelName,
                          })}
                        </SelectItem>
                      )}
                      {visionModelOptions.map(candidate => (
                        <SelectItem
                          key={visionSidecarModelKey(candidate)}
                          value={visionSidecarModelKey(candidate)}
                        >
                          {candidate.displayName || candidate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-text-muted">
                    {t('common:models.vision_sidecar_hint')}
                  </p>
                  {!loadingVisionModels && visionModelOptions.length === 0 && (
                    <p className="text-xs text-warning">
                      {t('common:models.vision_sidecar_empty')}
                    </p>
                  )}
                </div>
              )}

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
                    aria-label={
                      showApiKey ? t('common:models.hide_api_key') : t('common:models.show_api_key')
                    }
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
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
                    <p className="text-xs text-text-muted">
                      {t('common:models.context_window_hint')}
                    </p>
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
                  <div className="space-y-2">
                    <Label htmlFor="cost_index" className="text-sm font-medium">
                      {t('common:models.cost_index')}
                    </Label>
                    <Input
                      id="cost_index"
                      data-testid="model-cost-index-input"
                      type="text"
                      value={costIndex ?? ''}
                      onChange={e => setCostIndex(e.target.value || undefined)}
                      placeholder="1"
                      className="bg-base"
                    />
                    <p className="text-xs text-text-muted">{t('common:models.cost_index_hint')}</p>
                  </div>
                </div>
              )}

              {/* Thinking/Reasoning Config - JSON passthrough for LLM models */}
              {modelCategoryType === 'llm' && (
                <div className="space-y-2">
                  <Label htmlFor="thinking_config" className="text-sm font-medium">
                    {t('common:models.thinking_config')}
                  </Label>
                  <Textarea
                    id="thinking_config"
                    data-testid="thinking-config-input"
                    value={thinkingConfigStr}
                    onChange={e => handleThinkingConfigChange(e.target.value)}
                    placeholder={`{\n  "thinking": { "type": "enabled" }\n}`}
                    className={`bg-base font-mono text-sm min-h-[80px] ${thinkingConfigError ? 'border-error' : ''}`}
                  />
                  {thinkingConfigError && (
                    <p className="text-xs text-error">{thinkingConfigError}</p>
                  )}
                  <p className="text-xs text-text-muted">
                    {t('common:models.thinking_config_hint')}
                  </p>
                </div>
              )}

              {/* Multimodal capabilities (LLM models only) */}
              {modelCategoryType === 'llm' && (
                <div className="space-y-3 rounded-lg bg-muted p-4">
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="supports_image_input"
                      data-testid="supports-image-input-checkbox"
                      checked={supportsImageInput}
                      onCheckedChange={checked => setSupportsImageInput(Boolean(checked))}
                    />
                    <div className="space-y-1">
                      <Label
                        htmlFor="supports_image_input"
                        className="cursor-pointer text-sm font-medium"
                      >
                        {t('common:models.supports_image_input')}
                      </Label>
                      <p className="text-xs text-text-muted">
                        {t('common:models.supports_image_input_hint')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="supports_video_input"
                      data-testid="supports-video-input-checkbox"
                      checked={supportsVideoInput}
                      onCheckedChange={checked => setSupportsVideoInput(Boolean(checked))}
                    />
                    <div className="space-y-1">
                      <Label
                        htmlFor="supports_video_input"
                        className="cursor-pointer text-sm font-medium"
                      >
                        {t('common:models.supports_video_input')}
                      </Label>
                      <p className="text-xs text-text-muted">
                        {t('common:models.supports_video_input_hint')}
                      </p>
                    </div>
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
                      <p className="text-xs text-text-muted">
                        {t('common:models.stt_language_hint')}
                      </p>
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
                  <h4 className="text-sm font-medium text-text-secondary">
                    Embedding Configuration
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="embedding_dimensions" className="text-sm font-medium">
                        {t('common:models.embedding_dimensions')}
                      </Label>
                      <Input
                        id="embedding_dimensions"
                        type="number"
                        value={embeddingDimensions || ''}
                        onChange={e =>
                          setEmbeddingDimensions(parseInt(e.target.value) || undefined)
                        }
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
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="embedding_supports_image_input"
                      data-testid="embedding-image-input-checkbox"
                      checked={embeddingSupportsImageInput}
                      onCheckedChange={checked => setEmbeddingSupportsImageInput(Boolean(checked))}
                    />
                    <div className="space-y-1">
                      <Label
                        htmlFor="embedding_supports_image_input"
                        className="text-sm font-medium cursor-pointer"
                      >
                        {t('common:models.embedding_supports_image_input')}
                      </Label>
                      <p className="text-xs text-text-muted">
                        {t('common:models.embedding_supports_image_input_hint')}
                      </p>
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
                      <p className="text-xs text-text-muted">
                        {t('common:models.rerank_top_n_hint')}
                      </p>
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

              {/* Video-specific fields */}
              {modelCategoryType === 'video' && (
                <div className="space-y-4 p-4 bg-muted rounded-lg">
                  <h4 className="text-sm font-medium text-text-secondary">
                    {t('common:models.video_config_title')}
                  </h4>

                  {/* Model capabilities configuration */}
                  <div>
                    <p className="text-xs text-text-muted mb-3">
                      {t('common:models.video_capabilities_hint')}
                    </p>

                    {/* Supported aspect ratios */}
                    <div className="space-y-2 mb-4">
                      <Label className="text-sm font-medium">
                        {t('common:models.video_capabilities_ratios')}
                      </Label>
                      <div className="flex flex-wrap gap-2">
                        {['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map(ratio => (
                          <button
                            key={ratio}
                            type="button"
                            onClick={() =>
                              setCapRatios(prev =>
                                prev.some(option => option.value === ratio)
                                  ? prev.filter(option => option.value !== ratio)
                                  : [...prev, { label: ratio, value: ratio }]
                              )
                            }
                            className={cn(
                              'px-3 py-1.5 text-xs rounded-md border transition-colors',
                              capRatios.some(option => option.value === ratio)
                                ? 'bg-primary/10 border-primary text-primary'
                                : 'bg-base border-border text-text-secondary hover:border-text-muted'
                            )}
                          >
                            {ratio === 'adaptive' ? t('chat:video.ratio.adaptive') : ratio}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Supported resolutions */}
                    <div className="space-y-2 mb-4">
                      <Label className="text-sm font-medium">
                        {t('common:models.video_capabilities_resolutions')}
                      </Label>
                      <div className="flex flex-wrap gap-2">
                        {['480p', '720p', '1080p'].map(res => (
                          <button
                            key={res}
                            type="button"
                            onClick={() =>
                              setCapResolutions(prev =>
                                prev.some(option => (option.value ?? option.label) === res)
                                  ? prev.filter(option => (option.value ?? option.label) !== res)
                                  : [...prev, { label: res, value: res }]
                              )
                            }
                            className={cn(
                              'px-3 py-1.5 text-xs rounded-md border transition-colors',
                              capResolutions.some(option => (option.value ?? option.label) === res)
                                ? 'bg-primary/10 border-primary text-primary'
                                : 'bg-base border-border text-text-secondary hover:border-text-muted'
                            )}
                          >
                            {res}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2 mt-4">
                      <Label htmlFor="video-advanced-capabilities" className="text-sm font-medium">
                        {t('common:models.video_advanced_capabilities')}
                      </Label>
                      <Textarea
                        id="video-advanced-capabilities"
                        data-testid="video-advanced-capabilities"
                        value={advancedCapabilities}
                        onChange={event => {
                          setAdvancedCapabilities(event.target.value)
                          setAdvancedCapabilitiesError('')
                        }}
                        placeholder='{"supports_image_input":true,"supports_video_input":true,"generation_modes":[...]}'
                        className={`min-h-[180px] bg-base font-mono text-xs ${
                          advancedCapabilitiesError ? 'border-error' : ''
                        }`}
                      />
                      <p className="text-xs text-text-muted">
                        {t('common:models.video_advanced_capabilities_hint')}
                      </p>
                      {advancedCapabilitiesError && (
                        <p className="text-xs text-error">{advancedCapabilitiesError}</p>
                      )}
                    </div>

                    {/* Supported durations */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">
                        {t('common:models.video_capabilities_durations')}
                      </Label>
                      <div className="flex flex-wrap gap-2 items-center">
                        {[-1, 5, 10].map(dur => (
                          <button
                            key={dur}
                            type="button"
                            onClick={() =>
                              setCapDurations(prev =>
                                prev.includes(dur)
                                  ? prev.filter(d => d !== dur)
                                  : [...prev, dur].sort((a, b) => a - b)
                              )
                            }
                            className={cn(
                              'px-3 py-1.5 text-xs rounded-md border transition-colors',
                              capDurations.includes(dur)
                                ? 'bg-primary/10 border-primary text-primary'
                                : 'bg-base border-border text-text-secondary hover:border-text-muted'
                            )}
                          >
                            {dur === -1 ? t('common:models.video_duration_auto') : `${dur}s`}
                          </button>
                        ))}
                        {/* Show custom durations that aren't predefined */}
                        {capDurations
                          .filter(d => d !== -1 && d !== 5 && d !== 10)
                          .map(dur => (
                            <button
                              key={dur}
                              type="button"
                              onClick={() => setCapDurations(prev => prev.filter(d => d !== dur))}
                              className="px-3 py-1.5 text-xs rounded-md border bg-primary/10 border-primary text-primary transition-colors"
                            >
                              {dur}s ×
                            </button>
                          ))}
                        {/* Custom duration input */}
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={1}
                            max={300}
                            placeholder={t('common:models.video_capabilities_custom_add')}
                            value={customDuration}
                            onChange={e => setCustomDuration(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                const val = parseInt(customDuration)
                                if (val > 0 && !capDurations.includes(val)) {
                                  setCapDurations(prev => [...prev, val].sort((a, b) => a - b))
                                  setCustomDuration('')
                                }
                              }
                            }}
                            className="w-20 h-8 text-xs bg-base"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2"
                            onClick={() => {
                              const val = parseInt(customDuration)
                              if (val > 0 && !capDurations.includes(val)) {
                                setCapDurations(prev => [...prev, val].sort((a, b) => a - b))
                                setCustomDuration('')
                              }
                            }}
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Feature toggles */}
                  <div className="border-t pt-4 mt-4">
                    <h5 className="text-sm font-medium text-text-secondary mb-3">
                      {t('common:models.video_feature_toggles')}
                    </h5>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-sm font-medium">
                            {t('common:models.video_generate_audio')}
                          </Label>
                          <p className="text-xs text-text-muted">
                            {t('common:models.video_generate_audio_hint')}
                          </p>
                        </div>
                        <Select
                          value={videoGenerateAudio ? 'true' : 'false'}
                          onValueChange={v => setVideoGenerateAudio(v === 'true')}
                        >
                          <SelectTrigger className="w-20 bg-base">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">是</SelectItem>
                            <SelectItem value="false">否</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-sm font-medium">
                            {t('common:models.video_draft_mode')}
                          </Label>
                          <p className="text-xs text-text-muted">
                            {t('common:models.video_draft_mode_hint')}
                          </p>
                        </div>
                        <Select
                          value={videoDraft ? 'true' : 'false'}
                          onValueChange={v => setVideoDraft(v === 'true')}
                        >
                          <SelectTrigger className="w-20 bg-base">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">是</SelectItem>
                            <SelectItem value="false">否</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-sm font-medium">
                            {t('common:models.video_camera_fixed')}
                          </Label>
                          <p className="text-xs text-text-muted">
                            {t('common:models.video_camera_fixed_hint')}
                          </p>
                        </div>
                        <Select
                          value={videoCameraFixed ? 'true' : 'false'}
                          onValueChange={v => setVideoCameraFixed(v === 'true')}
                        >
                          <SelectTrigger className="w-20 bg-base">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">是</SelectItem>
                            <SelectItem value="false">否</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-sm font-medium">
                            {t('common:models.video_watermark')}
                          </Label>
                        </div>
                        <Select
                          value={videoWatermark ? 'true' : 'false'}
                          onValueChange={v => setVideoWatermark(v === 'true')}
                        >
                          <SelectTrigger className="w-20 bg-base">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">是</SelectItem>
                            <SelectItem value="false">否</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  {/* Advanced parameters */}
                  <div className="border-t pt-4 mt-4">
                    <h5 className="text-sm font-medium text-text-secondary mb-3">
                      {t('common:models.video_advanced_options')}
                    </h5>
                    <div className="space-y-2">
                      <Label htmlFor="video_seed" className="text-sm font-medium">
                        {t('common:models.video_seed')}
                      </Label>
                      <Input
                        id="video_seed"
                        type="number"
                        value={videoSeed}
                        onChange={e => setVideoSeed(parseInt(e.target.value) || -1)}
                        placeholder="-1"
                        className="bg-base w-40"
                      />
                      <p className="text-xs text-text-muted">
                        {t('common:models.video_seed_hint')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Image-specific fields */}
              {modelCategoryType === 'image' && (
                <ImageConfigSection
                  config={imageConfig}
                  onChange={changes => setImageConfig(prev => ({ ...prev, ...changes }))}
                />
              )}
            </>
          )}

          {publicationGroups && (
            <div data-testid="model-publish-scope-section">
              <CapabilityScopeSelector
                value={publicationScope.target}
                groups={publicationScope.writableGroups}
                groupNames={publicationScope.groupNames}
                onChange={publicationScope.handleChange}
                existingResource={isEditing}
                multipleGroups
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            data-testid="model-test-connection-button"
            disabled={testing || (editingMode === 'form' && (!modelId || !apiKey))}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <BeakerIcon className="w-4 h-4 mr-1" />
            {t('common:models.test_connection')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saving || publicationScope.loading}
            >
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
