// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react'
import { ShieldX } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import MessagesArea from '../message/MessagesArea'
import { QuickAccessCards } from './QuickAccessCards'
import { SloganDisplay } from './SloganDisplay'
import { ChatInputCard } from '../input/ChatInputCard'
import PipelineStageIndicator from './PipelineStageIndicator'
import { ScrollToBottomIndicator } from './ScrollToBottomIndicator'
import { ScrollbarMarkers } from './ScrollbarMarkers'
import { GuidedQuestions } from '@/features/knowledge/document/components/GuidedQuestions'
import type { PipelineStageInfo } from '@/apis/tasks'
import { useChatAreaState } from './useChatAreaState'
import { useChatStreamHandlers } from './useChatStreamHandlers'
import { allBotsHavePredefinedModel } from '../selector/ModelSelector'
import { QuoteProvider, SelectionTooltip, useQuote } from '../text-selection'
import type { Team, SubtaskContextBrief, TaskType } from '@/types/api'
import type { Model } from '../../hooks/useModelSelection'
import type { ContextItem } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useRouter } from 'next/navigation'
import { useTaskContext } from '../../contexts/taskContext'
import { useTaskStateMachine } from '../../hooks/useTaskStateMachine'
import { Button } from '@/components/ui/button'
import { useScrollManagement } from '../hooks/useScrollManagement'
import { useFloatingInput } from '../hooks/useFloatingInput'
import { getAttachment } from '@/apis/attachments'
import { useAttachmentUpload } from '../hooks/useAttachmentUpload'
import { useSchemeMessageActions } from '@/lib/scheme'
import { useSkillSelector } from '../../hooks/useSkillSelector'
import { useModelSelection } from '../../hooks/useModelSelection'

/**
 * Threshold in pixels for determining when to collapse selectors.
 * When the controls container width is less than this value, selectors will collapse.
 */
const COLLAPSE_SELECTORS_THRESHOLD = 420

