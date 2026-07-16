// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import ReasoningDisplay from '../ReasoningDisplay'
import type { MessageBlock, SubagentBlock as SubagentBlockType } from '../types'
import { blockToToolPair } from '../utils/blockToToolPair'
import { ToolBlock } from './ToolBlock'

interface SubagentBlockProps {
  block: SubagentBlockType
  theme: 'light' | 'dark'
  defaultExpanded?: boolean
}

export function isRunningStatus(status: MessageBlock['status']): boolean {
  return (
    status === 'generating_arguments' ||
    status === 'invoking' ||
    status === 'streaming' ||
    status === 'pending'
  )
}

export type SubagentLifecycleStatus = 'queued' | 'running' | 'completed' | 'failed'

export function getSubagentLifecycleStatus(
  status: MessageBlock['status']
): SubagentLifecycleStatus {
  if (status === 'error' || status === 'failed') return 'failed'
  if (status === 'done') return 'completed'
  if (isRunningStatus(status)) return 'running'
  return 'queued'
}

export function getSubagentTitle(block: SubagentBlockType): string {
  return (
    block.title ||
    block.description ||
    block.display_name ||
    block.agent_type ||
    block.tool_name ||
    'Subagent'
  )
}

export function getChildSummary(children: MessageBlock[] | undefined): {
  toolCount: number
  textCount: number
  hasErrors: boolean
  hasRunning: boolean
} {
  const initial = {
    toolCount: 0,
    textCount: 0,
    hasErrors: false,
    hasRunning: false,
  }

  return (children || []).reduce((summary, child) => {
    if (child.type === 'tool') {
      summary.toolCount += 1
    } else if (child.type === 'text' || child.type === 'thinking') {
      summary.textCount += 1
    }

    if (child.status === 'error' || child.status === 'failed') {
      summary.hasErrors = true
    }
    if (isRunningStatus(child.status)) {
      summary.hasRunning = true
    }

    return summary
  }, initial)
}

export const SubagentBlock = memo(function SubagentBlock({
  block,
  theme,
  defaultExpanded = false,
}: SubagentBlockProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const title = getSubagentTitle(block)
  const children = useMemo(() => block.children || [], [block.children])
  const summary = useMemo(() => getChildSummary(children), [children])
  const lifecycleStatus = getSubagentLifecycleStatus(block.status)
  const isRunning = lifecycleStatus === 'running'
  const hasError = lifecycleStatus === 'failed'
  const isCompleted = lifecycleStatus === 'completed'
  const hasDetails = children.length > 0 || Boolean(block.output || block.summary)
  const agentType = block.agent_type || block.tool_name || t('thinking.subagent.agent')

  return (
    <div className="mb-1">
      <div
        className={`inline-flex max-w-full items-center gap-1.5 pl-1.5 pr-2.5 py-1 border rounded-xl ${
          hasError
            ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
            : 'bg-[#f7f7f8] dark:bg-[#2a2a2a] border-[#e5e5e5] dark:border-[#3a3a3a]'
        } ${
          hasDetails
            ? 'cursor-pointer hover:bg-[#f0f0f0] dark:hover:bg-[#333] hover:border-[#ddd] dark:hover:border-[#444]'
            : 'cursor-default'
        } transition-all`}
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        data-testid="subagent-block"
      >
        <div className="flex items-center justify-center w-4 h-4 bg-white dark:bg-[#3a3a3a] border border-[#e8e8e8] dark:border-[#444] rounded-md flex-shrink-0">
          {lifecycleStatus === 'queued' ? (
            <CircleDashed className="w-2.5 h-2.5 text-[#aaa] dark:text-[#777]" />
          ) : isRunning ? (
            <Loader2 className="w-2.5 h-2.5 text-[#888] dark:text-[#999] animate-spin" />
          ) : hasError ? (
            <AlertCircle className="w-2.5 h-2.5 text-red-500" />
          ) : (
            <CheckCircle2 className="w-2.5 h-2.5 text-[#888] dark:text-[#999]" />
          )}
        </div>

        <span className="text-xs font-medium text-[#666] dark:text-[#aaa] truncate max-w-[320px]">
          {t('thinking.subagent.title')} {title}
        </span>

        <span className="text-xs text-[#999] dark:text-[#777] flex-shrink-0">{agentType}</span>

        {children.length > 0 && (
          <span className="text-xs text-[#999] dark:text-[#777] flex-shrink-0">
            {summary.toolCount > 0
              ? t('thinking.subagent.tool_count', { count: summary.toolCount })
              : t('thinking.subagent.step_count', { count: children.length })}
          </span>
        )}

        <span
          className="text-xs text-[#999] dark:text-[#777] flex-shrink-0"
          data-testid="subagent-status"
        >
          {t(`thinking.subagent.status_${lifecycleStatus}`)}
        </span>

        {isCompleted && (
          <CheckCircle2 className="w-3 h-3 text-[#999] dark:text-[#777] flex-shrink-0" />
        )}

        {hasDetails && (
          <div className="flex-shrink-0 ml-0.5">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-[#aaa] dark:text-[#666]" />
            ) : (
              <ChevronRight className="w-3 h-3 text-[#aaa] dark:text-[#666]" />
            )}
          </div>
        )}
      </div>

      {isExpanded && hasDetails && (
        <div className="mt-1.5 ml-6 space-y-2 border-l border-[#e5e5e5] dark:border-[#3a3a3a] pl-3">
          {block.summary && (
            <div className="text-xs text-[#666] dark:text-[#aaa]">
              <EnhancedMarkdown source={block.summary} theme={theme} />
            </div>
          )}
          {block.output && (
            <div className="text-xs text-[#666] dark:text-[#aaa]">
              <EnhancedMarkdown source={block.output} theme={theme} />
            </div>
          )}
          {children.map(child => (
            <SubagentChildBlock key={child.id} block={child} theme={theme} />
          ))}
        </div>
      )}
    </div>
  )
})

export function SubagentChildBlock({
  block,
  theme,
}: {
  block: MessageBlock
  theme: 'light' | 'dark'
}) {
  if (block.type === 'tool') {
    return <ToolBlock tool={blockToToolPair(block)} defaultExpanded={false} />
  }

  if (block.type === 'thinking') {
    return (
      <ReasoningDisplay
        reasoningContent={block.content || ''}
        isStreaming={block.status === 'streaming'}
      />
    )
  }

  if (block.type === 'text') {
    if (!block.content?.trim()) return null
    return (
      <div className="text-xs text-[#666] dark:text-[#aaa]">
        <EnhancedMarkdown source={block.content} theme={theme} />
      </div>
    )
  }

  if (block.type === 'subagent') {
    return <SubagentBlock block={block} theme={theme} />
  }

  return null
}

export default SubagentBlock
