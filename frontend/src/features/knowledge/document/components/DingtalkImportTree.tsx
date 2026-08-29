// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronRight } from 'lucide-react'
import { DingtalkNodeIcon } from '@/components/icons/DingtalkNodeIcon'
import Link from 'next/link'
import { SelectionIndicator } from '@/components/ui/selection-indicator'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DingtalkDocNode, DingtalkSyncStatus } from '@/types/dingtalk-doc'
import type { ExternalDocumentImportStatuses } from '@/apis/knowledge'
import type { DocumentIndexStatus } from '@/types/knowledge'

const IMPORT_STATUS_KEYS: Record<DocumentIndexStatus, string> = {
  success: 'document.upload.dingtalk.imported',
  failed: 'document.upload.dingtalk.importFailed',
  queued: 'document.upload.dingtalk.importProcessing',
  pending_conversion: 'document.upload.dingtalk.importProcessing',
  converting: 'document.upload.dingtalk.importProcessing',
  indexing: 'document.upload.dingtalk.importProcessing',
  not_indexed: 'document.upload.dingtalk.importPending',
}

type SpreadsheetConfiguration = Pick<DingtalkSyncStatus, 'ai_table_configured' | 'table_configured'>

function spreadsheetConfigurationKey(node: DingtalkDocNode): keyof SpreadsheetConfiguration | null {
  if (node.node_type === 'folder' || node.content_type.toUpperCase() !== 'ALIDOC') return null
  if (node.extension === 'able') return 'ai_table_configured'
  if (node.extension === 'axls') return 'table_configured'
  return null
}

function isImportable(
  node: DingtalkDocNode,
  configuration?: SpreadsheetConfiguration | null
): boolean {
  if (node.node_type === 'folder') return false
  const configurationKey = spreadsheetConfigurationKey(node)
  if (configurationKey) return Boolean(configuration?.[configurationKey])
  if (node.content_type.toUpperCase() === 'ALIDOC' && node.extension === 'adoc') return true
  return (
    node.node_type === 'file' &&
    Boolean(node.content_type) &&
    node.content_type.toUpperCase() !== 'ALIDOC' &&
    ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md'].includes(node.extension ?? '')
  )
}

export function collectImportableIds(
  nodes: DingtalkDocNode[],
  query = '',
  configuration?: SpreadsheetConfiguration | null
): string[] {
  const normalized = query.trim().toLowerCase()
  return [
    ...new Set(
      nodes.flatMap(node => [
        ...(isImportable(node, configuration) && node.name.toLowerCase().includes(normalized)
          ? [node.dingtalk_node_id]
          : []),
        ...collectImportableIds(node.children ?? [], normalized, configuration),
      ])
    ),
  ]
}

/** Keep ancestors without turning a folder-name match into a subtree selection. */
export function filterImportTree(nodes: DingtalkDocNode[], query: string): DingtalkDocNode[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return nodes
  return nodes.flatMap(node => {
    const children = filterImportTree(node.children ?? [], normalized)
    return node.name.toLowerCase().includes(normalized) || children.length
      ? [{ ...node, children }]
      : []
  })
}

interface DingtalkImportTreeProps {
  importStatuses: ExternalDocumentImportStatuses
  nodes: DingtalkDocNode[]
  query: string
  selectedIds: Set<string>
  expandedKeys: Set<string>
  disabled: boolean
  configuration: SpreadsheetConfiguration | null
  onToggle: (ids: string[]) => void
  onExpand: (key: string) => void
}

/** Presentation shares the chat picker's indicator, not its context-selection model. */
export function DingtalkImportTree(props: DingtalkImportTreeProps) {
  return props.nodes.map(node => (
    <ImportTreeNode
      key={`${node.source}:${node.dingtalk_node_id}`}
      {...props}
      node={node}
      depth={0}
    />
  ))
}

