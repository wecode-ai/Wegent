// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTaskContext } from '../contexts/taskContext';
import type {
  TaskDetail,
  TaskDetailSubtask,
  Team,
  GitRepoInfo,
  GitBranch,
  Attachment,
} from '@/types/api';
import { Share2, FileText, ChevronDown, Download } from 'lucide-react';
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
import { useMultipleStreamingRecovery, type RecoveryState } from '@/hooks/useStreamingRecovery';
import MessageBubble, { type Message } from './MessageBubble';
import TaskShareModal from './TaskShareModal';
import { taskApis } from '@/apis/tasks';
import { type SelectableMessage } from './ExportPdfButton';
import { generateChatPdf } from '@/utils/pdf-generator';
import { getAttachmentPreviewUrl, isImageExtension } from '@/apis/attachments';
import { getToken } from '@/apis/user';

interface ResultWithThinking {
  thinking?: unknown[];
  value?: unknown;
}

/**
 * Component to render a recovered message with typewriter effect.
 * This is a separate component because hooks cannot be used in loops.
 */
interface RecoveredMessageBubbleProps {
  msg: Message;
  index: number;
  recovery: RecoveryState;
  selectedTaskDetail: TaskDetail | null;
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  theme: 'light' | 'dark';
  t: (key: string) => string;
  /** Generic callback when a component inside the message bubble wants to send a message */
  onSendMessage?: (content: string) => void;
}

function RecoveredMessageBubble({
  msg,
  index,
  recovery,
  selectedTaskDetail,
  selectedTeam,
  selectedRepo,
  selectedBranch,
  theme,
  t,
  onSendMessage,
}: RecoveredMessageBubbleProps) {
  // Use typewriter effect for recovered content that is still streaming
  const displayContent = useTypewriter(recovery.content || '');

  // Create a modified message with the typewriter-processed content
  const modifiedMsg: Message = {
    ...msg,
    // Replace recoveredContent with typewriter-processed content
    recoveredContent: recovery.streaming ? displayContent : recovery.content,
    isRecovered: true,
    isIncomplete: recovery.incomplete,
  };

  return (
    <MessageBubble
      msg={modifiedMsg}
      index={index}
      selectedTaskDetail={selectedTaskDetail}
      selectedTeam={selectedTeam}
      selectedRepo={selectedRepo}
      selectedBranch={selectedBranch}
      theme={theme}
      t={t}
      onSendMessage={onSendMessage}
    />
  );
}

interface MessagesAreaProps {
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  /** Streaming content for Chat Shell (optional) */
  streamingContent?: string;
  /** Whether streaming is in progress */
  isStreaming?: boolean;
  /** Pending user message for optimistic update */
  pendingUserMessage?: string | null;
  /** Callback to render share button in parent component (e.g., TopNavigation) */
  onShareButtonRender?: (button: React.ReactNode) => void;
  /** Pending attachment for optimistic update */
  pendingAttachment?: Attachment | null;
  /** Callback to notify parent when content changes and scroll may be needed */
  onContentChange?: () => void;
  /** Current streaming subtask ID (for deduplication) */
  streamingSubtaskId?: number | null;
  /** Generic callback when a component inside the message bubble wants to send a message */
  onSendMessage?: (content: string) => void;
}

