// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'
import { FilePreview } from '@/components/common/FilePreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { TFunction } from 'i18next'

import {
  formatModifiedAt,
  formatSize,
  getMimeTypeFromPreviewKind,
  resolvePreviewKind,
  type PreviewKind,
  type SortOption,
} from './remote-workspace-utils'

type RemoteWorkspaceDialogMobileProps = {
  t: TFunction<'translation', undefined>
  currentPath: string
  isTreeLoading: boolean
  treeError: string | null
  visibleEntries: RemoteWorkspaceTreeEntry[]
  selectedPaths: Set<string>
  selectedEntries: RemoteWorkspaceTreeEntry[]
  previewKind: PreviewKind
  previewBlob: Blob | null
  isPreviewLoading: boolean
  previewError: string | null
  searchKeyword: string
  sortOption: SortOption
  canGoParent: boolean
  canDownloadPreview: boolean
  onDownload: (entry: RemoteWorkspaceTreeEntry) => void
  onGoRoot: () => void
  onGoParent: () => void
  onRefresh: () => void
  onSearchChange: (value: string) => void
  onSortChange: (value: SortOption) => void
  onOpenEntry: (entry: RemoteWorkspaceTreeEntry) => void
}

function resolveTypeLabel(
  entry: RemoteWorkspaceTreeEntry,
  t: TFunction<'translation', undefined>
): string {
  if (entry.is_directory) {
    return t('remote_workspace.types.folder', 'Folder')
  }

  const previewKind = resolvePreviewKind(entry.name)
  if (previewKind === 'image') {
    return t('remote_workspace.types.image', 'Image')
  }
  if (previewKind === 'pdf') {
    return t('remote_workspace.types.pdf', 'PDF')
  }
  if (previewKind === 'text') {
    return t('remote_workspace.types.text', 'Text')
  }

  return t('remote_workspace.types.file', 'File')
}

