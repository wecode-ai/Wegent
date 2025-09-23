// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { RiRobot2Line } from 'react-icons/ri'
import { FiCopy, FiCheck } from 'react-icons/fi'
import { Button } from 'antd'

import MarkdownEditor from '@uiw/react-markdown-editor'

interface Message {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
}

// CopyButton component for copying markdown content
const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    // 检查是否在浏览器环境中且 Clipboard API 可用
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
    <>
      {/* 坐下角复制按钮 */}
      <Button
        type="text"
        onClick={handleCopy}
        className="absolute bottom-0 left-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        title="Copy markdown content"
        icon={copied ?
          <FiCheck className="w-4 h-4 text-green-400" /> :
          <FiCopy className="w-4 h-4 text-gray-400 hover:text-white" />
        }
        style={{
          padding: '4px',
          background: '#1e2937',
          height: 'auto',
          minWidth: 'auto'
        }}
      />
    </>
  );
};

export default function MessagesArea() {
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
        let content = '';
        let msgType: 'user' | 'ai' = 'ai';

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
          let aiContent = '';
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
            aiContent = 'Subtask completed';
          } else if (sub.status === 'FAILED') {
            aiContent = `Subtask failed: ${sub.error_message || 'Unknown error'}`;
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
              <div className={`max-w-[80%] p-3 rounded-lg ${msg.type === 'user'
                  ? 'bg-[#161b22] border border-[#30363d] text-white'
                  : 'bg-[#161b22] border border-[#30363d] text-gray-300'
                }`}>
                {/* Bot name and icon, only displayed for ai messages, and before the timestamp */}
                {msg.type === 'ai' && (
                  <div className="flex items-center mb-1 text-xs opacity-80">
                    <RiRobot2Line className="w-5 h-5 mr-1" />
                    <span className="font-semibold mr-2">{msg.botName || 'Bot'}</span>
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
                                  <span className="text-sm">Task Status: {status}</span>
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
                            <div className="relative group">
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
                                            <span className="text-sm">Task Status: {status}</span>
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
                                        {/* ★ 复制按钮用解包后的内容 */}
                                        <CopyButton content={result} />
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
                    const progressMatch = line.match(/__PROGRESS_BAR__:(.*?):(\d+)/);
                    if (progressMatch) {
                      const status = progressMatch[1];
                      const progress = parseInt(progressMatch[2], 10) || 0;
                      return (
                        <div key={idx} className="mt-2">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-sm">Task Status: {status}</span>
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
                      <div key={idx} className="relative group">
                        <div className="text-sm break-all pr-8">
                          {line}
                        </div>
                        {line.trim() && <CopyButton content={line} />}
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