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
    // 优先使用 Clipboard API
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

    // 降级方案：使用 document.execCommand
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

// 气泡工具栏：支持复制按钮与可扩展的其它工具按钮
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

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    // 只有当任务存在且未完成时才进行定时刷新
    if (selectedTaskDetail?.id && selectedTaskDetail.status !== 'COMPLETED' && selectedTaskDetail.status !== 'FAILED' && selectedTaskDetail.status !== 'CANCELLED') {
      intervalId = setInterval(() => {
        refreshSelectedTaskDetail(true); // 这是自动刷新
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
    <div className="flex-1 w-full max-w-2xl mx-auto flex flex-col">
      {/* Messages Area - only shown when there are messages or loading */}
      {(displayMessages.length > 0) && (
        <div className="flex-1 overflow-y-auto mb-4 space-y-4 messages-container custom-scrollbar">
          {displayMessages.map((msg, index) => (
            <div key={index} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`relative group max-w-[80%] p-3 rounded-lg ${msg.type === 'user'
                  ? 'bg-[#161b22] border border-[#30363d] text-white'
                  : 'bg-[#161b22] border border-[#30363d] text-gray-300'
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
                                <div className="w-full bg-gray-700 rounded-full h-2">
                                  <div
                                    className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-in-out"
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
                                    // ★ 规范化：如果 result 是一个完整的 fenced code block，就解包
                                    const normalizedResult = (() => {
                                      const s = (result ?? '').trim();

                                      // 只匹配“整串都是 fenced block”的情况：
                                      // ```markdown\n...\n```  或 ```md\n...\n```  或 ```\n...\n```
                                      const m = s.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/);
                                      if (m) return m[1];

                                      return s;
                                    })();

                                    // ★ 锚定进度条匹配，避免误伤正文里提到的标记
                                    const progressMatch = normalizedResult.match(/^__PROGRESS_BAR__:(.*?):(\d+)$/);
                                    if (progressMatch) {
                                      const status = progressMatch[1];
                                      const progress = parseInt(progressMatch[2], 10) || 0;
                                      return (
                                        <div className="mt-2">
                                          <div className="flex justify-between items-center mb-1">
                                            <span className="text-sm">{t('messages.task_status')} {status}</span>
                                          </div>
                                          <div className="w-full bg-gray-700 rounded-full h-2">
                                            <div
                                              className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-in-out"
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
                                          wrapperElement={{ 'data-color-mode': 'dark' }}
                                        />
                                        {/* ★ 顶部悬浮工具栏：复制 + 可扩展工具 */}
                                        <BubbleTools
                                          contentToCopy={`${prompt ? (prompt + '\n\n') : ''}${normalizedResult}`}
                                          tools={[
                                            {
                                              key: 'download',
                                              title: t('messages.download') || 'Download',
                                              icon: <FiDownload className="w-4 h-4 text-gray-400 hover:text-white" />,
                                              onClick: () => {
                                                // 简易下载：将内容作为文件下载
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
                          <div className="w-full bg-gray-700 rounded-full h-2">
                            <div
                              className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-in-out"
                              style={{ width: `${progress}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    }
                    // Plain text
                    return (
                      <div key={idx} className="group pb-8">
                        {/* 仅在首行渲染工具栏，复制整条消息 */}
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