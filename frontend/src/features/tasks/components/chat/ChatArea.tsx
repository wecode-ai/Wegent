// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react'
import { Command, MessageSquareText, ShieldX, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import MessagesArea from '../message/MessagesArea'
import { QuickAccessCards } from './QuickAccessCards'
import { SloganDisplay } from './SloganDisplay'
import { ChatInputCard } from '../input/ChatInputCard'
import PipelineStageIndicator from './PipelineStageIndicator'
import PipelineNextStepDialog from './PipelineNextStepDialog'
import {
  buildPipelineNextStepDraft,
  type PipelineNextStepMessage,
  type PipelineNextStepPayload,
} from './pipelineNextStep'
import { ScrollToBottomIndicator } from './ScrollToBottomIndicator'
import { ScrollbarMarkers } from './ScrollbarMarkers'
import { GuidedQuestions } from '@/features/knowledge/document/components/GuidedQuestions'
import type { PipelineStageInfo } from '@/apis/tasks'
import { useChatAreaState } from './useChatAreaState'
import { useChatStreamHandlers, type SendMessageOptions } from './useChatStreamHandlers'
import { allBotsHavePredefinedModel } from '../selector/ModelSelector'
import { QuoteProvider, SelectionTooltip, useQuote } from '../text-selection'
import type { Team, SubtaskContextBrief, TaskType } from '@/types/api'
import type { PipelineContextPassing } from '@/types/api'
import type { Model } from '../../hooks/useModelSelection'
import type { ContextItem, ExternalKnowledgeRef, QueueMessageContext } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { useOptionalTaskSession } from '@/features/tasks/session/TaskSession'
import { Button } from '@/components/ui/button'
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
import { useToast } from '@/hooks/use-toast'
import { useScrollManagement } from '../hooks/useScrollManagement'
import { useFloatingInput } from '../hooks/useFloatingInput'
import { getAttachment } from '@/apis/attachments'
import { userApis } from '@/apis/user'
import { useAttachmentUpload } from '../hooks/useAttachmentUpload'
import { useSchemeMessageActions } from '@/lib/scheme'
import { QueryParamAutoSend } from '../params'
import { useSkillSelector } from '../../hooks/useSkillSelector'
import { useModelSelection } from '../../hooks/useModelSelection'
import { QueueMessageHandler } from '@/features/inbox'
import type { ChatAreaExtension } from './types'
import { useProjectContext } from '@/features/projects/contexts/projectContext'
import { useChatStatusIndicator } from '@/features/tasks/hooks/useChatStatusIndicator'
import {
  buildInteractiveFormCancellation,
  findPendingInteractiveForm,
} from './interactiveFormPending'
import {
  parseQuickLaunchIntent,
  removeQuickLaunchQueryParams,
  type QuickLaunchIntent,
} from './quick-launch/launch-intent'
import { shouldClearDeviceSelectionForQuickLauncher } from './quick-launch/execution-target'
import type { QuickPresetSelection } from './quick-launch/types'
import { useDevices } from '@/contexts/DeviceContext'
import {
  filterTeamsByMode,
  getTeamGenerateMode,
  teamSupportsBothGenerationModes,
  type TeamModeFilter,
} from '../selector/team-selector-utils'
import type { UnifiedMessage } from '@wegent/chat-core'
import type { ArtifactPromptRequest } from '@/types/knowledge-artifact'
import type { KnowledgeCapabilityDraftRequest } from '@/types/knowledge-capability'
import { getFirstSearchParam, getSearchParam, stringifySearchParams } from '@/lib/search-params'
import {
  getTaskQueryParam,
  removeGenerationModeQueryParam,
  removeTaskQueryParams,
  removeTeamQueryParam,
} from '@/features/tasks/utils/task-query-params'
import type { ImageGenerationConfig, VideoCapabilities, VideoGenerationMode } from '@/apis/models'
import { readVideoFrameRate } from './mediaMetadata'
import {
  exceedsReferenceMaterialLimits,
  resolveReferenceMaterialLimits,
} from './referenceMaterialLimits'
import { formatAspectRatioLimit, formatVideoPixelLimit } from './generationFormatting'
import {
  formatsToAcceptString,
  getFileExtension,
  isAudioExtension,
  isImageExtension,
  isVideoExtension,
} from '@/apis/attachments'
import type { AttachmentTypeLimits } from '@/hooks/useMultiAttachment'

/**
 * Threshold in pixels for determining when to collapse selectors.
 * When the controls container width is less than this value, selectors will collapse.
 */
const COLLAPSE_SELECTORS_THRESHOLD = 420

function isAllowedGenerationFormat(format: string, formats: string[]): boolean {
  const normalized = format.toLowerCase().replace(/^\./, '')
  return formats.some(value => {
    const allowed = value.toLowerCase().replace(/^\./, '')
    return allowed === normalized || (allowed === 'jpeg' && normalized === 'jpg')
  })
}

function buildExternalRefFromContext(context: SubtaskContextBrief): ExternalKnowledgeRef | null {
  if (!context.external_provider || !context.external_mode) return null
  return {
    provider: context.external_provider,
    mode: context.external_mode,
    id: context.external_id ?? undefined,
    name: context.name,
    scope: context.external_scope ?? undefined,
    target_type: context.external_target_type ?? undefined,
    node_id: context.external_node_id ?? undefined,
    document_id: context.external_document_id ?? undefined,
    parent_id: context.external_parent_id ?? undefined,
  }
}

function buildExternalContextId(ref: ExternalKnowledgeRef) {
  const targetType = ref.target_type ?? 'knowledge_base'
  if (targetType !== 'knowledge_base') {
    const targetId = ref.node_id ?? ref.document_id ?? 'unknown'
    return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}:${targetType}:${targetId}`
  }
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}`
}

/** Generation mode type - video or image */
type GenerateMode = 'video' | 'image'

function isGenerateMode(taskType: TaskType): taskType is GenerateMode {
  return taskType === 'video' || taskType === 'image'
}

const PIPELINE_NEXT_STEP_CONTEXT_TYPES = new Set<SubtaskContextBrief['context_type']>([
  'attachment',
  'knowledge_base',
  'table',
])

function isPipelineNextStepContext(context: unknown): context is SubtaskContextBrief {
  if (!context || typeof context !== 'object') {
    return false
  }

  const candidate = context as Partial<SubtaskContextBrief>
  return (
    typeof candidate.id === 'number' &&
    typeof candidate.name === 'string' &&
    typeof candidate.status === 'string' &&
    PIPELINE_NEXT_STEP_CONTEXT_TYPES.has(
      candidate.context_type as SubtaskContextBrief['context_type']
    )
  )
}

function getPipelineNextStepContexts(contexts: unknown): SubtaskContextBrief[] | undefined {
  if (!Array.isArray(contexts)) {
    return undefined
  }

  const validContexts = contexts.filter(isPipelineNextStepContext)
  return validContexts.length > 0 ? validContexts : undefined
}

function getPipelineContextPassingForStage(
  team: Team | null | undefined,
  stageInfo: PipelineStageInfo | null
): PipelineContextPassing {
  const stageIndex = stageInfo?.current_stage ?? 0
  return team?.bots?.[stageIndex]?.contextPassing ?? 'none'
}

function getSystemQuickLaunchFunctionId(selection: QuickPresetSelection): string | null {
  if (selection.launcher.type !== 'system_function') {
    return null
  }

  const [prefix, ...idParts] = selection.launcher.key.split(':')
  if (prefix !== 'system' || idParts.length === 0) {
    return null
  }

  const functionId = idParts.join(':').trim()
  return functionId || null
}

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
  selectedTeamForNewTask?: Team | null
  showRepositorySelector?: boolean
  taskType?: TaskType
  teamModeFilter?: TeamModeFilter
  onShareButtonRender?: (button: React.ReactNode) => void
  onRefreshTeams?: () => Promise<Team[]>
  /** Initial knowledge base to pre-select when starting a new chat from knowledge page */
  initialKnowledgeBase?: {
    id: number
    name: string
    namespace: string
    document_count?: number
  } | null
  /** Callback when a new task is created (used for binding knowledge base) */
  onTaskCreated?: (taskId: number) => void
  /** Knowledge base ID for knowledge type tasks */
  knowledgeBaseId?: number
  /** Selected document IDs from KnowledgeSourcePanel (for notebook mode context injection) */
  selectedDocumentIds?: number[]
  /** Reason why input is disabled (e.g., device offline). If set, input will be disabled and show this message. */
  disabledReason?: string
  /** When true, hide all selectors (team, model, skills, attachments, etc.) - only show text input + send button */
  hideSelectors?: boolean
  /** Callback when user switches between video and image mode (only used in generate page) */
  onGenerateModeChange?: (mode: GenerateMode) => void
  /** Guided questions to display when starting a new conversation (for notebook mode) */
  guidedQuestions?: string[]
  /** When true, input is always positioned at bottom even when there are no messages (used in knowledge notebook mode) */
  inputAlwaysAtBottom?: boolean
  /** Custom content to display when there are no messages (used in knowledge notebook mode for KnowledgeBaseSummaryCard) */
  emptyStateContent?: React.ReactNode
  /** Extension for team editing functionality (injected from parent to avoid module coupling) */
  extension?: ChatAreaExtension
  /** One-shot prompt submitted through the normal chat send path. */
  externalPromptRequest?: ArtifactPromptRequest | null
  onExternalPromptConsumed?: (requestId: string) => void
  /** One-shot request that opens and prefills a new task without sending. */
  externalDraftRequest?: KnowledgeCapabilityDraftRequest | null
  onExternalDraftConsumed?: (requestId: string) => void
}

/**
 * Inner component that uses the QuoteContext.
 * Must be rendered inside QuoteProvider.
 */
