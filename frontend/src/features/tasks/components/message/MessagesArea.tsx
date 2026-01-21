// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useTaskContext } from '../../contexts/taskContext'
import type { TaskDetail, Team, GitRepoInfo, GitBranch } from '@/types/api'
import {
  Share2,
  FileText,
  ChevronDown,
  Download,
  MessageSquare,
  Users,
  MoreHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTypewriter } from '@/hooks/useTypewriter'
import MessageBubble, { type Message } from './MessageBubble'
import TaskShareModal from '../share/TaskShareModal'
import ExportSelectModal, {
  type SelectableMessage,
  type SelectableAttachment,
  type SelectableKnowledgeBase,
  type ExportFormat,
} from '../share/ExportSelectModal'
import { taskApis } from '@/apis/tasks'
import { subtaskApis } from '@/apis/subtasks'
import { TaskMembersPanel } from '../group-chat'
import { useUser } from '@/features/common/UserContext'
import { useUnifiedMessages, type DisplayMessage } from '../../hooks/useUnifiedMessages'
import { useChatStreamContext } from '../../contexts/chatStreamContext'
import { useStreamingVisibilityRecovery } from '../../hooks/useStreamingVisibilityRecovery'
import { useTraceAction } from '@/hooks/useTraceAction'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  correctionApis,
  CorrectionResponse,
  extractCorrectionFromResult,
  correctionDataToResponse,
} from '@/apis/correction'
import CorrectionResultPanel from '../CorrectionResultPanel'
import CorrectionProgressIndicator, {
  type CorrectionStreamingContent,
} from '../CorrectionProgressIndicator'
import { useSocket } from '@/contexts/SocketContext'
import type { CorrectionStage, CorrectionField } from '@/types/socket'
import type { Model } from '../../hooks/useModelSelection'

/**
 * Component to render a streaming message with typewriter effect.
 */
interface StreamingMessageBubbleProps {
  message: DisplayMessage
  selectedTaskDetail: TaskDetail | null
  selectedTeam?: Team | null
  selectedRepo?: GitRepoInfo | null
  selectedBranch?: GitBranch | null
  theme: 'light' | 'dark'
  t: (key: string) => string
  onSendMessage?: (content: string) => void
  index: number
  isGroupChat?: boolean
  isPendingConfirmation?: boolean
  onContextReselect?: (context: import('@/types/api').SubtaskContextBrief) => void
}

function StreamingMessageBubble({
  message,
  selectedTaskDetail,
  selectedTeam,
  selectedRepo,
  selectedBranch,
  theme,
  t,
  onSendMessage,
  index,
  isGroupChat,
  isPendingConfirmation,
  onContextReselect,
}: StreamingMessageBubbleProps) {
  // Use typewriter effect for streaming content
  const displayContent = useTypewriter(message.content || '')

  const hasContent = Boolean(message.content && message.content.trim())
  const isStreaming = message.status === 'streaming'
  // Check if we have thinking data (for executor tasks like Claude Code)
  const hasThinking = Boolean(
    message.thinking && Array.isArray(message.thinking) && message.thinking.length > 0
  )

  // Create msg object with thinking data
  // IMPORTANT: Create a new object each time to ensure memo comparison detects changes
  const msgForBubble = {
    type: 'ai' as const,
    content: '${$$}$' + (message.content || ''),
    timestamp: message.timestamp,
    botName: message.botName || selectedTeam?.name || t('common:messages.bot') || 'Bot',
    subtaskStatus: 'RUNNING',
    recoveredContent: isStreaming ? displayContent : hasContent ? message.content : undefined,
    isRecovered: false,
    isIncomplete: false,
    subtaskId: message.subtaskId,
    // Pass thinking data for executor tasks (Claude Code, etc.)
    thinking: message.thinking as Message['thinking'],
    // Pass result with shell_type for component selection
    result: message.result,
    // Pass sources for RAG knowledge base citations
    sources: message.sources,
  }

  return (
    <MessageBubble
      key={message.id}
      msg={msgForBubble}
      index={index}
      selectedTaskDetail={selectedTaskDetail}
      selectedTeam={selectedTeam}
      selectedRepo={selectedRepo}
      selectedBranch={selectedBranch}
      theme={theme}
      t={t}
      isWaiting={Boolean(isStreaming && !hasContent && !hasThinking)}
      onSendMessage={onSendMessage}
      isGroupChat={isGroupChat}
      isPendingConfirmation={isPendingConfirmation}
      onContextReselect={onContextReselect}
    />
  )
}