export default function MessagesArea({
  selectedTeam,
  selectedRepo,
  selectedBranch,
  streamingContent,
  isStreaming,
  pendingUserMessage,
  pendingAttachment,
  onContentChange,
  streamingSubtaskId,
  onShareButtonRender,
  onSendMessage,
}: MessagesAreaProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext();
  const { theme } = useTheme();

  // Task share modal state
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isExportingDocx, setIsExportingDocx] = useState(false);

  // Use Typewriter effect for streaming content
  const displayContent = useTypewriter(streamingContent || '');

  // Handle task share - wrapped in useCallback to prevent infinite loops
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
    } finally {
      setIsSharing(false);
    }
  }, [selectedTaskDetail?.id, toast, tCommon]);

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
    try {
      // Generate exportable messages from task detail subtasks
      const exportableMessages: SelectableMessage[] = selectedTaskDetail.subtasks
        ? await Promise.all(
            selectedTaskDetail.subtasks.map(async (sub: TaskDetailSubtask) => {
              const isUser = sub.role === 'USER';
              let content = sub.prompt || '';

              // For AI messages, extract the result value
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

              // Load image data for attachments
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
                userName: selectedTaskDetail?.user?.user_name,
                teamName: selectedTaskDetail?.team?.name,
                attachments: attachmentsWithImages,
              };
            })
          )
        : [];

      // Filter out empty messages
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
          selectedTaskDetail?.title || selectedTaskDetail?.prompt?.slice(0, 50) || 'Chat Export',
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
    } finally {
      setIsExportingPdf(false);
    }
  }, [selectedTaskDetail, toast, t, tCommon, loadImageAsBase64]);

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
    try {
      // Call backend API
      const blob = await taskApis.exportTaskDocx(selectedTaskDetail.id);

      // Trigger download
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
    } finally {
      setIsExportingDocx(false);
    }
  }, [selectedTaskDetail, toast, t, tCommon]);

  // Check if team uses Chat Shell (streaming mode, no polling needed)
  // Case-insensitive comparison since backend may return 'chat' or 'Chat'
  const isChatShell = selectedTeam?.agent_type?.toLowerCase() === 'chat';

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    // Chat Shell uses streaming, no polling needed
    if (isChatShell) {
      return;
    }

    // Only auto-refresh when the task exists and is not completed
    if (
      selectedTaskDetail?.id &&
      selectedTaskDetail.status !== 'COMPLETED' &&
      selectedTaskDetail.status !== 'FAILED' &&
      selectedTaskDetail.status !== 'CANCELLED'
    ) {
      intervalId = setInterval(() => {
        refreshSelectedTaskDetail(true); // This is auto-refresh
      }, 5000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [selectedTaskDetail?.id, selectedTaskDetail?.status, refreshSelectedTaskDetail, isChatShell]);

  // Prepare subtasks for recovery check
  const subtasksForRecovery = useMemo(() => {
    if (!selectedTaskDetail?.subtasks) return null;
    return selectedTaskDetail.subtasks.map(sub => ({
      id: sub.id,
      status: sub.status,
      role: sub.role,
    }));
  }, [selectedTaskDetail?.subtasks]);

  // Get team ID for offset-based streaming recovery
  const teamId = selectedTeam?.id || selectedTaskDetail?.team?.id || null;

  // Use recovery hook to get streaming content for RUNNING subtasks
  // When stream completes, refresh task detail to update status
  // Pass streamingSubtaskId to prevent recovery for actively streaming subtasks
  const recoveryMap = useMultipleStreamingRecovery(
    subtasksForRecovery,
    teamId,
    () => {
      // Refresh task detail when any subtask stream completes
      refreshSelectedTaskDetail(false);
    },
    streamingSubtaskId
  );

  // Calculate messages from taskDetail
  // Now accepts isStreaming and streamingSubtaskId to filter out currently streaming subtask
  function generateTaskMessages(
    detail: TaskDetail | null,
    currentlyStreaming: boolean,
    currentStreamingSubtaskId: number | null
  ): Message[] {
    if (!detail) return [];
    const messages: Message[] = [];

    // When subtasks exist, synthesize according to useTaskActionData logic
    if (Array.isArray(detail.subtasks) && detail.subtasks.length > 0) {
      detail.subtasks.forEach((sub: TaskDetailSubtask) => {
        // Only skip AI subtasks that are currently streaming to avoid duplication
        // Always show user messages (role === 'USER') even if they match streamingSubtaskId
        // This ensures user messages are always visible
        if (
          sub.role !== 'USER' &&
          currentlyStreaming &&
          currentStreamingSubtaskId &&
          sub.id === currentStreamingSubtaskId
        ) {
          return;
        }

        const promptContent = sub.prompt || '';
        let content;
        let msgType: 'user' | 'ai';
        let thinkingData: Message['thinking'] = null;

        if (sub.role === 'USER') {
          msgType = 'user';
          content = promptContent;
        } else {
          msgType = 'ai';
          let truncated = false;
          let shortPrompt = promptContent;
          const MAX_PROMPT_LENGTH = 50;
          if (promptContent.length > MAX_PROMPT_LENGTH) {
            shortPrompt = promptContent.substring(0, MAX_PROMPT_LENGTH) + '...';
            truncated = true;
          }

          // Generate aiContent
          let aiContent;
          const result = sub.result;

          if (result) {
            if (typeof result === 'object') {
              const resultObj = result as ResultWithThinking;
              // Check for new data structure with thinking and value
              if (resultObj.thinking && Array.isArray(resultObj.thinking)) {
                thinkingData = resultObj.thinking as Message['thinking'];
              }
              // Also check if thinking might be in a nested structure
              else if (
                resultObj.value &&
                typeof resultObj.value === 'object' &&
                (resultObj.value as ResultWithThinking).thinking
              ) {
                thinkingData = (resultObj.value as ResultWithThinking)
                  .thinking as Message['thinking'];
              }
              // Check if thinking is in a string that needs to be parsed
              else if (typeof resultObj.value === 'string') {
                try {
                  const parsedValue = JSON.parse(resultObj.value) as ResultWithThinking;
                  if (parsedValue.thinking && Array.isArray(parsedValue.thinking)) {
                    thinkingData = parsedValue.thinking as Message['thinking'];
                  }
                } catch {
                  // Not valid JSON, ignore
                }
              }

              aiContent =
                result && 'value' in result
                  ? result.value !== null && result.value !== undefined && result.value !== ''
                    ? String(result.value)
                    : `__PROGRESS_BAR__:${sub.status}:${sub.progress}`
                  : result && 'thinking' in result
                    ? `__PROGRESS_BAR__:${sub.status}:${sub.progress}`
                    : JSON.stringify(result);
            } else {
              aiContent = String(result);
            }
          } else if (sub.status === 'COMPLETED') {
            aiContent = t('messages.subtask_completed');
          } else if (sub.status === 'FAILED') {
            aiContent = `${t('messages.subtask_failed')} ${sub.error_message || t('messages.unknown_error')}`;
          } else {
            aiContent = `__PROGRESS_BAR__:${sub.status}:${sub.progress}`;
          }

          // Merge prompt and aiContent, use special format when truncated
          if (truncated) {
            content = `__PROMPT_TRUNCATED__:${shortPrompt}::${promptContent}\${$$}$${aiContent}`;
          } else {
            content = `${promptContent}\${$$}$${aiContent}`;
          }
        }

        // Check if we have recovered content for this subtask
        const recovery = recoveryMap.get(sub.id);
        let recoveredContent: string | undefined;
        let isRecovered = false;
        let isIncomplete = false;

        if (recovery?.recovered && recovery.content) {
          recoveredContent = recovery.content;
          isRecovered = true;
          isIncomplete = recovery.incomplete;
        }

        messages.push({
          type: msgType,
          content: content,
          timestamp: new Date(sub.updated_at).getTime(),
          botName:
            detail?.team?.workflow?.mode !== 'pipeline' && detail?.team?.name?.trim()
              ? detail.team.name
              : sub?.bots?.[0]?.name?.trim() || 'Bot',
          thinking: thinkingData,
          subtaskStatus: sub.status, // Add subtask status
          subtaskId: sub.id, // Add subtask ID for stable key
          attachments: sub.attachments as Attachment[], // Add attachments
          recoveredContent, // Add recovered content if available
          isRecovered, // Flag to indicate this is recovered content
          isIncomplete, // Flag to indicate content is incomplete
        });
      });
    }

    return messages;
  }

  const displayMessages = generateTaskMessages(
    selectedTaskDetail,
    isStreaming || false,
    streamingSubtaskId || null
  );

  // Check if pending user message is already in displayMessages (to avoid duplication)
  // Check if pending user message is already in displayMessages (to avoid duplication)
  // This happens when refreshTasks() is called and the backend returns the message
  const isPendingMessageAlreadyDisplayed = useMemo(() => {
    if (!pendingUserMessage) return false;

    // IMPORTANT: Don't hide pending message while streaming is active
    // The user message subtask might be filtered out by streamingSubtaskId logic,
    // so we need to keep showing the pending message until streaming completes
    if (isStreaming) return false;

    // Check if ANY user message in displayMessages matches the pending message
    // This handles the case where the message might not be the last one
    const userMessages = displayMessages.filter(msg => msg.type === 'user');
    if (userMessages.length === 0) return false;

    const pendingTrimmed = pendingUserMessage.trim();
    // Check all user messages for a match
    // Use includes() as a fallback in case of minor formatting differences
    const isDisplayed = userMessages.some(msg => {
      const msgTrimmed = msg.content.trim();
      // Exact match
      if (msgTrimmed === pendingTrimmed) return true;
      // Check if one contains the other (handles cases where backend might add/remove whitespace)
      if (msgTrimmed.includes(pendingTrimmed) || pendingTrimmed.includes(msgTrimmed)) return true;
      return false;
    });

    return isDisplayed;
  }, [displayMessages, pendingUserMessage, isStreaming]);
  // Check if streaming content is already in displayMessages (to avoid duplication)
  // This happens when the stream completes and the backend returns the AI response
  const isStreamingContentAlreadyDisplayed = useMemo(() => {
    if (!streamingContent) return false;

    // If we have a streaming subtask ID, check if that specific subtask has completed content
    if (streamingSubtaskId) {
      const streamingSubtaskMessage = displayMessages.find(
        msg => msg.type === 'ai' && msg.subtaskId === streamingSubtaskId
      );
      if (streamingSubtaskMessage) {
        // Check if this subtask has actual content (not just progress bar)
        if (streamingSubtaskMessage.content && streamingSubtaskMessage.content.includes('${$$}$')) {
          const parts = streamingSubtaskMessage.content.split('${$$}$');
          if (parts.length >= 2) {
            const aiContent = parts[1];
            // If AI content is not empty and not a progress bar, it's already displayed
            if (aiContent && !aiContent.includes('__PROGRESS_BAR__')) {
              return true;
            }
          }
        }
        // Also check subtask status
        const subtaskStatus = streamingSubtaskMessage.subtaskStatus;
        if (subtaskStatus && subtaskStatus !== 'RUNNING' && subtaskStatus !== 'PENDING') {
          return true;
        }
      }
      // If the streaming subtask is not in displayMessages yet, don't hide streaming content
      return false;
    }

    // Fallback: check the last AI message (for backward compatibility)
    const aiMessages = displayMessages.filter(msg => msg.type === 'ai');
    if (aiMessages.length === 0) return false;
    const lastAiMessage = aiMessages[aiMessages.length - 1];
    // If the last AI message's subtask is completed (not RUNNING/PENDING),
    // the streaming content is already saved to backend
    const subtaskStatus = lastAiMessage.subtaskStatus;
    if (subtaskStatus && subtaskStatus !== 'RUNNING' && subtaskStatus !== 'PENDING') {
      return true;
    }
    // Also check if the content has actual AI response (not just progress bar)
    if (lastAiMessage.content && lastAiMessage.content.includes('${$$}$')) {
      const parts = lastAiMessage.content.split('${$$}$');
      if (parts.length >= 2) {
        const aiContent = parts[1];
        // If AI content is not empty and not a progress bar, it's already displayed
        if (aiContent && !aiContent.includes('__PROGRESS_BAR__')) {
          return true;
        }
      }
    }
    return false;
  }, [displayMessages, streamingContent, streamingSubtaskId]);

  // Notify parent component when content changes (for scroll management)
  useLayoutEffect(() => {
    if (onContentChange) {
      onContentChange();
    }
  }, [
    displayMessages,
    displayContent,
    pendingUserMessage,
    pendingAttachment,
    isStreaming,
    onContentChange,
  ]);

  // Memoize share and export buttons to prevent infinite re-renders
  const shareButton = useMemo(() => {
    if (!selectedTaskDetail?.id || displayMessages.length === 0) {
      return null;
    }

    return (
      <div className="flex items-center gap-2">
        {/* Share Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleShareTask}
          disabled={isSharing}
          className="flex items-center gap-2"
        >
          <Share2 className="h-4 w-4" />
          {isSharing ? tCommon('shared_task.sharing') : tCommon('shared_task.share_link')}
        </Button>

        {/* Export Button (Dropdown Menu) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={isExportingPdf || isExportingDocx}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
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
        </DropdownMenu>
      </div>
    );
  }, [
    selectedTaskDetail?.id,
    displayMessages.length,
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

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col" data-chat-container="true">
      {/* Messages Area - always render container to prevent layout shift */}
      {/* Show messages when: 1) has display messages, 2) has pending message, 3) is streaming, 4) has selected task (even if loading) */}
      {(displayMessages.length > 0 ||
        pendingUserMessage ||
        isStreaming ||
        selectedTaskDetail?.id) && (
        <div className="flex-1 space-y-8 messages-container">
          {displayMessages.map((msg, index) => {
            // Check if this message has recovery state and is still streaming
            const recovery = msg.subtaskId ? recoveryMap.get(msg.subtaskId) : undefined;

            // Generate a unique key combining subtaskId and message type to avoid duplicates
            // This handles cases where user and AI messages might share the same subtaskId
            const messageKey = msg.subtaskId
              ? `${msg.type}-${msg.subtaskId}`
              : `msg-${index}-${msg.timestamp}`;

            // Use RecoveredMessageBubble for messages with active recovery (streaming)
            if (recovery?.recovered && recovery.streaming) {
              return (
                <RecoveredMessageBubble
                  key={messageKey}
                  msg={msg}
                  index={index}
                  recovery={recovery}
                  selectedTaskDetail={selectedTaskDetail}
                  selectedTeam={selectedTeam}
                  selectedRepo={selectedRepo}
                  selectedBranch={selectedBranch}
                  theme={theme as 'light' | 'dark'}
                  t={t}
                  onSendMessage={onSendMessage}
                />
              );
            }

            // Use regular MessageBubble for other messages
            return (
              <MessageBubble
                key={messageKey}
                msg={msg}
                index={index}
                selectedTaskDetail={selectedTaskDetail}
                selectedTeam={selectedTeam}
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                theme={theme as 'light' | 'dark'}
                t={t}
                onSendMessage={onSendMessage}
              />
            );
          })}

          {/* Pending user message (optimistic update) - only show if not already in displayMessages */}
          {/* Use MessageBubble to ensure proper rendering of special formats like ClarificationAnswerSummary */}
          {pendingUserMessage && !isPendingMessageAlreadyDisplayed && (
            <MessageBubble
              key="pending-user-message"
              msg={{
                type: 'user',
                content: pendingUserMessage,
                timestamp: Date.now(),
                attachments: pendingAttachment ? [pendingAttachment] : undefined,
              }}
              index={displayMessages.length}
              selectedTaskDetail={selectedTaskDetail}
              selectedTeam={selectedTeam}
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
              theme={theme as 'light' | 'dark'}
              t={t}
              onSendMessage={onSendMessage}
            />
          )}

          {/* Streaming AI response - use MessageBubble component for consistency */}
          {/* Show waiting indicator inside MessageBubble when streaming but no content yet */}
          {(isStreaming || streamingContent) &&
            streamingContent !== undefined &&
            !isStreamingContentAlreadyDisplayed && (
              <MessageBubble
                key="streaming-message"
                msg={{
                  type: 'ai',
                  content: `\${$$}$${streamingContent || ''}`,
                  timestamp: Date.now(),
                  botName: selectedTeam?.name || t('messages.bot') || 'Bot',
                  subtaskStatus: 'RUNNING',
                  recoveredContent: displayContent,
                  isRecovered: false,
                  isIncomplete: false,
                }}
                index={displayMessages.length}
                selectedTaskDetail={selectedTaskDetail}
                selectedTeam={selectedTeam}
                selectedRepo={selectedRepo}
                selectedBranch={selectedBranch}
                theme={theme as 'light' | 'dark'}
                t={t}
                isWaiting={Boolean(isStreaming && !streamingContent)}
                onSendMessage={onSendMessage}
              />
            )}
        </div>
      )}
      {/* Task Share Modal */}
      <TaskShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        taskTitle={selectedTaskDetail?.title || 'Untitled Task'}
        shareUrl={shareUrl}
      />
    </div>
  );
}
