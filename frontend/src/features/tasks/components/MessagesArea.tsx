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
import { Bot, Copy, Check, Download, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { useToast } from '@/hooks/use-toast';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTypewriter } from '@/hooks/useTypewriter';
import { useMultipleStreamingRecovery, type RecoveryState } from '@/hooks/useStreamingRecovery';
import MessageBubble, { type Message } from './MessageBubble';
import AttachmentPreview from './AttachmentPreview';
import TaskShareModal from './TaskShareModal';
import { taskApis } from '@/apis/tasks';

interface ResultWithThinking {
  thinking?: unknown[];
  value?: unknown;
}

// CopyButton component for copying markdown content
const CopyButton = ({ content, className }: { content: string; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation('chat');

  const handleCopy = async () => {
    // Prefer using Clipboard API
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    }

    // Fallback: use document.execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Fallback copy failed: ', err);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={className ?? 'h-8 w-8 hover:bg-muted'}
      title={t('messages.copy_markdown')}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 text-text-muted" />
      )}
    </Button>
  );
};

// Bubble toolbar: supports copy button and extensible tool buttons
const BubbleTools = ({
  contentToCopy,
  tools = [],
}: {
  contentToCopy: string;
  tools?: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    onClick: () => void;
  }>;
}) => {
  return (
    <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
      <CopyButton content={contentToCopy} />
      {tools.map(tool => (
        <Button
          key={tool.key}
          variant="ghost"
          size="icon"
          onClick={tool.onClick}
          title={tool.title}
          className="h-8 w-8 hover:bg-muted"
        >
          {tool.icon}
        </Button>
      ))}
    </div>
  );
};
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
}: MessagesAreaProps) {
  const { t } = useTranslation('chat');
  const { toast } = useToast();
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext();
  const { theme } = useTheme();

  // Task share modal state
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [isSharing, setIsSharing] = useState(false);

  // Use Typewriter effect for streaming content
  const displayContent = useTypewriter(streamingContent || '');

  // Handle task share - wrapped in useCallback to prevent infinite loops
  const handleShareTask = useCallback(async () => {
    if (!selectedTaskDetail?.id) {
      toast({
        variant: 'destructive',
        title: t('shared_task.no_task_selected'),
        description: t('shared_task.no_task_selected_desc'),
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
        title: t('shared_task.share_failed'),
        description: (err as Error)?.message || t('shared_task.share_failed_desc'),
      });
    } finally {
      setIsSharing(false);
    }
  }, [selectedTaskDetail?.id, toast, t]);

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

  // Memoize share button to prevent infinite re-renders
  const shareButton = useMemo(() => {
    if (!selectedTaskDetail?.id || displayMessages.length === 0) {
      return null;
    }

    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleShareTask}
        disabled={isSharing}
        className="flex items-center gap-2"
      >
        <Share2 className="h-4 w-4" />
        {isSharing ? t('shared_task.sharing') : t('shared_task.share_task')}
      </Button>
    );
  }, [selectedTaskDetail?.id, displayMessages.length, isSharing, handleShareTask, t]);

  // Pass share button to parent for rendering in TopNavigation
  useEffect(() => {
    if (onShareButtonRender) {
      onShareButtonRender(shareButton);
    }
  }, [onShareButtonRender, shareButton]);

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col" data-chat-container="true">
      {/* Messages Area - only shown when there are messages or loading */}
      {(displayMessages.length > 0 || pendingUserMessage || isStreaming) && (
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
              />
            );
          })}

          {/* Pending user message (optimistic update) - only show if not already in displayMessages */}
          {pendingUserMessage && !isPendingMessageAlreadyDisplayed && (
            <div className="flex justify-end my-6">
              <div className="flex max-w-[75%] w-auto flex-col gap-3 items-end">
                <div className="relative group w-full p-5 pb-10 rounded-2xl border border-border text-text-primary shadow-sm bg-muted">
                  {/* Show pending attachment */}
                  {pendingAttachment && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      <AttachmentPreview
                        attachment={pendingAttachment}
                        compact={false}
                        showDownload={false}
                      />
                    </div>
                  )}
                  <div className="text-sm break-all">{pendingUserMessage}</div>
                </div>
              </div>
            </div>
          )}

          {/* Streaming AI response - only show if not already in displayMessages */}
          {(isStreaming || streamingContent) &&
            streamingContent !== undefined &&
            !isStreamingContentAlreadyDisplayed && (
              <div className="flex justify-start">
                <div className="flex w-full flex-col gap-3 items-start">
                  <div className="relative group w-full p-5 pb-10 rounded-2xl border border-border text-text-primary shadow-sm bg-surface">
                    <div className="flex items-center gap-2 mb-2 text-xs opacity-80">
                      <Bot className="w-4 h-4" />
                      <span className="font-semibold">
                        {selectedTeam?.name || t('messages.bot') || 'Bot'}
                      </span>
                    </div>
                    {displayContent ? (
                      <>
                        <MarkdownEditor.Markdown
                          source={displayContent}
                          style={{ background: 'transparent' }}
                          wrapperElement={{ 'data-color-mode': theme }}
                          components={{
                            a: ({ href, children, ...props }) => (
                              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                                {children}
                              </a>
                            ),
                          }}
                        />
                        {/* Show copy button when streaming is complete */}
                        {!isStreaming && (
                          <BubbleTools
                            contentToCopy={streamingContent || ''}
                            tools={[
                              {
                                key: 'download',
                                title: t('messages.download') || 'Download',
                                icon: <Download className="h-4 w-4 text-text-muted" />,
                                onClick: () => {
                                  const blob = new Blob([streamingContent || ''], {
                                    type: 'text/plain;charset=utf-8',
                                  });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = 'message.md';
                                  a.click();
                                  URL.revokeObjectURL(url);
                                },
                              },
                            ]}
                          />
                        )}
                      </>
                    ) : (
                      <div className="flex items-center gap-2 text-text-muted">
                        <span className="animate-pulse">●</span>
                        <span className="text-sm">{t('messages.thinking') || 'Thinking...'}</span>
                      </div>
                    )}
                    {/* Blinking cursor - only show when actively streaming */}
                    {isStreaming && (
                      <div className="absolute bottom-2 left-2 z-10 h-8 flex items-center px-2">
                        <span className="animate-pulse text-primary">▊</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
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