interface MessagesAreaProps {
  selectedTeam?: Team | null
  selectedRepo?: GitRepoInfo | null
  selectedBranch?: GitBranch | null
  onShareButtonRender?: (button: React.ReactNode) => void
  onContentChange?: () => void
  onSendMessage?: (content: string) => void
  /** Callback for sending message with a specific model override (used for regenerate) */
  onSendMessageWithModel?: (
    content: string,
    model: Model,
    existingContexts?: import('@/types/api').SubtaskContextBrief[]
  ) => void
  isGroupChat?: boolean
  onRetry?: (message: Message) => void
  // Correction mode props
  enableCorrectionMode?: boolean
  correctionModelId?: string | null
  enableCorrectionWebSearch?: boolean
  // Whether there are messages to display (from parent ChatArea)
  // This ensures MessagesArea shows content when ChatArea's hasMessages is true
  hasMessages?: boolean
  /**
   * Pending task ID - used when selectedTaskDetail.id is not yet available.
   * Can be either tempTaskId (negative) or taskId (positive) before selectedTaskDetail updates.
   */
  pendingTaskId?: number | null
  /**
   * Whether the current pipeline stage is pending confirmation.
   * This is the single source of truth from pipeline_stage_info.is_pending_confirmation.
   */
  isPendingConfirmation?: boolean
  /** Callback when user clicks on a context badge to re-select it */
  onContextReselect?: (context: import('@/types/api').SubtaskContextBrief) => void
  /** Hide group chat management button (e.g., in notebook mode) */
  hideGroupChatOptions?: boolean
}