export function RemoteWorkspaceDialogMobile({
  t,
  currentPath,
  isTreeLoading,
  treeError,
  visibleEntries,
  selectedPaths,
  selectedEntries,
  previewKind,
  previewBlob,
  isPreviewLoading,
  previewError,
  searchKeyword,
  sortOption,
  canGoParent,
  canDownloadPreview,
  onGoRoot,
  onGoParent,
  onRefresh,
  onSearchChange,
  onSortChange,
  onOpenEntry,
  onDownload,
}: RemoteWorkspaceDialogMobileProps) {
  const [activeTab, setActiveTab] = useState('files')
  const detailEntry = selectedEntries.length === 1 ? selectedEntries[0] : null
  const footerLabel = `${visibleEntries.length} ${t('remote_workspace.status.items')}`

  const handleEntryOpen = (entry: RemoteWorkspaceTreeEntry) => {
    onOpenEntry(entry)
    setActiveTab(entry.is_directory ? 'files' : 'preview')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-[44px]"
            onClick={onGoRoot}
          >
            {t('remote_workspace.root')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-[44px]"
            onClick={onRefresh}
          >
            {t('remote_workspace.actions.refresh')}
          </Button>
        </div>
        <Input
          value={searchKeyword}
          onChange={event => onSearchChange(event.target.value)}
          placeholder={t('remote_workspace.search_placeholder')}
          className="h-11"
        />
        <label
          className="flex items-center gap-2 text-xs text-text-muted"
          htmlFor="workspace-sort-mobile"
        >
          {t('remote_workspace.sort.label')}
          <select
            id="workspace-sort-mobile"
            className="h-11 w-full rounded-md border border-border bg-base px-2 text-sm text-text-primary"
            value={sortOption}
            onChange={event => onSortChange(event.target.value as SortOption)}
          >
            <option value="name_asc">{t('remote_workspace.sort.options.name_asc')}</option>
            <option value="name_desc">{t('remote_workspace.sort.options.name_desc')}</option>
            <option value="size_desc">{t('remote_workspace.sort.options.size_desc')}</option>
            <option value="modified_desc">
              {t('remote_workspace.sort.options.modified_desc')}
            </option>
          </select>
        </label>
      </section>

      <p className="border-b border-border px-4 py-2 text-xs text-text-muted">
        {t('remote_workspace.status.path')}: {currentPath}
      </p>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col px-4 py-3"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="files">{t('remote_workspace.mobile.tabs.files')}</TabsTrigger>
          <TabsTrigger value="preview">{t('remote_workspace.mobile.tabs.preview')}</TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-auto">
          {isTreeLoading && (
            <p className="text-sm text-text-muted">{t('remote_workspace.tree.loading')}</p>
          )}
          {!isTreeLoading && treeError && <p className="text-sm text-error">{treeError}</p>}
          {!isTreeLoading && !treeError && visibleEntries.length === 0 && (
            <p className="text-sm text-text-muted">{t('remote_workspace.tree.empty')}</p>
          )}
          {!isTreeLoading && !treeError && canGoParent && (
            <div className="mb-2 rounded-md border border-border bg-base p-3">
              <button
                type="button"
                className="flex min-h-[44px] w-full flex-col items-start justify-center text-left"
                data-testid="remote-workspace-mobile-parent-row"
                onClick={() => {
                  onGoParent()
                  setActiveTab('files')
                }}
              >
                <span className="text-sm text-text-primary">
                  {t('remote_workspace.parent_entry', 'Parent folder')}
                </span>
                <span className="mt-1 text-xs text-text-muted">
                  {t('remote_workspace.parent_entry_hint', 'Go back one level')}
                </span>
              </button>
            </div>
          )}
          {!isTreeLoading &&
            !treeError &&
            visibleEntries.map(entry => {
              const isSelected = selectedPaths.has(entry.path)

              return (
                <div
                  key={entry.path}
                  className={`mb-2 rounded-md border p-3 ${isSelected ? 'border-primary bg-primary/10' : 'border-border bg-base'}`}
                >
                  <button
                    type="button"
                    className="flex min-h-[44px] w-full flex-col items-start justify-center text-left"
                    onClick={() => handleEntryOpen(entry)}
                  >
                    <span className="text-sm text-text-primary">{entry.name}</span>
                    <span className="mt-1 text-xs text-text-muted">
                      {resolveTypeLabel(entry, t)} ·{' '}
                      {entry.is_directory ? '--' : formatSize(entry.size)} ·{' '}
                      {formatModifiedAt(entry.modified_at)}
                    </span>
                  </button>
                </div>
              )
            })}
        </TabsContent>

        <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto">
          {selectedEntries.length === 0 && (
            <p className="text-sm text-text-muted">
              {t('remote_workspace.detail.no_file_selected')}
            </p>
          )}
          {selectedEntries.length > 1 && (
            <p className="text-sm text-text-muted">
              {t('remote_workspace.detail.multiple_selected')}
            </p>
          )}
          {detailEntry && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-surface p-3 text-xs">
                <p className="font-medium text-text-primary">{detailEntry.name}</p>
                <p className="mt-1 break-all text-text-muted">
                  {t('remote_workspace.detail.metadata_path')}: {detailEntry.path}
                </p>
                <p className="text-text-muted">
                  {t('remote_workspace.detail.metadata_type')}: {resolveTypeLabel(detailEntry, t)}
                </p>
                <p className="text-text-muted">
                  {t('remote_workspace.detail.metadata_size')}:{' '}
                  {detailEntry.is_directory ? '--' : formatSize(detailEntry.size)}
                </p>
              </div>

              {!detailEntry.is_directory && canDownloadPreview && detailEntry && (
                <Button
                  variant="outline"
                  className="h-11 min-w-[44px]"
                  onClick={() => onDownload(detailEntry)}
                >
                  {t('remote_workspace.actions.download')}
                </Button>
              )}

              {!detailEntry.is_directory && (
                <div className="h-[360px] rounded-md border border-border bg-surface p-3">
                  {previewKind === 'unsupported' && (
                    <p className="text-sm text-text-muted">
                      {t('remote_workspace.preview.unsupported')}
                    </p>
                  )}
                  {previewKind !== 'unsupported' && previewError && (
                    <p className="text-sm text-error">{previewError}</p>
                  )}
                  {previewKind !== 'unsupported' &&
                    !previewError &&
                    (isPreviewLoading || !previewBlob) && (
                      <p className="text-sm text-text-muted">
                        {t('remote_workspace.preview.loading')}
                      </p>
                    )}
                  {previewKind !== 'unsupported' &&
                    !previewError &&
                    !isPreviewLoading &&
                    previewBlob && (
                      <FilePreview
                        fileBlob={previewBlob}
                        filename={detailEntry.name}
                        mimeType={getMimeTypeFromPreviewKind(previewKind, detailEntry.name)}
                        fileSize={detailEntry.size}
                        showToolbar={false}
                        onDownload={() => onDownload(detailEntry)}
                      />
                    )}
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <footer className="flex min-h-[60px] items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-text-muted">
        <span className="min-w-0 truncate">{footerLabel}</span>
      </footer>
    </div>
  )
}
