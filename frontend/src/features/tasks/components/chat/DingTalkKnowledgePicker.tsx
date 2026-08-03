// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Database, FileText, Folder, FolderOpen } from 'lucide-react'

import { SelectionIndicator } from '@/components/ui/selection-indicator'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import type { ContextItem, DingTalkDocContext } from '@/types/context'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { getDingTalkSelectionKey } from './DingTalkDocContextSelector'

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

type SelectionState = 'checked' | 'mixed' | 'unchecked'

function flattenDingTalkNodes(nodes: DingtalkDocNode[]): DingtalkDocNode[] {
  return nodes.flatMap(node => [node, ...flattenDingTalkNodes(node.children ?? [])])
}

function hasAncestorInSet(
  node: DingtalkDocNode,
  ids: Set<string>,
  nodesById: Map<string, DingtalkDocNode>
): boolean {
  let parentId = node.parent_node_id
  while (parentId) {
    if (ids.has(parentId)) return true
    parentId = nodesById.get(parentId)?.parent_node_id ?? ''
  }
  return false
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
  onReplace,
}: {
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onReplace?: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
}) {
  const getScope = useCallback(
    (source: DingtalkDocNode['source'], containerId: string) =>
      selectedContexts.find(
        (context): context is DingTalkDocContext =>
          context.type === 'dingtalk_doc' &&
          context.source === source &&
          context.container_id === containerId
      ),
    [selectedContexts]
  )

  const replaceScope = useCallback(
    (existing: DingTalkDocContext | undefined, next?: DingTalkDocContext) => {
      const ids = existing ? [existing.id] : []
      if (onReplace) {
        onReplace(ids, next ? [next] : [])
        return
      }
      ids.forEach(onDeselect)
      if (next) onSelect(next)
    },
    [onDeselect, onReplace, onSelect]
  )

  const buildScope = useCallback(
    (
      source: DingtalkDocNode['source'],
      container: { id: string; name: string; url?: string },
      values: Pick<
        DingTalkDocContext,
        'scope_mode' | 'folder_ids' | 'document_ids' | 'excluded_node_ids'
      >
    ): DingTalkDocContext => ({
      id: `dingtalk-scope:${source}:${container.id}`,
      name: container.name,
      type: 'dingtalk_doc',
      doc_url: container.url ?? '',
      node_type: 'folder',
      dingtalk_node_id: container.id,
      source,
      container_id: container.id,
      container_name: container.name,
      include_descendants: true,
      ...values,
    }),
    []
  )

  const toggleAll = useCallback(
    (source: DingtalkDocNode['source'], container: { id: string; name: string; url?: string }) => {
      const existing = getScope(source, container.id)
      if (existing?.scope_mode === 'all' && !(existing.excluded_node_ids?.length ?? 0)) {
        replaceScope(existing)
        return
      }
      replaceScope(
        existing,
        buildScope(source, container, {
          scope_mode: 'all',
          folder_ids: [],
          document_ids: [],
          excluded_node_ids: [],
        })
      )
    },
    [buildScope, getScope, replaceScope]
  )

  const toggleNode = useCallback(
    (
      node: DingtalkDocNode,
      container: { id: string; name: string; url?: string },
      roots: DingtalkDocNode[]
    ) => {
      const existing = getScope(node.source, container.id)
      const folderIds = existing?.folder_ids ?? []
      const documentIds = existing?.document_ids ?? []
      const excludedIds = existing?.excluded_node_ids ?? []
      const nodesById = new Map(
        flattenDingTalkNodes(roots).map(item => [item.dingtalk_node_id, item])
      )
      const targetIds = node.node_type === 'folder' ? folderIds : documentIds
      const explicitlySelected = targetIds.includes(node.dingtalk_node_id)
      const directlyExcluded = excludedIds.includes(node.dingtalk_node_id)
      const excludedByAncestor = hasAncestorInSet(node, new Set(excludedIds), nodesById)
      const inheritedFromFolder = hasAncestorInSet(node, new Set(folderIds), nodesById)

      if (existing?.scope_mode === 'all') {
        if (excludedByAncestor) {
          const ancestorId = findNearestAncestorInSet(node, new Set(excludedIds), nodesById)
          replaceScope(
            existing,
            buildScope(node.source, container, {
              scope_mode: 'all',
              folder_ids: [],
              document_ids: [],
              excluded_node_ids: excludedIds.filter(id => id !== ancestorId),
            })
          )
          return
        }
        replaceScope(
          existing,
          buildScope(node.source, container, {
            scope_mode: 'all',
            folder_ids: [],
            document_ids: [],
            excluded_node_ids: directlyExcluded
              ? excludedIds.filter(id => id !== node.dingtalk_node_id)
              : [...excludedIds, node.dingtalk_node_id],
          })
        )
        return
      }

      if (excludedByAncestor) {
        const ancestorId = findNearestAncestorInSet(node, new Set(excludedIds), nodesById)
        replaceScope(
          existing,
          buildScope(node.source, container, {
            scope_mode: 'custom',
            folder_ids: folderIds,
            document_ids: documentIds,
            excluded_node_ids: excludedIds.filter(id => id !== ancestorId),
          })
        )
        return
      }

      if (directlyExcluded || inheritedFromFolder) {
        replaceScope(
          existing,
          buildScope(node.source, container, {
            scope_mode: 'custom',
            folder_ids: folderIds,
            document_ids: documentIds,
            excluded_node_ids: directlyExcluded
              ? excludedIds.filter(id => id !== node.dingtalk_node_id)
              : [...excludedIds, node.dingtalk_node_id],
          })
        )
        return
      }

      const descendantIds = new Set(
        flattenDingTalkNodes(node.children ?? []).map(item => item.dingtalk_node_id)
      )
      const nextFolderIds =
        node.node_type === 'folder'
          ? explicitlySelected
            ? folderIds.filter(id => id !== node.dingtalk_node_id)
            : [...folderIds.filter(id => !descendantIds.has(id)), node.dingtalk_node_id]
          : folderIds
      const nextDocumentIds =
        node.node_type === 'folder'
          ? explicitlySelected
            ? documentIds
            : documentIds.filter(id => !descendantIds.has(id))
          : explicitlySelected
            ? documentIds.filter(id => id !== node.dingtalk_node_id)
            : [...documentIds, node.dingtalk_node_id]
      const nextExcludedIds =
        node.node_type === 'folder' && !explicitlySelected
          ? excludedIds.filter(id => !descendantIds.has(id))
          : excludedIds
      if (nextFolderIds.length === 0 && nextDocumentIds.length === 0) {
        replaceScope(existing)
        return
      }
      replaceScope(
        existing,
        buildScope(node.source, container, {
          scope_mode: 'custom',
          folder_ids: nextFolderIds,
          document_ids: nextDocumentIds,
          excluded_node_ids: nextExcludedIds,
        })
      )
    },
    [buildScope, getScope, replaceScope]
  )

  return {
    getScope,
    toggleNode,
    toggleAll,
  }
}

