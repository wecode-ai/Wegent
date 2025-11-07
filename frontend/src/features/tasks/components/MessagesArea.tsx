// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { RiRobot2Line, RiUser3Line } from 'react-icons/ri'
import { FiCopy, FiCheck, FiTool, FiExternalLink, FiDownload } from 'react-icons/fi'
import { Button } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import MarkdownEditor from '@uiw/react-markdown-editor'
import { useTheme } from '@/features/theme/ThemeProvider'
import ThinkingComponent from './ThinkingComponent'

interface Message {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
  thinking?: any[] | null
}

// CopyButton component for copying markdown content
const CopyButton = ({ content, className }: { content: string, className?: string }) => {
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
      type="text"
      onClick={handleCopy}
      className={className ?? ''}
      // className="absolute bottom-0 left-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
      title={t('messages.copy_markdown')}
      icon={
        copied
          ? <FiCheck className="w-4 h-4 text-green-400" />
          : <FiCopy className="w-4 h-4 text-gray-400 hover:text-white" />
      }
      style={{
          padding: '4px',
          height: 'auto',
          minWidth: 'auto',
          borderRadius: '4px'
      }}
    />
  );
}

    // Bubble toolbar: supports copy button and extensible tool buttons
const BubbleTools = ({
  contentToCopy,
  tools = [],
}: {
  contentToCopy: string,
  tools?: Array<{
    key: string,
    title: string,
    icon: React.ReactNode,
    onClick: () => void
  }>
}) => {
  return (
    <div className="absolute bottom-1 left-2 flex items-center gap-1 z-10">
      <CopyButton content={contentToCopy} />
      {tools.map(tool => (
        <Button
          key={tool.key}
          type="text"
          onClick={tool.onClick}
          title={tool.title}
          icon={tool.icon}
          className=""
          style={{
            padding: '4px',
            height: 'auto',
            minWidth: 'auto',
            borderRadius: '4px'
          }}
        />
      ))}
    </div>
  );
}

