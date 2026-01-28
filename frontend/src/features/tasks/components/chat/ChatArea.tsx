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
import type { PipelineStageInfo } from '@/apis/tasks'
import { useChatAreaState } from './useChatAreaState'
import { useChatStreamHandlers } from './useChatStreamHandlers'
import { allBotsHavePredefinedModel } from '../selector/ModelSelector'
import { QuoteProvider, SelectionTooltip, useQuote } from '../text-selection'
import type { Team, SubtaskContextBrief } from '@/types/api'
import type { Model } from '../../hooks/useModelSelection'
import type { ContextItem } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useRouter } from 'next/navigation'
import { useTaskContext } from '../../contexts/taskContext'
import { useChatStreamContext } from '../../contexts/chatStreamContext'
import { Button } from '@/components/ui/button'
import { useScrollManagement } from '../hooks/useScrollManagement'
import { useFloatingInput } from '../hooks/useFloatingInput'
import { useAttachmentUpload } from '../hooks/useAttachmentUpload'
import { useSchemeMessageActions } from '@/lib/scheme'

/**
 * Threshold in pixels for determining when to collapse selectors.
 * When the controls container width is less than this value, selectors will collapse.
 */
const COLLAPSE_SELECTORS_THRESHOLD = 420

interface ChatAreaProps {
  teams: Team[]
  isTeamsLoading: boolean
  selectedTeamForNewTask?: Team | null
  showRepositorySelector?: boolean
  taskType?: 'chat' | 'code' | 'knowledge' | 'task'
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
}: ChatAreaProps) {
  const { t } = useTranslation()
  const router = useRouter()

  // Pipeline stage info state - shared between PipelineStageIndicator and MessagesArea
  const [pipelineStageInfo, setPipelineStageInfo] = useState<PipelineStageInfo | null>(null)
  const { quote, clearQuote, formatQuoteForMessage } = useQuote()

  // Task context
  const { selectedTaskDetail, setSelectedTask, accessDenied, clearAccessDenied } = useTaskContext()

  // Stream context for getStreamState
  // getStreamState is used to access messages (SINGLE SOURCE OF TRUTH per AGENTS.md)
  const { getStreamState } = useChatStreamContext()

  // Get stream state for current task to check messages
  const currentStreamState = selectedTaskDetail?.id
    ? getStreamState(selectedTaskDetail.id)
    : undefined

  // Chat area state (team, repo, branch, model, input, toggles, etc.)
  const chatState = useChatAreaState({
    teams,
    taskType,
    selectedTeamForNewTask,
    initialKnowledgeBase,
  })

  // Compute subtask info for scroll management
  const subtaskList = selectedTaskDetail?.subtasks ?? []
  const lastSubtask = subtaskList.length ? subtaskList[subtaskList.length - 1] : null
  const lastSubtaskId = lastSubtask?.id ?? null
  const lastSubtaskUpdatedAt = lastSubtask?.updated_at || lastSubtask?.completed_at || null
  // Determine if there are messages to display (computed early for hooks)
  // Uses context messages as the single source of truth, not selectedTaskDetail.subtasks
  const hasMessagesForHooks = useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id
    // Check messages from context (single source of truth)
    const hasContextMessages = currentStreamState?.messages && currentStreamState.messages.size > 0
    return Boolean(hasSelectedTask || hasContextMessages)
  }, [selectedTaskDetail, currentStreamState?.messages])

  // Get taskId from URL for team sync logic
  const searchParams = useSearchParams()
  const taskIdFromUrl =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')

  // Track initialization and last synced task for team selection
  const hasInitializedTeamRef = useRef(false)
  const lastSyncedTaskIdRef = useRef<number | null>(null)

  // Filter teams by bind_mode based on current mode
  const filteredTeams = useMemo(() => {
    console.log('[ChatArea] Filtering teams:', {
      taskType,
      totalTeams: teams.length,
      teamsBindModes: teams.map(t => ({ name: t.name, bind_mode: t.bind_mode })),
    })
    const teamsWithValidBindMode = teams.filter(team => {
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      return true
    })
    const result = teamsWithValidBindMode.filter(team => {
      if (!team.bind_mode) return true
      const included = team.bind_mode.includes(taskType as 'chat' | 'code' | 'knowledge' | 'task')
      console.log('[ChatArea] Team filter:', {
        name: team.name,
        bind_mode: team.bind_mode,
        taskType,
        included,
      })
      return included
    })
    console.log(
      '[ChatArea] Filtered teams result:',
      result.map(t => t.name)
    )
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
            console.log('[ChatArea] Syncing team from task detail:', teamFromDetail.name)
            handleTeamChange(teamFromDetail)
            lastSyncedTaskIdRef.current = selectedTaskDetail.id
            hasInitializedTeamRef.current = true
            return
          } else {
            // Team not in filtered list, try to use the team object from detail
            const teamObject =
              typeof selectedTaskDetail.team === 'object' ? (selectedTaskDetail.team as Team) : null
            if (teamObject) {
              console.log('[ChatArea] Using team object from detail:', teamObject.name)
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
        console.log('[ChatArea] Waiting for taskDetail to match URL')
        return
      }
    }

    // Case 2: New chat (no taskId in URL) - use default team from server config
    if (!taskIdFromUrl && !hasInitializedTeamRef.current) {
      // Use the default team computed from server config
      const defaultTeamForMode = findDefaultTeamForMode(filteredTeams)
      if (defaultTeamForMode) {
        console.log('[ChatArea] Using default team from server config:', defaultTeamForMode.name)
        handleTeamChange(defaultTeamForMode)
        hasInitializedTeamRef.current = true
        lastSyncedTaskIdRef.current = null
        return
      }
      // No default found, select first team
      if (!selectedTeam && filteredTeams.length > 0) {
        console.log('[ChatArea] Selecting first team:', filteredTeams[0].name)
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
        console.log('[ChatArea] Current team not in filtered list, selecting default')
        const defaultTeamForMode = findDefaultTeamForMode(filteredTeams)
        handleTeamChange(defaultTeamForMode || filteredTeams[0])
      }
    } else if (!taskIdFromUrl) {
      // No selection and no task - select default team
      console.log('[ChatArea] No selection, selecting default team')
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

  // Stream handlers (send message, retry, cancel, stop)
  const streamHandlers = useChatStreamHandlers({
    selectedTeam: chatState.selectedTeam,
    selectedModel: chatState.selectedModel,
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
  const hasMessages = useMemo(() => {
    const hasSelectedTask = selectedTaskDetail && selectedTaskDetail.id
    const hasNewTaskStream =
      !selectedTaskDetail?.id && streamHandlers.pendingTaskId && streamHandlers.isStreaming
    const hasSubtasks = selectedTaskDetail?.subtasks && selectedTaskDetail.subtasks.length > 0
    const hasLocalPending = streamHandlers.localPendingMessage !== null
    const hasUnifiedMessages =
      streamHandlers.currentStreamState?.messages &&
      streamHandlers.currentStreamState.messages.size > 0

    if (hasSelectedTask && hasSubtasks) {
      return true
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
    streamHandlers.currentStreamState?.messages,
  ])

  // Note: Team selection is now handled by useTeamSelection hook in TeamSelector component
  // Model selection is handled by useModelSelection hook in ModelSelector component

  // Check if model selection is required
  const isModelSelectionRequired = useMemo(() => {
    if (!chatState.selectedTeam || chatState.selectedTeam.agent_type === 'dify') return false
    const hasDefaultOption = allBotsHavePredefinedModel(chatState.selectedTeam)
    if (hasDefaultOption) return false
    return !chatState.selectedModel
  }, [chatState.selectedTeam, chatState.selectedModel])

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

  // Load prompt from sessionStorage - single remaining useEffect
  useEffect(() => {
    if (hasMessages) return

    const pendingPromptData = sessionStorage.getItem('pendingTaskPrompt')
    if (pendingPromptData) {
      try {
        const data = JSON.parse(pendingPromptData)
        const isRecent = Date.now() - data.timestamp < 5 * 60 * 1000

        if (isRecent && data.prompt) {
          chatState.setTaskInputMessage(data.prompt)
          sessionStorage.removeItem('pendingTaskPrompt')
        }
      } catch (error) {
        console.error('Failed to parse pending prompt data:', error)
        sessionStorage.removeItem('pendingTaskPrompt')
      }
    }
  }, [hasMessages, chatState])

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
      const existingInput = chatState.taskInputMessage.trim()
      const combinedMessage = existingInput ? `${content}\n\n---\n\n${existingInput}` : content
      chatState.setTaskInputMessage('')
      await streamHandlers.handleSendMessage(combinedMessage)
    },
    [chatState, streamHandlers]
  )

  // Callback for child components to send messages with a specific model (for regeneration)
  // Accepts optional existingContexts to preserve attachments/knowledge bases from the original message
  const handleSendMessageWithModelFromChild = useCallback(
    async (content: string, model: Model, existingContexts?: SubtaskContextBrief[]) => {
      await streamHandlers.handleSendMessageWithModel(content, model, existingContexts)
    },
    [streamHandlers]
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

      // Check if context is already selected
      const isAlreadySelected = chatState.selectedContexts.some(
        c => c.type === contextItem!.type && c.id === contextItem!.id
      )

      // If not already selected, add it to selectedContexts
      if (!isAlreadySelected) {
        chatState.setSelectedContexts([...chatState.selectedContexts, contextItem!])
      }
    },
    [chatState]
  )

  // Handle access denied state
  if (accessDenied) {
    const handleGoHome = () => {
      clearAccessDenied()
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
    externalApiParams: chatState.externalApiParams,
    onTeamChange: chatState.handleTeamChange,
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
        {/* Top gradient fade effect */}
        {hasMessages && (
          <div
            className="absolute top-0 left-0 right-0 h-12 z-10 pointer-events-none"
            style={{
              background:
                'linear-gradient(to bottom, rgb(var(--color-bg-base)) 0%, rgb(var(--color-bg-base) / 0.8) 40%, rgb(var(--color-bg-base) / 0) 100%)',
            }}
          />
        )}
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
              onRetry={streamHandlers.handleRetry}
              enableCorrectionMode={chatState.enableCorrectionMode}
              correctionModelId={chatState.correctionModelId}
              enableCorrectionWebSearch={chatState.enableCorrectionWebSearch}
              hasMessages={hasMessages}
              pendingTaskId={streamHandlers.pendingTaskId}
              isPendingConfirmation={pipelineStageInfo?.is_pending_confirmation}
              onContextReselect={handleContextReselect}
              hideGroupChatOptions={taskType === 'knowledge'}
            />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className={hasMessages ? 'w-full' : 'flex-1 flex flex-col w-full'}>
        {/* Center area for input when no messages */}
        {!hasMessages && (
          <div
            className={
              taskType === 'knowledge'
                ? 'flex-1 flex items-end justify-center w-full pb-6'
                : 'flex-1 flex items-center justify-center w-full'
            }
            style={taskType === 'knowledge' ? undefined : { marginBottom: '20vh' }}
          >
            <div ref={floatingInputRef} className="w-full max-w-4xl mx-auto px-4 sm:px-6">
              {taskType !== 'knowledge' && <SloganDisplay slogan={chatState.randomSlogan} />}
              <ChatInputCard
                {...inputCardProps}
                autoFocus={!hasMessages}
                inputControlsRef={inputControlsRef}
              />
              {taskType !== 'knowledge' && (
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

        {/* Floating Input Area for messages view */}
        {hasMessages && (
          <div
            ref={floatingInputRef}
            className="fixed bottom-0 z-50"
            style={{
              left: floatingMetrics.left,
              width: floatingMetrics.width,
            }}
          >
            <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 py-4">
              <ChatInputCard {...inputCardProps} />
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