function ImportTreeNode({
  node,
  depth,
  ...props
}: DingtalkImportTreeProps & {
  node: DingtalkDocNode
  depth: number
}) {
  const { t } = useTranslation('knowledge')
  const { query, selectedIds, expandedKeys, disabled, onToggle, onExpand } = props
  const searching = Boolean(query.trim())
  const folder = node.node_type === 'folder'
  const hasChildren = Boolean(node.children?.length)
  const importable = isImportable(node, props.configuration)
  const importStatus = importable ? props.importStatuses[node.dingtalk_node_id] : undefined
  // A document selects itself; only folders are bulk-selection shortcuts.
  const ids = folder
    ? collectImportableIds([node], '', props.configuration)
    : importable
      ? [node.dingtalk_node_id]
      : []
  const count = ids.filter(id => selectedIds.has(id)).length
  const checked = ids.length > 0 && count === ids.length
  const mixed = count > 0 && !checked
  const key = `${node.source}:${node.dingtalk_node_id}`
  const open = expandedKeys.has(key) || searching
  const visible = filterImportTree([node], query)[0]
  if (!visible) return null
  const selectDisabled = disabled || !ids.length || (folder && searching)
  return (
    <>
      <div
        className="group relative flex min-h-11 items-center rounded-md hover:bg-surface"
        style={{ paddingLeft: depth * 16 }}
        data-testid={`${folder ? 'dingtalk-folder-option' : 'dingtalk-document-option'}-${node.dingtalk_node_id}`}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 right-0 h-px bg-border"
          style={{ left: depth * 16 + 44 }}
        />
        {hasChildren ? (
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted focus-visible:outline-primary"
            aria-expanded={open}
            aria-label={t(
              open
                ? 'document.upload.dingtalk.collapseFolder'
                : 'document.upload.dingtalk.expandFolder',
              { name: node.name }
            )}
            disabled={disabled || !node.children?.length || searching}
            onClick={() => onExpand(key)}
            data-testid={`${folder ? 'dingtalk-folder-navigate' : 'dingtalk-node-expand'}-${node.dingtalk_node_id}`}
          >
            <ChevronRight className={cn('h-4 w-4', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" />
        )}
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-sm focus-visible:outline-primary"
          title={node.name}
          onClick={() => (folder ? onExpand(key) : onToggle(ids))}
          disabled={
            disabled ||
            (!folder && !importable) ||
            (folder && (!node.children?.length || searching))
          }
          data-testid={`dingtalk-node-name-${node.dingtalk_node_id}`}
        >
          <DingtalkNodeIcon node={node} expanded={open} />
          <span className="truncate">{node.name}</span>
          {folder && (
            <span
              className="shrink-0 text-xs text-text-muted"
              title={t('document.upload.dingtalk.folderDocumentCountHint')}
              data-testid={`dingtalk-folder-document-count-${node.dingtalk_node_id}`}
            >
              {t('document.upload.dingtalk.folderDocumentCount', { count: ids.length })}
            </span>
          )}
        </button>
        {importStatus && (
          <span
            className="ml-1 max-w-[45%] shrink-0 truncate rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text-secondary"
            title={t('document.upload.dingtalk.currentKbStatus', {
              status: t(IMPORT_STATUS_KEYS[importStatus]),
            })}
            data-testid={`dingtalk-import-status-${node.dingtalk_node_id}`}
          >
            {t(IMPORT_STATUS_KEYS[importStatus])}
          </span>
        )}
        {folder || importable ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={mixed ? 'mixed' : checked}
            aria-label={node.name}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            disabled={selectDisabled}
            onClick={() => onToggle(ids)}
            data-testid={`dingtalk-node-select-${node.dingtalk_node_id}`}
          >
            <SelectionIndicator checked={checked} indeterminate={mixed} mixedIcon="bar" />
          </button>
        ) : spreadsheetConfigurationKey(node) ? (
          <Link
            href="/settings?tab=integrations"
            className="flex min-h-11 shrink-0 items-center px-2 text-xs text-primary"
            title={t(
              node.extension === 'able'
                ? 'document.upload.dingtalk.aiTableNotConfigured'
                : 'document.upload.dingtalk.tableNotConfigured'
            )}
            data-testid={`dingtalk-node-configure-${node.dingtalk_node_id}`}
          >
            {t('document.goToSettings')}
          </Link>
        ) : (
          <span
            className="shrink-0 px-2 text-xs text-text-secondary"
            data-testid={`dingtalk-node-unsupported-${node.dingtalk_node_id}`}
          >
            {node.extension
              ? t('document.upload.dingtalk.unsupportedFormat', { extension: node.extension })
              : t('document.upload.dingtalk.unsupported')}
          </span>
        )}
      </div>
      {open &&
        node.children?.map(child => (
          <ImportTreeNode
            key={`${child.source}:${child.dingtalk_node_id}`}
            {...props}
            node={child}
            depth={depth + 1}
          />
        ))}
    </>
  )
}
