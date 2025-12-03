// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useEffect, useLayoutEffect } from 'react';
import { useTaskContext } from '../contexts/taskContext';
import type {
  TaskDetail,
  TaskDetailSubtask,
  Team,
  GitRepoInfo,
  GitBranch,
  Attachment,
} from '@/types/api';
import { Bot, Copy, Check, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTypewriter } from '@/hooks/useTypewriter';
import MessageBubble, { type Message } from './MessageBubble';
import AttachmentPreview from './AttachmentPreview';
import { useState } from 'react';

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
  /** Pending attachment for optimistic update */
  pendingAttachment?: Attachment | null;
  /** Callback to notify parent when content changes and scroll may be needed */
  onContentChange?: () => void;
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
}: MessagesAreaProps) {
  const { t } = useTranslation('chat');
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext();
  const { theme } = useTheme();

  // Use Typewriter effect for streaming content
  const displayContent = useTypewriter(streamingContent || '');

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

  // Calculate messages from taskDetail
  function generateTaskMessages(detail: TaskDetail | null): Message[] {
    if (!detail) return [];
    const messages: Message[] = [];

    // When subtasks exist, synthesize according to useTaskActionData logic
    if (Array.isArray(detail.subtasks) && detail.subtasks.length > 0) {
      detail.subtasks.forEach((sub: TaskDetailSubtask) => {
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
        });
      });
    }

    return messages;
  }

  const displayMessages = generateTaskMessages(selectedTaskDetail);

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

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col" data-chat-container="true">
      {/* Messages Area - only shown when there are messages or loading */}
      {(displayMessages.length > 0 || pendingUserMessage || isStreaming) && (
        <div className="flex-1 space-y-8 messages-container">
          {displayMessages.map((msg, index) => (
            <MessageBubble
              key={msg.subtaskId || `msg-${index}-${msg.timestamp}`}
              msg={msg}
              index={index}
              selectedTaskDetail={selectedTaskDetail}
              selectedTeam={selectedTeam}
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
              theme={theme as 'light' | 'dark'}
              t={t}
            />
          ))}

          {/* Pending user message (optimistic update) */}
          {pendingUserMessage && (
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

          {/* Streaming AI response */}
          {(isStreaming || streamingContent) && streamingContent !== undefined && (
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
                  {isStreaming && <span className="animate-pulse text-primary">▊</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
