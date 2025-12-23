// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTaskContext } from '../contexts/taskContext';
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
import TaskShareModal from './TaskShareModal';
import { taskApis } from '@/apis/tasks';
import { type SelectableMessage } from './ExportPdfButton';
import { generateChatPdf } from '@/utils/pdf';
import { getAttachmentPreviewUrl, isImageExtension } from '@/apis/attachments';
import { getToken } from '@/apis/user';
import { TaskMembersPanel } from './group-chat';
import { useUser } from '@/features/common/UserContext';
import { useUnifiedMessages, type DisplayMessage } from '../hooks/useUnifiedMessages';
import { useTraceAction } from '@/hooks/useTraceAction';

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
}

export default function MessagesArea({
  selectedTeam,
  selectedRepo,
  selectedBranch,
  onContentChange,
  onShareButtonRender,
  onSendMessage,
  isGroupChat = false,
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

  // Check if team uses Chat Shell (streaming mode, no polling needed)
  const effectiveTeam = selectedTaskDetail?.id
    ? selectedTaskDetail?.team || selectedTeam || null
    : selectedTeam || selectedTaskDetail?.team || null;
  const isChatShell = effectiveTeam?.agent_type?.toLowerCase() === 'chat';

  // Auto-refresh for non-Chat Shell tasks
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    if (isChatShell) return;

    if (
      selectedTaskDetail?.id &&
      selectedTaskDetail.status !== 'COMPLETED' &&
      selectedTaskDetail.status !== 'FAILED' &&
      selectedTaskDetail.status !== 'CANCELLED'
    ) {
      intervalId = setInterval(() => {
        refreshSelectedTaskDetail(true);
      }, 5000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [selectedTaskDetail?.id, selectedTaskDetail?.status, refreshSelectedTaskDetail, isChatShell]);

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
            className="flex items-center gap-2"
          >
            <Users className="h-4 w-4" />
            {t('groupChat.members.title') || 'Members'}
          </Button>
        )}

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

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const feedbackUrl =
                process.env.NEXT_PUBLIC_FEEDBACK_URL ||
                'https://github.com/wecode-ai/wegent/issues/new';
              window.open(feedbackUrl, '_blank');
            }}
            className="flex items-center gap-2"
          >
            <MessageSquare className="h-4 w-4" />
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
  const convertToMessage = useCallback((msg: DisplayMessage): Message => {
    // For AI messages, format content with separator
    let content = msg.content;
    if (msg.type === 'ai') {
      content = '${$$}$' + msg.content;
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
      recoveredContent: msg.recoveredContent,
      isRecovered: msg.isRecovered,
      isIncomplete: msg.isIncomplete,
    };
  }, []);

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
