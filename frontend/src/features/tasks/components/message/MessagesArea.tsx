// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTaskContext } from '../../contexts/taskContext';
import type { TaskDetail, TaskDetailSubtask, Team, GitRepoInfo, GitBranch } from '@/types/api';
import { Share2, FileText, ChevronDown, Download, MessageSquare, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { useTranslation } from '@/hooks/useTranslation';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTypewriter } from '@/hooks/useTypewriter';
import MessageBubble, { type Message } from './MessageBubble';
import TaskShareModal from '../share/TaskShareModal';
import { taskApis } from '@/apis/tasks';
import { type SelectableMessage } from '../share/ExportPdfButton';
import { generateChatPdf } from '@/utils/pdf';
import { getAttachmentPreviewUrl, isImageExtension } from '@/apis/attachments';
import { getToken } from '@/apis/user';
import { TaskMembersPanel } from '../group-chat';
import { useUser } from '@/features/common/UserContext';
import { useUnifiedMessages, type DisplayMessage } from '../../hooks/useUnifiedMessages';
import { useTraceAction } from '@/hooks/useTraceAction';
import {
  correctionApis,
  CorrectionResponse,
  extractCorrectionFromResult,
  correctionDataToResponse,
} from '@/apis/correction';
import CorrectionResultPanel from '../CorrectionResultPanel';

/**
 * Component to render a streaming message with typewriter effect.
 */
interface StreamingMessageBubbleProps {
  message: DisplayMessage;
  selectedTaskDetail: TaskDetail | null;
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  theme: 'light' | 'dark';
  t: (key: string) => string;
  onSendMessage?: (content: string) => void;
  index: number;
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
}: StreamingMessageBubbleProps) {
  // Use typewriter effect for streaming content
  const displayContent = useTypewriter(message.content || '');

  const hasContent = Boolean(message.content && message.content.trim());
  const isStreaming = message.status === 'streaming';
  // Check if we have thinking data (for executor tasks like Claude Code)
  const hasThinking = Boolean(
    message.thinking && Array.isArray(message.thinking) && message.thinking.length > 0
  );

  // Create msg object with thinking data
  // IMPORTANT: Create a new object each time to ensure memo comparison detects changes
  const msgForBubble = {
    type: 'ai' as const,
    content: '${$$}$' + (message.content || ''),
    timestamp: message.timestamp,
    botName: message.botName || selectedTeam?.name || t('messages.bot') || 'Bot',
    subtaskStatus: 'RUNNING',
    recoveredContent: isStreaming ? displayContent : hasContent ? message.content : undefined,
    isRecovered: false,
    isIncomplete: false,
    subtaskId: message.subtaskId,
    // Pass thinking data for executor tasks (Claude Code, etc.)
    thinking: message.thinking as Message['thinking'],
    // Pass result with shell_type for component selection
    result: message.result,
  };

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
    />
  );
}

interface MessagesAreaProps {
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  onShareButtonRender?: (button: React.ReactNode) => void;
  onContentChange?: () => void;
  onSendMessage?: (content: string) => void;
  isGroupChat?: boolean;
  onRetry?: (message: Message) => void;
  // Correction mode props
  enableCorrectionMode?: boolean;
  correctionModelId?: string | null;
  enableCorrectionWebSearch?: boolean;
}

