// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useState, useLayoutEffect, useMemo } from 'react';
import { Brain, ChevronDown, ChevronUp, ChevronsDown, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

interface ThinkingStep {
  title: string;
  next_action: string;
  details?: {
    type?: string;
    subtype?: string;
    message?: {
      id?: string;
      type?: string;
      role?: string;
      model?: string;
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      parent_tool_use_id?: string;
    };
    // Tool use details
    id?: string;
    name?: string;
    input?: string;
    // Tool result details
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
    // Result message details
    session_id?: string;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    result?: string;
    timestamp?: string;
    created_at?: string;
    // Custom details
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // Legacy fields for backward compatibility
  action?: string;
  result?: string;
  reasoning?: string;
  confidence?: number;
  value?: unknown;
}

interface TodoItem {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm?: string;
}

interface TodoListData {
  todos?: TodoItem[];
}

interface ThinkingComponentProps {
  thinking: ThinkingStep[] | null;
  taskStatus?: string;
}

// Tool icon mapping
const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '⚙️',
  Grep: '🔍',
  Glob: '📁',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
};

export default function ThinkingComponent({ thinking, taskStatus }: ThinkingComponentProps) {
  const { t: tTasks } = useTranslation('tasks');
  const { t: tChat } = useTranslation('chat');
  const items = useMemo(() => thinking ?? [], [thinking]);

  // DEBUG: Log when ThinkingComponent receives new thinking data
  console.log('[ThinkingComponent] Render', {
    thinkingType: typeof thinking,
    thinkingIsArray: Array.isArray(thinking),
    thinkingLen: Array.isArray(thinking) ? thinking.length : 0,
    itemsLen: items.length,
    taskStatus,
  });

  // Initialize isOpen based on taskStatus
  const shouldBeCollapsed =
    taskStatus === 'COMPLETED' || taskStatus === 'FAILED' || taskStatus === 'CANCELLED';

  const [isOpen, setIsOpen] = useState(!shouldBeCollapsed);
  const previousSignatureRef = useRef<string | null>(null);
  const userCollapsedRef = useRef(false);
  const previousStatusRef = useRef<string | undefined>(taskStatus);
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set());

  // Refs for scroll management
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollStateRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
    isUserScrolling: boolean;
  }>({
    scrollTop: 0,
    scrollHeight: 0,
    isUserScrolling: false,
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    const signature = JSON.stringify(items);
    if (
      previousSignatureRef.current !== null &&
      previousSignatureRef.current !== signature &&
      !userCollapsedRef.current
    ) {
      setIsOpen(true);
    }
    previousSignatureRef.current = signature;
  }, [items]);

  // Auto-collapse when subtask status changes to COMPLETED/FAILED/CANCELLED
  useEffect(() => {
    const shouldCollapse =
      taskStatus === 'COMPLETED' || taskStatus === 'FAILED' || taskStatus === 'CANCELLED';

    // Only auto-collapse when status changes to a terminal state
    if (shouldCollapse && previousStatusRef.current !== taskStatus) {
      setIsOpen(false);
      userCollapsedRef.current = false; // Reset user collapsed state
    }

    previousStatusRef.current = taskStatus;
  }, [taskStatus]);

  // Handle scroll events
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isOpen) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const isNearBottom = distanceFromBottom <= 24;

      // Store current scroll position
      // If user has manually scrolled to bottom, reset isUserScrolling to false to resume auto-scrolling
      scrollStateRef.current = {
        scrollTop,
        scrollHeight,
        isUserScrolling: !isNearBottom, // Reset to false if user is near bottom
      };

      // Show "scroll to bottom" button if not near bottom
      setShowScrollToBottom(distanceFromBottom > 24);
    };

    container.addEventListener('scroll', handleScroll);

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isOpen]);

  // Handle new content and scrolling
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container || !isOpen) return;

    const previous = scrollStateRef.current;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isNearBottom = distanceFromBottom <= 24;

    // Auto-scroll to bottom only if we're not user scrolling or if we're already near bottom
    if (!previous.isUserScrolling || isNearBottom) {
      container.scrollTop = container.scrollHeight;
      setShowScrollToBottom(false);
    } else {
      // If user is scrolling and new content appears, show "scroll to bottom" button
      if (scrollHeight > previous.scrollHeight) {
        setShowScrollToBottom(true);
      }
    }

    // If user has manually scrolled to bottom, update the scrolling state
    // to ensure future auto-scrolling works correctly
    scrollStateRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      isUserScrolling: previous.isUserScrolling && !isNearBottom, // Reset when user is at bottom
    };
  }, [items, isOpen]);

  if (items.length === 0) {
    return null;
  }

  // Extract tool calls from thinking array
  const extractToolCalls = (thinkingSteps: ThinkingStep[]): Record<string, number> => {
    const toolCounts: Record<string, number> = {};

    thinkingSteps.forEach(step => {
      if (step.details?.message?.content) {
        step.details.message.content.forEach(content => {
          if (content.type === 'tool_use' && content.name) {
            toolCounts[content.name] = (toolCounts[content.name] || 0) + 1;
          }
        });
      }
      // Also check direct tool_use type
      if (step.details?.type === 'tool_use' && step.details?.name) {
        toolCounts[step.details.name] = (toolCounts[step.details.name] || 0) + 1;
      }
    });

    return toolCounts;
  };

  // Calculate duration from thinking array
  const calculateDuration = (thinkingSteps: ThinkingStep[]): string | null => {
    if (thinkingSteps.length === 0) return null;

    // Try to extract timestamps from details
    let startTime: number | null = null;
    let endTime: number | null = null;

    // Get first timestamp
    for (const step of thinkingSteps) {
      if (step.details?.message?.id) {
        // Assuming message id might contain timestamp info, or we need to find timestamp field
        // For now, we'll try to use created_at or timestamp if available
        const timestamp = step.details?.timestamp || step.details?.created_at;
        if (timestamp) {
          startTime = new Date(timestamp).getTime();
          break;
        }
      }
    }

    // Get last timestamp
    for (let i = thinkingSteps.length - 1; i >= 0; i--) {
      const step = thinkingSteps[i];
      if (step.details?.message?.id) {
        const timestamp = step.details?.timestamp || step.details?.created_at;
        if (timestamp) {
          endTime = new Date(timestamp).getTime();
          break;
        }
      }
    }

    if (!startTime || !endTime) return null;

    const durationMs = endTime - startTime;
    const durationSec = durationMs / 1000;

    if (durationSec < 1) return '<1s';
    if (durationSec < 60) return `${durationSec.toFixed(1)}s`;

    const minutes = Math.floor(durationSec / 60);
    const seconds = Math.floor(durationSec % 60);
    return `${minutes}m ${seconds}s`;
  };

  // Format collapsed title with status, tool icons, and duration
  const formatCollapsedTitle = (): string => {
    let statusText = '';
    if (taskStatus === 'COMPLETED') {
      statusText = tTasks('thinking.execution_completed');
    } else if (taskStatus === 'FAILED') {
      statusText = tTasks('thinking.execution_failed');
    } else if (taskStatus === 'CANCELLED') {
      statusText = tTasks('thinking.execution_cancelled');
    }

    const toolCounts = extractToolCalls(items);
    const toolParts: string[] = [];

    Object.entries(toolCounts).forEach(([toolName, count]) => {
      if (count > 0 && TOOL_ICONS[toolName]) {
        toolParts.push(`${TOOL_ICONS[toolName]}×${count}`);
      }
    });

    const duration = calculateDuration(items);
    let result = statusText;

    if (toolParts.length > 0) {
      result += ' ' + toolParts.join(' ');
    }

    if (duration) {
      result += ' · ' + duration;
    }

    return result;
  };

  const isThinkingCompleted =
    taskStatus === 'COMPLETED' ||
    taskStatus === 'FAILED' ||
    taskStatus === 'CANCELLED' ||
    items.some(item => item.value !== null && item.value !== undefined && item.value !== '');

  const toggleOpen = () =>
    setIsOpen(prev => {
      const next = !prev;
      userCollapsedRef.current = !next;
      return next;
    });

  // Handler for clicking the scroll to bottom button
  const handleScrollToBottom = () => {
    const container = contentRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    scrollStateRef.current.isUserScrolling = false;
    setShowScrollToBottom(false);
  };

  const getThinkingText = (key: string): string => {
    if (!key) return '';

    const templateRegex = /\$\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    let result = key;

    while ((match = templateRegex.exec(key)) !== null) {
      const templateKey = match[1];
      if (templateKey.includes('.')) {
        // Use tChat for translation (most thinking keys are in chat.json)
        const translatedText = tChat(templateKey) || templateKey;
        result = result.replace(match[0], translatedText);
      } else {
        result = result.replace(match[0], templateKey);
      }
    }

    if (result === key && key.includes('.')) {
      // Use tChat for translation (most thinking keys are in chat.json)
      return tChat(key) || key;
    }

    return result;
  };

  const formatConfidence = (confidence?: number) => {
    if (confidence === undefined || confidence === null || confidence === -1) return null;
    return `${Math.round(confidence * 100)}%`;
  };

  // Parse <tool_call> tags from text content
  interface ParsedToolCall {
    toolName: string;
    args: Record<string, string>;
    beforeText: string;
    afterText: string;
  }

  const parseToolCallTags = (text: string): ParsedToolCall | null => {
    // Match <tool_call>...</tool_call> pattern
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/;
    const match = text.match(toolCallRegex);

    if (!match) return null;

    const toolCallContent = match[1];
    const beforeText = text.substring(0, match.index).trim();
    const afterText = text.substring(match.index! + match[0].length).trim();

    // Extract tool name from the content before first <arg_key>
    const toolNameMatch = toolCallContent.match(/^\s*(\w+)\s*</);
    const toolName = toolNameMatch ? toolNameMatch[1] : 'Unknown';

    // Special handling for TodoWrite
    if (toolName === 'TodoWrite') {
      const todosMatch = toolCallContent.match(
        /<arg_key>todos<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/
      );
      if (todosMatch) {
        return {
          toolName,
          args: { todos: todosMatch[1] },
          beforeText,
          afterText,
        };
      }
    }

    // Extract all arguments
    const args: Record<string, string> = {};
    const argRegex = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let argMatch;

    while ((argMatch = argRegex.exec(toolCallContent)) !== null) {
      const key = argMatch[1].trim();
      const value = argMatch[2].trim();
      args[key] = value;
    }

    return {
      toolName,
      args,
      beforeText,
      afterText,
    };
  };
  // Check if content should be collapsible (more than 3 lines or long single lines)
  const shouldCollapse = (content: string): boolean => {
    // Add null/undefined check
    if (!content || typeof content !== 'string') {
      return false;
    }

    const lines = content.split('\n');

    // Check if there are more than 3 lines
    if (lines.length > 3) {
      return true;
    }

    // Check if any single line is too long (more than 100 characters)
    // This accounts for automatic wrapping in the UI
    const hasLongLine = lines.some(line => line.length > 100);

    // Also check total character count as a fallback
    const isLongContent = content.length > 300;

    return hasLongLine || isLongContent;
  };

  // Get preview of content (first 3 lines or truncated long lines)
  const getContentPreview = (content: string): string => {
    const lines = content.split('\n');
    const previewLines = [];

    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const line = lines[i];
      // If line is very long, truncate it
      if (line.length > 100) {
        previewLines.push(line.substring(0, 100) + '...');
      } else {
        previewLines.push(line);
      }
    }

    return previewLines.join('\n');
  };

  // Toggle parameter expansion
  const toggleParamExpansion = (paramKey: string) => {
    setExpandedParams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(paramKey)) {
        newSet.delete(paramKey);
      } else {
        newSet.add(paramKey);
      }
      return newSet;
    });
  };

  // Render text content with tool_call parsing
  const renderTextContent = (text: string, uniqueId: string) => {
    const parsed = parseToolCallTags(text);

    if (!parsed) {
      // Check if this is a TodoWrite tool call in text format
      const todoWriteMatch = text.match(
        /<tool_call>TodoWrite\s*<arg_key>todos<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/
      );
      if (todoWriteMatch) {
        try {
          const todosData = JSON.parse(todoWriteMatch[1]);
          return (
            <div className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
              <div className="text-xs font-medium text-blue-400 mb-2">
                {tChat('thinking.todo_list') || 'Todo List'}
              </div>
              <div className="space-y-2">
                {Array.isArray(todosData) &&
                  todosData.map((todo: unknown, todoIdx: number) => {
                    const todoItem = todo as TodoItem;
                    return (
                      <div
                        key={todoIdx}
                        className="flex items-start gap-2 p-2 bg-surface/50 rounded"
                      >
                        <div className="flex-shrink-0 mt-0.5">
                          {todoItem.status === 'in_progress' ? (
                            <div
                              className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"
                              title={tChat('thinking.todo_status_in_progress') || 'In Progress'}
                            ></div>
                          ) : todoItem.status === 'completed' ? (
                            <div
                              className="w-3 h-3 rounded-full bg-green-400"
                              title={tChat('thinking.todo_status_completed') || 'Completed'}
                            ></div>
                          ) : (
                            <div
                              className="w-3 h-3 rounded-full bg-gray-400"
                              title={tChat('thinking.todo_status_pending') || 'Pending'}
                            ></div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-text-secondary font-medium">
                            {todoItem.content}
                          </div>
                          {todoItem.activeForm && (
                            <div className="text-xs text-text-tertiary mt-1 italic">
                              {todoItem.activeForm}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        } catch {
          // If parsing fails, fall back to regular text rendering
        }
      }

      // No tool_call tags, render as plain text with collapse support
      const isCollapsible = shouldCollapse(text);
      const textKey = `${uniqueId}-text`;
      const isExpanded = expandedParams.has(textKey);
      const displayText = isCollapsible && !isExpanded ? getContentPreview(text) : text;

      return (
        <div className="text-xs text-text-secondary">
          {isCollapsible && (
            <div className="flex justify-end mb-1">
              <button
                onClick={() => toggleParamExpansion(textKey)}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
              >
                {isExpanded ? (
                  <>
                    <Minimize2 className="h-3 w-3" />
                    <span className="text-xs">{tChat('thinking.collapse') || 'Collapse'}</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3 w-3" />
                    <span className="text-xs">{tChat('thinking.expand') || 'Expand'}</span>
                  </>
                )}
              </button>
            </div>
          )}
          <div className="whitespace-pre-wrap">
            {displayText}
            {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
          </div>
        </div>
      );
    }

    // Render with parsed tool_call
    return (
      <div className="space-y-2">
        {parsed.beforeText && (
          <div className="text-xs text-text-secondary whitespace-pre-wrap">{parsed.beforeText}</div>
        )}

        {/* Special handling for TodoWrite */}
        {parsed.toolName === 'TodoWrite' && parsed.args.todos ? (
          <div className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
            <div className="text-xs font-medium text-blue-400 mb-2">
              {tChat('thinking.todo_write') || 'Todo List'}
            </div>
            <div className="space-y-2">
              {(() => {
                try {
                  const todosData = JSON.parse(parsed.args.todos);
                  return (
                    Array.isArray(todosData) &&
                    todosData.map((todo: unknown, todoIdx: number) => {
                      const todoItem = todo as TodoItem;
                      return (
                        <div
                          key={todoIdx}
                          className="flex items-start gap-2 p-2 bg-surface/50 rounded"
                        >
                          <div className="flex-shrink-0 mt-0.5">
                            {todoItem.status === 'in_progress' ? (
                              <div
                                className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"
                                title={tChat('thinking.todo_status_in_progress') || 'In Progress'}
                              ></div>
                            ) : todoItem.status === 'completed' ? (
                              <div
                                className="w-3 h-3 rounded-full bg-green-400"
                                title={tChat('thinking.todo_status_completed') || 'Completed'}
                              ></div>
                            ) : (
                              <div
                                className="w-3 h-3 rounded-full bg-gray-400"
                                title={tChat('thinking.todo_status_pending') || 'Pending'}
                              ></div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-text-secondary font-medium">
                              {todoItem.content}
                            </div>
                            {todoItem.activeForm && (
                              <div className="text-xs text-text-tertiary mt-1 italic">
                                {todoItem.activeForm}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  );
                } catch {
                  return (
                    <pre className="text-xs text-text-tertiary overflow-x-auto bg-surface/50 p-1.5 rounded">
                      {parsed.args.todos}
                    </pre>
                  );
                }
              })()}
            </div>
          </div>
        ) : (
          <div className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
            <div className="text-xs font-medium text-blue-400 mb-2">
              {tChat('thinking.pre_tool_call') || 'Tool Call'}: {parsed.toolName}
            </div>
            <div className="space-y-2">
              {Object.entries(parsed.args).map(([key, value]) =>
                renderParamValue(key, value, `${uniqueId}-toolcall-${key}`)
              )}
            </div>
          </div>
        )}

        {parsed.afterText && (
          <div className="text-xs text-text-secondary whitespace-pre-wrap">{parsed.afterText}</div>
        )}
      </div>
    );
  };

  // Render parameter value with collapse/expand support
  const renderParamValue = (key: string, value: unknown, uniqueId: string) => {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const isCollapsible = shouldCollapse(stringValue);
    const paramKey = `${uniqueId}-${key}`;
    const isExpanded = expandedParams.has(paramKey);
    const displayValue =
      isCollapsible && !isExpanded ? getContentPreview(stringValue) : stringValue;

    return (
      <div key={paramKey} className="text-xs">
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-medium text-blue-300">{key}:</span>
          {isCollapsible && (
            <button
              onClick={() => toggleParamExpansion(paramKey)}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
              title={
                isExpanded
                  ? tChat('thinking.collapse') || 'Collapse'
                  : tChat('thinking.expand') || 'Expand'
              }
            >
              {isExpanded ? (
                <>
                  <Minimize2 className="h-3 w-3" />
                  <span className="text-xs">{tChat('thinking.collapse') || 'Collapse'}</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3 w-3" />
                  <span className="text-xs">{tChat('thinking.expand') || 'Expand'}</span>
                </>
              )}
            </button>
          )}
        </div>
        <pre className="text-text-tertiary overflow-x-auto bg-surface/50 p-1.5 rounded whitespace-pre-wrap break-words">
          {displayValue}
          {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
        </pre>
      </div>
    );
  };

  // Render details content based on type
  const renderDetailsContent = (item: ThinkingStep, itemIndex: number) => {
    const details = item.details;
    if (!details) return null;

    // Handle assistant message with content array
    if ((details.type === 'assistant' || details.type === 'user') && details.message?.content) {
      return (
        <div className="mt-2 space-y-2">
          {details.message.content.map((content, idx) => {
            if (content.type === 'tool_use') {
              // Special handling for TodoWrite tool
              if (
                content.name === 'TodoWrite' &&
                content.input &&
                typeof content.input === 'object' &&
                'todos' in content.input
              ) {
                const inputObj = content.input as TodoListData;
                return (
                  <div key={idx} className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
                    <div className="text-xs font-medium text-blue-400 mb-2">
                      {tChat('thinking.todo_list') || 'Todo List'}
                    </div>
                    <div className="space-y-2">
                      {Array.isArray(inputObj.todos) &&
                        inputObj.todos.map((todo, todoIdx: number) => (
                          <div
                            key={todoIdx}
                            className="flex items-start gap-2 p-2 bg-surface/50 rounded"
                          >
                            <div className="flex-shrink-0 mt-0.5">
                              {todo.status === 'in_progress' ? (
                                <div
                                  className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"
                                  title={tChat('thinking.todo_status_in_progress') || 'In Progress'}
                                ></div>
                              ) : todo.status === 'completed' ? (
                                <div
                                  className="w-3 h-3 rounded-full bg-green-400"
                                  title={tChat('thinking.todo_status_completed') || 'Completed'}
                                ></div>
                              ) : (
                                <div
                                  className="w-3 h-3 rounded-full bg-gray-400"
                                  title={tChat('thinking.todo_status_pending') || 'Pending'}
                                ></div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-text-secondary font-medium">
                                {todo.content}
                              </div>
                              {todo.activeForm && (
                                <div className="text-xs text-text-tertiary mt-1 italic">
                                  {todo.activeForm}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                );
              }

              return (
                <div key={idx} className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
                  <div className="text-xs font-medium text-blue-400 mb-2">
                    {tChat('thinking.tool_use') || 'Tool Use'}: {content.name}
                  </div>
                  {content.input && (
                    <div className="space-y-2">
                      {typeof content.input === 'object' && !Array.isArray(content.input) ? (
                        Object.entries(content.input).map(([key, value]) =>
                          renderParamValue(key, value, `item-${itemIndex}-content-${idx}-${key}`)
                        )
                      ) : (
                        <pre className="text-xs text-text-tertiary overflow-x-auto bg-surface/50 p-1.5 rounded">
                          {JSON.stringify(content.input, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            } else if (content.type === 'tool_result') {
              const resultContent =
                typeof content.content === 'string'
                  ? content.content
                  : JSON.stringify(content.content, null, 2);
              const isCollapsible = shouldCollapse(resultContent);
              const resultKey = `item-${itemIndex}-result-${idx}`;
              const isExpanded = expandedParams.has(resultKey);
              const displayContent =
                isCollapsible && !isExpanded ? getContentPreview(resultContent) : resultContent;

              return (
                <div
                  key={idx}
                  className={`rounded p-2 border ${content.is_error ? 'bg-red-500/5 border-red-500/20' : 'bg-green-500/5 border-green-500/20'}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div
                      className={`text-xs font-medium ${content.is_error ? 'text-red-400' : 'text-green-400'}`}
                    >
                      {content.is_error ? '❌' : '✅'}{' '}
                      {tChat('thinking.tool_result') || 'Tool Result'}
                    </div>
                    {isCollapsible && (
                      <button
                        onClick={() => toggleParamExpansion(resultKey)}
                        className={`flex items-center gap-1 transition-colors ${content.is_error ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'}`}
                      >
                        {isExpanded ? (
                          <>
                            <Minimize2 className="h-3 w-3" />
                            <span className="text-xs">
                              {tChat('thinking.collapse') || 'Collapse'}
                            </span>
                          </>
                        ) : (
                          <>
                            <Maximize2 className="h-3 w-3" />
                            <span className="text-xs">{tChat('thinking.expand') || 'Expand'}</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                  <pre className="text-xs text-text-tertiary whitespace-pre-wrap break-words">
                    {displayContent}
                    {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
                  </pre>
                </div>
              );
            } else if (content.type === 'text' && content.text) {
              return (
                <div key={idx}>
                  {renderTextContent(content.text, `item-${itemIndex}-text-${idx}`)}
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    // Handle direct tool_use type
    if (details.type === 'tool_use') {
      // Special handling for TodoWrite tool
      if (
        details.name === 'TodoWrite' &&
        details.input &&
        typeof details.input === 'object' &&
        'todos' in details.input
      ) {
        const inputObj = details.input as TodoListData;
        return (
          <div className="mt-2 rounded bg-blue-500/5 p-2 border border-blue-500/20">
            <div className="text-xs font-medium text-blue-400 mb-2">
              {tChat('thinking.todo_list') || 'Todo List'}
            </div>
            <div className="space-y-2">
              {Array.isArray(inputObj.todos) &&
                inputObj.todos.map((todo, todoIdx: number) => (
                  <div key={todoIdx} className="flex items-start gap-2 p-2 bg-surface/50 rounded">
                    <div className="flex-shrink-0 mt-0.5">
                      {todo.status === 'in_progress' ? (
                        <div
                          className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"
                          title={tChat('thinking.todo_status_in_progress') || 'In Progress'}
                        ></div>
                      ) : todo.status === 'completed' ? (
                        <div
                          className="w-3 h-3 rounded-full bg-green-400"
                          title={tChat('thinking.todo_status_completed') || 'Completed'}
                        ></div>
                      ) : (
                        <div
                          className="w-3 h-3 rounded-full bg-gray-400"
                          title={tChat('thinking.todo_status_pending') || 'Pending'}
                        ></div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-text-secondary font-medium">{todo.content}</div>
                      {todo.activeForm && (
                        <div className="text-xs text-text-tertiary mt-1 italic">
                          {todo.activeForm}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        );
      }

      return (
        <div className="mt-2 rounded bg-blue-500/5 p-2 border border-blue-500/20">
          <div className="text-xs font-medium text-blue-400 mb-2">
            {tChat('thinking.tool_use') || 'Tool Use'}: {details.name}
          </div>
          {details.input && (
            <div className="space-y-2">
              {typeof details.input === 'object' && !Array.isArray(details.input) ? (
                Object.entries(details.input).map(([key, value]) =>
                  renderParamValue(key, value, `item-${itemIndex}-direct-${key}`)
                )
              ) : (
                <pre className="text-xs text-text-tertiary overflow-x-auto bg-surface/50 p-1.5 rounded">
                  {JSON.stringify(details.input, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      );
    }

    // Handle direct tool_result type
    if (details.type === 'tool_result') {
      const resultContent =
        typeof details.content === 'string'
          ? details.content
          : JSON.stringify(details.content, null, 2);
      const isCollapsible = shouldCollapse(resultContent);
      const resultKey = `item-${itemIndex}-direct-result`;
      const isExpanded = expandedParams.has(resultKey);
      const displayContent =
        isCollapsible && !isExpanded ? getContentPreview(resultContent) : resultContent;

      return (
        <div
          className={`mt-2 rounded p-2 border ${details.is_error ? 'bg-red-500/5 border-red-500/20' : 'bg-green-500/5 border-green-500/20'}`}
        >
          <div className="flex items-center justify-between mb-1">
            <div
              className={`text-xs font-medium ${details.is_error ? 'text-red-400' : 'text-green-400'}`}
            >
              {details.is_error ? '❌' : '✅'} {tChat('thinking.tool_result') || 'Tool Result'}
            </div>
            {isCollapsible && (
              <button
                onClick={() => toggleParamExpansion(resultKey)}
                className={`flex items-center gap-1 transition-colors ${details.is_error ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'}`}
              >
                {isExpanded ? (
                  <>
                    <Minimize2 className="h-3 w-3" />
                    <span className="text-xs">{tChat('thinking.collapse') || 'Collapse'}</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3 w-3" />
                    <span className="text-xs">{tChat('thinking.expand') || 'Expand'}</span>
                  </>
                )}
              </button>
            )}
          </div>
          <pre className="text-xs text-text-tertiary whitespace-pre-wrap break-words">
            {displayContent}
            {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
          </pre>
        </div>
      );
    }

    // Handle result message type
    if (details.type === 'result') {
      return (
        <div className="mt-2 rounded bg-purple-500/5 p-2 border border-purple-500/20">
          <div className="text-xs font-medium text-purple-400 mb-1">
            📋 {tChat('thinking.result_message') || 'Result Message'}
          </div>
          <div className="space-y-1 text-xs text-text-tertiary">
            {details.subtype && <div>Subtype: {details.subtype}</div>}
            {details.num_turns !== undefined && <div>Turns: {details.num_turns}</div>}
            {details.duration_ms !== undefined && <div>Duration: {details.duration_ms}ms</div>}
            {/*{details.total_cost_usd !== undefined && <div>Cost: ${details.total_cost_usd.toFixed(4)}</div>}*/}
            {details.usage && (
              <div>
                Tokens: {details.usage.input_tokens || 0} in / {details.usage.output_tokens || 0}{' '}
                out
              </div>
            )}
          </div>
        </div>
      );
    }

    // Handle system message type
    if (details.type === 'system') {
      return (
        <div className="mt-2 rounded bg-gray-500/5 p-2 border border-gray-500/20">
          <div className="text-xs font-medium text-gray-400 mb-2">
            ⚙️ {tChat('thinking.system_message') || 'System Message'}: {details.subtype}
          </div>

          {/* Show key system information */}
          <div className="space-y-1 text-xs text-text-tertiary">
            {/* Model information */}
            {details.model && (
              <div className="flex items-center gap-1">
                <span className="font-medium">{tChat('thinking.system_model') || 'Model'}:</span>
                <span>{details.model}</span>
              </div>
            )}

            {/* Tools count */}
            {details.tools && Array.isArray(details.tools) && (
              <div className="flex items-center gap-1">
                <span className="font-medium">{tChat('thinking.system_tools') || 'Tools'}:</span>
                <span>
                  {details.tools.length} {tChat('thinking.system_tools_available') || 'available'}
                </span>
              </div>
            )}

            {/* MCP Servers status */}
            {details.mcp_servers &&
              Array.isArray(details.mcp_servers) &&
              details.mcp_servers.length > 0 && (
                <div className="flex items-center gap-1">
                  <span className="font-medium">
                    {tChat('thinking.system_mcp_servers') || 'MCP Servers'}:
                  </span>
                  <div className="flex gap-2">
                    {details.mcp_servers.map((server: unknown, idx: number) => {
                      const serverObj = server as { status?: string; name?: string };
                      return (
                        <span
                          key={idx}
                          className={`px-1.5 py-0.5 rounded text-xs ${
                            serverObj.status === 'connected'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-red-500/10 text-red-400'
                          }`}
                        >
                          {serverObj.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

            {/* Permission mode */}
            {details.permissionMode && (
              <div className="flex items-center gap-1">
                <span className="font-medium">
                  {tChat('thinking.system_permission') || 'Permission'}:
                </span>
                <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-xs">
                  {details.permissionMode}
                </span>
              </div>
            )}

            {/* Working directory */}
            {details.cwd && details.cwd !== '/app/executor' && (
              <div className="flex items-center gap-1">
                <span className="font-medium">
                  {tChat('thinking.system_directory') || 'Directory'}:
                </span>
                <span className="text-xs">{details.cwd}</span>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Handle execution failed with error_message and execution_type
    if (details.error_message || details.execution_type) {
      return (
        <div className="mt-2 rounded bg-red-500/5 p-2 border border-red-500/20">
          <div className="space-y-2">
            {details.error_message && (
              <div className="text-xs">
                <span className="font-medium text-red-300">
                  {tChat('thinking.error_message') || 'Error Message'}:
                </span>
                <pre className="mt-1 text-text-tertiary overflow-x-auto bg-surface/50 p-1.5 rounded whitespace-pre-wrap break-words">
                  {details.error_message}
                </pre>
              </div>
            )}
            {details.execution_type && (
              <div className="text-xs">
                <span className="font-medium text-red-300">
                  {tChat('thinking.execution_type') || 'Execution Type'}:
                </span>
                <span className="ml-2 text-text-tertiary">{details.execution_type}</span>
              </div>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className="w-full rounded-lg border border-border shadow-sm relative bg-surface/80"
      data-thinking-inline
    >
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-surface/60"
      >
        <div className="flex items-center gap-2">
          <Brain className="text-blue-400 h-4 w-4" />
          <span
            className={`font-medium text-sm ${isThinkingCompleted ? 'text-blue-300' : 'text-blue-400'}`}
          >
            {!isOpen && isThinkingCompleted
              ? formatCollapsedTitle()
              : isThinkingCompleted
                ? tTasks('thinking.execution_completed')
                : tChat('messages.thinking') || 'Thinking'}
          </span>
        </div>
        {isOpen ? (
          <ChevronUp className="text-text-tertiary h-4 w-4" />
        ) : (
          <ChevronDown className="text-text-tertiary h-4 w-4" />
        )}
      </button>

      {isOpen && (
        <div className="relative">
          <div
            ref={contentRef}
            className="overflow-y-auto custom-scrollbar space-y-3 px-3 pb-3 pt-1 max-h-[400px]"
          >
            {items.map((item, index) => {
              const confidenceText = formatConfidence(item.confidence);
              const hasLegacyFields = item.action || item.result || item.reasoning;

              return (
                <div
                  key={index}
                  className="rounded-md border border-border/60 bg-surface shadow-sm relative p-3"
                >
                  {/* Title */}
                  <div className="mb-2 font-semibold text-blue-300 text-xs">
                    {getThinkingText(item.title)}
                  </div>

                  {/* Legacy fields for backward compatibility */}
                  {hasLegacyFields && (
                    <>
                      {item.action && (
                        <div className="mb-2 text-xs text-text-secondary">
                          <span className="font-medium">
                            {tChat('messages.action') || 'Action'}:{' '}
                          </span>
                          {getThinkingText(item.action)}
                        </div>
                      )}
                      {item.result && (
                        <div key="result" className="mb-2 text-xs text-text-tertiary">
                          <span className="font-medium">
                            {tChat('messages.result') || 'Result'}:{' '}
                          </span>
                          {(() => {
                            const resultText = getThinkingText(item.result);
                            const isCollapsible = shouldCollapse(resultText);
                            const resultKey = `item-${index}-legacy-result`;
                            const isExpanded = expandedParams.has(resultKey);
                            const displayResult =
                              isCollapsible && !isExpanded
                                ? getContentPreview(resultText)
                                : resultText;

                            return (
                              <div>
                                {isCollapsible && (
                                  <div className="flex justify-end mb-1">
                                    <button
                                      onClick={() => toggleParamExpansion(resultKey)}
                                      className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                                    >
                                      {isExpanded ? (
                                        <>
                                          <Minimize2 className="h-3 w-3" />
                                          <span className="text-xs">
                                            {tChat('thinking.collapse') || 'Collapse'}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <Maximize2 className="h-3 w-3" />
                                          <span className="text-xs">
                                            {tChat('thinking.expand') || 'Expand'}
                                          </span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                )}
                                <div className="whitespace-pre-wrap">
                                  {displayResult}
                                  {isCollapsible && !isExpanded && (
                                    <span className="text-blue-400">...</span>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {item.reasoning && (
                        <div key="reasoning" className="mb-2 text-xs text-text-tertiary">
                          <span className="font-medium">
                            {tChat('messages.reasoning') || 'Reasoning'}:{' '}
                          </span>
                          {(() => {
                            const reasoningText = getThinkingText(item.reasoning);
                            const isCollapsible = shouldCollapse(reasoningText);
                            const reasoningKey = `item-${index}-legacy-reasoning`;
                            const isExpanded = expandedParams.has(reasoningKey);
                            const displayReasoning =
                              isCollapsible && !isExpanded
                                ? getContentPreview(reasoningText)
                                : reasoningText;

                            return (
                              <div>
                                {isCollapsible && (
                                  <div className="flex justify-end mb-1">
                                    <button
                                      onClick={() => toggleParamExpansion(reasoningKey)}
                                      className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                                    >
                                      {isExpanded ? (
                                        <>
                                          <Minimize2 className="h-3 w-3" />
                                          <span className="text-xs">
                                            {tChat('thinking.collapse') || 'Collapse'}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <Maximize2 className="h-3 w-3" />
                                          <span className="text-xs">
                                            {tChat('thinking.expand') || 'Expand'}
                                          </span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                )}
                                <div className="whitespace-pre-wrap">
                                  {displayReasoning}
                                  {isCollapsible && !isExpanded && (
                                    <span className="text-blue-400">...</span>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </>
                  )}

                  {/* New details field */}
                  {renderDetailsContent(item, index)}

                  {/* Footer with confidence and next_action */}
                  <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                    {confidenceText && (
                      <div className="text-xs text-text-tertiary">
                        <span className="font-medium">
                          {tChat('messages.confidence') || 'Confidence'}:{' '}
                        </span>
                        {confidenceText}
                      </div>
                    )}
                    {item.next_action &&
                      item.next_action !== 'continue' &&
                      item.next_action !== 'thinking.continue' && (
                        <div className="rounded bg-blue-500/10 px-2.5 py-1 text-xs text-blue-400 shadow-sm">
                          {getThinkingText(item.next_action)}
                        </div>
                      )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scroll to bottom button */}
          {showScrollToBottom && (
            <button
              onClick={handleScrollToBottom}
              className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs text-white shadow-md transition-all hover:bg-primary/90"
            >
              <ChevronsDown className="h-3 w-3" />
              <span>{tChat('thinking.scroll_to_bottom') || 'Scroll to bottom'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