function findNearestAncestorInSet(
  node: DingtalkDocNode,
  ids: Set<string>,
  nodesById: Map<string, DingtalkDocNode>
): string | undefined {
  let parentId = node.parent_node_id
  while (parentId) {
    if (ids.has(parentId)) return parentId
    parentId = nodesById.get(parentId)?.parent_node_id ?? ''
  }
  return undefined
}

export function getDingTalkContainerSelectionState(
  scope: DingTalkDocContext | undefined
): SelectionState {
  if (!scope) return 'unchecked'
  if (scope.scope_mode === 'all' && (scope.excluded_node_ids?.length ?? 0) === 0) {
    return 'checked'
  }
  return 'mixed'
}

export function getDingTalkNodeSelectionState(
  node: DingtalkDocNode,
  scope: DingTalkDocContext | undefined,
  roots: DingtalkDocNode[]
): SelectionState {
  if (!scope) return 'unchecked'
  const nodesById = new Map(flattenDingTalkNodes(roots).map(item => [item.dingtalk_node_id, item]))
  const folderIds = new Set(scope.folder_ids ?? [])
  const documentIds = new Set(scope.document_ids ?? [])
  const excludedIds = new Set(scope.excluded_node_ids ?? [])
  const excluded =
    excludedIds.has(node.dingtalk_node_id) || hasAncestorInSet(node, excludedIds, nodesById)
  const inherited =
    scope.scope_mode === 'all' ||
    folderIds.has(node.dingtalk_node_id) ||
    hasAncestorInSet(node, folderIds, nodesById)
  const selected =
    !excluded &&
    (inherited || (node.node_type !== 'folder' && documentIds.has(node.dingtalk_node_id)))
  const descendantIds = new Set(
    flattenDingTalkNodes(node.children ?? []).map(item => item.dingtalk_node_id)
  )
  const hasPartialDescendant =
    [...folderIds, ...documentIds].some(id => descendantIds.has(id)) ||
    [...excludedIds].some(id => descendantIds.has(id))

  if (node.node_type === 'folder' && hasPartialDescendant) return 'mixed'
  return selected ? 'checked' : 'unchecked'
}

