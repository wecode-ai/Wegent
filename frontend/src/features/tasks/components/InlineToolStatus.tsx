// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { memo, useState } from 'react';
import { Search, CheckCircle2, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

interface ThinkingStep {
  title: string;
  next_action: string;
  details?: {
    type?: string;
    tool_name?: string;
    status?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface InlineToolStatusProps {
  thinking: ThinkingStep[] | null;
  taskStatus?: string;
}

/**
 * Inline tool status display for chat_v2.
 * Shows a collapsible timeline of tool usage.
 */
const InlineToolStatus = memo(function InlineToolStatus({
  thinking,
  taskStatus,
}: InlineToolStatusProps) {
  const { t } = useTranslation('chat');

  // Process thinking steps into paired tool entries
  interface ToolEntry {
    toolName: string;
    query: string;
    status: 'running' | 'completed';
    resultCount?: number;
    startIndex: number;
    endIndex?: number;
  }

  const toolEntries: ToolEntry[] = [];
  const toolStartMap = new Map<string, number>(); // Map run_id to start index

  if (thinking && thinking.length > 0) {
    thinking.forEach((step, index) => {
      const details = step.details;
      if (!details) return;

      // Track tool_use starts
      if (details.type === 'tool_use' && details.status === 'started') {
        const toolName: string =
          (typeof details.tool_name === 'string' ? details.tool_name : '') ||
          (typeof details.name === 'string' ? details.name : '') ||
          'unknown';
        const runId = (step as { run_id?: string }).run_id || `${index}`;

        let query: string = '';
        if (toolName === 'web_search' && details.input) {
          query = (details.input as { query?: string }).query || '';
        } else if (toolName === 'wegentFetch' && details.input) {
          query = (details.input as { url?: string }).url || '';
        } else {
          // For other tools, show a generic description
          const titleStr = typeof step.title === 'string' ? step.title : '';
          query = titleStr || toolName;
        }

        toolStartMap.set(runId, toolEntries.length);
        toolEntries.push({
          toolName,
          query,
          status: 'running',
          startIndex: index,
        });
      }
      // Match tool_result with tool_use
      else if (details.type === 'tool_result' && details.status === 'completed') {
        const toolName: string =
          (typeof details.tool_name === 'string' ? details.tool_name : '') ||
          (typeof details.name === 'string' ? details.name : '') ||
          'unknown';
        const runId = (step as { run_id?: string }).run_id || '';
        const startIdx = toolStartMap.get(runId);

        let resultCount: number | undefined;
        if (toolName === 'web_search') {
          try {
            const output = details.output || details.content;
            let outputData: { count?: number };

            if (typeof output === 'string') {
              outputData = JSON.parse(output);
            } else {
              outputData = output as { count?: number };
            }

            resultCount = outputData.count;
          } catch {
            // Ignore parse errors
          }
        }

        // Update the corresponding tool entry
        if (startIdx !== undefined && toolEntries[startIdx]) {
          toolEntries[startIdx].status = 'completed';
          toolEntries[startIdx].resultCount = resultCount;
          toolEntries[startIdx].endIndex = index;
        }
      }
    });
  }

  // Check if any tool is still running
  const hasRunning = toolEntries.some(entry => entry.status === 'running');

  // Default to expanded if there's an active tool
  // IMPORTANT: Call useState before any early returns
  const [isExpanded, setIsExpanded] = useState(hasRunning);

  // Early return after hooks
  if (!thinking || thinking.length === 0 || toolEntries.length === 0) {
    return null;
  }

  const isRunning = taskStatus === 'RUNNING';

  // Count total tools
  const toolCount = toolEntries.length;

  // Summary text
  const summaryText = isRunning
    ? `${t('messages.using_tools') || '使用工具中'}...`
    : toolCount > 0
      ? `${t('messages.used_tools') || '使用了工具'} · ${toolCount} ${t('messages.times') || '次'}`
      : `${t('messages.used_tools') || '使用了工具'}`;

  return (
    <div className="mb-3">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all hover:bg-surface/50 bg-blue-500/5 border-blue-500/20 text-blue-600 dark:text-blue-400"
      >
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
        )}
        <Search className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-xs font-medium">{summaryText}</span>
        {isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
        )}
      </button>

      {/* Expandable timeline */}
      {isExpanded && (
        <div className="mt-2 ml-4 border-l-2 border-blue-500/20 pl-4 space-y-3">
          {toolEntries.map((entry, index) => (
            <div key={index} className="space-y-2">
              {/* Tool start */}
              <div className="relative">
                <div className="absolute -left-[21px] top-1.5 w-3 h-3 rounded-full border-2 border-blue-500/40 bg-surface" />
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    {entry.status === 'running' ? (
                      <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 text-blue-500" />
                    )}
                    <span className="font-medium text-blue-600 dark:text-blue-400">
                      {entry.status === 'running'
                        ? `${t('messages.using_tool') || '使用工具'}: ${entry.toolName}`
                        : `${t('messages.tool_completed') || '工具完成'}: ${entry.toolName}`}
                    </span>
                  </div>
                  {entry.query && (
                    <div className="text-text-secondary ml-5">
                      {entry.toolName === 'web_search'
                        ? `${t('messages.query') || '查询'}: ${entry.query}`
                        : entry.query}
                    </div>
                  )}
                </div>
              </div>

              {/* Tool result (only if completed) */}
              {entry.status === 'completed' && (
                <div className="relative">
                  <div className="absolute -left-[21px] top-1.5 w-3 h-3 rounded-full border-2 border-green-500/40 bg-surface" />
                  <div className="text-xs">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                      <span className="font-medium text-green-600 dark:text-green-400">
                        {entry.toolName === 'web_search' && typeof entry.resultCount === 'number'
                          ? `${t('messages.found') || '找到'} ${entry.resultCount} ${t('messages.results') || '条结果'}`
                          : t('messages.tool_completed') || '工具完成'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export default InlineToolStatus;