export default function MessagesArea() {
  const { t } = useTranslation('chat')
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext()
  const { theme } = useTheme()
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollStateRef = useRef<{ scrollTop: number, scrollHeight: number }>({ scrollTop: 0, scrollHeight: 0 })
  const isUserNearBottomRef = useRef(true)
  const AUTO_SCROLL_THRESHOLD = 32

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

        // Only auto-refresh when the task exists and is not completed
    if (selectedTaskDetail?.id && selectedTaskDetail.status !== 'COMPLETED' && selectedTaskDetail.status !== 'FAILED' && selectedTaskDetail.status !== 'CANCELLED') {
      intervalId = setInterval(() => {
        refreshSelectedTaskDetail(true); // This is auto-refresh
      }, 5000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    }
  }, [selectedTaskDetail?.id, selectedTaskDetail?.status, refreshSelectedTaskDetail])

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
        let thinkingData = null;

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
          
          // Debug: log the result structure
          console.log('Subtask result:', result);
          
          if (result) {
            if (typeof result === 'object') {
              // Check for new data structure with thinking and value
              if (result.thinking && Array.isArray(result.thinking)) {
                thinkingData = result.thinking;
              }
              // Also check if thinking might be in a nested structure
              else if (result.value && typeof result.value === 'object' && result.value.thinking) {
                thinkingData = result.value.thinking;
              }
              // Check if thinking is in a string that needs to be parsed
              else if (typeof result.value === 'string') {
                try {
                  const parsedValue = JSON.parse(result.value);
                  if (parsedValue.thinking && Array.isArray(parsedValue.thinking)) {
                    thinkingData = parsedValue.thinking;
                  }
                } catch (e) {
                  // Not valid JSON, ignore
                }
              }
              
              aiContent = result && 'value' in result
                ? (result.value !== null && result.value !== undefined && result.value !== ''
                  ? String(result.value)
                  : `__PROGRESS_BAR__:${sub.status}:${sub.progress}`)
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
          botName: (detail?.team?.workflow?.mode !== "pipeline" && detail?.team?.name?.trim()) ? detail.team.name : (sub?.bots?.[0]?.name?.trim() || 'Bot'),
          thinking: thinkingData,
        });
      });
    }
    return messages;
  }
  
  const displayMessages = generateTaskMessages(selectedTaskDetail);

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const updateScrollMeta = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      scrollStateRef.current = {
        scrollTop,
        scrollHeight,
      }
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
    }

    const handleScroll = () => {
      updateScrollMeta()
    }

    container.addEventListener('scroll', handleScroll)

    // Initialize stored values
    updateScrollMeta()

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [selectedTaskDetail?.id, displayMessages.length > 0, AUTO_SCROLL_THRESHOLD])

  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const previous = scrollStateRef.current
    const shouldStickToBottom = isUserNearBottomRef.current

    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight
    } else {
      container.scrollTop = previous.scrollTop
    }

    scrollStateRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
  }, [displayMessages, AUTO_SCROLL_THRESHOLD])

  const renderProgressBar = (status: string, progress: number) => {
    const normalizedStatus = (status ?? '').toUpperCase()
    const isActiveStatus = ['RUNNING', 'PENDING', 'PROCESSING'].includes(normalizedStatus)
    const safeProgress = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 100) : 0

    return (
      <div className="mt-2">
        <div className="flex justify-between items-center mb-1">
          <span className="text-sm">
            {t('messages.task_status')} {status}
          </span>
        </div>
        <div className="w-full bg-border/60 rounded-full h-2">
          <div
            className={`bg-primary h-2 rounded-full transition-all duration-300 ease-in-out ${isActiveStatus ? 'progress-bar-animated' : ''}`}
            style={{ width: `${safeProgress}%` }}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={safeProgress}
            role="progressbar"
          ></div>
        </div>
      </div>
    )
  };

  const renderMarkdownResult = (rawResult: string, promptPart?: string) => {
    const trimmed = (rawResult ?? '').trim();
    const fencedMatch = trimmed.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/);
    const normalizedResult = fencedMatch ? fencedMatch[1] : trimmed;

    const progressMatch = normalizedResult.match(/^__PROGRESS_BAR__:(.*?):(\d+)$/);
    if (progressMatch) {
      const status = progressMatch[1];
      const progress = parseInt(progressMatch[2], 10) || 0;
      return renderProgressBar(status, progress);
    }

    return (
      <>
        <MarkdownEditor.Markdown
          source={normalizedResult}
          style={{ background: 'transparent' }}
          wrapperElement={{ 'data-color-mode': theme }}
          components={{
            a: ({ href, children, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            )
          }}
        />
        <BubbleTools
          contentToCopy={`${promptPart ? (promptPart + '\n\n') : ''}${normalizedResult}`}
          tools={[
            {
              key: 'download',
              title: t('messages.download') || 'Download',
              icon: <FiDownload className="w-4 h-4 text-gray-400 hover:text-white" />,
              onClick: () => {
                const blob = new Blob([`${normalizedResult}`], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'message.md';
                a.click();
                URL.revokeObjectURL(url);
              }
            }
          ]}
        />
      </>
    );
  };

  const renderPlainMessage = (msg: Message) => (
    (msg.content?.split('\n') || []).map((line, idx) => {
      if (line.startsWith('__PROMPT_TRUNCATED__:')) {
        const match = line.match(/^__PROMPT_TRUNCATED__:(.*)::(.*)$/);
        if (match) {
          const shortPrompt = match[1];
          const fullPrompt = match[2];
          return (
            <span
              key={idx}
              className="text-sm font-bold cursor-pointer underline decoration-dotted block"
              title={fullPrompt}
            >
              {shortPrompt}
            </span>
          );
        }
      }

      const progressMatch = line.match(/__PROGRESS_BAR__:(.*?):(\d+)/);
      if (progressMatch) {
        const status = progressMatch[1];
        const progress = parseInt(progressMatch[2], 10) || 0;
        return renderProgressBar(status, progress);
      }

      return (
        <div key={idx} className="group pb-4">
          {idx === 0 && (
            <BubbleTools
              contentToCopy={msg.content}
              tools={[]}
            />
          )}
          <div className="text-sm break-all">
            {line}
          </div>
        </div>
      );
    })
  );

  const renderAiMessage = (msg: Message) => {
    const content = msg.content ?? '';
    if (!content.includes('${$$}$')) {
      return renderPlainMessage(msg);
    }

    const [prompt, result] = content.split('${$$}$');
    return (
      <>
        {prompt && (
          <div className="text-sm whitespace-pre-line mb-2">
            {prompt}
          </div>
        )}
        {result && renderMarkdownResult(result, prompt)}
      </>
    );
  };

  const renderMessageBody = (msg: Message) => (
    msg.type === 'ai' ? renderAiMessage(msg) : renderPlainMessage(msg)
  );

  const formatTimestamp = (timestamp: number | undefined) => {
    if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return ''
    return new Date(timestamp).toLocaleTimeString(navigator.language, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  }

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col" data-chat-container="true">
      {/* Messages Area - only shown when there are messages or loading */}
      {(displayMessages.length > 0) && (
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto mb-4 space-y-4 messages-container custom-scrollbar"
        >
          {displayMessages.map((msg, index) => {
            const bubbleBaseClasses = 'relative group w-full p-3 pb-8 rounded-lg border border-border text-text-primary'
            const bubbleTypeClasses = msg.type === 'user' ? 'bg-muted my-6' : 'bg-surface'
            const isUserMessage = msg.type === 'user'
            const timestampLabel = formatTimestamp(msg.timestamp)
            const headerIcon = isUserMessage ? (
              <RiUser3Line className="w-4 h-4" />
            ) : (
              <RiRobot2Line className="w-4 h-4" />
            )
            const headerLabel = isUserMessage
              ? ''
              : (msg.botName || t('messages.bot') || 'Bot')

            return (
              <div key={index} className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex ${isUserMessage ? 'w-3/4 sm:w-2/3 md:w-1/2' : 'w-full'} flex-col gap-3 ${isUserMessage ? 'items-end' : 'items-start'}`}>
                  {msg.type === 'ai' && msg.thinking && (
                    <ThinkingComponent thinking={msg.thinking} taskStatus={selectedTaskDetail?.status} />
                  )}
                  <div className={`${bubbleBaseClasses} ${bubbleTypeClasses}`}>
                    <div className="flex items-center gap-2 mb-2 text-xs opacity-80">
                      {headerIcon}
                      <span className="font-semibold">{headerLabel}</span>
                      {timestampLabel && <span>{timestampLabel}</span>}
                    </div>
                    {renderMessageBody(msg)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
