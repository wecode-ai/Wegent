// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'

import { TruncatedText } from '@/components/common/long-text'
import { Badge } from '@/components/ui/badge'
import { SelectionIndicator } from '@/components/ui/selection-indicator'
import type { KnowledgeDocument } from '@/types/knowledge'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { KnowledgeSelectionControl } from './KnowledgeSelectionControl'
import {
  countSelectedInternalDocuments,
  hasSelectedInternalDocument,
  hasSelectedInternalFolder,
  isCoveredBySelectedAncestorFolder,
  type InternalTreeNode,
} from './knowledgeSourcePickerHelpers'

export interface InternalDocumentSearchResultsProps {
  items: Array<{ node: InternalTreeNode; path: string[] }>
  wholeKnowledgeBaseSelected: boolean
  selectedDocIds: Set<number>
  selectedFolderIds: Set<number>
  onToggleDocument: (document: KnowledgeDocument) => void
  onToggleFolder: (node: InternalTreeNode) => void
}

export function InternalDocumentSearchResults({
  items,
  wholeKnowledgeBaseSelected,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: InternalDocumentSearchResultsProps) {
  const { t } = useTranslation('knowledge')
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-muted">
        {t('picker.emptyDocuments')}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {items.map(({ node, path }) => {
        const isFolder = node.type === 'folder'
        const document = node.document
        const inheritedSelected =
          wholeKnowledgeBaseSelected || isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
        const selectedDocumentCount = countSelectedInternalDocuments(
          node,
          wholeKnowledgeBaseSelected,
          selectedDocIds,
          selectedFolderIds
        )
        const selected =
          isFolder && node.folderId !== undefined
            ? inheritedSelected || selectedFolderIds.has(node.folderId)
            : inheritedSelected || Boolean(document && selectedDocIds.has(document.id))
        const Icon = isFolder ? Folder : FileText
        const folderPartiallySelected =
          isFolder && selectedDocumentCount > 0 && selectedDocumentCount < node.documentCount
        const folderSelected =
          isFolder &&
          (selected || (selectedDocumentCount === node.documentCount && node.documentCount > 0))
        return (
          <button
            key={node.id}
            type="button"
            role={isFolder ? 'checkbox' : undefined}
            aria-checked={
              isFolder ? (folderPartiallySelected ? 'mixed' : folderSelected) : undefined
            }
            aria-pressed={!isFolder ? selected : undefined}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface',
              selected ? 'bg-primary/10 text-primary' : ''
            )}
            onClick={() => {
              if (isFolder) onToggleFolder(node)
              else if (document) onToggleDocument(document)
            }}
            data-testid={
              isFolder
                ? `knowledge-picker-search-folder-${node.folderId}`
                : `knowledge-picker-document-node-document-${document?.id}`
            }
          >
            <span className="flex min-w-0 items-start gap-2">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <TruncatedText
                  text={node.name}
                  tooltipText={formatKnowledgePath(path, node.name)}
                  focusable={false}
                  className="text-text-primary"
                />
                <PathLabel path={path} />
              </span>
            </span>
            {isFolder ? (
              <span className="flex items-center gap-2">
                <Badge variant="secondary" size="sm">
                  {node.documentCount}
                </Badge>
                <SelectionIndicator
                  checked={folderSelected}
                  indeterminate={folderPartiallySelected}
                />
              </span>
            ) : (
              <SelectionIndicator checked={selected} />
            )}
          </button>
        )
      })}
    </div>
  )
}

export interface InternalDocumentNodeProps {
  node: InternalTreeNode
  depth: number
  disabled: boolean
  wholeKnowledgeBaseSelected: boolean
  selectedDocIds: Set<number>
  selectedFolderIds: Set<number>
  onToggleDocument: (document: KnowledgeDocument) => void
  onToggleFolder: (node: InternalTreeNode) => void
}

export function InternalDocumentNode({
  node,
  depth,
  disabled,
  wholeKnowledgeBaseSelected,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: InternalDocumentNodeProps) {
  const isFolder = node.type === 'folder'
  const inheritedSelected =
    wholeKnowledgeBaseSelected || isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
  const selectedDocumentCount = countSelectedInternalDocuments(
    node,
    wholeKnowledgeBaseSelected,
    selectedDocIds,
    selectedFolderIds
  )
  const folderScopeSelected = Boolean(
    isFolder && (inheritedSelected || (node.folderId && selectedFolderIds.has(node.folderId)))
  )
  const folderSelected = Boolean(
    isFolder &&
    (folderScopeSelected ||
      (node.documentCount > 0 && selectedDocumentCount === node.documentCount))
  )
  const folderPartiallySelected =
    isFolder && selectedDocumentCount > 0 && selectedDocumentCount < node.documentCount
  const containsSelected =
    hasSelectedInternalDocument(node, selectedDocIds) ||
    (isFolder && hasSelectedInternalFolder(node, selectedFolderIds))
  const [open, setOpen] = useState(depth < 1 || containsSelected)
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])
  const selected =
    inheritedSelected || Boolean(node.document && selectedDocIds.has(node.document.id))
  const Icon = isFolder ? (open ? FolderOpen : Folder) : FileText

  return (
    <div>
      {isFolder ? (
        <div
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            folderSelected ? 'bg-primary/10 text-primary' : ''
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          data-testid={`knowledge-picker-document-node-${node.id}`}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            onClick={() => setOpen(!open)}
          >
            <ChevronRight
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-transform',
                open ? 'rotate-90' : ''
              )}
            />
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText text={node.name} focusable={false} className="text-text-primary" />
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary" size="sm">
              {node.documentCount}
            </Badge>
            <KnowledgeSelectionControl
              state={folderSelected ? 'checked' : folderPartiallySelected ? 'mixed' : 'unchecked'}
              onToggle={() => onToggleFolder(node)}
              testId={`knowledge-picker-folder-scope-${node.folderId}`}
              label={node.name}
            />
          </span>
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            selected ? 'bg-primary/10 text-primary' : '',
            disabled ? 'opacity-50' : ''
          )}
          aria-pressed={selected}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => {
            if (node.document && !disabled) onToggleDocument(node.document)
          }}
          data-testid={`knowledge-picker-document-node-${node.id}`}
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText
                text={node.name}
                tooltipText={formatKnowledgePath(node.path, node.name)}
                focusable={false}
                className="text-text-primary"
              />
              <PathLabel path={node.path} />
            </span>
          </span>
          <SelectionIndicator checked={selected} />
        </button>
      )}
      {isFolder && open
        ? node.children.map(child => (
            <InternalDocumentNode
              key={child.id}
              node={child}
              depth={depth + 1}
              disabled={disabled}
              wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              onToggleDocument={onToggleDocument}
              onToggleFolder={onToggleFolder}
            />
          ))
        : null}
    </div>
  )
}

function formatKnowledgePath(path: string[], name: string): string {
  return path.length > 0 ? [...path, name].join(' / ') : name
}

function PathLabel({ path }: { path: string[] }) {
  if (path.length === 0) return null
  return <span className="block truncate text-xs text-text-muted">{path.join(' / ')}</span>
}
