// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useTaskContext } from '../contexts/taskContext'
import { taskApis } from '@/apis/tasks'
import type { TaskDetail, TaskDetailSubtask } from '@/types/api'
import { RiRobot2Line } from 'react-icons/ri'

import ReactMarkdown from 'react-markdown'

interface Message {
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
}

export default function MessagesArea() {
  const { selectedTask } = useTaskContext()
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  // Fetch task details
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    // Add isSilent parameter, do not show loading during timed refresh
    const fetchDetail = (isSilent: boolean = false) => {
      if (!selectedTask?.id) {
        setTaskDetail(null)
        return
      }
      if (!isSilent) setIsLoading(true)
      setError('')
      taskApis.getTaskDetail(selectedTask.id)
        .then((detail: TaskDetail) => {
          setTaskDetail(detail)
        })
        .catch((e: any) => {
          setError(e?.message || 'Failed to fetch task detail')
          setTaskDetail(null)
        })
        .finally(() => {
          if (!isSilent) setIsLoading(false)
        })
    }

    // Show loading when first loading/switching tasks
    fetchDetail(false);

    if (selectedTask?.id) {
      intervalId = setInterval(() => {
        fetchDetail(true); // Silent update during timed refresh
      }, 5000); // Auto-refresh every 30 seconds
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    }
  }, [selectedTask?.id])

  // Calculate messages from taskDetail
  function generateTaskMessages(detail: TaskDetail | null): Message[] {
    if (!detail) return [];
    const messages: Message[] = [];
  
    // Main task user prompt
    if (detail.prompt) {
      messages.push({
        type: 'user',
        content: detail.prompt,
        timestamp: new Date(detail.created_at).getTime(),
      });
    }
  
    // When subtasks exist, synthesize according to useTaskActionData logic
    if (Array.isArray(detail.subtasks) && detail.subtasks.length > 0) {
      detail.subtasks.forEach((sub: TaskDetailSubtask) => {
        let promptContent = sub.prompt || '';
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
        let mergedContent = '';
        if (truncated) {
          mergedContent = `__PROMPT_TRUNCATED__:${shortPrompt}::${promptContent}\${$$}$${aiContent}`;
        } else {
          mergedContent = `${promptContent}\${$$}$${aiContent}`;
        }
  
        messages.push({
          type: 'ai',
          content: mergedContent,
          timestamp: new Date(sub.updated_at).getTime(),
          botName: sub.bot?.name || 'Bot',
        });
      });
      return messages;
    } else {
      // When there are no subtasks, main task ai message (merge bot_prompt)
      let aiContent = '';
      const timestamp = new Date(detail.updated_at).getTime();
      const result = detail.result;
  
      if (result) {
        if (typeof result === 'object') {
          aiContent = result && Object.keys(result).length === 1 && 'value' in result
            ? String(result.value)
            : JSON.stringify(result);
        } else {
          aiContent = String(result);
        }
      } else if (detail.status === 'COMPLETED') {
        aiContent = 'Task completed';
      } else if (detail.status === 'FAILED') {
        aiContent = `Task failed: ${detail.error_message || 'Unknown error'}`;
      } else {
        aiContent = `__PROGRESS_BAR__:${detail.status}:${detail.progress}`;
      }
      const finalAiContent = aiContent;
  
      messages.push({
        type: 'ai',
        content: finalAiContent,
        timestamp,
        botName: 'Bot',
      });
  
      return messages;
    }
  }

  // Display loading virtual messages
  const displayMessages = isLoading
    ? [
        {
          type: 'user',
          content: 'loading...',
          timestamp: 0,
        },
        {
          type: 'ai',
          content: 'loading task status...',
          timestamp: 0,
          botName: 'Bot',
        },
      ]
      : generateTaskMessages(taskDetail);

  return (
    <div className="flex-1 w-full max-w-2xl mx-auto flex flex-col">
      {/* Error Message */}
      {error && (
        <div className="mb-4 bg-red-900/20 border border-red-800/50 rounded-md p-3">
          <div className="text-sm text-red-300">{error}</div>
        </div>
      )}

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
                            <div className="text-sm markdown-body break-all">
                                <ReactMarkdown>{result}</ReactMarkdown>
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
                      <div key={idx} className="text-sm markdown-body break-all">
                            {line}
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