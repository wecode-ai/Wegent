// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CheckSquare, ChevronRight, Plus, Search, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeFolder } from '@/types/knowledge'

interface DocumentSourceWorkspaceHeaderProps {
  canUpload: boolean
  canToggleExpandAll: boolean
  isExpandAllView: boolean
  currentFolderId: number
  folderBreadcrumb: KnowledgeFolder[]
  searchQuery: string
  searchPlaceholder: string
  selectionEnabled: boolean
  documentCount: number
  isAllSelected: boolean
  selectedSelectableDocumentCount: number
  selectableDocumentCount: number
  usesAllAvailableDocuments: boolean
  availableDocumentCount: number | null
  selectedDocumentCount: number
  onAddMaterials: () => void
  onToggleExpandAll: () => void
  onNavigateFolder: (folderId: number) => void
  onSearchQueryChange: (value: string) => void
  onSelectAll: (selected: boolean) => void
}

export function DocumentSourceWorkspaceHeader({
  canUpload,
  canToggleExpandAll,
  isExpandAllView,
  currentFolderId,
  folderBreadcrumb,
  searchQuery,
  searchPlaceholder,
  selectionEnabled,
  documentCount,
  isAllSelected,
  selectedSelectableDocumentCount,
  selectableDocumentCount,
  usesAllAvailableDocuments,
  availableDocumentCount,
  selectedDocumentCount,
  onAddMaterials,
  onToggleExpandAll,
  onNavigateFolder,
  onSearchQueryChange,
  onSelectAll,
}: DocumentSourceWorkspaceHeaderProps) {
  const { t } = useTranslation('knowledge')

  return (
    <>
      {canUpload && (
        <Button
          variant="outline"
          className="h-11 w-full"
          onClick={onAddMaterials}
          data-testid="document-add-source-full-width"
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t('artifact.addMaterials')}
        </Button>
      )}

      <div
        className="flex items-center justify-between gap-2"
        data-testid="document-source-breadcrumb-row"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm text-text-muted">
          <button
            onClick={() => onNavigateFolder(0)}
            className={`shrink-0 transition-colors hover:text-text-primary ${
              currentFolderId === 0 ? 'font-medium text-text-primary' : ''
            }`}
            data-testid="breadcrumb-root"
          >
            {t('document.breadcrumb.root')}
          </button>
          {!isExpandAllView &&
            folderBreadcrumb.map((folder, index) => (
              <span key={folder.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
                {index < folderBreadcrumb.length - 1 ? (
                  <button
                    onClick={() => onNavigateFolder(folder.id)}
                    className="truncate transition-colors hover:text-text-primary"
                    data-testid={`breadcrumb-folder-${folder.id}`}
                  >
                    {folder.name}
                  </button>
                ) : (
                  <span className="truncate font-medium text-text-primary">{folder.name}</span>
                )}
              </span>
            ))}
        </div>
        {canToggleExpandAll && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 min-h-11 shrink-0"
            onClick={onToggleExpandAll}
            data-testid="expand-all-toggle"
          >
            {isExpandAllView ? t('document.tree.layeredNav') : t('document.tree.expandAll')}
          </Button>
        )}
      </div>

      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          className="h-11 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={event => onSearchQueryChange(event.target.value)}
          data-testid="document-source-search-input"
        />
      </div>

      {selectionEnabled && (
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 text-xs text-text-secondary"
          data-testid="document-source-scope-summary"
        >
          {documentCount > 0 && (
            <button
              type="button"
              onClick={() => onSelectAll(!isAllSelected)}
              className="flex min-h-11 shrink-0 items-center gap-1.5 text-text-muted transition-colors hover:text-text-primary md:min-h-0"
              aria-pressed={isAllSelected}
              data-testid="document-select-current-page"
            >
              {isAllSelected ? (
                <CheckSquare className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              <span>{t('document.document.batch.selectCurrentPage')}</span>
              <span>
                ({selectedSelectableDocumentCount}/{selectableDocumentCount})
              </span>
            </button>
          )}
          <span>
            {usesAllAvailableDocuments
              ? availableDocumentCount === null
                ? t('artifact.sourceDialog.all')
                : t('artifact.sourceDialog.defaultAllHint', {
                    count: availableDocumentCount,
                  })
              : t('artifact.sourceDialog.selectedHint', {
                  count: selectedDocumentCount,
                })}
          </span>
        </div>
      )}
    </>
  )
}
