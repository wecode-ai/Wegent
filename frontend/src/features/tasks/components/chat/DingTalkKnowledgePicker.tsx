// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, Database, FileText, Folder, FolderOpen } from 'lucide-react'

import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import type { ContextItem } from '@/types/context'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import {
  buildDingTalkDocContext,
  getDingTalkSelectedIds,
  getDingTalkSelectionKey,
} from './DingTalkDocContextSelector'

export function countDingTalkNodes(nodes: DingtalkDocNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countDingTalkNodes(node.children ?? []), 0)
}

function dingTalkNodeMatchesSearch(node: DingtalkDocNode, query: string): boolean {
  if (!query.trim()) return true
  const normalized = query.trim().toLowerCase()
  if (node.name.toLowerCase().includes(normalized)) return true
  return (node.children ?? []).some(child => dingTalkNodeMatchesSearch(child, query))
}

function filterDingTalkNodes(nodes: DingtalkDocNode[], query: string): DingtalkDocNode[] {
  if (!query.trim()) return nodes
  const normalized = query.trim().toLowerCase()
  return nodes.reduce<DingtalkDocNode[]>((result, node) => {
    const children = filterDingTalkNodes(node.children ?? [], query)
    if (node.name.toLowerCase().includes(normalized) || children.length > 0) {
      result.push({ ...node, children })
    }
    return result
  }, [])
}

function SelectionIndicator({
  selected,
  indeterminate = false,
}: {
  selected: boolean
  indeterminate?: boolean
}) {
  return (
    <span
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-border bg-base text-transparent transition-colors group-hover:border-primary/70',
        selected && !indeterminate ? 'border-primary bg-primary text-white shadow-sm' : '',
        indeterminate ? 'border-primary bg-primary/10 text-primary' : ''
      )}
    >
      {indeterminate ? (
        <span className="h-0.5 w-2.5 rounded bg-current" />
      ) : selected ? (
        <Check className="h-3 w-3 stroke-[2.5]" />
      ) : null}
    </span>
  )
}

function collectSelectableDingTalkNodes(node: DingtalkDocNode): DingtalkDocNode[] {
  if (node.node_type !== 'folder') return [node]
  return (node.children ?? []).flatMap(collectSelectableDingTalkNodes)
}

function DingTalkPickerLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-muted">
      {label}
    </div>
  )
}

function DingTalkPickerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <div className="text-sm text-red-500">{message}</div>
      <button type="button" className="text-xs text-primary hover:underline" onClick={onRetry}>
        {t('common:actions.retry')}
      </button>
    </div>
  )
}

function DingTalkPickerEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-muted">
      {label}
    </div>
  )
}

export function useDingTalkKnowledgeSelection({
  selectedContexts,
  onSelect,
  onDeselect,
  onSelectMultiple,
  onDeselectMultiple,
}: {
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onSelectMultiple?: (contexts: ContextItem[]) => void
  onDeselectMultiple?: (ids: (number | string)[]) => void
}) {
  const selectedIds = getDingTalkSelectedIds(selectedContexts)

  const toggleNode = useCallback(
    (node: DingtalkDocNode, container?: { id?: string; name?: string }) => {
      if (node.node_type === 'folder') {
        const descendants = collectSelectableDingTalkNodes(node)
        const descendantIds = descendants.map(descendant =>
          getDingTalkSelectionKey(descendant.source, descendant.dingtalk_node_id)
        )
        const allSelected =
          descendantIds.length > 0 && descendantIds.every(id => selectedIds.has(id))
        if (allSelected) {
          if (onDeselectMultiple) {
            onDeselectMultiple(descendantIds)
          } else {
            descendantIds.forEach(id => onDeselect(id))
          }
          return
        }

        const contexts = descendants
          .filter(
            descendant =>
              !selectedIds.has(
                getDingTalkSelectionKey(descendant.source, descendant.dingtalk_node_id)
              )
          )
          .map(descendant => buildDingTalkDocContext(descendant, container))
        if (onSelectMultiple) {
          onSelectMultiple(contexts)
        } else {
          contexts.forEach(context => onSelect(context))
        }
        return
      }

      const selectionKey = getDingTalkSelectionKey(node.source, node.dingtalk_node_id)
      if (selectedIds.has(selectionKey)) {
        onDeselect(selectionKey)
      } else {
        onSelect(buildDingTalkDocContext(node, container))
      }
    },
    [onDeselect, onDeselectMultiple, onSelect, onSelectMultiple, selectedIds]
  )

  return {
    selectedIds,
    toggleNode,
  }
}

