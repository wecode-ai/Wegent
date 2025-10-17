// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { RiRobot2Line } from 'react-icons/ri'
import { FiCopy, FiCheck, FiTool, FiExternalLink, FiDownload } from 'react-icons/fi'
import { Button } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import MarkdownEditor from '@uiw/react-markdown-editor'
import { useTheme } from '@/features/theme/ThemeProvider'

interface Message {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
}

// CopyButton component for copying markdown content
const CopyButton = ({ content, className }: { content: string, className?: string }) => {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

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
    <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
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
  const { t } = useTranslation('common')
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext()
  const { theme } = useTheme()

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
              aiContent = result && Object.keys(result).length === 1 && 'value' in result
                ? String(result.value)
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
        });
      });
    }
    return messages;
  }
  
  const displayMessages = generateTaskMessages(selectedTaskDetail);

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col">
      {/* Messages Area - only shown when there are messages or loading */}
      {(displayMessages.length > 0) && (
        <div className="flex-1 overflow-y-auto mb-4 space-y-4 messages-container custom-scrollbar">
          {displayMessages.map((msg, index) => (
            <div key={index} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`relative group max-w-[100%] p-3 rounded-lg ${msg.type === 'user'
                  ? 'bg-muted border border-border text-text-primary my-10'
                  : 'bg-surface border border-border text-text-primary'
                }`}>
                {/* Bot name and icon, only displayed for ai messages, and before the timestamp */}
                {msg.type === 'ai' && (
                  <div className="flex items-center mb-1 text-xs opacity-80">
                    <RiRobot2Line className="w-5 h-5 mr-1" />
                    <span className="font-semibold mr-2">{msg.botName || t('messages.bot')}</span>
                    <span>
                      {new Date(msg.timestamp ?? 0).toLocaleTimeString(navigator.language, {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
                      })}
                    </span>
                  </div>
                )}
                {/* Multi-line content support, split by ${$$}$ and render each line intelligently */}
                {/* Bot messages distinguish between Prompt and Result, Result is rendered with Markdown */}
                {msg.type === 'ai' && msg.content?.includes('${$$}$') ? (() => {
                  const [prompt, result] = msg.content.split('${$$}$');
                  return (
                    <>
                      {/* Prompt part, plain text */}
                      {prompt && (
                        <div className="text-sm whitespace-pre-line mb-2">
                          {prompt}
                        </div>
                      )}
                      {/* Result part, markdown rendering */}
                      {result && (
                        (() => {
                          // Prioritize progress bar handling
                          const progressMatch = result.match(/__PROGRESS_BAR__:(.*?):(\d+)/);
                          if (progressMatch) {
                            const status = progressMatch[1];
                            const progress = parseInt(progressMatch[2], 10) || 0;
                            return (
                              <div className="mt-2">
                                <div className="flex justify-between items-center mb-1">
                                  <span className="text-sm">{t('messages.task_status')} {status}</span>
                                </div>
                                <div className="w-full bg-border/60 rounded-full h-2">
                                  <div
                                    className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out"
                                    style={{ width: `${progress}%` }}
                                  ></div>
                                </div>
                              </div>
                            );
                          }
                          // Not a progress bar, normal markdown rendering
                          return (
                            <div className="group pb-8">
                              <div className="text-sm">
                                <div className="w-full" style={{ background: 'transparent' }}>
                                  {(() => {
                                        // ★ Normalize: if result is a complete fenced code block, unpack it
                                    const normalizedResult = (() => {
                                      const s = (result ?? '').trim();

                                          // Only match the case where the entire string is a fenced block:
                                          // ```markdown\n...\n``` or ```md\n...\n``` or ```\n...\n```
                                      const m = s.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/);
                                      if (m) return m[1];

                                      return s;
                                    })();

                                        // ★ Anchor progress bar matching to avoid false positives in main text
                                    const progressMatch = normalizedResult.match(/^__PROGRESS_BAR__:(.*?):(\d+)$/);
                                    if (progressMatch) {
                                      const status = progressMatch[1];
                                      const progress = parseInt(progressMatch[2], 10) || 0;
                                      return (
                                        <div className="mt-2">
                                          <div className="flex justify-between items-center mb-1">
                                            <span className="text-sm">{t('messages.task_status')} {status}</span>
                                          </div>
                                          <div className="w-full bg-border/60 rounded-full h-2">
                                            <div
                                              className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out"
                                              style={{ width: `${progress}%` }}
                                            />
                                          </div>
                                        </div>
                                      );
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
                                        {/* ★ Top floating toolbar: copy + extensible tools */}
                                        <BubbleTools
                                          contentToCopy={`${prompt ? (prompt + '\n\n') : ''}${normalizedResult}`}
                                          tools={[
                                            {
                                              key: 'download',
                                              title: t('messages.download') || 'Download',
                                              icon: <FiDownload className="w-4 h-4 text-gray-400 hover:text-white" />,
                                              onClick: () => {
                                                    // Simple download: save content as file
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
                                  })()}
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      )}
                    </>
                  );
                })() : (
                  // Non-Bot messages or no separator, keep original multi-line processing
                  (msg.content?.split('\n') || []).map((line, idx) => {
                    // __PROMPT_TRUNCATED__ handling
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
                    // __PROGRESS_BAR__ handling
                    const progressMatch2 = line.match(/__PROGRESS_BAR__:(.*?):(\d+)/);
                    if (progressMatch2) {
                      const status = progressMatch2[1];
                      const progress = parseInt(progressMatch2[2], 10) || 0;
                      return (
                        <div key={idx} className="mt-2">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-sm">{t('messages.task_status')} {status}</span>
                          </div>
                          <div className="w-full bg-border/60 rounded-full h-2">
                            <div
                              className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out"
                              style={{ width: `${progress}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    }
                    // Plain text
                    return (
                      <div key={idx} className="group pb-8">
                        {/* Only render toolbar on the first line, copy the entire message */}
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
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
