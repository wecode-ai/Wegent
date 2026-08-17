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
  GitFork,
  Loader2,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import type { SubagentBlock as SubagentBlockType } from '../types'
import {
  getChildSummary,
  getSubagentLifecycleStatus,
  getSubagentTitle,
  SubagentChildBlock,
} from './SubagentBlock'

const DEFAULT_VISIBLE_AGENT_COUNT = 5

interface SubagentGroupBlockProps {
  blocks: SubagentBlockType[]
  theme: 'light' | 'dark'
}

interface GroupStatus {
  completed: number
  running: number
  queued: number
  failed: number
}

function getGroupStatus(blocks: SubagentBlockType[]): GroupStatus {
  return blocks.reduce<GroupStatus>(
    (status, block) => {
      const lifecycleStatus = getSubagentLifecycleStatus(block.status)

      status[lifecycleStatus === 'completed' ? 'completed' : lifecycleStatus] += 1
      return status
    },
    { completed: 0, running: 0, queued: 0, failed: 0 }
  )
}

export const SubagentGroupBlock = memo(function SubagentGroupBlock({
  blocks,
  theme,
}: SubagentGroupBlockProps) {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(blocks[0]?.id ?? null)
  const status = useMemo(() => getGroupStatus(blocks), [blocks])
  const visibleBlocks = showAll ? blocks : blocks.slice(0, DEFAULT_VISIBLE_AGENT_COUNT)
  const remainingCount = Math.max(0, blocks.length - visibleBlocks.length)
  const hasRunning = status.running > 0
  const hasQueued = status.queued > 0
  const hasFailed = status.failed > 0
  const statusLabel = hasFailed
    ? t('thinking.subagent.parallel_progress_failed', {
        completed: status.completed,
        total: blocks.length,
        failed: status.failed,
      })
    : hasRunning
      ? t('thinking.subagent.parallel_progress_running', {
          completed: status.completed,
          total: blocks.length,
          running: status.running,
        })
      : hasQueued
        ? t('thinking.subagent.parallel_progress_queued', {
            completed: status.completed,
            total: blocks.length,
            queued: status.queued,
          })
        : t('thinking.subagent.parallel_progress', {
            completed: status.completed,
            total: blocks.length,
          })

  return (
    <div className="mb-1 w-full max-w-[760px]" data-testid="subagent-group-block">
      <button
        type="button"
        className={`inline-flex max-w-full items-center gap-1.5 rounded-xl border py-1 pl-1.5 pr-2.5 transition-colors ${
          hasFailed
            ? 'border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/30 dark:hover:bg-red-950/50'
            : 'border-[#e5e5e5] bg-[#f7f7f8] hover:border-[#ddd] hover:bg-[#f0f0f0] dark:border-[#3a3a3a] dark:bg-[#2a2a2a] dark:hover:border-[#444] dark:hover:bg-[#333]'
        }`}
        onClick={() => setIsExpanded(value => !value)}
        aria-expanded={isExpanded}
        data-testid="subagent-group-toggle"
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-md border border-[#e8e8e8] bg-white dark:border-[#444] dark:bg-[#3a3a3a]">
          {hasRunning ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin text-[#888] dark:text-[#999]" />
          ) : hasFailed ? (
            <AlertCircle className="h-2.5 w-2.5 text-red-500" />
          ) : (
            <GitFork className="h-2.5 w-2.5 text-[#888] dark:text-[#999]" />
          )}
        </span>
        <span className="truncate text-xs font-medium text-[#666] dark:text-[#aaa]">
          {t('thinking.subagent.parallel_title', { count: blocks.length })}
        </span>
        <span className="flex-shrink-0 text-xs text-[#999] dark:text-[#777]">{statusLabel}</span>
        {!hasRunning && !hasFailed && !hasQueued && (
          <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-[#999] dark:text-[#777]" />
        )}
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-[#aaa] dark:text-[#666]" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-[#aaa] dark:text-[#666]" />
        )}
      </button>

      {isExpanded && (
        <div className="ml-6 mt-1.5 border-l border-[#e5e5e5] pl-3 dark:border-[#3a3a3a]">
          <div className="max-w-[720px] space-y-0.5">
            {visibleBlocks.map(block => (
              <SubagentTreeItem
                key={block.id}
                block={block}
                theme={theme}
                isExpanded={expandedAgentId === block.id}
                onToggle={() =>
                  setExpandedAgentId(current => (current === block.id ? null : block.id))
                }
              />
            ))}
            {remainingCount > 0 && (
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-1.5 rounded px-2 text-left text-xs text-[#888] transition-colors hover:bg-[#f7f7f8] dark:text-[#888] dark:hover:bg-[#2a2a2a]"
                onClick={() => setShowAll(true)}
                data-testid="subagent-group-show-all"
              >
                <ChevronRight className="h-3 w-3 flex-shrink-0 text-[#aaa]" />
                {t('thinking.subagent.remaining', { count: remainingCount })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

function SubagentTreeItem({
  block,
  theme,
  isExpanded,
  onToggle,
}: {
  block: SubagentBlockType
  theme: 'light' | 'dark'
  isExpanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('chat')
  const children = block.children || []
  const summary = getChildSummary(children)
  const lifecycleStatus = getSubagentLifecycleStatus(block.status)
  const hasDetails = children.length > 0 || Boolean(block.summary)

  return (
    <div data-testid="subagent-tree-item">
      <button
        type="button"
        className={`flex min-h-8 w-full items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors hover:bg-[#f7f7f8] dark:hover:bg-[#2a2a2a] ${
          isExpanded ? 'bg-[#f7f7f8] dark:bg-[#2a2a2a]' : ''
        }`}
        onClick={() => hasDetails && onToggle()}
        aria-expanded={hasDetails ? isExpanded : undefined}
        data-testid={`subagent-tree-toggle-${block.id}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {hasDetails ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 flex-shrink-0 text-[#aaa]" />
            ) : (
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-[#aaa]" />
            )
          ) : (
            <span className="h-3 w-3 flex-shrink-0" />
          )}
          <span className="truncate text-xs font-medium text-[#666] dark:text-[#aaa]">
            {getSubagentTitle(block)}
          </span>
        </span>
        <span
          className="flex flex-shrink-0 items-center gap-1.5 text-xs text-[#999] dark:text-[#777]"
          data-testid={`subagent-tree-status-${block.id}`}
        >
          {lifecycleStatus === 'completed' && summary.toolCount > 0
            ? t('thinking.subagent.tool_count', { count: summary.toolCount })
            : t(`thinking.subagent.status_${lifecycleStatus}`)}
          {lifecycleStatus === 'queued' ? (
            <CircleDashed className="h-3 w-3" />
          ) : lifecycleStatus === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : lifecycleStatus === 'failed' ? (
            <AlertCircle className="h-3 w-3 text-red-500" />
          ) : (
            <CheckCircle2 className="h-3 w-3" />
          )}
        </span>
      </button>

      {isExpanded && hasDetails && (
        <div className="mb-2 ml-5 mt-1 space-y-2 border-l border-[#ececec] pl-3 dark:border-[#353535]">
          {block.summary && (
            <div className="text-xs text-[#666] dark:text-[#aaa]">
              <EnhancedMarkdown source={block.summary} theme={theme} />
            </div>
          )}
          {children.map(child => (
            <SubagentChildBlock key={child.id} block={child} theme={theme} />
          ))}
        </div>
      )}
    </div>
  )
}

export default SubagentGroupBlock