export default function MessagesArea({
  selectedTeam,
  selectedRepo,
  selectedBranch,
  onContentChange,
  onShareButtonRender,
  onSendMessage,
  onSendMessageWithModel,
  isGroupChat = false,
  onRetry,
  enableCorrectionMode = false,
  correctionModelId = null,
  enableCorrectionWebSearch = false,
  hasMessages: hasMessagesFromParent,
  pendingTaskId,
  isPendingConfirmation,
  onContextReselect,
  hideGroupChatOptions = false,
}: MessagesAreaProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { selectedTaskDetail, refreshSelectedTaskDetail, refreshTasks, setSelectedTask } =
    useTaskContext()
  const { theme } = useTheme()
  const { user } = useUser()
  const { traceAction } = useTraceAction()
  const { registerCorrectionHandlers } = useSocket()
  const isMobile = useIsMobile()

  // Use unified messages hook - SINGLE SOURCE OF TRUTH
  // Pass pendingTaskId to query messages when selectedTaskDetail.id is not yet available
  const { messages, streamingSubtaskIds, isStreaming } = useUnifiedMessages({
    team: selectedTeam || null,
    isGroupChat,
    pendingTaskId,
  })

  // Use streaming visibility recovery hook to sync state when user returns from background
  // This handles the case where WebSocket missed events while page was hidden
  useStreamingVisibilityRecovery({
    taskId: selectedTaskDetail?.id,
    isStreaming,
    minHiddenTime: 3000, // Recover if page was hidden for more than 3 seconds
    enabled: true,
  })

  // Task share modal state
  const [showShareModal, setShowShareModal] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [isSharing, setIsSharing] = useState(false)

  // Export modal state
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf')
  const [exportableMessages, setExportableMessages] = useState<SelectableMessage[]>([])

  // Group chat members panel state
  const [showMembersPanel, setShowMembersPanel] = useState(false)

  // Message edit state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)

  // Regenerate state
  const [isRegenerating, setIsRegenerating] = useState(false)

  // Correction mode state
  const [correctionResults, setCorrectionResults] = useState<Map<number, CorrectionResponse>>(
    new Map()
  )
  const [correctionLoading, setCorrectionLoading] = useState<Set<number>>(new Set())
  // Track which messages have been attempted for correction to avoid infinite retry loops
  const [correctionAttempted, setCorrectionAttempted] = useState<Set<number>>(new Set())
  // Track applied corrections - maps subtaskId to the improved answer content
  const [appliedCorrections, setAppliedCorrections] = useState<Map<number, string>>(new Map())
  // Track correction progress for real-time UI updates
  const [correctionProgress, setCorrectionProgress] = useState<
    Map<number, { stage: CorrectionStage | 'starting'; toolName?: string }>
  >(new Map())
  // Track streaming content for correction fields
  const [correctionStreamingContent, setCorrectionStreamingContent] = useState<
    Map<number, CorrectionStreamingContent>
  >(new Map())

  // Handle retry correction for a specific message
  const handleRetryCorrection = useCallback(
    async (subtaskId: number, originalQuestion: string, originalAnswer: string) => {
      if (!selectedTaskDetail?.id || !correctionModelId) return

      // Remove from attempted set to allow retry
      setCorrectionAttempted(prev => {
        const next = new Set(prev)
        next.delete(subtaskId)
        return next
      })

      // Remove old correction result
      setCorrectionResults(prev => {
        const next = new Map(prev)
        next.delete(subtaskId)
        return next
      })

      // Set loading state
      setCorrectionLoading(prev => new Set(prev).add(subtaskId))

      try {
        const result = await correctionApis.correctResponse({
          task_id: selectedTaskDetail.id,
          message_id: subtaskId,
          original_question: originalQuestion,
          original_answer: originalAnswer,
          correction_model_id: correctionModelId,
          force_retry: true, // Force re-evaluation even if correction exists
          enable_web_search: enableCorrectionWebSearch,
        })

        setCorrectionResults(prev => new Map(prev).set(subtaskId, result))
      } catch (error) {
        console.error('Retry correction failed:', error)
        toast({
          variant: 'destructive',
          title: 'Correction failed',
          description: (error as Error)?.message || 'Unknown error',
        })
      } finally {
        setCorrectionLoading(prev => {
          const next = new Set(prev)
          next.delete(subtaskId)
          return next
        })
      }
    },
    [selectedTaskDetail?.id, correctionModelId, enableCorrectionWebSearch, toast]
  )

  // Load persisted correction data from subtask.result when task detail changes
  useEffect(() => {
    if (!selectedTaskDetail?.subtasks) return

    const savedResults = new Map<number, CorrectionResponse>()

    selectedTaskDetail.subtasks.forEach(subtask => {
      // Only check assistant (AI) messages
      if (subtask.role !== 'ASSISTANT') return

      // Extract correction data from subtask.result.correction
      const correction = extractCorrectionFromResult(subtask.result)
      if (correction) {
        savedResults.set(subtask.id, correctionDataToResponse(correction, subtask.id))
      }
    })

    // Only update if we found saved corrections
    if (savedResults.size > 0) {
      setCorrectionResults(prev => {
        // Merge with existing results (API results take precedence)
        const merged = new Map(savedResults)
        prev.forEach((value, key) => {
          merged.set(key, value)
        })
        return merged
      })
    }
  }, [selectedTaskDetail?.subtasks])

  // Trigger correction when AI message completes
  useEffect(() => {
    if (!enableCorrectionMode || !correctionModelId || !selectedTaskDetail?.id) return

    // Find completed AI messages that haven't been corrected yet
    messages.forEach((msg, index) => {
      // Skip if not AI message, still streaming, or already corrected/loading
      if (msg.type !== 'ai' || msg.status === 'streaming') return
      if (!msg.subtaskId) return
      // Skip failed messages (status === 'error') - no need to correct failed responses
      if (msg.status === 'error') return
      // Skip empty AI messages - nothing to correct
      if (!msg.content || !msg.content.trim()) return
      // Skip if already has result, is loading, or has been attempted (to avoid infinite retry loops)
      if (
        correctionResults.has(msg.subtaskId) ||
        correctionLoading.has(msg.subtaskId) ||
        correctionAttempted.has(msg.subtaskId)
      )
        return

      // Find the corresponding user message (previous message)
      const userMsg = index > 0 ? messages[index - 1] : null
      if (!userMsg || userMsg.type !== 'user' || !userMsg.content) return

      // Mark as attempted to prevent infinite retry loops
      const subtaskId = msg.subtaskId
      setCorrectionAttempted(prev => new Set(prev).add(subtaskId))
      setCorrectionLoading(prev => new Set(prev).add(subtaskId))

      correctionApis
        .correctResponse({
          task_id: selectedTaskDetail.id,
          message_id: subtaskId,
          original_question: userMsg.content,
          original_answer: msg.content || '',
          correction_model_id: correctionModelId,
          enable_web_search: enableCorrectionWebSearch,
        })
        .then(result => {
          setCorrectionResults(prev => new Map(prev).set(subtaskId, result))
        })
        .catch(error => {
          console.error('Correction failed:', error)
          toast({
            variant: 'destructive',
            title: 'Correction failed',
            description: (error as Error)?.message || 'Unknown error',
          })
        })
        .finally(() => {
          setCorrectionLoading(prev => {
            const next = new Set(prev)
            next.delete(subtaskId)
            return next
          })
        })
    })
  }, [
    enableCorrectionMode,
    correctionModelId,
    enableCorrectionWebSearch,
    messages,
    selectedTaskDetail?.id,
    toast,
    correctionAttempted, // Add this dependency so useEffect re-runs when retry button is clicked
  ])

  // Register correction WebSocket event handlers for real-time progress updates
  useEffect(() => {
    if (!enableCorrectionMode || !selectedTaskDetail?.id) return

    const cleanup = registerCorrectionHandlers({
      onCorrectionStart: data => {
        // Only handle events for the current task
        if (data.task_id !== selectedTaskDetail.id) return

        // Set initial progress state and clear any previous streaming content
        setCorrectionProgress(prev => new Map(prev).set(data.subtask_id, { stage: 'starting' }))
        setCorrectionStreamingContent(prev => {
          const next = new Map(prev)
          next.set(data.subtask_id, { summary: '', improved_answer: '' })
          return next
        })
      },
      onCorrectionProgress: data => {
        // Only handle events for the current task
        if (data.task_id !== selectedTaskDetail.id) return

        // Update progress state with current stage
        setCorrectionProgress(prev =>
          new Map(prev).set(data.subtask_id, {
            stage: data.stage as CorrectionStage,
            toolName: data.tool_name,
          })
        )
      },
      onCorrectionChunk: data => {
        // Only handle events for the current task
        if (data.task_id !== selectedTaskDetail.id) return

        // Append streaming content to the appropriate field
        setCorrectionStreamingContent(prev => {
          const current = prev.get(data.subtask_id) || { summary: '', improved_answer: '' }
          const field = data.field as CorrectionField

          // Build the new content by appending the chunk at the correct offset
          let newFieldContent = current[field]
          if (data.offset === newFieldContent.length) {
            // Append at the end (normal case)
            newFieldContent += data.content
          } else if (data.offset < newFieldContent.length) {
            // Replace from offset (retry/resend case)
            newFieldContent = newFieldContent.slice(0, data.offset) + data.content
          } else {
            // Gap in content, just append (shouldn't happen normally)
            newFieldContent += data.content
          }

          return new Map(prev).set(data.subtask_id, {
            ...current,
            [field]: newFieldContent,
          })
        })
      },
      onCorrectionDone: data => {
        // Only handle events for the current task
        if (data.task_id !== selectedTaskDetail.id) return

        // Clear progress state and streaming content when done
        setCorrectionProgress(prev => {
          const next = new Map(prev)
          next.delete(data.subtask_id)
          return next
        })
        setCorrectionStreamingContent(prev => {
          const next = new Map(prev)
          next.delete(data.subtask_id)
          return next
        })
      },
      onCorrectionError: data => {
        // Only handle events for the current task
        if (data.task_id !== selectedTaskDetail.id) return

        // Clear progress state and streaming content on error
        setCorrectionProgress(prev => {
          const next = new Map(prev)
          next.delete(data.subtask_id)
          return next
        })
        setCorrectionStreamingContent(prev => {
          const next = new Map(prev)
          next.delete(data.subtask_id)
          return next
        })
      },
    })

    return cleanup
  }, [enableCorrectionMode, selectedTaskDetail?.id, registerCorrectionHandlers])

  // Handle task share
  const handleShareTask = useCallback(async () => {
    if (!selectedTaskDetail?.id) {
      toast({
        variant: 'destructive',
        title: t('shared-task:no_task_selected'),
        description: t('shared-task:no_task_selected_desc'),
      })
      return
    }

    setIsSharing(true)
    await traceAction(
      'share-task',
      {
        'action.type': 'share',
        'task.title': selectedTaskDetail?.title || '',
        'task.status': selectedTaskDetail?.status || '',
      },
      async () => {
        try {
          const response = await taskApis.shareTask(selectedTaskDetail.id)
          setShareUrl(response.share_url)
          setShowShareModal(true)
        } catch (err) {
          console.error('Failed to share task:', err)
          toast({
            variant: 'destructive',
            title: t('shared-task:share_failed'),
            description: (err as Error)?.message || t('shared-task:share_failed_desc'),
          })
          throw err
        } finally {
          setIsSharing(false)
        }
      }
    )
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.title,
    selectedTaskDetail?.status,
    toast,
    t,
    traceAction,
  ])

  // Prepare exportable messages and open export modal
  const prepareExport = useCallback(
    (format: ExportFormat) => {
      if (!selectedTaskDetail?.id) {
        toast({
          variant: 'destructive',
          title: t('shared-task:no_task_selected'),
          description: t('shared-task:no_task_selected_desc'),
        })
        return
      }

      // Use the messages from useUnifiedMessages which includes WebSocket updates
      // This is the SAME data that's displayed in the UI
      const exportableMessages: SelectableMessage[] = messages
        .filter(msg => msg.status === 'completed') // Only export completed messages
        .map(msg => {
          // Remove markdown prefix from AI messages if present
          let content = msg.content
          if (msg.type === 'ai' && content.startsWith('${$$}$')) {
            content = content.substring(6)
          }

          // Extract attachments and knowledge bases from contexts (new unified context system)
          // or fall back to legacy attachments field
          let attachments: SelectableAttachment[] | undefined
          let knowledgeBases: SelectableKnowledgeBase[] | undefined

          if (msg.contexts && msg.contexts.length > 0) {
            // Filter attachment type contexts and convert to SelectableAttachment format
            const attachmentContexts = msg.contexts.filter(ctx => ctx.context_type === 'attachment')
            if (attachmentContexts.length > 0) {
              attachments = attachmentContexts.map(ctx => ({
                id: ctx.id,
                filename: ctx.name,
                file_size: ctx.file_size || 0,
                file_extension: ctx.file_extension || '',
              }))
            }

            // Filter knowledge base type contexts and convert to SelectableKnowledgeBase format
            const kbContexts = msg.contexts.filter(ctx => ctx.context_type === 'knowledge_base')
            if (kbContexts.length > 0) {
              knowledgeBases = kbContexts.map(ctx => ({
                id: ctx.id,
                name: ctx.name,
                document_count: ctx.document_count ?? undefined,
              }))
            }
          } else if (msg.attachments && msg.attachments.length > 0) {
            // Legacy attachments field fallback
            attachments = msg.attachments.map(att => ({
              id: att.id,
              filename: att.filename,
              file_size: att.file_size,
              file_extension: att.file_extension,
            }))
          }

          return {
            id: msg.subtaskId?.toString() || msg.id,
            type: msg.type,
            content,
            timestamp: msg.timestamp,
            botName: msg.botName || selectedTaskDetail?.team?.name || 'Bot',
            userName: msg.senderUserName || selectedTaskDetail?.user?.user_name,
            teamName: selectedTaskDetail?.team?.name,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
            knowledgeBases:
              knowledgeBases && knowledgeBases.length > 0 ? knowledgeBases : undefined,
          }
        })

      const validMessages = exportableMessages.filter(msg => msg.content.trim() !== '')

      if (validMessages.length === 0) {
        toast({
          variant: 'destructive',
          title: t('chat:export.no_messages') || 'No messages to export',
        })
        return
      }

      setExportableMessages(validMessages)
      setExportFormat(format)
      setShowExportModal(true)
    },
    [selectedTaskDetail, messages, toast, t]
  )

  // Handle PDF export - open modal
  const handleExportPdf = useCallback(() => {
    prepareExport('pdf')
  }, [prepareExport])

  // Handle DOCX export - open modal
  const handleExportDocx = useCallback(() => {
    prepareExport('docx')
  }, [prepareExport])

  // Removed polling - relying entirely on WebSocket real-time updates
  // Task details will be updated via WebSocket events in taskContext

  // Notify parent component when content changes (for scroll management)
  useLayoutEffect(() => {
    if (onContentChange) {
      onContentChange()
    }
  }, [messages, onContentChange])

  // Handle user leaving group chat
  const handleLeaveGroupChat = useCallback(() => {
    setSelectedTask(null)
  }, [setSelectedTask])

  // Handle members changed in group chat panel
  const handleMembersChanged = useCallback(() => {
    // Refresh both task list (to move task to correct category)
    // and task detail (to update is_group_chat flag and enable @ feature)
    refreshTasks()
    refreshSelectedTaskDetail(false)
  }, [refreshTasks, refreshSelectedTaskDetail])

  // Handle edit button click - enter edit mode for a message
  const handleEditMessage = useCallback((msg: Message) => {
    if (msg.subtaskId) {
      setEditingMessageId(String(msg.subtaskId))
    }
  }, [])

  // Handle cancel edit - exit edit mode
  const handleEditCancel = useCallback(() => {
    setEditingMessageId(null)
  }, [])

  // Get cleanupMessagesAfterEdit from chat stream context
  const { cleanupMessagesAfterEdit } = useChatStreamContext()

  // Handle save edit - call API to edit message, then resend to trigger AI response
  const handleEditSave = useCallback(
    async (newContent: string) => {
      if (!editingMessageId) return

      const subtaskId = parseInt(editingMessageId, 10)
      if (isNaN(subtaskId)) return

      try {
        const response = await subtaskApis.editMessage(subtaskId, newContent)

        if (response.success) {
          // Exit edit mode first
          setEditingMessageId(null)

          // Immediately clean up messages from the edited position in local state
          // This removes the edited message and all subsequent messages before refreshing
          // to ensure UI consistency (no stale messages visible)
          if (selectedTaskDetail?.id) {
            cleanupMessagesAfterEdit(selectedTaskDetail.id, subtaskId)
          }

          // Refresh task detail to reload messages from backend
          await refreshSelectedTaskDetail(true)

          // Automatically resend the edited message to trigger AI response
          // This is the ChatGPT-style behavior: edit message -> delete all from edited -> resend as new
          if (onSendMessage) {
            onSendMessage(newContent)
          }
        }
      } catch (error) {
        console.error('Failed to edit message:', error)
        toast({
          variant: 'destructive',
          title: t('chat:edit.failed') || 'Failed to edit message',
          description: (error as Error)?.message || 'Unknown error',
        })
        throw error // Re-throw to let InlineMessageEdit know it failed
      }
    },
    [
      editingMessageId,
      selectedTaskDetail?.id,
      cleanupMessagesAfterEdit,
      refreshSelectedTaskDetail,
      onSendMessage,
      toast,
      t,
    ]
  )

  // Handle regenerate - find the user message before the AI message and resend it with selected model
  const handleRegenerate = useCallback(
    async (aiMessage: Message, selectedModel: Model) => {
      // 0. Check if currently streaming - prevent regenerate during active streaming
      if (isStreaming) {
        toast({
          variant: 'destructive',
          title: t('chat:regenerate.failed') || 'Failed to regenerate response',
          description:
            t('chat:edit.wait_for_completion') ||
            'Please wait for the current response to complete',
        })
        return
      }

      // 0.5. Validate aiMessage has subtaskId
      if (!aiMessage.subtaskId) {
        console.error('AI message has no subtaskId, cannot regenerate')
        return
      }

      // 1. Find the index of this AI message by subtaskId
      const aiIndex = messages.findIndex(
        m => m.subtaskId !== undefined && m.subtaskId === aiMessage.subtaskId
      )
      if (aiIndex < 0) {
        console.error('AI message not found in messages list')
        return
      }

      // 2. Find the preceding user message
      const userMessage = messages[aiIndex - 1]
      if (!userMessage || userMessage.type !== 'user') {
        console.error('No user message found before AI message')
        return
      }

      // 3. Get the subtask ID of the user message for API call
      const userSubtaskId = userMessage.subtaskId
      if (!userSubtaskId) {
        console.error('User message has no subtaskId')
        return
      }

      // 4. Save original content and contexts for potential recovery
      const originalUserContent = userMessage.content
      // Extract contexts from the original user message (attachments, knowledge bases, tables)
      const originalContexts = userMessage.contexts || []

      setIsRegenerating(true)
      try {
        // 4.5. Refresh task detail first to ensure we have latest state from backend
        // This helps detect any running subtasks that frontend might have missed
        await refreshSelectedTaskDetail(false)

        // 5. Call the edit message API with the SAME content (this will delete the AI response)
        const response = await subtaskApis.editMessage(userSubtaskId, originalUserContent)

        if (response.success) {
          // 6. Clean up local messages from the edited position
          if (selectedTaskDetail?.id) {
            cleanupMessagesAfterEdit(selectedTaskDetail.id, userSubtaskId)
          }

          // 7. Refresh task detail to sync with backend
          await refreshSelectedTaskDetail(true)

          // 8. Resend the same user message with the selected model to trigger new AI response
          // Pass the original contexts (attachments, knowledge bases, etc.) to preserve them
          if (onSendMessageWithModel) {
            onSendMessageWithModel(originalUserContent, selectedModel, originalContexts)
          } else if (onSendMessage) {
            // Fallback to regular send if model override is not supported
            onSendMessage(originalUserContent)
          }
        }
      } catch (error) {
        console.error('Failed to regenerate:', error)
        const errorMessage = (error as Error)?.message || 'Unknown error'

        // If backend says AI is generating, refresh task detail to sync frontend state
        if (errorMessage.includes('AI is generating')) {
          // Refresh to get latest state from backend
          await refreshSelectedTaskDetail(false)
        }

        toast({
          variant: 'destructive',
          title: t('chat:regenerate.failed') || 'Failed to regenerate response',
          description: errorMessage,
        })
      } finally {
        setIsRegenerating(false)
      }
    },
    [
      messages,
      selectedTaskDetail?.id,
      cleanupMessagesAfterEdit,
      refreshSelectedTaskDetail,
      onSendMessage,
      onSendMessageWithModel,
      toast,
      t,
      isStreaming,
    ]
  )

  // Memoize share and export buttons
  const shareButton = useMemo(() => {
    if (!selectedTaskDetail?.id || messages.length === 0) {
      return null
    }

    const isGroupChatTask = selectedTaskDetail?.is_group_chat || false
    const isChatAgentType = selectedTaskDetail?.team?.agent_type === 'chat'
    // Hide members button in notebook mode (hideGroupChatOptions)
    const showMembersButton = !hideGroupChatOptions && (isGroupChatTask || isChatAgentType)

    // Mobile: Use a single "More" dropdown menu (like Gemini)
    if (isMobile) {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="flex items-center justify-center h-8 w-8 p-0 rounded-[7px]"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {showMembersButton && (
              <DropdownMenuItem
                onClick={() => setShowMembersPanel(true)}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Users className="h-4 w-4" />
                <span>{t('common:groupChat.members.title') || 'Members'}</span>
              </DropdownMenuItem>
            )}
            {!isGroupChatTask && (
              <DropdownMenuItem
                onClick={handleShareTask}
                disabled={isSharing}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Share2 className="h-4 w-4" />
                <span>{isSharing ? t('shared-task:sharing') : t('shared-task:share_link')}</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={handleExportPdf}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>{t('chat:export.export_pdf')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleExportDocx}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>{t('chat:export.export_docx') || 'Export DOCX'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const feedbackUrl = getRuntimeConfigSync().feedbackUrl
                window.open(feedbackUrl, '_blank')
              }}
              className="flex items-center gap-2 cursor-pointer"
            >
              <MessageSquare className="h-4 w-4" />
              <span>{t('common:navigation.feedback')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }

    // Desktop: Show all buttons inline
    return (
      <div className="flex items-center gap-2">
        {showMembersButton && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMembersPanel(true)}
            className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
          >
            <Users className="h-3.5 w-3.5" />
            {t('common:groupChat.members.title') || 'Members'}
          </Button>
        )}

        {/* Hide share link button for group chat tasks */}
        {!isGroupChatTask && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleShareTask}
            disabled={isSharing}
            className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
          >
            <Share2 className="h-3.5 w-3.5" />
            {isSharing ? t('shared-task:sharing') : t('shared-task:share_link')}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
            >
              <Download className="h-3.5 w-3.5" />
              {t('chat:export.export')}
              <ChevronDown className="h-3 w-3 ml-0.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-30">
            <DropdownMenuItem
              onClick={handleExportPdf}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>{t('chat:export.export_pdf')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleExportDocx}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>{t('chat:export.export_docx') || 'Export DOCX'}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const feedbackUrl = getRuntimeConfigSync().feedbackUrl
            window.open(feedbackUrl, '_blank')
          }}
          className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {t('common:navigation.feedback')}
        </Button>
      </div>
    )
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.is_group_chat,
    selectedTaskDetail?.team?.agent_type,
    messages.length,
    isSharing,
    isMobile,
    handleShareTask,
    handleExportPdf,
    handleExportDocx,
    t,
    hideGroupChatOptions,
  ])

  // Pass share button to parent for rendering in TopNavigation
  useEffect(() => {
    if (onShareButtonRender) {
      onShareButtonRender(shareButton)
    }
  }, [onShareButtonRender, shareButton])

  // Convert DisplayMessage to Message format for MessageBubble
  const convertToMessage = useCallback(
    (msg: DisplayMessage): Message => {
      // For AI messages, check if there's an applied correction to use instead
      let content = msg.content
      if (msg.type === 'ai') {
        // Check if this message has an applied correction
        const appliedContent = msg.subtaskId ? appliedCorrections.get(msg.subtaskId) : undefined
        if (appliedContent) {
          content = '${$$}$' + appliedContent
        } else {
          content = '${$$}$' + msg.content
        }
      }

      return {
        type: msg.type,
        content,
        timestamp: msg.timestamp,
        botName: msg.botName,
        subtaskStatus: msg.subtaskStatus,
        subtaskId: msg.subtaskId,
        attachments: msg.attachments,
        contexts: msg.contexts, // Add contexts for unified context system
        senderUserName: msg.senderUserName,
        senderUserId: msg.senderUserId,
        shouldShowSender: msg.shouldShowSender,
        thinking: msg.thinking as Message['thinking'],
        result: msg.result, // Include result with shell_type for component selection
        sources: msg.sources, // Include sources for RAG knowledge base citations
        recoveredContent: msg.recoveredContent,
        isRecovered: msg.isRecovered,
        isIncomplete: msg.isIncomplete,
        status: msg.status,
        error: msg.error,
        reasoningContent: msg.reasoningContent, // DeepSeek R1 reasoning content
      }
    },
    [appliedCorrections]
  )

  // Pre-compute the last AI message subtaskId to avoid O(n²) complexity in render loop
  const lastAiMessageSubtaskId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'ai') {
        return messages[i].subtaskId
      }
    }
    return null
  }, [messages])

  return (
    <div
      className="flex-1 w-full max-w-3xl mx-auto flex flex-col"
      data-chat-container="true"
      translate="no"
    >
      {/* Messages Area */}
      {(messages.length > 0 ||
        streamingSubtaskIds.length > 0 ||
        selectedTaskDetail?.id ||
        hasMessagesFromParent) && (
        <div className="flex-1 space-y-8 messages-container">
          {messages.map((msg, index) => {
            const messageKey = msg.subtaskId
              ? `${msg.type}-${msg.subtaskId}`
              : `msg-${index}-${msg.timestamp}`

            // Determine if this is the current user's message (for group chat alignment)
            const isCurrentUserMessage =
              msg.type === 'user' ? (isGroupChat ? msg.senderUserId === user?.id : true) : false

            // Calculate if this is the last AI message (for regenerate button)
            const isLastAiMessage = msg.type === 'ai' && msg.subtaskId === lastAiMessageSubtaskId

            // Check if this AI message has a correction result
            const hasCorrectionResult =
              msg.type === 'ai' &&
              msg.subtaskId !== undefined &&
              correctionResults.has(msg.subtaskId)
            const isCorrecting =
              msg.type === 'ai' &&
              msg.subtaskId !== undefined &&
              correctionLoading.has(msg.subtaskId)
            const correctionResult = msg.subtaskId
              ? correctionResults.get(msg.subtaskId)
              : undefined

            // Use StreamingMessageBubble for streaming AI messages
            if (msg.type === 'ai' && msg.status === 'streaming') {
              return (
                <StreamingMessageBubble
                  key={messageKey}
                  message={msg}
                  selectedTaskDetail={selectedTaskDetail}
                  selectedTeam={selectedTeam}
                  selectedRepo={selectedRepo}
                  selectedBranch={selectedBranch}
                  theme={theme as 'light' | 'dark'}
                  t={t}
                  onSendMessage={onSendMessage}
                  index={index}
                  isGroupChat={isGroupChat}
                  isPendingConfirmation={isPendingConfirmation}
                  onContextReselect={onContextReselect}
                />
              )
            }

            // For AI messages with correction mode enabled, render side by side
            if (
              msg.type === 'ai' &&
              enableCorrectionMode &&
              (hasCorrectionResult || isCorrecting)
            ) {
              // Find the corresponding user message (previous message)
              const userMsg = index > 0 ? messages[index - 1] : null
              const originalQuestion = userMsg?.content || ''

              return (
                <div key={messageKey} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <MessageBubble
                    msg={convertToMessage(msg)}
                    index={index}
                    selectedTaskDetail={selectedTaskDetail}
                    selectedTeam={selectedTeam}
                    selectedRepo={selectedRepo}
                    selectedBranch={selectedBranch}
                    theme={theme as 'light' | 'dark'}
                    t={t}
                    onSendMessage={onSendMessage}
                    isCurrentUserMessage={isCurrentUserMessage}
                    isGroupChat={isGroupChat}
                    isPendingConfirmation={isPendingConfirmation}
                    onContextReselect={onContextReselect}
                  />
                  <div className="flex flex-col gap-2">
                    {/* Show progress indicator when correction is in progress */}
                    {isCorrecting && msg.subtaskId && correctionProgress.has(msg.subtaskId) && (
                      <CorrectionProgressIndicator
                        stage={correctionProgress.get(msg.subtaskId)!.stage}
                        toolName={correctionProgress.get(msg.subtaskId)!.toolName}
                        streamingContent={correctionStreamingContent.get(msg.subtaskId)}
                      />
                    )}
                    <CorrectionResultPanel
                      result={
                        correctionResult || {
                          message_id: 0,
                          scores: { accuracy: 0, logic: 0, completeness: 0 },
                          corrections: [],
                          summary: '',
                          improved_answer: '',
                          is_correct: false,
                        }
                      }
                      isLoading={isCorrecting}
                      onRetry={
                        msg.subtaskId && originalQuestion && msg.content
                          ? () =>
                              handleRetryCorrection(msg.subtaskId!, originalQuestion, msg.content)
                          : undefined
                      }
                      subtaskId={msg.subtaskId}
                      onApply={(improvedAnswer: string) => {
                        // Update the local state to immediately show the improved answer
                        if (msg.subtaskId) {
                          setAppliedCorrections(prev =>
                            new Map(prev).set(msg.subtaskId!, improvedAnswer)
                          )
                        }
                      }}
                    />
                  </div>
                </div>
              )
            }

            // Use regular MessageBubble for other messages
            return (
              <MessageBubble
                key={messageKey}
                msg={convertToMessage(msg)}
                index={index}
                selectedTaskDetail={selectedTaskDetail}
                selectedTeam={selectedTeam}
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                theme={theme as 'light' | 'dark'}
                t={t}
                onSendMessage={onSendMessage}
                isCurrentUserMessage={isCurrentUserMessage}
                onRetry={onRetry}
                isGroupChat={isGroupChat}
                isPendingConfirmation={isPendingConfirmation}
                onContextReselect={onContextReselect}
                isEditing={msg.subtaskId ? editingMessageId === String(msg.subtaskId) : false}
                onEdit={handleEditMessage}
                onEditSave={handleEditSave}
                onEditCancel={handleEditCancel}
                isLastAiMessage={isLastAiMessage}
                onRegenerate={!isGroupChat ? handleRegenerate : undefined}
                isRegenerating={isRegenerating}
              />
            )
          })}
        </div>
      )}

      {/* Task Share Modal */}
      <TaskShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        taskTitle={selectedTaskDetail?.title || 'Untitled Task'}
        shareUrl={shareUrl}
      />

      {/* Export Select Modal */}
      {selectedTaskDetail?.id && (
        <ExportSelectModal
          open={showExportModal}
          onClose={() => setShowExportModal(false)}
          messages={exportableMessages}
          taskId={selectedTaskDetail.id}
          taskName={
            selectedTaskDetail?.title || selectedTaskDetail?.prompt?.slice(0, 50) || 'Chat Export'
          }
          exportFormat={exportFormat}
        />
      )}

      {/* Group Chat Members Panel */}
      {selectedTaskDetail?.id && user?.id && (
        <TaskMembersPanel
          open={showMembersPanel}
          onClose={() => setShowMembersPanel(false)}
          taskId={selectedTaskDetail.id}
          taskTitle={selectedTaskDetail.title || selectedTaskDetail.prompt || 'Untitled Task'}
          currentUserId={user.id}
          onLeave={handleLeaveGroupChat}
          onMembersChanged={handleMembersChanged}
        />
      )}
    </div>
  )
}