export default function MessagesArea({
  selectedTeam,
  selectedRepo,
  selectedBranch,
  onContentChange,
  onShareButtonRender,
  onSendMessage,
  isGroupChat = false,
  onRetry,
  enableCorrectionMode = false,
  correctionModelId = null,
  enableCorrectionWebSearch = false,
}: MessagesAreaProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const { selectedTaskDetail, refreshSelectedTaskDetail, refreshTasks, setSelectedTask } =
    useTaskContext();
  const { theme } = useTheme();
  const { user } = useUser();
  const { traceAction } = useTraceAction();

  // Use unified messages hook - SINGLE SOURCE OF TRUTH
  const { messages, streamingSubtaskIds } = useUnifiedMessages({
    team: selectedTeam || null,
    isGroupChat,
  });

  // Task share modal state
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isExportingDocx, setIsExportingDocx] = useState(false);

  // Group chat members panel state
  const [showMembersPanel, setShowMembersPanel] = useState(false);

  // Correction mode state
  const [correctionResults, setCorrectionResults] = useState<Map<number, CorrectionResponse>>(
    new Map()
  );
  const [correctionLoading, setCorrectionLoading] = useState<Set<number>>(new Set());
  // Track which messages have been attempted for correction to avoid infinite retry loops
  const [correctionAttempted, setCorrectionAttempted] = useState<Set<number>>(new Set());
  // Track applied corrections - maps subtaskId to the improved answer content
  const [appliedCorrections, setAppliedCorrections] = useState<Map<number, string>>(new Map());

  // Handle retry correction for a specific message
  const handleRetryCorrection = useCallback(
    async (subtaskId: number, originalQuestion: string, originalAnswer: string) => {
      if (!selectedTaskDetail?.id || !correctionModelId) return;

      // Remove from attempted set to allow retry
      setCorrectionAttempted(prev => {
        const next = new Set(prev);
        next.delete(subtaskId);
        return next;
      });

      // Remove old correction result
      setCorrectionResults(prev => {
        const next = new Map(prev);
        next.delete(subtaskId);
        return next;
      });

      // Set loading state
      setCorrectionLoading(prev => new Set(prev).add(subtaskId));

      try {
        const result = await correctionApis.correctResponse({
          task_id: selectedTaskDetail.id,
          message_id: subtaskId,
          original_question: originalQuestion,
          original_answer: originalAnswer,
          correction_model_id: correctionModelId,
          force_retry: true, // Force re-evaluation even if correction exists
          enable_web_search: enableCorrectionWebSearch,
        });

        setCorrectionResults(prev => new Map(prev).set(subtaskId, result));
      } catch (error) {
        console.error('Retry correction failed:', error);
        toast({
          variant: 'destructive',
          title: 'Correction failed',
          description: (error as Error)?.message || 'Unknown error',
        });
      } finally {
        setCorrectionLoading(prev => {
          const next = new Set(prev);
          next.delete(subtaskId);
          return next;
        });
      }
    },
    [selectedTaskDetail?.id, correctionModelId, enableCorrectionWebSearch, toast]
  );

  // Load persisted correction data from subtask.result when task detail changes
  useEffect(() => {
    if (!selectedTaskDetail?.subtasks) return;

    const savedResults = new Map<number, CorrectionResponse>();

    selectedTaskDetail.subtasks.forEach(subtask => {
      // Only check assistant (AI) messages
      if (subtask.role !== 'ASSISTANT') return;

      // Extract correction data from subtask.result.correction
      const correction = extractCorrectionFromResult(subtask.result);
      if (correction) {
        savedResults.set(subtask.id, correctionDataToResponse(correction, subtask.id));
      }
    });

    // Only update if we found saved corrections
    if (savedResults.size > 0) {
      setCorrectionResults(prev => {
        // Merge with existing results (API results take precedence)
        const merged = new Map(savedResults);
        prev.forEach((value, key) => {
          merged.set(key, value);
        });
        return merged;
      });
    }
  }, [selectedTaskDetail?.subtasks]);

  // Trigger correction when AI message completes
  useEffect(() => {
    if (!enableCorrectionMode || !correctionModelId || !selectedTaskDetail?.id) return;

    // Find completed AI messages that haven't been corrected yet
    messages.forEach((msg, index) => {
      // Skip if not AI message, still streaming, or already corrected/loading
      if (msg.type !== 'ai' || msg.status === 'streaming') return;
      if (!msg.subtaskId) return;
      // Skip failed messages (status === 'error') - no need to correct failed responses
      if (msg.status === 'error') return;
      // Skip empty AI messages - nothing to correct
      if (!msg.content || !msg.content.trim()) return;
      // Skip if already has result, is loading, or has been attempted (to avoid infinite retry loops)
      if (
        correctionResults.has(msg.subtaskId) ||
        correctionLoading.has(msg.subtaskId) ||
        correctionAttempted.has(msg.subtaskId)
      )
        return;

      // Find the corresponding user message (previous message)
      const userMsg = index > 0 ? messages[index - 1] : null;
      if (!userMsg || userMsg.type !== 'user' || !userMsg.content) return;

      // Mark as attempted to prevent infinite retry loops
      const subtaskId = msg.subtaskId;
      setCorrectionAttempted(prev => new Set(prev).add(subtaskId));
      setCorrectionLoading(prev => new Set(prev).add(subtaskId));

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
          setCorrectionResults(prev => new Map(prev).set(subtaskId, result));
        })
        .catch(error => {
          console.error('Correction failed:', error);
          toast({
            variant: 'destructive',
            title: 'Correction failed',
            description: (error as Error)?.message || 'Unknown error',
          });
        })
        .finally(() => {
          setCorrectionLoading(prev => {
            const next = new Set(prev);
            next.delete(subtaskId);
            return next;
          });
        });
    });
  }, [
    enableCorrectionMode,
    correctionModelId,
    enableCorrectionWebSearch,
    messages,
    selectedTaskDetail?.id,
    toast,
    correctionAttempted, // Add this dependency so useEffect re-runs when retry button is clicked
  ]);

  // Handle task share
  const handleShareTask = useCallback(async () => {
    if (!selectedTaskDetail?.id) {
      toast({
        variant: 'destructive',
        title: tCommon('shared_task.no_task_selected'),
        description: tCommon('shared_task.no_task_selected_desc'),
      });
      return;
    }

    setIsSharing(true);
    await traceAction(
      'share-task',
      {
        'action.type': 'share',
        'task.title': selectedTaskDetail?.title || '',
        'task.status': selectedTaskDetail?.status || '',
      },
      async () => {
        try {
          const response = await taskApis.shareTask(selectedTaskDetail.id);
          setShareUrl(response.share_url);
          setShowShareModal(true);
        } catch (err) {
          console.error('Failed to share task:', err);
          toast({
            variant: 'destructive',
            title: tCommon('shared_task.share_failed'),
            description: (err as Error)?.message || tCommon('shared_task.share_failed_desc'),
          });
          throw err;
        } finally {
          setIsSharing(false);
        }
      }
    );
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.title,
    selectedTaskDetail?.status,
    toast,
    tCommon,
    traceAction,
  ]);

  // Load image data as base64 for embedding in PDF
  const loadImageAsBase64 = useCallback(
    async (attachmentId: number): Promise<string | undefined> => {
      try {
        const token = getToken();
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        });

        if (!response.ok) {
          console.warn(`Failed to load image ${attachmentId}: ${response.status}`);
          return undefined;
        }

        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result as string;
            const base64Data = base64.split(',')[1];
            resolve(base64Data);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (error) {
        console.warn(`Failed to load image ${attachmentId}:`, error);
        return undefined;
      }
    },
    []
  );

  // Handle PDF export
  const handleExportPdf = useCallback(async () => {
    if (!selectedTaskDetail?.id) {
      toast({
        variant: 'destructive',
        title: tCommon('shared_task.no_task_selected'),
        description: tCommon('shared_task.no_task_selected_desc'),
      });
      return;
    }

    setIsExportingPdf(true);
    await traceAction(
      'export-pdf',
      {
        'action.type': 'export',
        'export.format': 'pdf',
        'task.title': selectedTaskDetail?.title || '',
        'task.status': selectedTaskDetail?.status || '',
        'export.message_count': selectedTaskDetail?.subtasks?.length || 0,
      },
      async () => {
        try {
          const exportableMessages: SelectableMessage[] = selectedTaskDetail.subtasks
            ? await Promise.all(
                selectedTaskDetail.subtasks.map(async (sub: TaskDetailSubtask) => {
                  const isUser = sub.role === 'USER';
                  let content = sub.prompt || '';

                  if (!isUser && sub.result) {
                    if (typeof sub.result === 'object' && 'value' in sub.result) {
                      const value = (sub.result as { value?: unknown }).value;
                      if (typeof value === 'string') {
                        content = value;
                      } else if (value !== null && value !== undefined) {
                        content = JSON.stringify(value);
                      }
                    } else if (typeof sub.result === 'string') {
                      content = sub.result;
                    }
                  }

                  let attachmentsWithImages;
                  if (sub.attachments && sub.attachments.length > 0) {
                    attachmentsWithImages = await Promise.all(
                      sub.attachments.map(async att => {
                        const exportAtt = {
                          id: att.id,
                          filename: att.filename,
                          file_size: att.file_size,
                          file_extension: att.file_extension,
                          imageData: undefined as string | undefined,
                        };

                        if (isImageExtension(att.file_extension)) {
                          exportAtt.imageData = await loadImageAsBase64(att.id);
                        }

                        return exportAtt;
                      })
                    );
                  }

                  return {
                    id: sub.id,
                    type: isUser ? ('user' as const) : ('ai' as const),
                    content,
                    timestamp: new Date(sub.updated_at).getTime(),
                    botName: sub.bots?.[0]?.name || 'Bot',
                    userName: sub.sender_user_name || selectedTaskDetail?.user?.user_name,
                    teamName: selectedTaskDetail?.team?.name,
                    attachments: attachmentsWithImages,
                  };
                })
              )
            : [];

          const validMessages = exportableMessages.filter(msg => msg.content.trim() !== '');

          if (validMessages.length === 0) {
            toast({
              variant: 'destructive',
              title: t('export.no_messages') || 'No messages to export',
            });
            return;
          }

          await generateChatPdf({
            taskName:
              selectedTaskDetail?.title ||
              selectedTaskDetail?.prompt?.slice(0, 50) ||
              'Chat Export',
            messages: validMessages,
          });

          toast({
            title: t('export.success') || 'PDF exported successfully',
          });
        } catch (error) {
          console.error('Failed to export PDF:', error);
          toast({
            variant: 'destructive',
            title: t('export.failed') || 'Failed to export PDF',
            description: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          setIsExportingPdf(false);
        }
      }
    );
  }, [selectedTaskDetail, toast, t, tCommon, loadImageAsBase64, traceAction]);

  // Handle DOCX export
  const handleExportDocx = useCallback(async () => {
    if (!selectedTaskDetail?.id) {
      toast({
        variant: 'destructive',
        title: tCommon('shared_task.no_task_selected'),
        description: tCommon('shared_task.no_task_selected_desc'),
      });
      return;
    }

    setIsExportingDocx(true);
    await traceAction(
      'export-docx',
      {
        'action.type': 'export',
        'export.format': 'docx',
        'task.title': selectedTaskDetail?.title || '',
        'task.status': selectedTaskDetail?.status || '',
        'export.message_count': selectedTaskDetail?.subtasks?.length || 0,
      },
      async () => {
        try {
          const blob = await taskApis.exportTaskDocx(selectedTaskDetail.id);

          const url = window.URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${selectedTaskDetail.title || selectedTaskDetail.prompt?.slice(0, 50) || 'Chat_Export'}_${new Date().toISOString().split('T')[0]}.docx`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);

          toast({
            title: t('export.docx_success') || 'DOCX exported successfully',
          });
        } catch (error) {
          console.error('Failed to export DOCX:', error);
          toast({
            variant: 'destructive',
            title: t('export.docx_failed') || 'Failed to export DOCX',
            description: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          setIsExportingDocx(false);
        }
      }
    );
  }, [selectedTaskDetail, toast, t, tCommon, traceAction]);

  // Removed polling - relying entirely on WebSocket real-time updates
  // Task details will be updated via WebSocket events in taskContext

  // Notify parent component when content changes (for scroll management)
  useLayoutEffect(() => {
    if (onContentChange) {
      onContentChange();
    }
  }, [messages, onContentChange]);

  // Handle user leaving group chat
  const handleLeaveGroupChat = useCallback(() => {
    setSelectedTask(null);
  }, [setSelectedTask]);

  // Handle members changed in group chat panel
  const handleMembersChanged = useCallback(() => {
    // Refresh both task list (to move task to correct category)
    // and task detail (to update is_group_chat flag and enable @ feature)
    refreshTasks();
    refreshSelectedTaskDetail(false);
  }, [refreshTasks, refreshSelectedTaskDetail]);

  // Memoize share and export buttons
  const shareButton = useMemo(() => {
    if (!selectedTaskDetail?.id || messages.length === 0) {
      return null;
    }

    const isGroupChatTask = selectedTaskDetail?.is_group_chat || false;
    const isChatAgentType = selectedTaskDetail?.team?.agent_type === 'chat';
    const showMembersButton = isGroupChatTask || isChatAgentType;

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
            {t('groupChat.members.title') || 'Members'}
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
            {isSharing ? tCommon('shared_task.sharing') : tCommon('shared_task.share_link')}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={isExportingPdf || isExportingDocx}
              className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
            >
              <Download className="h-3.5 w-3.5" />
              {t('export.export')}
              <ChevronDown className="h-3 w-3 ml-0.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-30">
            <DropdownMenuItem
              onClick={handleExportPdf}
              disabled={isExportingPdf}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>
                {isExportingPdf
                  ? t('export.exporting') || 'Exporting...'
                  : tCommon('shared_task.share_pdf')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleExportDocx}
              disabled={isExportingDocx}
              className="flex items-center gap-2 cursor-pointer"
            >
              <FileText className="h-4 w-4" />
              <span>
                {isExportingDocx
                  ? t('export.exporting_docx') || 'Exporting DOCX...'
                  : t('export.export_docx') || 'Export DOCX'}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const feedbackUrl =
                process.env.NEXT_PUBLIC_FEEDBACK_URL ||
                'https://github.com/wecode-ai/wegent/issues/new';
              window.open(feedbackUrl, '_blank');
            }}
            className="flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {tCommon('navigation.feedback')}
          </Button>
        </DropdownMenu>
      </div>
    );
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.is_group_chat,
    selectedTaskDetail?.team?.agent_type,
    messages.length,
    isSharing,
    isExportingPdf,
    isExportingDocx,
    handleShareTask,
    handleExportPdf,
    handleExportDocx,
    t,
    tCommon,
  ]);

  // Pass share button to parent for rendering in TopNavigation
  useEffect(() => {
    if (onShareButtonRender) {
      onShareButtonRender(shareButton);
    }
  }, [onShareButtonRender, shareButton]);

  // Convert DisplayMessage to Message format for MessageBubble
  const convertToMessage = useCallback(
    (msg: DisplayMessage): Message => {
      // For AI messages, check if there's an applied correction to use instead
      let content = msg.content;
      if (msg.type === 'ai') {
        // Check if this message has an applied correction
        const appliedContent = msg.subtaskId ? appliedCorrections.get(msg.subtaskId) : undefined;
        if (appliedContent) {
          content = '${$$}$' + appliedContent;
        } else {
          content = '${$$}$' + msg.content;
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
        senderUserName: msg.senderUserName,
        senderUserId: msg.senderUserId,
        shouldShowSender: msg.shouldShowSender,
        thinking: msg.thinking as Message['thinking'],
        result: msg.result, // Include result with shell_type for component selection
        recoveredContent: msg.recoveredContent,
        isRecovered: msg.isRecovered,
        isIncomplete: msg.isIncomplete,
        status: msg.status,
        error: msg.error,
      };
    },
    [appliedCorrections]
  );

  return (
    <div
      className="flex-1 w-full max-w-3xl mx-auto flex flex-col"
      data-chat-container="true"
      translate="no"
    >
      {/* Messages Area */}
      {(messages.length > 0 || streamingSubtaskIds.length > 0 || selectedTaskDetail?.id) && (
        <div className="flex-1 space-y-8 messages-container">
          {messages.map((msg, index) => {
            const messageKey = msg.subtaskId
              ? `${msg.type}-${msg.subtaskId}`
              : `msg-${index}-${msg.timestamp}`;

            // Determine if this is the current user's message (for group chat alignment)
            const isCurrentUserMessage =
              msg.type === 'user' ? (isGroupChat ? msg.senderUserId === user?.id : true) : false;

            // Check if this AI message has a correction result
            const hasCorrectionResult =
              msg.type === 'ai' &&
              msg.subtaskId !== undefined &&
              correctionResults.has(msg.subtaskId);
            const isCorrecting =
              msg.type === 'ai' &&
              msg.subtaskId !== undefined &&
              correctionLoading.has(msg.subtaskId);
            const correctionResult = msg.subtaskId
              ? correctionResults.get(msg.subtaskId)
              : undefined;

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
                />
              );
            }

            // For AI messages with correction mode enabled, render side by side
            if (
              msg.type === 'ai' &&
              enableCorrectionMode &&
              (hasCorrectionResult || isCorrecting)
            ) {
              // Find the corresponding user message (previous message)
              const userMsg = index > 0 ? messages[index - 1] : null;
              const originalQuestion = userMsg?.content || '';

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
                  />
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
                        ? () => handleRetryCorrection(msg.subtaskId!, originalQuestion, msg.content)
                        : undefined
                    }
                    subtaskId={msg.subtaskId}
                    onApply={(improvedAnswer: string) => {
                      // Update the local state to immediately show the improved answer
                      if (msg.subtaskId) {
                        setAppliedCorrections(prev =>
                          new Map(prev).set(msg.subtaskId!, improvedAnswer)
                        );
                      }
                    }}
                  />
                </div>
              );
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
              />
            );
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
  );
}