export function DingTalkDocsRootRow({
  nodes,
  totalCount,
  loading,
  error,
  configured,
  scope,
  onRetry,
  onToggle,
}: {
  nodes: DingtalkDocNode[]
  totalCount: number
  loading: boolean
  error: string | null
  configured: boolean
  scope?: DingTalkDocContext
  onRetry: () => void
  onToggle: () => void
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
        <ScopeSelectionButton
          state={getDingTalkContainerSelectionState(scope)}
          label={t('chat:dingtalkDocs.allDocs')}
          testId="knowledge-picker-dingtalk-all-docs-select"
          onClick={onToggle}
        />
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
  getScope,
  onRetry,
  onOpen,
  onToggle,
}: {
  nodes: DingtalkDocNode[]
  query: string
  loading: boolean
  error: string | null
  configured: boolean
  activeNode: DingtalkDocNode | null
  getScope: (
    source: DingtalkDocNode['source'],
    containerId: string
  ) => DingTalkDocContext | undefined
  onRetry: () => void
  onOpen: (node: DingtalkDocNode) => void
  onToggle: (node: DingtalkDocNode) => void
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
        const state = getDingTalkContainerSelectionState(
          getScope(node.source, node.workspace_id || node.dingtalk_node_id)
        )
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
            <ScopeSelectionButton
              state={state}
              label={node.name}
              testId={`knowledge-picker-dingtalk-space-select-${node.dingtalk_node_id}`}
              onClick={() => onToggle(node)}
            />
          </div>
        )
      })}
    </div>
  )
}

function ScopeSelectionButton({
  state,
  label,
  testId,
  onClick,
}: {
  state: SelectionState
  label: string
  testId: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary md:h-9 md:w-9"
      onClick={onClick}
      data-testid={testId}
    >
      <SelectionIndicator
        checked={state === 'checked'}
        indeterminate={state === 'mixed'}
        mixedIcon="bar"
      />
    </button>
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
  scope,
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
  scope?: DingTalkDocContext
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
              roots={nodes}
              depth={0}
              scope={scope}
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
  roots,
  depth,
  scope,
  forceOpen,
  onToggle,
}: {
  node: DingtalkDocNode
  roots: DingtalkDocNode[]
  depth: number
  scope?: DingTalkDocContext
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
  const state = getDingTalkNodeSelectionState(node, scope, roots)
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
          aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
          aria-label={node.name}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary md:h-9 md:w-9"
          onClick={() => onToggle(node)}
          data-testid={`knowledge-picker-dingtalk-node-select-${node.source}-${node.dingtalk_node_id}`}
        >
          <SelectionIndicator
            checked={state === 'checked'}
            indeterminate={state === 'mixed'}
            mixedIcon="bar"
          />
        </button>
      </div>
      {isFolder && open
        ? (node.children ?? []).map(child => (
            <DingTalkDocumentNode
              key={getDingTalkSelectionKey(child.source, child.dingtalk_node_id)}
              node={child}
              roots={roots}
              depth={depth + 1}
              scope={scope}
              forceOpen={forceOpen}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  )
}