export function DingTalkDocsRootRow({
  nodes,
  totalCount,
  loading,
  error,
  configured,
  onRetry,
}: {
  nodes: DingtalkDocNode[]
  totalCount: number
  loading: boolean
  error: string | null
  configured: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation('chat')
  if (loading) return <DingTalkPickerLoading label={t('common:actions.loading')} />
  if (error) return <DingTalkPickerError message={error} onRetry={onRetry} />
  if (!configured) return <DingTalkPickerEmpty label={t('chat:dingtalkDocs.notConfigured')} />
  if (nodes.length === 0) return <DingTalkPickerEmpty label={t('chat:dingtalkDocs.empty')} />

  return (
    <div className="space-y-1 p-2">
      <div
        className="group flex w-full items-center justify-between gap-2 rounded-md bg-primary/10 px-3 py-2 text-left text-primary hover:bg-primary/15"
        data-testid="knowledge-picker-dingtalk-all-docs"
      >
        <span className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {t('chat:dingtalkDocs.allDocs')}
            </span>
            <span className="block text-xs text-text-muted">
              {t('knowledge:picker.count.documents', { count: totalCount })}
            </span>
          </span>
        </span>
      </div>
    </div>
  )
}

export function DingTalkWikispaceRows({
  nodes,
  query,
  loading,
  error,
  configured,
  activeNode,
  onRetry,
  onOpen,
}: {
  nodes: DingtalkDocNode[]
  query: string
  loading: boolean
  error: string | null
  configured: boolean
  activeNode: DingtalkDocNode | null
  onRetry: () => void
  onOpen: (node: DingtalkDocNode) => void
}) {
  const { t } = useTranslation('chat')
  if (loading) return <DingTalkPickerLoading label={t('common:actions.loading')} />
  if (error) return <DingTalkPickerError message={error} onRetry={onRetry} />
  if (!configured)
    return <DingTalkPickerEmpty label={t('chat:dingtalkDocs.wikispaceNotConfigured')} />

  const visibleNodes = nodes.filter(node => dingTalkNodeMatchesSearch(node, query))
  if (visibleNodes.length === 0)
    return <DingTalkPickerEmpty label={t('chat:dingtalkDocs.wikispaceEmpty')} />

  return (
    <div className="space-y-1 p-2">
      {visibleNodes.map(node => {
        const active = activeNode?.dingtalk_node_id === node.dingtalk_node_id
        return (
          <div
            key={getDingTalkSelectionKey(node.source, node.dingtalk_node_id)}
            className={cn(
              'group flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-surface',
              active ? 'bg-primary/10 text-primary' : 'text-text-primary'
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onOpen(node)}
              data-testid={`knowledge-picker-dingtalk-space-${node.dingtalk_node_id}`}
            >
              <Database className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{node.name}</span>
                <span className="block text-xs text-text-muted">
                  {t('knowledge:picker.count.documents', {
                    count: countDingTalkNodes(node.children ?? []),
                  })}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-text-muted" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function DingTalkDocumentHeader({
  title,
  documentCount,
}: {
  title: string
  documentCount: number
}) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-text-primary">{title}</div>
        <div className="text-xs text-text-muted">
          {t('picker.count.documents', { count: documentCount })}
        </div>
      </div>
    </div>
  )
}

export function DingTalkDocumentColumn({
  title,
  nodes,
  totalCount,
  loading,
  error,
  configured,
  notConfiguredLabel,
  emptyLabel,
  query,
  selectedIds,
  onRetry,
  onToggle,
}: {
  title: string
  nodes: DingtalkDocNode[]
  totalCount: number
  loading: boolean
  error: string | null
  configured: boolean
  notConfiguredLabel: string
  emptyLabel: string
  query: string
  selectedIds: Set<string>
  onRetry: () => void
  onToggle: (node: DingtalkDocNode) => void
}) {
  const { t } = useTranslation('chat')
  const visibleNodes = filterDingTalkNodes(nodes, query)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DingTalkDocumentHeader title={title} documentCount={totalCount} />
      {loading ? (
        <DingTalkPickerLoading label={t('common:actions.loading')} />
      ) : error ? (
        <DingTalkPickerError message={error} onRetry={onRetry} />
      ) : !configured ? (
        <DingTalkPickerEmpty label={notConfiguredLabel} />
      ) : visibleNodes.length === 0 ? (
        <DingTalkPickerEmpty label={emptyLabel} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visibleNodes.map(node => (
            <DingTalkDocumentNode
              key={getDingTalkSelectionKey(node.source, node.dingtalk_node_id)}
              node={node}
              depth={0}
              selectedIds={selectedIds}
              forceOpen={Boolean(query.trim())}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DingTalkDocumentNode({
  node,
  depth,
  selectedIds,
  forceOpen,
  onToggle,
}: {
  node: DingtalkDocNode
  depth: number
  selectedIds: Set<string>
  forceOpen: boolean
  onToggle: (node: DingtalkDocNode) => void
}) {
  const isFolder = node.node_type === 'folder'
  const hasChildren = (node.children ?? []).length > 0
  const [open, setOpen] = useState(depth < 1 || forceOpen)
  useEffect(() => {
    if (forceOpen) {
      setOpen(true)
    }
  }, [forceOpen])
  const selectionKey = getDingTalkSelectionKey(node.source, node.dingtalk_node_id)
  const selectableDescendants = isFolder ? collectSelectableDingTalkNodes(node) : []
  const selectedDescendantCount = selectableDescendants.filter(descendant =>
    selectedIds.has(getDingTalkSelectionKey(descendant.source, descendant.dingtalk_node_id))
  ).length
  const selected = isFolder
    ? selectableDescendants.length > 0 && selectedDescendantCount === selectableDescendants.length
    : selectedIds.has(selectionKey)
  const partiallySelected =
    isFolder &&
    selectedDescendantCount > 0 &&
    selectedDescendantCount < selectableDescendants.length
  const Icon = isFolder ? (open ? FolderOpen : Folder) : FileText

  return (
    <div>
      <div
        className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-md pr-2 text-left text-sm hover:bg-surface"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => (isFolder ? setOpen(!open) : onToggle(node))}
          data-testid={`knowledge-picker-dingtalk-node-${node.source}-${node.dingtalk_node_id}`}
        >
          {isFolder && hasChildren ? (
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 text-text-muted transition-transform',
                open && 'rotate-90'
              )}
            />
          ) : (
            <span className="h-4 w-4 shrink-0" />
          )}
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="truncate text-text-primary">{node.name}</span>
          </span>
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={partiallySelected ? 'mixed' : selected}
          aria-label={node.name}
          disabled={isFolder && !hasChildren}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary md:h-9 md:w-9"
          onClick={() => onToggle(node)}
          data-testid={`knowledge-picker-dingtalk-node-select-${node.source}-${node.dingtalk_node_id}`}
        >
          <SelectionIndicator selected={selected} indeterminate={partiallySelected} />
        </button>
      </div>
      {isFolder && open
        ? (node.children ?? []).map(child => (
            <DingTalkDocumentNode
              key={getDingTalkSelectionKey(child.source, child.dingtalk_node_id)}
              node={child}
              depth={depth + 1}
              selectedIds={selectedIds}
              forceOpen={forceOpen}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  )
}