/** Generation mode type - video or image */
type GenerateMode = 'video' | 'image'
interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
  selectedTeamForNewTask?: Team | null
  showRepositorySelector?: boolean
  taskType?: TaskType
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
  /** Selected document IDs from DocumentPanel (for notebook mode context injection) */
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
}: ChatAreaProps) {
  const { t } = useTranslation()
  const router = useRouter()

  // Pipeline stage info state - shared between PipelineStageIndicator and MessagesArea
  const [pipelineStageInfo, setPipelineStageInfo] = useState<PipelineStageInfo | null>(null)
  const { quote, clearQuote, formatQuoteForMessage } = useQuote()

  // Task context
  const { selectedTaskDetail, setSelectedTask, accessDenied } = useTaskContext()

  // Use useTaskStateMachine hook for reactive state updates (SINGLE SOURCE OF TRUTH per AGENTS.md)
  const { state: taskState } = useTaskStateMachine(selectedTaskDetail?.id)

  // Video model selection state - only enabled for video mode
  // Uses unified useModelSelection hook with modelCategoryType='video'
  // NOTE: Must be called before useChatAreaState to provide maxAttachments
  const videoModelSelection = useModelSelection({
    teamId: null,
    taskId: null,
    selectedTeam: null,
    disabled: taskType !== 'video',
    modelCategoryType: 'video',
  })

  // Image model selection state - only enabled for image mode
  // Uses unified useModelSelection hook with modelCategoryType='image'
  // NOTE: Must be called before useChatAreaState to provide maxAttachments
  const imageModelSelection = useModelSelection({
    teamId: null,
    taskId: null,
    selectedTeam: null,
    disabled: taskType !== 'image',
    modelCategoryType: 'image',
  })

  // Compute maxAttachments from selected model's imageConfig
  // This value is passed to useChatAreaState for attachment upload limits
  const maxAttachmentsFromModel = useMemo(() => {
    if (taskType === 'image') {
      const imageConfig = imageModelSelection.selectedModel?.config?.imageConfig as
        | { max_reference_images?: number }
        | undefined
      return imageConfig?.max_reference_images
    }
    // Video mode can also use reference images, use same field if available
    if (taskType === 'video') {
      const videoConfig = videoModelSelection.selectedModel?.config?.videoConfig as
        | { max_reference_images?: number }
        | undefined
      return videoConfig?.max_reference_images
    }
    return undefined
  }, [
    taskType,
    imageModelSelection.selectedModel?.config,
    videoModelSelection.selectedModel?.config,
  ])

  // Chat area state (team, repo, branch, model, input, toggles, etc.)
  const chatState = useChatAreaState({
    teams,
    taskType,
    selectedTeamForNewTask,
    initialKnowledgeBase,
    maxAttachments: maxAttachmentsFromModel,
  })

  // Skill selector state - fetches available skills and manages selection
  const skillSelector = useSkillSelector({
    team: chatState.selectedTeam,
    enabled: true,
  })

  // Video mode specific state - resolution, aspect ratio, and duration
  // These are kept separate from useModelSelection as they are video-specific parameters
  const [selectedResolution, setSelectedResolution] = useState('1080p')
  const [selectedRatio, setSelectedRatio] = useState('16:9')
  const [selectedDuration, setSelectedDuration] = useState(5)

  // Derive available options and defaults from selected video model's config
  const videoConfig = videoModelSelection.selectedModel?.config?.videoConfig as
    | {
        resolution?: string
        ratio?: string
        duration?: number
        capabilities?: {
          aspect_ratios?: { value: string }[]
          resolutions?: { label: string }[]
          durations_sec?: number[]
        }
      }
    | undefined
  const videoCapabilities = videoConfig?.capabilities

  const availableResolutions = useMemo(() => {
    if (videoCapabilities?.resolutions?.length) {
      return videoCapabilities.resolutions.map(r => r.label)
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
    if (videoConfig.resolution && availableResolutions.includes(videoConfig.resolution)) {
      setSelectedResolution(videoConfig.resolution)
    } else if (availableResolutions.length) {
      setSelectedResolution(availableResolutions[0])
    }
    if (videoConfig.ratio && availableRatios.includes(videoConfig.ratio)) {
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
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id
    // Check messages from state machine (single source of truth)
    const hasContextMessages = taskState?.messages && taskState.messages.size > 0
    return Boolean(hasSelectedTask || hasContextMessages)
  }, [selectedTaskDetail, taskState?.messages])

  // Get taskId from URL for team sync logic
  const searchParams = useSearchParams()
  const taskIdFromUrl =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')

  // Track initialization and last synced task for team selection
  const hasInitializedTeamRef = useRef(false)
  const lastSyncedTaskIdRef = useRef<number | null>(null)

  // Filter teams by bind_mode based on current mode
  const filteredTeams = useMemo(() => {
    const teamsWithValidBindMode = teams.filter(team => {
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      return true
    })
    const result = teamsWithValidBindMode.filter(team => {
      if (!team.bind_mode) return true
      const included = team.bind_mode.includes(taskType)
      return included
    })

    return result
  }, [teams, taskType])

  // Extract values for dependency array
  const selectedTeam = chatState.selectedTeam
  const handleTeamChange = chatState.handleTeamChange
  const findDefaultTeamForMode = chatState.findDefaultTeamForMode

  // Team selection logic - using default team from server configuration
  useEffect(() => {
    if (filteredTeams.length === 0) return

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
    } else if (!taskIdFromUrl) {
      // No selection and no task - select default team
      const defaultTeamForMode = findDefaultTeamForMode(filteredTeams)
      handleTeamChange(defaultTeamForMode || filteredTeams[0])
    }
  }, [
    filteredTeams,
    selectedTaskDetail,
    taskIdFromUrl,
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
      handleTeamChange(team)
    },
    [handleTeamChange]
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
    if (taskType === 'video') return videoModelSelection.selectedModel
    if (taskType === 'image') return imageModelSelection.selectedModel
    return chatState.selectedModel
  }, [
    taskType,
    videoModelSelection.selectedModel,
    imageModelSelection.selectedModel,
    chatState.selectedModel,
  ])

  // Build generate params for video/image generation tasks
  // Include model name for display in user message bubble
  const generateParams = useMemo(() => {
    if (taskType === 'video') {
      return {
        resolution: selectedResolution,
        ratio: selectedRatio,
        duration: selectedDuration,
        model: videoModelSelection.selectedModel?.name,
      }
    }
    if (taskType === 'image') {
      return {
        size: selectedImageSize,
        model: imageModelSelection.selectedModel?.name,
      }
    }
    return undefined
  }, [
    taskType,
    selectedResolution,
    selectedRatio,
    selectedDuration,
    selectedImageSize,
    videoModelSelection.selectedModel?.name,
    imageModelSelection.selectedModel?.name,
  ])

  // Stream handlers (send message, retry, cancel, stop)
  const streamHandlers = useChatStreamHandlers({
    selectedTeam: chatState.selectedTeam,
    selectedModel: effectiveSelectedModel,
    forceOverride: chatState.forceOverride,
    selectedRepo: chatState.selectedRepo,
    selectedBranch: chatState.selectedBranch,
    showRepositorySelector,
    effectiveRequiresWorkspace: chatState.effectiveRequiresWorkspace,
    taskInputMessage: chatState.taskInputMessage,
    setTaskInputMessage: chatState.setTaskInputMessage,
    setIsLoading: chatState.setIsLoading,
    enableDeepThinking: chatState.enableDeepThinking,
    enableClarification: chatState.enableClarification,
    externalApiParams: chatState.externalApiParams,
    attachments: chatState.attachmentState.attachments,
    resetAttachment: chatState.resetAttachment,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    taskType,
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
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id
    const hasNewTaskStream =
      !selectedTaskDetail?.id && streamHandlers.pendingTaskId && streamHandlers.isStreaming
    const hasLocalPending = streamHandlers.localPendingMessage !== null
    // Use taskState from state machine (single source of truth)
    const hasUnifiedMessages = taskState?.messages && taskState.messages.size > 0

    // If we have a selected task with messages in state machine, show messages
    if (hasSelectedTask && hasUnifiedMessages) {
      return true
    }

    // In inputAlwaysAtBottom mode (knowledge notebook), only consider actual messages
    // not just the presence of selectedTaskDetail
    if (inputAlwaysAtBottom) {
      return Boolean(
        streamHandlers.hasPendingUserMessage ||
        streamHandlers.isStreaming ||
        hasNewTaskStream ||
        hasLocalPending ||
        hasUnifiedMessages
      )
    }

    return Boolean(
      hasSelectedTask ||
      streamHandlers.hasPendingUserMessage ||
      streamHandlers.isStreaming ||
      hasNewTaskStream ||
      hasLocalPending ||
      hasUnifiedMessages
    )
  }, [
    selectedTaskDetail,
    streamHandlers.hasPendingUserMessage,
    streamHandlers.isStreaming,
    streamHandlers.pendingTaskId,
    streamHandlers.localPendingMessage,
    taskState?.messages,
    inputAlwaysAtBottom,
  ])

  // Note: Team selection is now handled by useTeamSelection hook in TeamSelector component
  // Model selection is handled by useModelSelection hook in ModelSelector component

  // Check if model selection is required
  const isModelSelectionRequired = useMemo(() => {
    // OpenClaw devices handle model on device side, no model selection required
    if (hideSelectors) return false
    // Video mode uses video model selection, not regular model selection
    if (taskType === 'video') {
      // In video mode, we need a video model selected
      return !videoModelSelection.selectedModel
    }
    // Image mode uses image model selection
    if (taskType === 'image') {
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
    taskType,
    hideSelectors,
    videoModelSelection.selectedModel,
    imageModelSelection.selectedModel,
  ])

  // Unified canSubmit flag
  const canSubmit = useMemo(() => {
    return (
      !disabledReason &&
      !chatState.isLoading &&
      !streamHandlers.isStreaming &&
      !isModelSelectionRequired &&
      chatState.isAttachmentReadyToSend
    )
  }, [
    disabledReason,
    chatState.isLoading,
    streamHandlers.isStreaming,
    isModelSelectionRequired,
    chatState.isAttachmentReadyToSend,
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

  const setTaskInputMessage = chatState.setTaskInputMessage
  const setSelectedContexts = chatState.setSelectedContexts
  const resetAttachment = chatState.resetAttachment
  const addExistingAttachment = chatState.addExistingAttachment
  const selectedContextsRef = useRef(chatState.selectedContexts)
  selectedContextsRef.current = chatState.selectedContexts

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
      isLoading: chatState.isLoading,
      isStreaming: streamHandlers.isStreaming,
      attachmentState: chatState.attachmentState,
      onFileSelect: chatState.handleFileSelect,
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
    async (content: string) => {
      const existingInput = taskInputMessageRef.current.trim()
      const combinedMessage = existingInput ? `${content}\n\n---\n\n${existingInput}` : content
      setTaskInputMessage('')
      await handleSendMessageRef.current(combinedMessage)
    },
    [setTaskInputMessage]
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

  // Callback for re-selecting a context from a message badge
  const handleContextReselect = useCallback(
    (context: SubtaskContextBrief) => {
      // Convert SubtaskContextBrief to ContextItem format
      let contextItem: ContextItem | null = null

      if (context.context_type === 'knowledge_base') {
        contextItem = {
          id: context.id,
          name: context.name,
          type: 'knowledge_base',
          document_count: context.document_count ?? undefined,
        }
      } else if (context.context_type === 'table') {
        contextItem = {
          id: context.id,
          name: context.name,
          type: 'table',
          document_id: 0, // Not available in SubtaskContextBrief, backend will resolve it
          source_config: context.source_config ?? undefined,
        }
      }

      if (!contextItem) return

      const currentContexts = selectedContextsRef.current
      const isAlreadySelected = currentContexts.some(
        c => c.type === contextItem.type && c.id === contextItem.id
      )
      if (isAlreadySelected) return

      setSelectedContexts([...currentContexts, contextItem])
    },
    [setSelectedContexts]
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
      let userStateMsg: import('../../state/TaskStateMachine').UnifiedMessage | undefined

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
        let lastUserMsg: import('../../state/TaskStateMachine').UnifiedMessage | undefined
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
          restoredContextItems.push({
            id: ctx.id,
            name: ctx.name,
            type: 'knowledge_base',
            document_count: ctx.document_count ?? undefined,
          })
        } else if (ctx.context_type === 'table') {
          restoredContextItems.push({
            id: ctx.id,
            name: ctx.name,
            type: 'table',
            document_id: 0,
            source_config: ctx.source_config ?? undefined,
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
      setSelectedTask(null)
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
    selectedTeam: chatState.selectedTeam,
    teams: teams,
    externalApiParams: chatState.externalApiParams,
    onTeamChange: chatState.handleTeamChange,
    onTeamsRefresh: async () => {
      if (onRefreshTeams) {
        await onRefreshTeams()
      }
    },
    onExternalApiParamsChange: chatState.handleExternalApiParamsChange,
    onAppModeChange: chatState.handleAppModeChange,
    // Only enable restore when default team exists
    onRestoreDefaultTeam: chatState.defaultTeam ? chatState.restoreDefaultTeam : undefined,
    isUsingDefaultTeam: chatState.isUsingDefaultTeam,
    taskType,
    tipText: chatState.randomTip,
    isGroupChat: selectedTaskDetail?.is_group_chat || false,
    isDragging: chatState.isDragging,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    canSubmit,
    handleSendMessage: async (overrideMessage?: string) => {
      // Format message with quote if present, then clear quote
      const baseMessage = overrideMessage?.trim() || chatState.taskInputMessage.trim()
      const message = formatQuoteForMessage(baseMessage)
      if (quote) {
        clearQuote()
      }
      await streamHandlers.handleSendMessage(message)
    },
    onPasteFile: handlePasteFile,
    // ChatInputControls props
    selectedModel: chatState.selectedModel,
    setSelectedModel: chatState.setSelectedModel,
    forceOverride: chatState.forceOverride,
    setForceOverride: chatState.setForceOverride,
    teamId: chatState.selectedTeam?.id,
    taskId: selectedTaskDetail?.id,
    showRepositorySelector,
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
    onFileSelect: chatState.handleFileSelect,
    onAttachmentRemove: chatState.handleAttachmentRemove,
    isLoading: chatState.isLoading,
    isStreaming: streamHandlers.isStreaming,
    isStopping: streamHandlers.isStopping,
    hasMessages,
    shouldCollapseSelectors,
    shouldHideQuotaUsage: chatState.shouldHideQuotaUsage,
    shouldHideChatInput: chatState.shouldHideChatInput,
    isModelSelectionRequired,
    isAttachmentReadyToSend: chatState.isAttachmentReadyToSend,
    isSubtaskStreaming: streamHandlers.isSubtaskStreaming,
    onStopStream: streamHandlers.stopStream,
    onSendMessage: () => {
      // Format message with quote if present, then clear quote
      const message = formatQuoteForMessage(chatState.taskInputMessage.trim())
      if (quote) {
        clearQuote()
      }
      streamHandlers.handleSendMessage(message)
    },
    // Whether there are no available teams for current mode
    hasNoTeams: filteredTeams.length === 0,
    // Knowledge base ID to exclude from context selector (used in notebook mode)
    knowledgeBaseId,
    // Reason why input is disabled (shown as placeholder)
    disabledReason,
    // Skill selector props
    availableSkills: skillSelector.availableSkills,
    teamSkillNames: skillSelector.teamSkillNames,
    preloadedSkillNames: skillSelector.preloadedSkillNames,
    selectedSkillNames: skillSelector.selectedSkillNames,
    onToggleSkill: skillSelector.toggleSkill,
    // Video mode props - only passed when taskType is 'video'
    // Note: videoModels is no longer passed - ModelSelector fetches models internally via useModelSelection
    selectedVideoModel: videoModelSelection.selectedModel,
    onVideoModelChange: (model: Model) =>
      videoModelSelection.selectModelByKey(`${model.name}:${model.type || ''}`),
    isVideoModelsLoading: videoModelSelection.isLoading,
    selectedResolution,
    onResolutionChange: setSelectedResolution,
    availableResolutions,
    selectedRatio,
    onRatioChange: setSelectedRatio,
    availableRatios,
    selectedDuration,
    onDurationChange: setSelectedDuration,
    availableDurations,
    // Image mode props - only passed when taskType is 'image'
    // Note: imageModels is no longer passed - ModelSelector fetches models internally via useModelSelection
    selectedImageModel: imageModelSelection.selectedModel,
    onImageModelChange: (model: Model) =>
      imageModelSelection.selectModelByKey(`${model.name}:${model.type || ''}`),
    isImageModelsLoading: imageModelSelection.isLoading,
    selectedImageSize,
    onImageSizeChange: setSelectedImageSize,
    // Generate mode switch props - only passed when in generate page
    onGenerateModeChange,
    // Hide all selectors (for OpenClaw devices)
    hideSelectors,
  }

  return (
    <div
      ref={chatAreaRef}
      className="flex-1 flex flex-col min-h-0 w-full relative"
      style={{ height: '100%', boxSizing: 'border-box' }}
    >
      {/* Pipeline Stage Indicator - shows current stage progress for pipeline mode */}
      {hasMessages && selectedTaskDetail?.id && (
        <PipelineStageIndicator
          taskId={selectedTaskDetail.id}
          taskStatus={selectedTaskDetail.status || null}
          collaborationModel={
            selectedTaskDetail.team?.workflow?.mode || chatState.selectedTeam?.workflow?.mode
          }
          onStageInfoChange={setPipelineStageInfo}
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
            />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div
        className={hasMessages || inputAlwaysAtBottom ? 'w-full' : 'flex-1 flex flex-col w-full'}
      >
        {/* Center area for input when no messages (and not in inputAlwaysAtBottom mode) */}
        {!hasMessages && !inputAlwaysAtBottom && (
          <div
            className="flex-1 flex items-center justify-center w-full"
            style={{ marginBottom: '12vh' }}
          >
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              {taskType !== 'knowledge' && <SloganDisplay slogan={chatState.randomSlogan} />}
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
              {taskType !== 'knowledge' && !hideSelectors && (
                <QuickAccessCards
                  teams={teams}
                  selectedTeam={chatState.selectedTeam}
                  onTeamSelect={handleTeamSelect}
                  currentMode={taskType}
                  isLoading={isTeamsLoading}
                  isTeamsLoading={isTeamsLoading}
                  hideSelected={true}
                  onRefreshTeams={onRefreshTeams}
                  showWizardButton={taskType === 'chat'}
                  defaultTeam={chatState.defaultTeam}
                />
              )}
            </div>
          </div>
        )}
        {/* Empty state content for inputAlwaysAtBottom mode (e.g., KnowledgeBaseSummaryCard in notebook mode) */}
        {!hasMessages && inputAlwaysAtBottom && (
          <div className="flex-1 flex flex-col items-center justify-center w-full px-4 sm:px-6">
            {emptyStateContent}
          </div>
        )}

        {/* Floating Input Area for messages view or inputAlwaysAtBottom mode */}
        {(hasMessages || inputAlwaysAtBottom) && (
          <div
            ref={floatingInputRef}
            className="fixed bottom-0 z-50"
            style={{
              left: floatingMetrics.left,
              width: floatingMetrics.width,
            }}
          >
            {/* Bottom gradient fade effect - text fades as it approaches the input, limited width to avoid overlapping scrollbar */}
            {hasMessages && (
              <div
                className="absolute top-0 h-8 -translate-y-full pointer-events-none"
                style={{
                  left: '18px',
                  width: 'calc(100% - 36px)',
                  background:
                    'linear-gradient(to top, rgb(var(--color-bg-base)) 0%, rgb(var(--color-bg-base) / 0.6) 50%, rgb(var(--color-bg-base) / 0) 100%)',
                }}
              />
            )}
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
            {/* pb-10 provides enough space to avoid overlap with DeviceSelectorTab (-top-[29px]) */}
            {!hasMessages &&
              inputAlwaysAtBottom &&
              taskType === 'knowledge' &&
              guidedQuestions &&
              guidedQuestions.length > 0 && (
                <div className="w-full max-w-[820px] mx-auto px-4 sm:px-6 pb-10">
                  <GuidedQuestions
                    questions={guidedQuestions}
                    onQuestionClick={question => chatState.setTaskInputMessage(question)}
                  />
                </div>
              )}
            <div className="relative w-full max-w-[820px] mx-auto px-4 sm:px-6">
              <div className="py-4 bg-base">
                <ChatInputCard
                  {...inputCardProps}
                  autoFocus={!hasMessages && inputAlwaysAtBottom}
                />
              </div>
            </div>
          </div>
        )}
      </div>
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