function ChatAreaContent({
  teams,
  isTeamsLoading,
  selectedTeamForNewTask,
  showRepositorySelector = true,
  taskType = 'chat',
  teamModeFilter = taskType,
  onShareButtonRender,
  onRefreshTeams,
  initialKnowledgeBase,
  onTaskCreated,
  knowledgeBaseId,
  selectedDocumentIds,
  disabledReason,
  hideSelectors,
  onGenerateModeChange,
  guidedQuestions,
  inputAlwaysAtBottom,
  emptyStateContent,
  extension,
  externalPromptRequest,
  onExternalPromptConsumed,
  externalDraftRequest,
  onExternalDraftConsumed,
}: ChatAreaProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const { setSelectedDeviceId } = useDevices()
  const chatStreamContext = useOptionalTaskSession()
  const chatStatus = useChatStatusIndicator()

  // Pipeline stage info state - shared between PipelineStageIndicator and MessagesArea
  const [pipelineStageInfo, setPipelineStageInfo] = useState<PipelineStageInfo | null>(null)
  const [isPipelineNextStepOpen, setIsPipelineNextStepOpen] = useState(false)
  const [isPipelineNextStepConfirming, setIsPipelineNextStepConfirming] = useState(false)
  const [pendingReplacementMessage, setPendingReplacementMessage] = useState<string | null>(null)
  const [pendingReplacementOptions, setPendingReplacementOptions] =
    useState<SendMessageOptions | null>(null)
  const [quickLaunchIntent, setQuickLaunchIntent] = useState<QuickLaunchIntent | null>(null)
  const [isPendingReplacementOpen, setIsPendingReplacementOpen] = useState(false)
  const [isPendingReplacementConfirming, setIsPendingReplacementConfirming] = useState(false)
  const [pendingFormReplacementMessage, setPendingFormReplacementMessage] = useState<string | null>(
    null
  )
  const [pendingFormReplacementOptions, setPendingFormReplacementOptions] =
    useState<SendMessageOptions | null>(null)
  const [isPendingFormReplacementOpen, setIsPendingFormReplacementOpen] = useState(false)
  const [isPendingFormReplacementConfirming, setIsPendingFormReplacementConfirming] =
    useState(false)
  const [pendingQuickPhrase, setPendingQuickPhrase] = useState<string | null>(null)
  const [isQuickPhraseOverwriteOpen, setIsQuickPhraseOverwriteOpen] = useState(false)
  const [pendingExternalDraft, setPendingExternalDraft] =
    useState<KnowledgeCapabilityDraftRequest | null>(null)
  const [focusInputAtEndSignal, setFocusInputAtEndSignal] = useState(0)
  const { quote, clearQuote, formatQuoteForMessage } = useQuote()

  // Task context
  const {
    selectedTask,
    selectedTaskDetail,
    selectTask,
    accessDenied,
    taskState: sessionTaskState,
  } = useTaskSession()
  const effectiveTaskId = selectedTask?.id ?? selectedTaskDetail?.id

  const taskState =
    sessionTaskState && sessionTaskState.taskId === effectiveTaskId ? sessionTaskState : null
  const runtimeTaskStatus = taskState?.runtime.taskStatus
  const pendingInteractiveForm = useMemo(
    () => findPendingInteractiveForm(taskState?.messages?.values()),
    [taskState?.messages]
  )

  const [mediaAttachmentLimits, setMediaAttachmentLimits] = useState<{
    maxAttachments?: number
    maxByType?: AttachmentTypeLimits
  }>({})
  const validateAttachmentFileRef = useRef<(file: File) => Promise<string | null>>(async () => null)
  const validateAttachmentFileProxy = useCallback(
    (file: File) => validateAttachmentFileRef.current(file),
    []
  )

  // Select the team before resolving generation models. Attachment limits are synchronized
  const chatState = useChatAreaState({
    teams,
    taskType,
    teamModeFilter,
    selectedTeamForNewTask,
    initialKnowledgeBase,
    maxAttachments: mediaAttachmentLimits.maxAttachments,
    maxAttachmentsByType: mediaAttachmentLimits.maxByType,
    validateAttachmentFile: validateAttachmentFileProxy,
  })

  // Video model selection state - only enabled for video mode
  // Uses unified useModelSelection hook with modelCategoryType='video'
  const videoModelSelection = useModelSelection({
    teamId: chatState.selectedTeam?.id ?? null,
    taskId: effectiveTaskId ?? null,
    selectedTeam: chatState.selectedTeam,
    disabled: taskType !== 'video',
    modelCategoryType: 'video',
  })

  // Image model selection state - only enabled for image mode
  // Uses unified useModelSelection hook with modelCategoryType='image'
  const imageModelSelection = useModelSelection({
    teamId: chatState.selectedTeam?.id ?? null,
    taskId: effectiveTaskId ?? null,
    selectedTeam: chatState.selectedTeam,
    disabled: taskType !== 'image',
    modelCategoryType: 'image',
  })

  const videoConfig = videoModelSelection.selectedModel?.config?.videoConfig as
    | {
        resolution?: string
        ratio?: string
        duration?: number
        max_reference_images?: number
        capabilities?: VideoCapabilities
      }
    | undefined
  const videoCapabilities = videoConfig?.capabilities
  const imageConfig = imageModelSelection.selectedModel?.config?.imageConfig as
    | ImageGenerationConfig
    | undefined
  const imageCapabilities = imageConfig?.capabilities
  const imageReferenceFormats = imageCapabilities?.image_formats
  const videoGenerationModes = useMemo(
    () => videoCapabilities?.generation_modes ?? [],
    [videoCapabilities?.generation_modes]
  )
  const [selectedVideoGenerationMode, setSelectedVideoGenerationMode] = useState<
    string | undefined
  >(undefined)

  useEffect(() => {
    setSelectedVideoGenerationMode(videoGenerationModes[0]?.id)
  }, [videoModelSelection.selectedModel?.name, videoGenerationModes])

  const activeVideoGenerationMode = useMemo<VideoGenerationMode | undefined>(
    () =>
      videoGenerationModes.find(mode => mode.id === selectedVideoGenerationMode) ??
      videoGenerationModes[0],
    [selectedVideoGenerationMode, videoGenerationModes]
  )

  const hasReferenceVideo = useMemo(
    () =>
      chatState.attachmentState.attachments.some(attachment =>
        isVideoExtension(attachment.file_extension)
      ) ||
      Array.from(chatState.attachmentState.uploadingFiles.values()).some(uploading =>
        isVideoExtension(getFileExtension(uploading.file.name))
      ),
    [chatState.attachmentState.attachments, chatState.attachmentState.uploadingFiles]
  )

  const videoMaterialLimits = useMemo(
    () =>
      resolveReferenceMaterialLimits({
        capabilities: videoCapabilities,
        mode: activeVideoGenerationMode,
        legacyImageLimit: videoConfig?.max_reference_images,
        hasReferenceVideo,
      }),
    [
      activeVideoGenerationMode,
      hasReferenceVideo,
      videoCapabilities,
      videoConfig?.max_reference_images,
    ]
  )

  const maxAttachmentsFromModel = useMemo(() => {
    if (taskType === 'image') {
      return imageCapabilities?.max_reference_images ?? imageConfig?.max_reference_images
    }
    if (taskType === 'video') {
      return videoMaterialLimits.total ?? videoConfig?.max_reference_images
    }
    return undefined
  }, [
    taskType,
    imageCapabilities?.max_reference_images,
    imageConfig?.max_reference_images,
    videoMaterialLimits.total,
    videoConfig?.max_reference_images,
  ])

  const maxAttachmentsByType = useMemo(() => {
    if (taskType !== 'video') return undefined
    return {
      image: videoMaterialLimits.image,
      imageWithVideo: videoCapabilities?.max_reference_images_with_video,
      video: videoMaterialLimits.video,
      audio: videoMaterialLimits.audio,
    }
  }, [taskType, videoMaterialLimits])

  const videoImageMaterialAccept = useMemo(
    () => formatsToAcceptString(videoCapabilities?.image_formats, 'image/*'),
    [videoCapabilities?.image_formats]
  )
  const imageMaterialAccept = useMemo(
    () => formatsToAcceptString(imageReferenceFormats, 'image/*'),
    [imageReferenceFormats]
  )

  const materialAccept = useMemo(() => {
    if (taskType === 'image') return imageMaterialAccept
    if (taskType !== 'video') return undefined
    const isKeyframeMode =
      activeVideoGenerationMode?.id === 'first_last_frame' ||
      activeVideoGenerationMode?.id === 'keyframe'
    const imageAllowed =
      activeVideoGenerationMode?.image_required ||
      activeVideoGenerationMode?.first_frame_required ||
      videoCapabilities?.supports_image_input !== false
    const videoAllowed =
      !isKeyframeMode &&
      videoCapabilities?.supports_video_input === true &&
      activeVideoGenerationMode?.video_allowed !== false
    const audioAllowed =
      !isKeyframeMode &&
      videoCapabilities?.supports_audio_input === true &&
      activeVideoGenerationMode?.audio_allowed !== false
    return [
      imageAllowed ? videoImageMaterialAccept : '',
      videoAllowed ? formatsToAcceptString(videoCapabilities?.video_formats, 'video/*') : '',
      audioAllowed ? formatsToAcceptString(videoCapabilities?.audio_formats, 'audio/*') : '',
    ]
      .filter(Boolean)
      .join(',')
  }, [
    activeVideoGenerationMode,
    imageMaterialAccept,
    taskType,
    videoCapabilities,
    videoImageMaterialAccept,
  ])

  const validateAttachmentFile = useCallback(
    async (file: File): Promise<string | null> => {
      const extension = getFileExtension(file.name)
      const format = extension.replace(/^\./, '').toLowerCase()
      if (taskType === 'image') {
        if (
          imageCapabilities?.supports_image_input === false ||
          (imageCapabilities?.max_reference_images ?? imageConfig?.max_reference_images) === 0
        ) {
          return t('generate.material_errors.model_image')
        }
        if (
          imageReferenceFormats?.length &&
          !isAllowedGenerationFormat(format, imageReferenceFormats)
        ) {
          return t('generate.material_errors.format', {
            format: format.toUpperCase(),
            formats: imageReferenceFormats.map(value => value.toUpperCase()).join(', '),
          })
        }
        const maxSizeMb = imageCapabilities?.image_max_size_mb
        if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
          return t('generate.material_errors.max_size', {
            current: Number((file.size / (1024 * 1024)).toFixed(1)),
            max: maxSizeMb,
          })
        }
        return null
      }
      if (taskType !== 'video' || !videoCapabilities) return null
      const isImage = isImageExtension(extension)
      const isVideo = isVideoExtension(extension)
      const isAudio = isAudioExtension(extension)
      const isImageMime = file.type.toLowerCase().startsWith('image/')
      const isKeyframeMode =
        activeVideoGenerationMode?.id === 'first_last_frame' ||
        activeVideoGenerationMode?.id === 'keyframe'
      if (isKeyframeMode && !isImage) {
        if (isImageMime && videoCapabilities.image_formats?.length) {
          return t('generate.material_errors.format', {
            format: format.toUpperCase(),
            formats: videoCapabilities.image_formats.map(value => value.toUpperCase()).join(', '),
          })
        }
        return t('generate.material_errors.mode_image_only')
      }
      if (!isImage && !isVideo && !isAudio) {
        return t('generate.material_errors.material_type')
      }
      if (isImage && videoCapabilities.supports_image_input === false) {
        return t('generate.material_errors.model_image')
      }
      if (isVideo && activeVideoGenerationMode?.video_allowed === false) {
        return t('generate.material_errors.mode_video')
      }
      if (isAudio && activeVideoGenerationMode?.audio_allowed === false) {
        return t('generate.material_errors.mode_audio')
      }
      if (isVideo && videoCapabilities.supports_video_input !== true) {
        return t('generate.material_errors.model_video')
      }
      if (isAudio && videoCapabilities.supports_audio_input !== true) {
        return t('generate.material_errors.model_audio')
      }
      const formats = isImage
        ? videoCapabilities.image_formats
        : isVideo
          ? videoCapabilities.video_formats
          : videoCapabilities.audio_formats
      if (formats?.length && !isAllowedGenerationFormat(format, formats)) {
        return t('generate.material_errors.format', {
          format: format.toUpperCase(),
          formats: formats.map(value => value.toUpperCase()).join(', '),
        })
      }
      const maxSizeMb = isImage
        ? videoCapabilities.image_max_size_mb
        : isVideo
          ? videoCapabilities.video_max_size_mb
          : videoCapabilities.audio_max_size_mb
      if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
        return t('generate.material_errors.max_size', {
          current: Number((file.size / (1024 * 1024)).toFixed(1)),
          max: maxSizeMb,
        })
      }
      if (isImage) {
        const dimensions = await new Promise<{ width: number; height: number } | null>(resolve => {
          const image = new Image()
          const url = URL.createObjectURL(file)
          image.onload = () => {
            URL.revokeObjectURL(url)
            resolve({ width: image.naturalWidth, height: image.naturalHeight })
          }
          image.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(null)
          }
          image.src = url
        })
        if (
          !dimensions &&
          (videoCapabilities.image_min_dimension != null ||
            videoCapabilities.image_max_dimension != null ||
            videoCapabilities.image_min_aspect_ratio != null ||
            videoCapabilities.image_max_aspect_ratio != null)
        ) {
          return t('generate.material_errors.image_metadata_unreadable')
        }
        if (dimensions) {
          const min = videoCapabilities.image_min_dimension
          const max = videoCapabilities.image_max_dimension
          const aspectRatio = dimensions.width / dimensions.height
          if (
            (min && (dimensions.width < min || dimensions.height < min)) ||
            (max && (dimensions.width > max || dimensions.height > max))
          ) {
            return t('generate.material_errors.image_dimension', {
              min: min ?? 1,
              max: max ?? t('generate.material_errors.unlimited'),
              width: dimensions.width,
              height: dimensions.height,
            })
          }
          if (
            (videoCapabilities.image_min_aspect_ratio &&
              aspectRatio < videoCapabilities.image_min_aspect_ratio) ||
            (videoCapabilities.image_max_aspect_ratio &&
              aspectRatio > videoCapabilities.image_max_aspect_ratio)
          ) {
            return t('generate.material_errors.image_aspect_ratio', {
              min:
                videoCapabilities.image_min_aspect_ratio != null
                  ? formatAspectRatioLimit(videoCapabilities.image_min_aspect_ratio)
                  : t('generate.material_errors.unlimited'),
              max:
                videoCapabilities.image_max_aspect_ratio != null
                  ? formatAspectRatioLimit(videoCapabilities.image_max_aspect_ratio)
                  : t('generate.material_errors.unlimited'),
              width: dimensions.width,
              height: dimensions.height,
            })
          }
        }
      }
      if (isVideo || isAudio) {
        const metadata = await new Promise<{
          duration: number | null
          width: number
          height: number
        } | null>(resolve => {
          const media = document.createElement(isVideo ? 'video' : 'audio')
          const url = URL.createObjectURL(file)
          media.onloadedmetadata = () => {
            URL.revokeObjectURL(url)
            const video = media as HTMLVideoElement
            resolve({
              duration: Number.isFinite(media.duration) ? media.duration : null,
              width: isVideo ? video.videoWidth : 0,
              height: isVideo ? video.videoHeight : 0,
            })
          }
          media.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(null)
          }
          media.src = url
        })
        const duration = metadata?.duration ?? null
        const min = isVideo
          ? videoCapabilities.video_min_duration_sec
          : videoCapabilities.audio_min_duration_sec
        const max = isVideo
          ? videoCapabilities.video_max_duration_sec
          : videoCapabilities.audio_max_duration_sec
        const requiresVideoMetadata =
          isVideo &&
          (videoCapabilities.video_min_dimension != null ||
            videoCapabilities.video_max_dimension != null ||
            videoCapabilities.video_min_pixels != null ||
            videoCapabilities.video_max_pixels != null ||
            videoCapabilities.video_min_aspect_ratio != null ||
            videoCapabilities.video_max_aspect_ratio != null ||
            videoCapabilities.video_min_fps != null ||
            videoCapabilities.video_max_fps != null)
        if (!metadata && requiresVideoMetadata) {
          return t('generate.material_errors.video_metadata_unreadable')
        }
        if (duration == null && (min != null || max != null)) {
          return t('generate.material_errors.duration_unreadable')
        }
        if (
          duration != null &&
          ((min != null && duration < min) || (max != null && duration > max))
        ) {
          return t('generate.material_errors.duration_range', {
            min: min ?? 0,
            max: max ?? t('generate.material_errors.unlimited'),
            current: Number(duration.toFixed(1)),
          })
        }
        if (isVideo && metadata?.width && metadata.height) {
          const { width, height } = metadata
          const minDimension = videoCapabilities.video_min_dimension
          const maxDimension = videoCapabilities.video_max_dimension
          const pixels = width * height
          const aspectRatio = width / height
          if (
            (minDimension && (width < minDimension || height < minDimension)) ||
            (maxDimension && (width > maxDimension || height > maxDimension))
          ) {
            return t('generate.material_errors.video_dimension', {
              min: minDimension ?? 1,
              max: maxDimension ?? t('generate.material_errors.unlimited'),
              width,
              height,
            })
          }
          if (
            (videoCapabilities.video_min_pixels && pixels < videoCapabilities.video_min_pixels) ||
            (videoCapabilities.video_max_pixels && pixels > videoCapabilities.video_max_pixels)
          ) {
            return t('generate.material_errors.video_pixels', {
              min:
                videoCapabilities.video_min_pixels != null
                  ? formatVideoPixelLimit(videoCapabilities.video_min_pixels)
                  : t('generate.material_errors.unlimited'),
              max:
                videoCapabilities.video_max_pixels != null
                  ? formatVideoPixelLimit(videoCapabilities.video_max_pixels)
                  : t('generate.material_errors.unlimited'),
              current: formatVideoPixelLimit(pixels),
              width,
              height,
            })
          }
          if (
            (videoCapabilities.video_min_aspect_ratio &&
              aspectRatio < videoCapabilities.video_min_aspect_ratio) ||
            (videoCapabilities.video_max_aspect_ratio &&
              aspectRatio > videoCapabilities.video_max_aspect_ratio)
          ) {
            return t('generate.material_errors.video_aspect_ratio', {
              min:
                videoCapabilities.video_min_aspect_ratio != null
                  ? formatAspectRatioLimit(videoCapabilities.video_min_aspect_ratio)
                  : t('generate.material_errors.unlimited'),
              max:
                videoCapabilities.video_max_aspect_ratio != null
                  ? formatAspectRatioLimit(videoCapabilities.video_max_aspect_ratio)
                  : t('generate.material_errors.unlimited'),
              width,
              height,
            })
          }
          const minFps = videoCapabilities.video_min_fps
          const maxFps = videoCapabilities.video_max_fps
          if (minFps != null || maxFps != null) {
            const fps = await readVideoFrameRate(file)
            if (fps == null) {
              return t('generate.material_errors.video_fps_unreadable')
            }
            if ((minFps != null && fps < minFps) || (maxFps != null && fps > maxFps)) {
              return t('generate.material_errors.video_fps', {
                min: minFps ?? 0,
                max: maxFps ?? t('generate.material_errors.unlimited'),
                current: Number(fps.toFixed(2)),
              })
            }
          }
        }
      }
      return null
    },
    [
      activeVideoGenerationMode,
      imageCapabilities,
      imageConfig?.max_reference_images,
      imageReferenceFormats,
      t,
      taskType,
      videoCapabilities,
    ]
  )

  useEffect(() => {
    validateAttachmentFileRef.current = validateAttachmentFile
  }, [validateAttachmentFile])

  useEffect(() => {
    setMediaAttachmentLimits({
      maxAttachments: maxAttachmentsFromModel,
      maxByType: maxAttachmentsByType,
    })
  }, [maxAttachmentsByType, maxAttachmentsFromModel])

  const handleVideoGenerationModeChange = useCallback(
    (modeId: string) => {
      const mode = videoGenerationModes.find(item => item.id === modeId)
      if (!mode) return
      const counts = chatState.attachmentState.attachments.reduce(
        (result, attachment) => {
          if (isImageExtension(attachment.file_extension)) result.image += 1
          if (isVideoExtension(attachment.file_extension)) result.video += 1
          if (isAudioExtension(attachment.file_extension)) result.audio += 1
          return result
        },
        { image: 0, video: 0, audio: 0 }
      )
      const limits = resolveReferenceMaterialLimits({
        capabilities: videoCapabilities,
        mode,
        legacyImageLimit: videoConfig?.max_reference_images,
        hasReferenceVideo: counts.video > 0,
      })
      const incompatible =
        (mode.video_allowed === false && counts.video > 0) ||
        (mode.audio_allowed === false && counts.audio > 0) ||
        exceedsReferenceMaterialLimits(counts, limits)
      if (incompatible) {
        toast({
          variant: 'destructive',
          title: t('generate.material_errors.mode_switch'),
        })
        return
      }
      setSelectedVideoGenerationMode(modeId)
    },
    [
      chatState.attachmentState.attachments,
      t,
      toast,
      videoCapabilities,
      videoConfig?.max_reference_images,
      videoGenerationModes,
    ]
  )

  const handleVideoModelChange = useCallback(
    (model: Model) => {
      const nextConfig = model.config?.videoConfig as
        | {
            max_reference_images?: number
            capabilities?: VideoCapabilities
          }
        | undefined
      const capabilities = nextConfig?.capabilities
      const mode = capabilities?.generation_modes?.[0]
      const counts = chatState.attachmentState.attachments.reduce(
        (result, attachment) => {
          if (isImageExtension(attachment.file_extension)) result.image += 1
          if (isVideoExtension(attachment.file_extension)) result.video += 1
          if (isAudioExtension(attachment.file_extension)) result.audio += 1
          return result
        },
        { image: 0, video: 0, audio: 0 }
      )
      const limits = resolveReferenceMaterialLimits({
        capabilities,
        mode,
        legacyImageLimit: nextConfig?.max_reference_images ?? 2,
        hasReferenceVideo: counts.video > 0,
      })
      const hasInvalidFile = chatState.attachmentState.attachments.some(attachment => {
        const extension = attachment.file_extension.replace(/^\./, '').toLowerCase()
        const isImage = isImageExtension(attachment.file_extension)
        const isVideo = isVideoExtension(attachment.file_extension)
        const isAudio = isAudioExtension(attachment.file_extension)
        const formats = isImage
          ? capabilities?.image_formats
          : isVideo
            ? capabilities?.video_formats
            : capabilities?.audio_formats
        if (formats?.length && !formats.map(value => value.toLowerCase()).includes(extension)) {
          return true
        }
        const maxSizeMb = isImage
          ? capabilities?.image_max_size_mb
          : isVideo
            ? capabilities?.video_max_size_mb
            : isAudio
              ? capabilities?.audio_max_size_mb
              : undefined
        return maxSizeMb != null && attachment.file_size > maxSizeMb * 1024 * 1024
      })
      const incompatible =
        hasInvalidFile ||
        (capabilities?.supports_image_input === false && counts.image > 0) ||
        ((!capabilities || capabilities.supports_video_input !== true) && counts.video > 0) ||
        ((!capabilities || capabilities.supports_audio_input !== true) && counts.audio > 0) ||
        (mode?.video_allowed === false && counts.video > 0) ||
        (mode?.audio_allowed === false && counts.audio > 0) ||
        exceedsReferenceMaterialLimits(counts, limits)
      if (incompatible) {
        toast({
          variant: 'destructive',
          title: t('generate.material_errors.model_switch'),
        })
        return
      }
      videoModelSelection.selectModelByKey(`${model.name}:${model.type || ''}`)
    },
    [chatState.attachmentState.attachments, t, toast, videoModelSelection.selectModelByKey]
  )

  const effectiveTaskType = useMemo<TaskType>(() => {
    if (
      taskType === 'chat' &&
      teamModeFilter === 'all' &&
      chatState.selectedTeam?.bind_mode?.includes('code') &&
      !chatState.selectedTeam.bind_mode.includes('chat')
    ) {
      return 'code'
    }

    return taskType
  }, [chatState.selectedTeam?.bind_mode, taskType, teamModeFilter])

  const effectiveShowRepositorySelector = showRepositorySelector && effectiveTaskType === 'code'

  // Compute initial selected skills from task detail (for page refresh recovery)
  const initialSelectedSkills = useMemo(() => {
    if (selectedTaskDetail?.requested_skills) {
      return selectedTaskDetail.requested_skills.map(skill => skill.name)
    }
    return []
  }, [selectedTaskDetail?.requested_skills])

  // Skill selector state - fetches available skills and manages selection
  const skillSelector = useSkillSelector({
    team: chatState.selectedTeam,
    enabled: true,
    initialSelectedSkills,
  })

  // Video mode specific state - resolution, aspect ratio, and duration
  // These are kept separate from useModelSelection as they are video-specific parameters
  const [selectedResolution, setSelectedResolution] = useState('1080p')
  const [selectedRatio, setSelectedRatio] = useState('16:9')
  const [selectedDuration, setSelectedDuration] = useState(5)

  // Derive available options and defaults from selected video model's config
  const availableResolutions = useMemo(() => {
    if (videoCapabilities?.resolutions?.length) {
      return videoCapabilities.resolutions.map(r => r.value ?? r.label)
    }
    return ['480p', '720p', '1080p']
  }, [videoCapabilities?.resolutions])

  const availableRatios = useMemo(() => {
    if (videoCapabilities?.aspect_ratios?.length) {
      return videoCapabilities.aspect_ratios.map(r => r.value)
    }
    return ['16:9', '9:16', '1:1', '4:3', '3:4']
  }, [videoCapabilities?.aspect_ratios])

  const availableDurations = useMemo(() => {
    if (videoCapabilities?.durations_sec?.length) {
      return videoCapabilities.durations_sec
    }
    return [5, 10]
  }, [videoCapabilities?.durations_sec])

  // When video model changes, apply model's recommended defaults
  const videoModelName = videoModelSelection.selectedModel?.name
  useEffect(() => {
    if (!videoConfig) return
    const configuredResolution = videoCapabilities?.resolutions?.find(
      option => option.value === videoConfig.resolution || option.label === videoConfig.resolution
    )
    if (configuredResolution) {
      setSelectedResolution(configuredResolution.value ?? configuredResolution.label)
    } else if (videoConfig.resolution && availableResolutions.includes(videoConfig.resolution)) {
      setSelectedResolution(videoConfig.resolution)
    } else if (availableResolutions.length) {
      setSelectedResolution(availableResolutions[0])
    }
    const configuredRatio = videoCapabilities?.aspect_ratios?.find(
      option => option.value === videoConfig.ratio || option.label === videoConfig.ratio
    )
    if (configuredRatio) {
      setSelectedRatio(configuredRatio.value)
    } else if (videoConfig.ratio && availableRatios.includes(videoConfig.ratio)) {
      setSelectedRatio(videoConfig.ratio)
    } else if (availableRatios.length) {
      setSelectedRatio(availableRatios[0])
    }
    if (videoConfig.duration && availableDurations.includes(videoConfig.duration)) {
      setSelectedDuration(videoConfig.duration)
    } else if (availableDurations.length) {
      setSelectedDuration(availableDurations[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoModelName])

  // Image mode specific state - image size
  const [selectedImageSize, setSelectedImageSize] = useState('2048x2048')

  // Compute subtask info for scroll management
  // Note: Now using taskState from state machine instead of selectedTaskDetail.subtasks
  // The state machine messages are the single source of truth
  const lastSubtaskId = useMemo(() => {
    if (!taskState?.messages || taskState.messages.size === 0) return null
    let maxSubtaskId: number | null = null
    for (const msg of taskState.messages.values()) {
      if (msg.subtaskId && (maxSubtaskId === null || msg.subtaskId > maxSubtaskId)) {
        maxSubtaskId = msg.subtaskId
      }
    }
    return maxSubtaskId
  }, [taskState?.messages])
  const lastSubtaskUpdatedAt = null // No longer needed from subtasks, scroll management uses other signals
  // Determine if there are messages to display (computed early for hooks)
  // Uses state machine messages as the single source of truth, not selectedTaskDetail.subtasks
  const hasMessagesForHooks = useMemo(() => {
    const hasSelectedTask = Boolean(effectiveTaskId)
    // Check messages from state machine (single source of truth)
    const hasContextMessages = taskState?.messages && taskState.messages.size > 0
    return Boolean(hasSelectedTask || hasContextMessages)
  }, [effectiveTaskId, taskState?.messages])

  // Get taskId from URL for team sync logic
  const searchParams = useSearchParams()
  const searchParamsString = stringifySearchParams(searchParams)
  const taskIdFromUrl = getFirstSearchParam(searchParams, ['taskId', 'task_id', 'taskid'])
  // Get teamId from URL for auto-selecting a specific team (e.g. after accepting a share invite)
  const teamIdFromUrl =
    getSearchParam(searchParams, 'teamId') ?? quickLaunchIntent?.teamId.toString() ?? null
  // Get project info when in project context
  const projectIdFromUrl = getSearchParam(searchParams, 'projectId')
  const { projects } = useProjectContext()
  const activeProject = useMemo(() => {
    if (!projectIdFromUrl) return null
    const project = projects.find(p => p.id === Number(projectIdFromUrl))
    if (!project) return null
    const explicitPath = project.config?.workspace?.localPath
    const defaultPath = `~/.wegent-executor/workspace/project${project.id}`
    return {
      name: project.name,
      path: explicitPath || defaultPath,
    }
  }, [projectIdFromUrl, projects])

  useEffect(() => {
    const intent = parseQuickLaunchIntent(new URLSearchParams(searchParamsString))
    if (!intent) {
      return
    }

    setQuickLaunchIntent(intent)
    const nextParams = removeQuickLaunchQueryParams(new URLSearchParams(searchParamsString))
    const nextSearch = nextParams.toString()
    router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname)
  }, [pathname, router, searchParamsString])

  // Track initialization and last synced task for team selection
  const hasInitializedTeamRef = useRef(false)
  const lastSyncedTaskIdRef = useRef<number | null>(null)
  const ignoredTeamIdParamRef = useRef<string | null>(null)
  const isExitingGenerationRef = useRef(false)

  // Filter teams by bind_mode based on current visible agent mode.
  const filteredTeams = useMemo(
    () => filterTeamsByMode(teams, teamModeFilter),
    [teams, teamModeFilter]
  )

  // Extract values for dependency array
  const selectedTeam = chatState.selectedTeam
  const handleTeamChange = chatState.handleTeamChange
  const findDefaultTeamForMode = chatState.findDefaultTeamForMode
  const showGenerateModeSelector =
    isGenerateMode(taskType) && teamSupportsBothGenerationModes(selectedTeam)

  const handleUserTeamChange = useCallback(
    (team: Team | null) => {
      handleTeamChange(team)
      const routeTaskId =
        typeof window === 'undefined'
          ? null
          : getTaskQueryParam(new URLSearchParams(window.location.search))
      if (effectiveTaskId || routeTaskId || !onGenerateModeChange || !isGenerateMode(taskType)) {
        return
      }
      const nextMode = getTeamGenerateMode(team, taskType)
      if (nextMode && nextMode !== taskType) {
        onGenerateModeChange(nextMode)
      }
    },
    [effectiveTaskId, handleTeamChange, onGenerateModeChange, taskType]
  )

  useEffect(() => {
    if (!isExitingGenerationRef.current || isGenerateMode(taskType)) return
    isExitingGenerationRef.current = false
    hasInitializedTeamRef.current = false
  }, [taskType])

  // Team selection logic - using default team from server configuration
  useEffect(() => {
    if (isExitingGenerationRef.current) return
    if (filteredTeams.length === 0) return
    if (!teamIdFromUrl) {
      ignoredTeamIdParamRef.current = null
    }

    // Extract team ID from task detail
    const detailTeamId = selectedTaskDetail?.team
      ? typeof selectedTaskDetail.team === 'number'
        ? selectedTaskDetail.team
        : (selectedTaskDetail.team as Team).id
      : null

    // Case 1: Sync from task detail (HIGHEST PRIORITY)
    // Only sync when URL taskId matches taskDetail.id to prevent race conditions
    if (taskIdFromUrl && selectedTaskDetail?.id && detailTeamId) {
      if (selectedTaskDetail.id.toString() === taskIdFromUrl) {
        // Only update if we haven't synced this task yet or team is different
        if (
          lastSyncedTaskIdRef.current !== selectedTaskDetail.id ||
          selectedTeam?.id !== detailTeamId
        ) {
          const teamFromDetail = filteredTeams.find(t => t.id === detailTeamId)
          if (teamFromDetail) {
            handleTeamChange(teamFromDetail)
            lastSyncedTaskIdRef.current = selectedTaskDetail.id
            hasInitializedTeamRef.current = true
            return
          } else {
            // Team not in filtered list, try to use the team object from detail
            const teamObject =
              typeof selectedTaskDetail.team === 'object' ? (selectedTaskDetail.team as Team) : null
            if (teamObject) {
              handleTeamChange(teamObject)
              lastSyncedTaskIdRef.current = selectedTaskDetail.id
              hasInitializedTeamRef.current = true
              return
            }
          }
        } else {
          // Already synced this task, skip
          return
        }
      } else {
        // URL and taskDetail don't match - wait for correct taskDetail to load
        return
      }
    }

    // Case 2a: teamId URL param present - select specific team regardless of initialization state
    // This handles navigation after accepting a share invite (/chat?teamId=xxx)
    if (!taskIdFromUrl && teamIdFromUrl && teamIdFromUrl !== ignoredTeamIdParamRef.current) {
      const targetTeamId = Number(teamIdFromUrl)
      const teamFromUrl =
        filteredTeams.find(t => t.id === targetTeamId) || teams.find(t => t.id === targetTeamId)
      if (teamFromUrl) {
        handleTeamChange(teamFromUrl)
        hasInitializedTeamRef.current = true
        lastSyncedTaskIdRef.current = null
        return
      }
    }

    // Case 2: New chat (no taskId in URL) - use default team from server config
    if (!taskIdFromUrl && !hasInitializedTeamRef.current) {
      // Use the default team computed from server config
      const defaultTeamForMode = findDefaultTeamForMode(filteredTeams)
      if (defaultTeamForMode) {
        handleTeamChange(defaultTeamForMode)
        hasInitializedTeamRef.current = true
        lastSyncedTaskIdRef.current = null
        return
      }
      // No default found, select first team
      if (!selectedTeam && filteredTeams.length > 0) {
        handleTeamChange(filteredTeams[0])
      }
      hasInitializedTeamRef.current = true
      lastSyncedTaskIdRef.current = null
      return
    }

    // Case 3: Validate current selection exists in filtered list
    if (selectedTeam) {
      const exists = filteredTeams.some(t => t.id === selectedTeam.id)
      if (!exists) {
        const defaultTeamForMode = findDefaultTeamForMode(filteredTeams)
        handleTeamChange(defaultTeamForMode || filteredTeams[0])
      }
    }
  }, [
    filteredTeams,
    teams,
    selectedTaskDetail,
    taskIdFromUrl,
    teamIdFromUrl,
    selectedTeam,
    handleTeamChange,
    findDefaultTeamForMode,
  ])

  // Reset initialization when switching from task to new chat
  useEffect(() => {
    if (!taskIdFromUrl) {
      lastSyncedTaskIdRef.current = null
    }
  }, [taskIdFromUrl])

  // Handle team selection from QuickAccessCards
  const handleTeamSelect = useCallback(
    (team: Team) => {
      if (effectiveTaskType === 'task' && shouldClearDeviceSelectionForQuickLauncher(team)) {
        setSelectedDeviceId(null)
      }
      handleUserTeamChange(team)
    },
    [effectiveTaskType, handleUserTeamChange, setSelectedDeviceId]
  )

  // Use scroll management hook - consolidates 4 useEffect calls
  const {
    scrollContainerRef,
    isUserNearBottomRef,
    showScrollIndicator,
    scrollToBottom,
    handleMessagesContentChange: _baseHandleMessagesContentChange,
  } = useScrollManagement({
    hasMessages: hasMessagesForHooks,
    isStreaming: false, // Will be updated after streamHandlers is created
    selectedTaskId: selectedTaskDetail?.id,
    lastSubtaskId,
    lastSubtaskUpdatedAt,
  })

  // Use floating input hook - consolidates 3 useEffect calls
  const {
    chatAreaRef,
    floatingInputRef,
    inputControlsRef,
    floatingMetrics,
    inputHeight,
    controlsContainerWidth,
  } = useFloatingInput({
    hasMessages: hasMessagesForHooks,
  })

  // For video/image mode, use respective model selection; otherwise use regular model selection
  // This ensures the correct model is passed to the backend for routing
  const effectiveSelectedModel = useMemo(() => {
    if (effectiveTaskType === 'video') return videoModelSelection.selectedModel
    if (effectiveTaskType === 'image') return imageModelSelection.selectedModel
    return chatState.selectedModel
  }, [
    effectiveTaskType,
    videoModelSelection.selectedModel,
    imageModelSelection.selectedModel,
    chatState.selectedModel,
  ])

  // Build generate params for video/image generation tasks
  // Include model name for display in user message bubble
  const generateParams = useMemo(() => {
    if (effectiveTaskType === 'video') {
      return {
        resolution: selectedResolution,
        ratio: selectedRatio,
        duration: selectedDuration,
        model: videoModelSelection.selectedModel?.name,
        generation_mode_id: selectedVideoGenerationMode,
      }
    }
    if (effectiveTaskType === 'image') {
      return {
        size: selectedImageSize,
        model: imageModelSelection.selectedModel?.name,
      }
    }
    return undefined
  }, [
    effectiveTaskType,
    selectedResolution,
    selectedRatio,
    selectedDuration,
    selectedVideoGenerationMode,
    selectedImageSize,
    videoModelSelection.selectedModel?.name,
    imageModelSelection.selectedModel?.name,
  ])

  // Stream handlers (send message, retry, cancel, stop)
  const streamHandlers = useChatStreamHandlers({
    selectedTeam: chatState.selectedTeam,
    selectedModel: effectiveSelectedModel,
    forceOverride: chatState.forceOverride,
    setSelectedModel: chatState.setSelectedModel,
    setForceOverride: chatState.setForceOverride,
    selectedRepo: chatState.selectedRepo,
    selectedBranch: chatState.selectedBranch,
    showRepositorySelector: effectiveShowRepositorySelector,
    effectiveRequiresWorkspace: chatState.effectiveRequiresWorkspace,
    taskInputMessage: chatState.taskInputMessage,
    setTaskInputMessage: chatState.setTaskInputMessage,
    enableDeepThinking: chatState.enableDeepThinking,
    enableClarification: chatState.enableClarification,
    externalApiParams: chatState.externalApiParams,
    attachments: chatState.attachmentState.attachments,
    resetAttachment: chatState.resetAttachment,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    taskType: effectiveTaskType,
    knowledgeBaseId,
    shouldHideChatInput: chatState.shouldHideChatInput,
    scrollToBottom,
    selectedContexts: chatState.selectedContexts,
    resetContexts: chatState.resetContexts,
    onTaskCreated,
    selectedDocumentIds,
    // Skill selection - pass user-selected skills to backend
    // Uses full skill info (name, namespace, is_public) for backend to determine preload vs download
    additionalSkills: skillSelector.selectedSkills,
    // Generation parameters for video/image generation tasks
    generateParams,
  })

  // Scheme URL action bridge - handles wegent://action/send-message and wegent://action/prefill-message
  useSchemeMessageActions({
    onSendMessage: streamHandlers.handleSendMessage,
    onPrefillMessage: chatState.setTaskInputMessage,
    onTeamChange: teamId => {
      const targetTeam =
        filteredTeams.find(t => t.id === teamId) || teams.find(t => t.id === teamId)
      if (targetTeam) {
        handleTeamChange(targetTeam)
      }
    },
    currentTeamId: chatState.selectedTeam?.id,
    teams: [...filteredTeams, ...teams],
  })

  // Determine if there are messages to display (full computation)
  // Note: Now using taskState.messages from state machine instead of selectedTaskDetail.subtasks
  const hasMessages = useMemo(() => {
    const hasSelectedTask = Boolean(effectiveTaskId)
    const hasNewTaskStream =
      !effectiveTaskId && streamHandlers.pendingTaskId && streamHandlers.isStreaming
    // Use taskState from state machine (single source of truth)
    const hasUnifiedMessages = taskState?.messages && taskState.messages.size > 0

    // If we have a selected task with messages in state machine, show messages
    if (hasSelectedTask && hasUnifiedMessages) {
      return true
    }

    // Fallback: consider task selected (hasSelectedTask) as having messages to avoid
    // brief hasMessages=false gap between task creation and state machine message population,
    // which would cause empty-state content (e.g. SummaryCard) to flash.
    return Boolean(
      hasSelectedTask ||
      streamHandlers.hasPendingUserMessage ||
      streamHandlers.isStreaming ||
      hasNewTaskStream ||
      hasUnifiedMessages
    )
  }, [
    effectiveTaskId,
    streamHandlers.hasPendingUserMessage,
    streamHandlers.isStreaming,
    streamHandlers.pendingTaskId,
    taskState?.messages,
  ])

  const pipelineNextStepMessages = useMemo<PipelineNextStepMessage[]>(() => {
    if (!taskState?.messages) return []

    const messages: UnifiedMessage[] = Array.from(taskState.messages.values())
    return messages.map(message => ({
      id: message.id,
      type: message.type,
      status: message.status,
      content: message.content,
      timestamp: message.timestamp,
      messageId: message.messageId,
      contexts: getPipelineNextStepContexts(message.contexts),
    }))
  }, [taskState?.messages])

  const pipelineContextPassing = useMemo(
    () =>
      getPipelineContextPassingForStage(
        chatState.selectedTeam ?? selectedTaskDetail?.team,
        pipelineStageInfo
      ),
    [chatState.selectedTeam, pipelineStageInfo, selectedTaskDetail?.team]
  )

  const pipelineNextStepDraft = useMemo(
    () => buildPipelineNextStepDraft(pipelineNextStepMessages, pipelineContextPassing),
    [pipelineContextPassing, pipelineNextStepMessages]
  )

  useEffect(() => {
    if (!pipelineStageInfo?.is_pending_confirmation) {
      setIsPipelineNextStepOpen(false)
    }
  }, [pipelineStageInfo?.is_pending_confirmation])

  // Note: Team selection is now handled by useTeamSelection hook in TeamSelector component
  // Model selection is handled by useModelSelection hook in ModelSelector component

  // Check if model selection is required
  const isModelSelectionRequired = useMemo(() => {
    // OpenClaw devices handle model on device side, no model selection required
    if (hideSelectors) return false
    // Video mode uses video model selection, not regular model selection
    if (effectiveTaskType === 'video') {
      // In video mode, we need a video model selected
      return !videoModelSelection.selectedModel
    }
    // Image mode uses image model selection
    if (effectiveTaskType === 'image') {
      // In image mode, we need an image model selected
      return !imageModelSelection.selectedModel
    }
    if (!chatState.selectedTeam || chatState.selectedTeam.agent_type === 'dify') return false
    const hasDefaultOption = allBotsHavePredefinedModel(chatState.selectedTeam)
    if (hasDefaultOption) return false
    return !chatState.selectedModel
  }, [
    chatState.selectedTeam,
    chatState.selectedModel,
    effectiveTaskType,
    hideSelectors,
    videoModelSelection.selectedModel,
    imageModelSelection.selectedModel,
  ])

  const generationAttachmentCounts = useMemo(() => {
    const material = chatState.attachmentState.attachments.filter(
      attachment =>
        isImageExtension(attachment.file_extension) ||
        isVideoExtension(attachment.file_extension) ||
        isAudioExtension(attachment.file_extension)
    ).length
    const image = chatState.attachmentState.attachments.filter(attachment =>
      isImageExtension(attachment.file_extension)
    ).length
    return { image, material }
  }, [chatState.attachmentState.attachments])

  const submitBlockedReason = useMemo(() => {
    if (disabledReason) return disabledReason
    if (isModelSelectionRequired) {
      return t('generate.material_errors.model_required')
    }
    if (!chatState.isAttachmentReadyToSend) {
      return t('generate.material_errors.attachment_uploading')
    }
    if (effectiveTaskType !== 'video') return null

    if (
      (activeVideoGenerationMode?.id === 'first_last_frame' ||
        activeVideoGenerationMode?.first_frame_required) &&
      generationAttachmentCounts.image === 0
    ) {
      return t('generate.material_errors.first_frame_required')
    }
    if (
      (activeVideoGenerationMode?.image_required || videoCapabilities?.image_input_required) &&
      generationAttachmentCounts.image === 0
    ) {
      return t('generate.material_errors.reference_image_required')
    }
    if (
      videoCapabilities?.reference_material_required &&
      generationAttachmentCounts.material === 0
    ) {
      return t('generate.material_errors.reference_material_required')
    }
    return null
  }, [
    activeVideoGenerationMode?.first_frame_required,
    activeVideoGenerationMode?.id,
    activeVideoGenerationMode?.image_required,
    chatState.isAttachmentReadyToSend,
    disabledReason,
    effectiveTaskType,
    generationAttachmentCounts.image,
    generationAttachmentCounts.material,
    isModelSelectionRequired,
    t,
    videoCapabilities?.image_input_required,
    videoCapabilities?.reference_material_required,
  ])

  // Unified canSubmit flag
  const canSubmit = useMemo(() => {
    return (
      !submitBlockedReason &&
      (!streamHandlers.isStreaming || streamHandlers.canQueueMessage) &&
      chatState.isAttachmentReadyToSend
    )
  }, [
    chatState.isAttachmentReadyToSend,
    streamHandlers.isStreaming,
    streamHandlers.canQueueMessage,
    submitBlockedReason,
  ])

  // Collapse selectors when space is limited
  const shouldCollapseSelectors =
    controlsContainerWidth > 0 && controlsContainerWidth < COLLAPSE_SELECTORS_THRESHOLD

  // Keep latest mutable values in refs so callbacks passed to MessagesArea remain stable.
  const taskInputMessageRef = useRef(chatState.taskInputMessage)
  taskInputMessageRef.current = chatState.taskInputMessage

  const stateMessagesRef = useRef(taskState?.messages)
  stateMessagesRef.current = taskState?.messages

  const handleSendMessageRef = useRef(streamHandlers.handleSendMessage)
  handleSendMessageRef.current = streamHandlers.handleSendMessage

  const handleSendMessageWithModelRef = useRef(streamHandlers.handleSendMessageWithModel)
  handleSendMessageWithModelRef.current = streamHandlers.handleSendMessageWithModel

  const handleRetryRef = useRef(streamHandlers.handleRetry)
  handleRetryRef.current = streamHandlers.handleRetry

  const handleRetryWithModelRef = useRef(streamHandlers.handleRetryWithModel)
  handleRetryWithModelRef.current = streamHandlers.handleRetryWithModel

  const setTaskInputMessage = chatState.setTaskInputMessage
  const setSelectedContexts = chatState.setSelectedContexts
  const resetAttachment = chatState.resetAttachment
  const resetContexts = chatState.resetContexts
  const restoreDefaultTeam = chatState.restoreDefaultTeam
  const resetSelectedSkills = skillSelector.resetSkills
  const addExistingAttachment = chatState.addExistingAttachment
  const handleFileSelect = chatState.handleFileSelect
  const handleAttachmentRemove = chatState.handleAttachmentRemove
  const quickPresetAttachmentIdsRef = useRef<Set<number>>(new Set())
  const selectedContextsRef = useRef(chatState.selectedContexts)
  selectedContextsRef.current = chatState.selectedContexts

  const handleRestoreDefaultTeam = useCallback(() => {
    const url = new URL(window.location.href)
    ignoredTeamIdParamRef.current = teamIdFromUrl
    setQuickLaunchIntent(null)
    const removedTeam = removeTeamQueryParam(url.searchParams)

    if (isGenerateMode(effectiveTaskType)) {
      isExitingGenerationRef.current = true
      removeGenerationModeQueryParam(url.searchParams)
      chatState.handleTeamChange(null)
      router.replace(`${url.pathname}${url.search}${url.hash}`)
      return
    }

    if (removedTeam) {
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`
      )
    }
    restoreDefaultTeam()
  }, [chatState.handleTeamChange, effectiveTaskType, restoreDefaultTeam, router, teamIdFromUrl])

  const shouldConfirmPendingReplacement =
    runtimeTaskStatus === 'PENDING' &&
    !streamHandlers.canQueueMessage &&
    !selectedTaskDetail?.is_group_chat

  const applyQuickPhraseToInput = useCallback(
    (phrase: string) => {
      setTaskInputMessage(phrase)
      setFocusInputAtEndSignal(signal => signal + 1)
    },
    [setTaskInputMessage]
  )

  const handleQuickPhraseSelect = useCallback(
    (phrase: string) => {
      if (chatState.taskInputMessage.trim()) {
        setPendingQuickPhrase(phrase)
        setIsQuickPhraseOverwriteOpen(true)
        return
      }

      applyQuickPhraseToInput(phrase)
    },
    [applyQuickPhraseToInput, chatState.taskInputMessage]
  )

  const clearQuickPresetAttachments = useCallback(async () => {
    const attachmentIds = Array.from(quickPresetAttachmentIdsRef.current)
    if (attachmentIds.length === 0) {
      return
    }

    quickPresetAttachmentIdsRef.current = new Set()
    await Promise.all(attachmentIds.map(attachmentId => handleAttachmentRemove(attachmentId)))
  }, [handleAttachmentRemove])

  const handleUserFileSelect = useCallback(
    async (files: File | File[]) => {
      await clearQuickPresetAttachments()
      await handleFileSelect(files)
    },
    [clearQuickPresetAttachments, handleFileSelect]
  )

  const handleInputAttachmentRemove = useCallback(
    async (attachmentId: number) => {
      await handleAttachmentRemove(attachmentId)
      if (quickPresetAttachmentIdsRef.current.has(attachmentId)) {
        const nextIds = new Set(quickPresetAttachmentIdsRef.current)
        nextIds.delete(attachmentId)
        quickPresetAttachmentIdsRef.current = nextIds
      }
    },
    [handleAttachmentRemove]
  )

  const handleQuickPresetSelect = useCallback(
    async (selection: QuickPresetSelection) => {
      const { preset } = selection
      const options = preset.options
      if (options?.enable_deep_thinking !== undefined && options.enable_deep_thinking !== null) {
        chatState.setEnableDeepThinking(options.enable_deep_thinking)
      }
      if (options?.enable_clarification !== undefined && options.enable_clarification !== null) {
        chatState.setEnableClarification(options.enable_clarification)
      }
      if (options?.force_override !== undefined && options.force_override !== null) {
        chatState.setForceOverride(options.force_override)
      }
      if (options?.selected_skill_names && options.selected_skill_names.length > 0) {
        skillSelector.setSelectedSkillNames(options.selected_skill_names)
      }

      const prompt = preset.prompt?.trim() || preset.title.trim()
      if (prompt) {
        handleQuickPhraseSelect(prompt)
      }

      const sourceAttachmentIds = preset.source_attachment_ids ?? []
      if (sourceAttachmentIds.length === 0) {
        await clearQuickPresetAttachments()
        return
      }

      const hasUserAttachment = chatState.attachmentState.attachments.some(
        attachment => !quickPresetAttachmentIdsRef.current.has(attachment.id)
      )
      if (hasUserAttachment) {
        await clearQuickPresetAttachments()
        return
      }

      const functionId = getSystemQuickLaunchFunctionId(selection)
      if (!functionId) {
        return
      }

      await clearQuickPresetAttachments()
      try {
        const response = await userApis.prepareQuickLaunchPreset({
          function_id: functionId,
          preset_id: preset.id,
        })
        response.attachments.forEach(attachment => {
          addExistingAttachment(attachment)
        })
        quickPresetAttachmentIdsRef.current = new Set(
          response.attachments.map(attachment => attachment.id)
        )
      } catch (error) {
        console.error('Failed to prepare quick launch preset attachments:', error)
      }
    },
    [
      addExistingAttachment,
      chatState,
      clearQuickPresetAttachments,
      handleQuickPhraseSelect,
      skillSelector,
    ]
  )

  const handleConfirmQuickPhraseOverwrite = useCallback(() => {
    if (!pendingQuickPhrase) return

    applyQuickPhraseToInput(pendingQuickPhrase)
    setPendingQuickPhrase(null)
    setIsQuickPhraseOverwriteOpen(false)
  }, [applyQuickPhraseToInput, pendingQuickPhrase])

  const sendOrConfirmPendingReplacement = useCallback(
    async (message: string, options?: SendMessageOptions) => {
      if (submitBlockedReason) {
        toast({
          variant: 'destructive',
          title: submitBlockedReason,
        })
        return
      }
      const trimmedMessage = message.trim()
      const hasAttachments = chatState.attachmentState.attachments.length > 0
      if (!trimmedMessage && !hasAttachments && !chatState.shouldHideChatInput) return

      if (pendingInteractiveForm && !options?.interactiveFormAnswer) {
        setPendingFormReplacementMessage(trimmedMessage)
        setPendingFormReplacementOptions(options ?? null)
        setIsPendingFormReplacementOpen(true)
        return
      }

      if (shouldConfirmPendingReplacement) {
        setPendingReplacementMessage(trimmedMessage)
        setPendingReplacementOptions(options ?? null)
        setIsPendingReplacementOpen(true)
        return
      }

      await streamHandlers.handleSendMessage(trimmedMessage, options)
    },
    [
      chatState.attachmentState.attachments.length,
      chatState.shouldHideChatInput,
      pendingInteractiveForm,
      shouldConfirmPendingReplacement,
      streamHandlers,
      submitBlockedReason,
      toast,
    ]
  )

  const consumedExternalPromptRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      !externalPromptRequest ||
      consumedExternalPromptRef.current === externalPromptRequest.requestId
    ) {
      return
    }
    consumedExternalPromptRef.current = externalPromptRequest.requestId
    onExternalPromptConsumed?.(externalPromptRequest.requestId)
    void sendOrConfirmPendingReplacement(externalPromptRequest.message, {
      artifactContext: externalPromptRequest.artifactContext,
    })
  }, [externalPromptRequest, onExternalPromptConsumed, sendOrConfirmPendingReplacement])

  const consumedExternalDraftRef = useRef<string | null>(null)
  const applyExternalDraft = useCallback(
    (request: KnowledgeCapabilityDraftRequest) => {
      const url = new URL(window.location.href)
      if (removeTaskQueryParams(url.searchParams)) {
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`
        )
      }
      selectTask(null)
      hasInitializedTeamRef.current = false
      lastSyncedTaskIdRef.current = null

      quickPresetAttachmentIdsRef.current = new Set()
      resetAttachment()
      resetContexts()
      resetSelectedSkills()
      restoreDefaultTeam()
      applyQuickPhraseToInput(request.message)
    },
    [
      applyQuickPhraseToInput,
      resetAttachment,
      resetContexts,
      resetSelectedSkills,
      restoreDefaultTeam,
      selectTask,
    ]
  )

  useEffect(() => {
    if (
      !externalDraftRequest ||
      consumedExternalDraftRef.current === externalDraftRequest.requestId
    ) {
      return
    }
    consumedExternalDraftRef.current = externalDraftRequest.requestId
    onExternalDraftConsumed?.(externalDraftRequest.requestId)

    const hasDirtyDraft =
      chatState.taskInputMessage.trim().length > 0 ||
      chatState.attachmentState.attachments.length > 0 ||
      chatState.selectedContexts.length > 0 ||
      skillSelector.selectedSkills.length > 0

    if (hasDirtyDraft) {
      setPendingExternalDraft(externalDraftRequest)
      return
    }

    void applyExternalDraft(externalDraftRequest)
  }, [
    applyExternalDraft,
    chatState.attachmentState.attachments.length,
    chatState.selectedContexts.length,
    chatState.taskInputMessage,
    externalDraftRequest,
    onExternalDraftConsumed,
    skillSelector.selectedSkills.length,
  ])

  const handleConfirmExternalDraft = useCallback(() => {
    if (!pendingExternalDraft) return

    const request = pendingExternalDraft
    setPendingExternalDraft(null)
    void applyExternalDraft(request)
  }, [applyExternalDraft, pendingExternalDraft])

  const handleConfirmPendingFormReplacement = useCallback(async () => {
    if (
      !pendingFormReplacementMessage ||
      !pendingInteractiveForm ||
      isPendingFormReplacementConfirming
    ) {
      return
    }

    setIsPendingFormReplacementConfirming(true)
    try {
      const cancellation = buildInteractiveFormCancellation(
        pendingInteractiveForm,
        pendingFormReplacementMessage
      )
      const options = pendingFormReplacementOptions
      setPendingFormReplacementMessage(null)
      setPendingFormReplacementOptions(null)
      setIsPendingFormReplacementOpen(false)
      await streamHandlers.handleSendMessage(cancellation.message, {
        ...options,
        interactiveFormAnswer: cancellation.answer,
      })
    } finally {
      setIsPendingFormReplacementConfirming(false)
    }
  }, [
    isPendingFormReplacementConfirming,
    pendingFormReplacementMessage,
    pendingFormReplacementOptions,
    pendingInteractiveForm,
    streamHandlers,
  ])

  const handleConfirmPendingReplacement = useCallback(async () => {
    if (pendingReplacementMessage === null || isPendingReplacementConfirming) return

    setIsPendingReplacementConfirming(true)
    try {
      const cancelled = await streamHandlers.handleCancelTask()
      if (!cancelled) return

      const message = pendingReplacementMessage
      const options = pendingReplacementOptions ?? undefined
      setPendingReplacementMessage(null)
      setPendingReplacementOptions(null)
      setIsPendingReplacementOpen(false)
      await streamHandlers.handleSendMessage(message, options)
    } finally {
      setIsPendingReplacementConfirming(false)
    }
  }, [
    pendingReplacementMessage,
    pendingReplacementOptions,
    isPendingReplacementConfirming,
    streamHandlers,
  ])

  // Handle queue message loaded from inbox - adds the message(s) as context(s)
  // Supports both single message and batch processing
  const handleQueueMessageLoaded = useCallback(
    (queueMessageContexts: QueueMessageContext[]) => {
      // Add the queue message contexts to selectedContexts
      const currentContexts = selectedContextsRef.current
      // Filter out duplicates
      const newContexts = queueMessageContexts.filter(
        ctx => !currentContexts.some(c => c.type === 'queue_message' && c.id === ctx.id)
      )
      if (newContexts.length > 0) {
        setSelectedContexts([...currentContexts, ...newContexts])
      }
    },
    [setSelectedContexts]
  )

  // Load prompt from sessionStorage - single remaining useEffect
  useEffect(() => {
    if (hasMessages) return

    const pendingPromptData = sessionStorage.getItem('pendingTaskPrompt')
    if (pendingPromptData) {
      try {
        const data = JSON.parse(pendingPromptData)
        const isRecent = Date.now() - data.timestamp < 5 * 60 * 1000

        if (isRecent && data.prompt) {
          setTaskInputMessage(data.prompt)
          sessionStorage.removeItem('pendingTaskPrompt')
        }
      } catch (error) {
        console.error('Failed to parse pending prompt data:', error)
        sessionStorage.removeItem('pendingTaskPrompt')
      }
    }
  }, [hasMessages, setTaskInputMessage])

  // Use attachment upload hook - centralizes all attachment upload logic
  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handlePasteFile } =
    useAttachmentUpload({
      team: chatState.selectedTeam,
      isSendPending: streamHandlers.hasPendingUserMessage,
      isStreaming: streamHandlers.isStreaming,
      attachmentState: chatState.attachmentState,
      onFileSelect: handleUserFileSelect,
      setIsDragging: chatState.setIsDragging,
    })

  // Callback for MessagesArea content changes - enhanced with streaming check
  const handleMessagesContentChange = useCallback(() => {
    if (streamHandlers.isStreaming || isUserNearBottomRef.current) {
      scrollToBottom()
    }
  }, [streamHandlers.isStreaming, scrollToBottom, isUserNearBottomRef])

  // Callback for child components to send messages
  const handleSendMessageFromChild = useCallback(
    async (content: string, options?: SendMessageOptions) => {
      const existingInput = taskInputMessageRef.current.trim()
      const combinedMessage = existingInput ? `${content}\n\n---\n\n${existingInput}` : content
      setTaskInputMessage('')
      await sendOrConfirmPendingReplacement(
        combinedMessage,
        options?.interactiveFormAnswer
          ? {
              interactiveFormAnswer: {
                ...options.interactiveFormAnswer,
                message: combinedMessage,
              },
            }
          : options
      )
    },
    [sendOrConfirmPendingReplacement, setTaskInputMessage]
  )

  // Callback for child components to send messages with a specific model (for regeneration)
  // Accepts optional existingContexts to preserve attachments/knowledge bases from the original message
  const handleSendMessageWithModelFromChild = useCallback(
    async (content: string, model: Model, existingContexts?: SubtaskContextBrief[]) => {
      await handleSendMessageWithModelRef.current(content, model, existingContexts)
    },
    []
  )

  // Keep retry callback stable so MessagesArea can skip re-render on input typing.
  const handleRetryFromMessagesArea = useCallback(
    (message: import('../message/MessageBubble').Message) => {
      void handleRetryRef.current(message)
    },
    []
  )

  const handleRetryWithModelFromMessagesArea = useCallback(
    (
      message: import('../message/MessageBubble').Message,
      model: import('@/apis/models').UnifiedModel
    ) => {
      void handleRetryWithModelRef.current(message, model)
    },
    []
  )

  // Callback for re-selecting a context from a message badge
  const handleContextReselect = useCallback(
    (context: SubtaskContextBrief) => {
      // Convert SubtaskContextBrief to ContextItem format
      let contextItem: ContextItem | null = null

      if (context.context_type === 'knowledge_base') {
        if (!context.knowledge_id) return
        contextItem = {
          id: context.knowledge_id,
          name: context.name,
          type: 'knowledge_base',
          document_count: context.document_count ?? undefined,
          document_ids: context.document_ids ?? undefined,
          folder_ids: context.folder_ids ?? undefined,
          folder_names: context.folder_names ?? undefined,
          include_subfolders: context.include_subfolders ?? undefined,
          scope_restricted: context.scope_restricted ?? undefined,
        }
      } else if (context.context_type === 'table') {
        if (!context.document_id) return
        contextItem = {
          id: `table-${context.document_id}`,
          name: context.name,
          type: 'table',
          document_id: context.document_id,
          source_config: context.source_config ?? undefined,
        }
      } else if (context.context_type === 'external_knowledge') {
        const ref = buildExternalRefFromContext(context)
        if (!ref) return
        contextItem = {
          id: buildExternalContextId(ref),
          name: context.name,
          type: 'external_knowledge',
          ref,
        }
      }

      if (!contextItem) return

      const currentContexts = selectedContextsRef.current
      const isAlreadySelected = currentContexts.some(
        c => c.type === contextItem!.type && c.id === contextItem!.id
      )
      if (isAlreadySelected) return

      setSelectedContexts([...currentContexts, contextItem])
    },
    [setSelectedContexts]
  )

  const handlePipelineNextStepClick = useCallback(() => {
    setIsPipelineNextStepOpen(true)
  }, [])

  const handlePipelineNextStepConfirm = useCallback(
    async (payload: PipelineNextStepPayload) => {
      const taskId = selectedTaskDetail?.id
      const teamId = chatState.selectedTeam?.id ?? selectedTaskDetail?.team?.id

      if (!taskId || !teamId) {
        toast({
          variant: 'destructive',
          title: t('pipeline.next_step_dialog.missing_task'),
        })
        return
      }

      if (!chatStreamContext) {
        toast({
          variant: 'destructive',
          title: t('pipeline.confirm_failed'),
        })
        return
      }

      setIsPipelineNextStepConfirming(true)
      try {
        await chatStreamContext.sendMessage(
          {
            task_id: taskId,
            team_id: teamId,
            message: payload.message,
            action: 'pipeline:confirm',
            attachment_ids: payload.attachmentIds.length > 0 ? payload.attachmentIds : undefined,
            contexts: payload.contexts.length > 0 ? payload.contexts : undefined,
          },
          {
            pendingUserMessage: payload.message,
            pendingContexts: payload.pendingContexts,
            immediateTaskId: taskId,
            onError: error => {
              throw error
            },
          }
        )

        setIsPipelineNextStepOpen(false)
        toast({
          title: t('pipeline.stage_confirmed'),
        })
      } catch (error) {
        console.error('Failed to confirm pipeline next step:', error)
        toast({
          variant: 'destructive',
          title: t('pipeline.confirm_failed'),
        })
      } finally {
        setIsPipelineNextStepConfirming(false)
      }
    },
    [
      chatState.selectedTeam?.id,
      chatStreamContext,
      selectedTaskDetail?.id,
      selectedTaskDetail?.team?.id,
      t,
      toast,
    ]
  )

  // Callback when user wants to use a previously generated image as reference
  // Fetches the attachment metadata and adds it to the current input attachments
  const handleUseAsReference = useCallback(
    async (item: import('../message/ImageGallery').ImageItem) => {
      if (!item.attachmentId) return
      try {
        const detail = await getAttachment(item.attachmentId)
        addExistingAttachment({
          id: detail.id,
          filename: detail.filename,
          file_size: detail.file_size,
          mime_type: detail.mime_type,
          status: detail.status,
          text_length: detail.text_length ?? null,
          error_message: detail.error_message ?? null,
          error_code: detail.error_code ?? null,
          subtask_id: detail.subtask_id ?? null,
          file_extension: detail.file_extension,
          created_at: detail.created_at,
        })
      } catch (error) {
        // Log error; system will fall back to auto intent analysis
        console.error('Failed to use image as reference:', error)
      }
    },
    [addExistingAttachment]
  )

  // Callback when user clicks re-edit on an AI message
  // Finds the corresponding user message from the state machine messages and restores its prompt + attachments to the input
  const handleReEdit = useCallback(
    async (aiMsg: import('../message/MessageBubble').Message) => {
      if (!aiMsg.subtaskId) return

      // Locate the AI message in the state machine to get its messageId (shared with the user message)
      const stateMessages = stateMessagesRef.current
      if (!stateMessages) return

      const aiStateMsg = stateMessages.get(`ai-${aiMsg.subtaskId}`)
      if (!aiStateMsg) return

      // Find the corresponding user message using the following strategy:
      // 1. Primary: match by shared messageId (works for messages loaded from backend)
      // 2. Fallback: use Map insertion order - find the last user message that appears
      //    before the AI message in the Map (works for live-session messages that have no messageId yet)
      let userStateMsg: import('@wegent/chat-core').UnifiedMessage | undefined

      if (aiStateMsg.messageId != null) {
        // Primary lookup: match by shared messageId
        for (const msg of stateMessages.values()) {
          if (msg.type === 'user' && msg.messageId === aiStateMsg.messageId) {
            userStateMsg = msg
            break
          }
        }
      }

      if (!userStateMsg) {
        // Fallback: iterate the Map in insertion order; track the last user message seen
        // before we reach the target AI message entry
        let lastUserMsg: import('@wegent/chat-core').UnifiedMessage | undefined
        for (const [key, msg] of stateMessages.entries()) {
          if (key === `ai-${aiMsg.subtaskId}`) {
            // Reached the AI message - the previous user message is the one we want
            if (lastUserMsg) {
              userStateMsg = lastUserMsg
            }
            break
          }
          if (msg.type === 'user') {
            lastUserMsg = msg
          }
        }
      }

      if (!userStateMsg) return

      // Restore text prompt to input
      if (userStateMsg.content) {
        setTaskInputMessage(userStateMsg.content)
      }

      // Clear any existing draft attachments and contexts before restoring the original ones
      // so the restored set exactly matches the original user message
      resetAttachment()
      setSelectedContexts([])

      // Restore all contexts (attachments and knowledge bases) from the user message
      const rawContexts = (userStateMsg.contexts || []) as SubtaskContextBrief[]

      // Restore attachment contexts
      const attachmentContexts = rawContexts.filter(c => c.context_type === 'attachment')
      for (const ctx of attachmentContexts) {
        try {
          const detail = await getAttachment(ctx.id)
          addExistingAttachment({
            id: detail.id,
            filename: detail.filename,
            file_size: detail.file_size,
            mime_type: detail.mime_type,
            status: detail.status,
            text_length: detail.text_length ?? null,
            error_message: detail.error_message ?? null,
            error_code: detail.error_code ?? null,
            subtask_id: detail.subtask_id ?? null,
            file_extension: detail.file_extension,
            created_at: detail.created_at,
          })
        } catch (error) {
          console.error('Failed to restore attachment for re-edit:', error)
        }
      }

      // Restore knowledge base and table contexts
      const restoredContextItems: ContextItem[] = []
      for (const ctx of rawContexts) {
        if (ctx.context_type === 'knowledge_base') {
          if (!ctx.knowledge_id) continue
          restoredContextItems.push({
            id: ctx.knowledge_id,
            name: ctx.name,
            type: 'knowledge_base',
            document_count: ctx.document_count ?? undefined,
            document_ids: ctx.document_ids ?? undefined,
            folder_ids: ctx.folder_ids ?? undefined,
            folder_names: ctx.folder_names ?? undefined,
            include_subfolders: ctx.include_subfolders ?? undefined,
            scope_restricted: ctx.scope_restricted ?? undefined,
          })
        } else if (ctx.context_type === 'table') {
          if (!ctx.document_id) continue
          restoredContextItems.push({
            id: `table-${ctx.document_id}`,
            name: ctx.name,
            type: 'table',
            document_id: ctx.document_id,
            source_config: ctx.source_config ?? undefined,
          })
        } else if (ctx.context_type === 'external_knowledge') {
          const ref = buildExternalRefFromContext(ctx)
          if (!ref) continue
          restoredContextItems.push({
            id: buildExternalContextId(ref),
            name: ctx.name,
            type: 'external_knowledge',
            ref,
          })
        }
      }
      if (restoredContextItems.length > 0) {
        setSelectedContexts(restoredContextItems)
      }
    },
    [setTaskInputMessage, resetAttachment, setSelectedContexts, addExistingAttachment]
  )

  // Handle access denied state
  if (accessDenied) {
    const handleGoHome = () => {
      selectTask(null)
      router.push('/chat')
    }

    return (
      <div
        ref={chatAreaRef}
        className="flex-1 flex flex-col min-h-0 w-full relative"
        style={{ height: '100%', boxSizing: 'border-box' }}
      >
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-lg w-full">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
                <ShieldX className="h-10 w-10 text-destructive" />
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-center mb-3 text-text-primary">
              {t('tasks:access_denied_title')}
            </h1>
            <p className="text-center text-text-muted mb-8 leading-relaxed">
              {t('tasks:access_denied_description')}
            </p>
            <div className="flex justify-center">
              <Button
                onClick={handleGoHome}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('tasks:access_denied_go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Common input card props
  const inputCardProps = {
    taskInputMessage: chatState.taskInputMessage,
    setTaskInputMessage: chatState.setTaskInputMessage,
    focusInputAtEndSignal,
    selectedTeam: chatState.selectedTeam,
    teams: teams,
    externalApiParams: chatState.externalApiParams,
    onTeamChange: handleUserTeamChange,
    onTeamsRefresh: async () => {
      if (onRefreshTeams) {
        await onRefreshTeams()
      }
    },
    onExternalApiParamsChange: chatState.handleExternalApiParamsChange,
    onAppModeChange: chatState.handleAppModeChange,
    onRestoreDefaultTeam:
      isGenerateMode(effectiveTaskType) || chatState.defaultTeam
        ? handleRestoreDefaultTeam
        : undefined,
    isUsingDefaultTeam: chatState.isUsingDefaultTeam,
    taskType: effectiveTaskType,
    teamModeFilter,
    tipText: chatState.randomTip,
    isGroupChat: selectedTaskDetail?.is_group_chat || false,
    isDragging: chatState.isDragging,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    canSubmit,
    submitBlockedReason,
    canQueueMessage: streamHandlers.canQueueMessage,
    canCancelTask: streamHandlers.canCancelTask,
    queuedMessages: streamHandlers.queuedMessages,
    onCancelQueuedMessage: streamHandlers.cancelQueuedMessage,
    onEditQueuedMessage: streamHandlers.editQueuedMessage,
    onSendQueuedAsGuidance: streamHandlers.sendQueuedAsGuidance,
    canSendGuidance: streamHandlers.canSendGuidance,
    guidanceMessages: streamHandlers.guidanceMessages,
    expiredGuidanceMessages: streamHandlers.expiredGuidanceMessages,
    onCancelGuidance: streamHandlers.cancelGuidance,
    onEditGuidanceMessage: streamHandlers.editGuidanceMessage,
    onSendExpiredGuidanceAsMessage: streamHandlers.sendExpiredGuidanceAsMessage,
    handleSendMessage: async (overrideMessage?: string) => {
      // Format message with quote if present, then clear quote
      const baseMessage = overrideMessage?.trim() || chatState.taskInputMessage.trim()
      const message = formatQuoteForMessage(baseMessage)
      if (quote) {
        clearQuote()
      }
      await sendOrConfirmPendingReplacement(message)
    },
    onSendGuidance: async () => {
      const baseMessage = chatState.taskInputMessage.trim()
      const message = formatQuoteForMessage(baseMessage)
      if (quote) {
        clearQuote()
      }
      await streamHandlers.handleSendGuidance(message)
    },
    onPasteFile: handlePasteFile,
    // ChatInputControls props
    selectedModel: chatState.selectedModel,
    setSelectedModel: chatState.setSelectedModel,
    forceOverride: chatState.forceOverride,
    setForceOverride: chatState.setForceOverride,
    teamId: chatState.selectedTeam?.id,
    taskId: selectedTaskDetail?.id,
    showRepositorySelector: effectiveShowRepositorySelector,
    selectedRepo: chatState.selectedRepo,
    setSelectedRepo: chatState.setSelectedRepo,
    selectedBranch: chatState.selectedBranch,
    setSelectedBranch: chatState.setSelectedBranch,
    selectedTaskDetail,
    effectiveRequiresWorkspace: chatState.effectiveRequiresWorkspace,
    onRequiresWorkspaceChange: (value: boolean) => {
      chatState.setRequiresWorkspaceOverride(value)
    },
    enableDeepThinking: chatState.enableDeepThinking,
    setEnableDeepThinking: chatState.setEnableDeepThinking,
    enableClarification: chatState.enableClarification,
    setEnableClarification: chatState.setEnableClarification,
    enableCorrectionMode: chatState.enableCorrectionMode,
    correctionModelName: chatState.correctionModelName,
    onCorrectionModeToggle: chatState.handleCorrectionModeToggle,
    selectedContexts: chatState.selectedContexts,
    setSelectedContexts: chatState.setSelectedContexts,
    attachmentState: chatState.attachmentState,
    onFileSelect: handleUserFileSelect,
    onAttachmentRemove: handleInputAttachmentRemove,
    onSwapAttachments: chatState.swapAttachments,
    isStreaming: streamHandlers.isStreaming,
    isStopping: streamHandlers.isStopping,
    hasMessages,
    shouldCollapseSelectors,
    shouldHideToolbarStatus: chatState.shouldHideToolbarStatus,
    shouldHideChatInput: chatState.shouldHideChatInput,
    isModelSelectionRequired,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    onStopStream: streamHandlers.stopStream,
    onCancelTask: streamHandlers.handleCancelTask,
    onSendMessage: () => {
      // Format message with quote if present, then clear quote
      const message = formatQuoteForMessage(chatState.taskInputMessage.trim())
      if (quote) {
        clearQuote()
      }
      void sendOrConfirmPendingReplacement(message)
    },
    // Whether there are no available teams for current mode
    hasNoTeams: filteredTeams.length === 0,
    // Knowledge base ID to exclude from context selector (used in notebook mode)
    knowledgeBaseId,
    // Reason why input is disabled (shown as placeholder)
    disabledReason,
    // Project context
    projectId: projectIdFromUrl ? Number(projectIdFromUrl) : null,
    // Skill selector props
    availableSkills: skillSelector.availableSkills,
    teamSkillNames: skillSelector.teamSkillNames,
    preloadedSkillNames: skillSelector.preloadedSkillNames,
    selectedSkillNames: skillSelector.selectedSkillNames,
    onToggleSkill: skillSelector.toggleSkill,
    // Video mode props - only passed when taskType is 'video'
    // Note: videoModels is no longer passed - ModelSelector fetches models internally via useModelSelection
    selectedVideoModel: videoModelSelection.selectedModel,
    onVideoModelChange: handleVideoModelChange,
    isVideoModelsLoading: videoModelSelection.isLoading,
    selectedResolution,
    onResolutionChange: setSelectedResolution,
    availableResolutions,
    resolutionOptions: videoCapabilities?.resolutions,
    selectedRatio,
    onRatioChange: setSelectedRatio,
    availableRatios,
    ratioOptions: videoCapabilities?.aspect_ratios,
    selectedDuration,
    onDurationChange: setSelectedDuration,
    availableDurations,
    videoGenerationModes,
    selectedVideoGenerationMode,
    onVideoGenerationModeChange: handleVideoGenerationModeChange,
    materialAccept,
    // Image mode props - only passed when taskType is 'image'
    // Note: imageModels is no longer passed - ModelSelector fetches models internally via useModelSelection
    selectedImageModel: imageModelSelection.selectedModel,
    onImageModelChange: (model: Model) =>
      imageModelSelection.selectModelByKey(`${model.name}:${model.type || ''}`),
    isImageModelsLoading: imageModelSelection.isLoading,
    selectedImageSize,
    onImageSizeChange: setSelectedImageSize,
    // Generate mode switch props - only passed when in generate page
    onGenerateModeChange: showGenerateModeSelector ? onGenerateModeChange : undefined,
    // Hide all selectors (for OpenClaw devices)
    hideSelectors,
    // Team edit callback - only provided when team is editable
    onEditTeam: extension?.teamEdit?.canEdit ? extension.teamEdit.onEdit : undefined,
  }

  const shouldMountQueueMessageHandler =
    effectiveTaskType === 'chat' || effectiveTaskType === 'task' || effectiveTaskType === 'code'
  const compactingWaitMessage = chatStatus.isCompacting
    ? t('common:chat_status.compacting')
    : undefined

  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-h-0 w-full relative"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Queue Message Handler - processes process_message URL parameter from inbox */}
      {shouldMountQueueMessageHandler && (
        <QueueMessageHandler onQueueMessageLoaded={handleQueueMessageLoaded} />
      )}

      {/* Auto-send message from URL query parameter ?q=xxx&teamId=xxx */}
      <QueryParamAutoSend
        teams={teams}
        isTeamsLoading={isTeamsLoading}
        selectedTeam={chatState.selectedTeam}
        onTeamChange={handleTeamChange}
        onSendMessage={streamHandlers.handleSendMessage}
        hasTaskId={!!taskIdFromUrl}
        onPrefillMessage={chatState.setTaskInputMessage}
      />

      {/* Pipeline Stage Indicator - shows current stage progress for pipeline mode */}
      {hasMessages && selectedTaskDetail?.id && (
        <PipelineStageIndicator
          taskId={selectedTaskDetail.id}
          taskStatus={selectedTaskDetail.status || null}
          collaborationModel={
            selectedTaskDetail.team?.workflow?.mode || chatState.selectedTeam?.workflow?.mode
          }
          onStageInfoChange={setPipelineStageInfo}
          canContinueToNextStage={pipelineNextStepDraft.hasSelectableContext}
          onNextStepClick={handlePipelineNextStepClick}
        />
      )}

      {/* Messages Area: always mounted to keep scroll container stable */}
      <div className={hasMessages ? 'relative flex-1 min-h-0' : 'relative'}>
        {/* Top gradient fade effect - limited width to avoid overlapping scrollbar */}
        {hasMessages && (
          <div
            className="absolute top-0 left-0 h-8 z-10 pointer-events-none"
            style={{
              width: 'calc(100% - 12px)',
              background:
                'linear-gradient(to bottom, rgb(var(--color-bg-base)) 0%, rgb(var(--color-bg-base) / 0.6) 50%, rgb(var(--color-bg-base) / 0) 100%)',
            }}
          />
        )}
        {/* Scrollbar markers - shows user message positions on the scrollbar track */}
        <ScrollbarMarkers scrollContainerRef={scrollContainerRef} visible={hasMessages} />
        <div
          ref={scrollContainerRef}
          className={
            (hasMessages ? 'h-full overflow-y-auto custom-scrollbar' : 'overflow-y-hidden') +
            ' transition-opacity duration-200 ' +
            (hasMessages ? 'opacity-100' : 'opacity-0 pointer-events-none h-0')
          }
          aria-hidden={!hasMessages}
          style={{ paddingBottom: hasMessages ? `${inputHeight + 16}px` : '0' }}
        >
          <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pt-12">
            <MessagesArea
              selectedTeam={chatState.selectedTeam}
              selectedRepo={chatState.selectedRepo}
              selectedBranch={chatState.selectedBranch}
              onContentChange={handleMessagesContentChange}
              onShareButtonRender={onShareButtonRender}
              onSendMessage={handleSendMessageFromChild}
              onSendMessageWithModel={handleSendMessageWithModelFromChild}
              isGroupChat={selectedTaskDetail?.is_group_chat || false}
              onRetry={handleRetryFromMessagesArea}
              onRetryWithModel={handleRetryWithModelFromMessagesArea}
              enableCorrectionMode={chatState.enableCorrectionMode}
              correctionModelId={chatState.correctionModelId}
              enableCorrectionWebSearch={chatState.enableCorrectionWebSearch}
              hasMessages={hasMessages}
              pendingTaskId={streamHandlers.pendingTaskId}
              isPendingConfirmation={pipelineStageInfo?.is_pending_confirmation}
              onContextReselect={handleContextReselect}
              hideGroupChatOptions={taskType === 'knowledge'}
              onUseAsReference={handleUseAsReference}
              onReEdit={handleReEdit}
              waitingMessage={compactingWaitMessage}
              defaultSaveKnowledgeBaseId={taskType === 'knowledge' ? knowledgeBaseId : undefined}
            />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div
        className={
          hasMessages
            ? 'w-full'
            : inputAlwaysAtBottom
              ? 'w-full flex-1 relative'
              : 'flex-1 flex flex-col w-full'
        }
      >
        {/* Center area for input when no messages (and not in inputAlwaysAtBottom mode) */}
        {!hasMessages && !inputAlwaysAtBottom && (
          <div
            className="flex-1 flex items-center justify-center w-full"
            style={{ marginBottom: '12vh' }}
          >
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              {taskType !== 'knowledge' && (
                <SloganDisplay slogan={chatState.randomSlogan} project={activeProject} />
              )}
              {taskType === 'knowledge' && guidedQuestions && guidedQuestions.length > 0 && (
                <GuidedQuestions
                  questions={guidedQuestions}
                  onQuestionClick={question => chatState.setTaskInputMessage(question)}
                />
              )}
              <ChatInputCard
                {...inputCardProps}
                autoFocus={!hasMessages}
                inputControlsRef={inputControlsRef}
              />
              {taskType !== 'knowledge' && !hideSelectors && !activeProject && (
                <QuickAccessCards
                  teams={teams}
                  selectedTeam={chatState.selectedTeam}
                  onTeamSelect={handleTeamSelect}
                  onPhraseSelect={handleQuickPhraseSelect}
                  onPresetSelect={handleQuickPresetSelect}
                  currentMode={teamModeFilter}
                  isLoading={isTeamsLoading}
                  isTeamsLoading={isTeamsLoading}
                  hideSelected={true}
                  onRefreshTeams={onRefreshTeams}
                  showWizardButton={effectiveTaskType === 'chat'}
                  defaultTeam={chatState.defaultTeam}
                  launchIntent={quickLaunchIntent}
                  onLaunchIntentConsumed={() => setQuickLaunchIntent(null)}
                />
              )}
            </div>
          </div>
        )}
        {/* Empty state content for inputAlwaysAtBottom mode (e.g., KnowledgeBaseSummaryCard in notebook mode) */}
        {/* Uses absolute positioning with inset to create a scrollable area that respects the floating input */}
        {!hasMessages && inputAlwaysAtBottom && (
          <div
            className="absolute inset-0 flex flex-col items-center w-full px-4 sm:px-6 overflow-y-auto pt-4"
            style={{
              // Reserve space for: GuidedQuestions (~200px max) + ChatInputCard (~120px) + padding (32px)
              // This prevents overlap between summary card and guided questions on smaller screens
              paddingBottom: guidedQuestions && guidedQuestions.length > 0 ? '352px' : '152px',
            }}
          >
            {emptyStateContent}
          </div>
        )}

        {/* Floating Input Area for messages view or inputAlwaysAtBottom mode */}
        {/* Width is reduced by 12px to avoid overlapping the scrollbar */}
        {(hasMessages || inputAlwaysAtBottom) && (
          <div
            ref={floatingInputRef}
            className="fixed bottom-0 z-50 bg-base"
            style={{
              left: floatingMetrics.left,
              width:
                floatingMetrics.width > 14 ? floatingMetrics.width - 14 : floatingMetrics.width,
            }}
          >
            {/* Top gradient fade effect - creates smooth transition from content to floating input area */}
            {/* For inputAlwaysAtBottom mode without messages, this prevents hard edge with summary card */}
            {/* Width is limited to avoid overlapping the scrollbar (12px reserved for scrollbar) */}
            <div
              className="absolute top-0 h-8 -translate-y-full pointer-events-none"
              style={{
                left: 0,
                width: 'calc(100% - 12px)',
                background:
                  'linear-gradient(to top, rgb(var(--color-bg-base)) 0%, rgb(var(--color-bg-base) / 0.6) 50%, rgb(var(--color-bg-base) / 0) 100%)',
              }}
            />
            {/* Scroll to bottom indicator */}
            {hasMessages && (
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full pointer-events-auto">
                <ScrollToBottomIndicator
                  visible={showScrollIndicator}
                  onClick={() => scrollToBottom(true)}
                />
              </div>
            )}
            {/* Guided questions for knowledge notebook mode - displayed above input card */}
            {!hasMessages &&
              inputAlwaysAtBottom &&
              taskType === 'knowledge' &&
              guidedQuestions &&
              guidedQuestions.length > 0 && (
                <div className="w-full max-w-[820px] mx-auto px-4 sm:px-6 pt-4 pb-6">
                  <GuidedQuestions
                    questions={guidedQuestions}
                    onQuestionClick={question => chatState.setTaskInputMessage(question)}
                  />
                </div>
              )}
            <div className="relative w-full max-w-[820px] mx-auto px-4 sm:px-6">
              <div className="py-4">
                <ChatInputCard
                  {...inputCardProps}
                  autoFocus={!hasMessages && inputAlwaysAtBottom}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Team Edit Dialog - rendered via extension if provided */}
      {selectedTaskDetail?.id && (
        <PipelineNextStepDialog
          open={isPipelineNextStepOpen}
          messages={pipelineNextStepMessages}
          contextPassing={pipelineContextPassing}
          isConfirming={isPipelineNextStepConfirming}
          onOpenChange={setIsPipelineNextStepOpen}
          onConfirm={handlePipelineNextStepConfirm}
        />
      )}
      <AlertDialog
        open={isQuickPhraseOverwriteOpen}
        onOpenChange={open => {
          setIsQuickPhraseOverwriteOpen(open)
          if (!open) {
            setPendingQuickPhrase(null)
          }
        }}
      >
        <AlertDialogContent className="w-[420px] max-w-[calc(100vw-32px)] rounded-2xl border-border bg-base">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('quick_launch.overwrite_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('quick_launch.overwrite_confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="quick-phrase-overwrite-cancel">
              {t('quick_launch.overwrite_confirm_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="quick-phrase-overwrite-confirm"
              onClick={handleConfirmQuickPhraseOverwrite}
              variant="primary"
            >
              {t('quick_launch.overwrite_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingExternalDraft !== null}
        onOpenChange={open => {
          if (!open) {
            setPendingExternalDraft(null)
          }
        }}
      >
        <AlertDialogContent className="w-[420px] max-w-[calc(100vw-32px)] rounded-2xl border-border bg-base">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge_draft.confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge_draft.confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="knowledge-draft-cancel">
              {t('knowledge_draft.confirm_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="knowledge-draft-confirm"
              onClick={handleConfirmExternalDraft}
              variant="primary"
            >
              {t('knowledge_draft.confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={isPendingFormReplacementOpen}
        onOpenChange={open => {
          if (isPendingFormReplacementConfirming) return
          setIsPendingFormReplacementOpen(open)
          if (!open) {
            setPendingFormReplacementMessage(null)
            setPendingFormReplacementOptions(null)
          }
        }}
      >
        <AlertDialogContent className="w-[520px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-2xl border-border bg-base p-0 shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Command className="h-4 w-4 text-text-secondary" />
            <span className="text-sm text-text-secondary">{t('pending_form_confirm.eyebrow')}</span>
            <AlertDialogCancel
              disabled={isPendingFormReplacementConfirming}
              className="ml-auto mt-0 h-8 w-8 rounded-full border-0 bg-transparent p-0 text-text-muted hover:bg-surface hover:text-text-primary"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t('pending_form_confirm.keep')}</span>
            </AlertDialogCancel>
          </div>
          <AlertDialogHeader className="space-y-0 px-5 py-5 text-left">
            <div className="flex items-start gap-3 rounded-xl bg-surface p-4">
              <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <AlertDialogTitle className="text-sm font-semibold text-text-primary">
                  {t('pending_form_confirm.title')}
                </AlertDialogTitle>
                <AlertDialogDescription className="mt-1 text-sm leading-6 text-text-secondary">
                  {t('pending_form_confirm.description')}
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 px-5 pb-5 pt-0 sm:space-x-0">
            <AlertDialogCancel
              disabled={isPendingFormReplacementConfirming}
              className="mt-0 flex h-auto flex-col items-start justify-start gap-0 rounded-xl border-border bg-base px-4 py-3 text-left hover:bg-surface"
            >
              <span className="block text-sm font-medium text-text-primary">
                {t('pending_form_confirm.keep')}
              </span>
              <span className="mt-1 block text-xs font-normal text-text-secondary">
                {t('pending_form_confirm.keep_hint')}
              </span>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault()
                void handleConfirmPendingFormReplacement()
              }}
              disabled={isPendingFormReplacementConfirming}
              className="flex h-auto flex-col items-start justify-start gap-0 rounded-xl border border-primary bg-primary/8 px-4 py-3 text-left hover:bg-primary/12"
            >
              <span className="block text-sm font-medium text-primary">
                {isPendingFormReplacementConfirming
                  ? t('pending_form_confirm.confirming')
                  : t('pending_form_confirm.confirm')}
              </span>
              <span className="mt-1 block text-xs font-normal text-text-secondary">
                {t('pending_form_confirm.confirm_hint')}
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={isPendingReplacementOpen}
        onOpenChange={open => {
          if (isPendingReplacementConfirming) return
          setIsPendingReplacementOpen(open)
          if (!open) {
            setPendingReplacementMessage(null)
            setPendingReplacementOptions(null)
          }
        }}
      >
        <AlertDialogContent className="w-[520px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-2xl border-border bg-base p-0 shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Command className="h-4 w-4 text-text-secondary" />
            <span className="text-sm text-text-secondary">{t('pending_task_confirm.eyebrow')}</span>
            <AlertDialogCancel
              disabled={isPendingReplacementConfirming}
              className="ml-auto mt-0 h-8 w-8 rounded-full border-0 bg-transparent p-0 text-text-muted hover:bg-surface hover:text-text-primary"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t('pending_task_confirm.wait')}</span>
            </AlertDialogCancel>
          </div>
          <AlertDialogHeader className="space-y-0 px-5 py-5 text-left">
            <div className="flex items-start gap-3 rounded-xl bg-surface p-4">
              <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <AlertDialogTitle className="text-sm font-semibold text-text-primary">
                  {t('pending_task_confirm.title')}
                </AlertDialogTitle>
                <AlertDialogDescription className="mt-1 text-sm leading-6 text-text-secondary">
                  {t('pending_task_confirm.description')}
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 px-5 pb-5 pt-0 sm:space-x-0">
            <AlertDialogCancel
              disabled={isPendingReplacementConfirming}
              className="mt-0 flex h-auto flex-col items-start justify-start gap-0 rounded-xl border-border bg-base px-4 py-3 text-left hover:bg-surface"
            >
              <span className="block text-sm font-medium text-text-primary">
                {t('pending_task_confirm.wait')}
              </span>
              <span className="mt-1 block text-xs font-normal text-text-secondary">
                {t('pending_task_confirm.wait_hint')}
              </span>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault()
                void handleConfirmPendingReplacement()
              }}
              disabled={isPendingReplacementConfirming}
              className="flex h-auto flex-col items-start justify-start gap-0 rounded-xl border border-primary bg-primary/8 px-4 py-3 text-left hover:bg-primary/12"
            >
              <span className="block text-sm font-medium text-primary">
                {isPendingReplacementConfirming
                  ? t('pending_task_confirm.confirming')
                  : t('pending_task_confirm.confirm')}
              </span>
              <span className="mt-1 block text-xs font-normal text-text-secondary">
                {t('pending_task_confirm.confirm_hint')}
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {extension?.teamEdit?.renderDialog()}
    </div>
  )
}

/**
 * ChatArea Component
 *
 * Main chat interface component that wraps ChatAreaContent with QuoteProvider
 * to enable text selection quoting functionality.
 */
export default function ChatArea(props: ChatAreaProps) {
  return (
    <QuoteProvider>
      <SelectionTooltip />
      <ChatAreaContent {...props} />
    </QuoteProvider>
  )
}
