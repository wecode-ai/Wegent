// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Download, X } from 'lucide-react'
import { useState } from 'react'

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { TFunction } from 'i18next'

import {
  formatModifiedAt,
  formatSize,
  getMimeTypeFromPreviewKind,
  resolvePreviewKind,
  type BreadcrumbSegment,
  type PreviewKind,
  type SortOption,
} from './remote-workspace-utils'
import { FilePreview } from '@/components/common/FilePreview'
import {
  type RemoteWorkspaceDirectoryCache,
  RemoteWorkspaceDirectoryTree,
} from './RemoteWorkspaceDirectoryTree'

type RemoteWorkspaceDialogDesktopProps = {
  t: TFunction<'translation', undefined>
  rootPath: string
  currentPath: string
  breadcrumbs: BreadcrumbSegment[]
  directoryCache: RemoteWorkspaceDirectoryCache
  expandedDirectoryPaths: Set<string>
  isTreeLoading: boolean
  treeError: string | null
  visibleEntries: RemoteWorkspaceTreeEntry[]
  selectedPaths: Set<string>
  selectedEntries: RemoteWorkspaceTreeEntry[]
  previewEntry: RemoteWorkspaceTreeEntry | null
  previewKind: PreviewKind
  previewBlob: Blob | null
  searchKeyword: string
  sortOption: SortOption
  pathInputValue: string
  pathInputError: string | null
  isPathEditing: boolean
  canGoParent: boolean
  isPreviewDialogOpen: boolean
  onDownload: (entry: RemoteWorkspaceTreeEntry) => void
  onGoRoot: () => void
  onGoParent: () => void
  onRefresh: () => void
  onToggleDirectoryExpand: (path: string) => void
  onSelectDirectory: (path: string) => void
  onRetryDirectoryLoad: (path: string) => void
  onSearchChange: (value: string) => void
  onSortChange: (value: SortOption) => void
  onPathEditStart: () => void
  onPathInputChange: (value: string) => void
  onPathSubmit: () => void
  onPathEditCancel: () => void
  onToggleAllEntries: (checked: boolean) => void
  onToggleEntrySelection: (entry: RemoteWorkspaceTreeEntry, checked: boolean) => void
  onSelectEntry: (entry: RemoteWorkspaceTreeEntry) => void
  onOpenEntry: (entry: RemoteWorkspaceTreeEntry) => void
  onPreviewDialogOpenChange: (open: boolean) => void
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
  if (previewKind === 'excel') {
    return t('remote_workspace.types.excel', 'Excel')
  }
  if (previewKind === 'text') {
    return t('remote_workspace.types.text', 'Text')
  }

  return t('remote_workspace.types.file', 'File')
}

export function RemoteWorkspaceDialogDesktop({
  t,
  rootPath,
  currentPath,
  breadcrumbs,
  directoryCache,
  expandedDirectoryPaths,
  isTreeLoading,
  treeError,
  visibleEntries,
  selectedPaths,
  selectedEntries,
  previewEntry,
  previewKind,
  previewBlob,
  searchKeyword,
  sortOption,
  pathInputValue,
  pathInputError,
  isPathEditing,
  canGoParent,
  isPreviewDialogOpen,
  onGoRoot,
  onGoParent,
  onRefresh,
  onToggleDirectoryExpand,
  onSelectDirectory,
  onRetryDirectoryLoad,
  onSearchChange,
  onSortChange,
  onPathEditStart,
  onPathInputChange,
  onPathSubmit,
  onPathEditCancel,
  onToggleAllEntries,
  onToggleEntrySelection,
  onSelectEntry,
  onOpenEntry,
  onPreviewDialogOpenChange,
  onDownload,
}: RemoteWorkspaceDialogDesktopProps) {
  const [isDownloadConfirmOpen, setIsDownloadConfirmOpen] = useState(false)
  const selectableEntries = visibleEntries.filter(entry => !entry.is_directory)
  const allEntriesSelected =
    selectableEntries.length > 0 && selectableEntries.every(entry => selectedPaths.has(entry.path))
  const selectedCount = selectedPaths.size
  const detailEntry = selectedEntries.length === 1 ? selectedEntries[0] : null
  const downloadableSelectedEntries = selectedEntries.filter(entry => !entry.is_directory)
  const downloadableSelectedCount = downloadableSelectedEntries.length
  const handleDownloadSelectedEntries = () => {
    if (downloadableSelectedCount === 1) {
      onDownload(downloadableSelectedEntries[0])
      return
    }

    if (downloadableSelectedCount > 1) {
      setIsDownloadConfirmOpen(true)
    }
  }
  const handleConfirmDownloadSelectedEntries = () => {
    downloadableSelectedEntries.forEach(entry => onDownload(entry))
    setIsDownloadConfirmOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onGoRoot}>
            {t('remote_workspace.root')}
          </Button>
          <div className="w-full min-w-[200px] flex-1 md:max-w-[420px]">
            <Input
              value={searchKeyword}
              onChange={event => onSearchChange(event.target.value)}
              placeholder={t('remote_workspace.search_placeholder')}
            />
          </div>
          <label
            className="flex items-center gap-2 text-xs text-text-muted"
            htmlFor="workspace-sort"
          >
            {t('remote_workspace.sort.label')}
            <select
              id="workspace-sort"
              aria-label={t('remote_workspace.sort.label')}
              className="h-9 rounded-md border border-border bg-base px-2 text-sm text-text-primary"
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
          <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
            {t('remote_workspace.actions.refresh')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPreviewDialogOpenChange(true)}
            disabled={!previewEntry}
          >
            {t('remote_workspace.actions.preview', 'Preview')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={downloadableSelectedCount === 0}
            onClick={handleDownloadSelectedEntries}
          >
            {t('remote_workspace.actions.download')}
          </Button>
        </div>

        {isPathEditing ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="workspace-path" className="shrink-0 text-xs text-text-muted">
                {t('remote_workspace.status.path')}
              </label>
              <Input
                id="workspace-path"
                value={pathInputValue}
                autoFocus
                onChange={event => onPathInputChange(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onPathSubmit()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    onPathEditCancel()
                  }
                }}
                className="h-9"
              />
              <Button type="button" variant="outline" size="sm" onClick={onPathSubmit}>
                {t('remote_workspace.actions.go', 'Go')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onPathEditCancel}>
                {t('remote_workspace.actions.cancel', 'Cancel')}
              </Button>
            </div>
            {pathInputError && <p className="pl-9 text-xs text-error">{pathInputError}</p>}
          </div>
        ) : (
          <button
            type="button"
            aria-label={t('remote_workspace.path.edit', 'Edit path')}
            className="mt-3 flex h-9 w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-surface px-3 text-left text-sm text-text-muted hover:bg-base"
            onClick={onPathEditStart}
          >
            {breadcrumbs.map((segment, index) => (
              <div className="flex items-center gap-2" key={segment.path}>
                <span className={index === breadcrumbs.length - 1 ? 'text-text-primary' : ''}>
                  {segment.label}
                </span>
                {index < breadcrumbs.length - 1 && <span>/</span>}
              </div>
            ))}
          </button>
        )}
      </section>

      <section className="grid min-h-0 flex-1 overflow-hidden grid-cols-[220px_minmax(0,1fr)_300px] xl:grid-cols-[240px_minmax(0,1fr)_340px]">
        <RemoteWorkspaceDirectoryTree
          t={t}
          rootPath={rootPath}
          currentPath={currentPath}
          directoryCache={directoryCache}
          expandedDirectoryPaths={expandedDirectoryPaths}
          onToggleDirectoryExpand={onToggleDirectoryExpand}
          onSelectDirectory={onSelectDirectory}
          onRetryDirectoryLoad={onRetryDirectoryLoad}
        />

        <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
          <div className="h-full min-h-0 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 border-b border-border bg-surface text-text-muted">
                <tr>
                  <th className="w-10 px-3 py-2 text-left">
                    <Checkbox
                      aria-label={t('remote_workspace.columns.select_all')}
                      checked={allEntriesSelected}
                      disabled={selectableEntries.length === 0}
                      onCheckedChange={checked => onToggleAllEntries(Boolean(checked))}
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('remote_workspace.columns.name')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('remote_workspace.columns.type')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('remote_workspace.columns.size')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('remote_workspace.columns.modified')}
                  </th>
                </tr>
              </thead>

              <tbody>
                {isTreeLoading && (
                  <tr>
                    <td className="px-3 py-6 text-text-muted" colSpan={5}>
                      {t('remote_workspace.tree.loading')}
                    </td>
                  </tr>
                )}

                {!isTreeLoading && treeError && (
                  <tr>
                    <td className="px-3 py-6 text-error" colSpan={5}>
                      {treeError}
                    </td>
                  </tr>
                )}

                {!isTreeLoading && !treeError && visibleEntries.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-text-muted" colSpan={5}>
                      {t('remote_workspace.tree.empty')}
                    </td>
                  </tr>
                )}

                {!isTreeLoading && !treeError && canGoParent && (
                  <tr
                    className="cursor-pointer hover:bg-surface"
                    data-testid="remote-workspace-parent-row"
                    onClick={onGoParent}
                  >
                    <td className="px-3 py-2 align-middle" />
                    <td className="px-3 py-2 align-middle">
                      <span className="block max-w-[280px] truncate rounded px-1 py-1 text-left text-text-primary">
                        {t('remote_workspace.parent_entry', 'Parent folder')}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle text-text-muted">
                      {t('remote_workspace.types.folder', 'Folder')}
                    </td>
                    <td className="px-3 py-2 align-middle text-text-muted">--</td>
                    <td className="px-3 py-2 align-middle text-text-muted">--</td>
                  </tr>
                )}

                {!isTreeLoading &&
                  !treeError &&
                  visibleEntries.map(entry => {
                    const isSelectable = !entry.is_directory
                    const isSelected = isSelectable && selectedPaths.has(entry.path)

                    return (
                      <tr
                        key={entry.path}
                        className={
                          isSelected
                            ? 'bg-primary/10 cursor-pointer'
                            : 'hover:bg-surface cursor-pointer'
                        }
                        onClick={() => {
                          if (entry.is_directory) {
                            onOpenEntry(entry)
                            return
                          }

                          onSelectEntry(entry)
                        }}
                        onDoubleClick={() => onOpenEntry(entry)}
                      >
                        <td className="px-3 py-2 align-middle">
                          {isSelectable && (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={checked =>
                                onToggleEntrySelection(entry, Boolean(checked))
                              }
                              onClick={event => event.stopPropagation()}
                              onDoubleClick={event => event.stopPropagation()}
                              aria-label={`select-${entry.name}`}
                            />
                          )}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <span className="block max-w-[280px] truncate rounded px-1 py-1 text-left text-text-primary">
                            {entry.name}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-middle text-text-muted">
                          {resolveTypeLabel(entry, t)}
                        </td>
                        <td className="px-3 py-2 align-middle text-text-muted">
                          {entry.is_directory ? '--' : formatSize(entry.size)}
                        </td>
                        <td className="px-3 py-2 align-middle text-text-muted">
                          {formatModifiedAt(entry.modified_at)}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="min-h-0 min-w-0 overflow-auto p-4">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('remote_workspace.detail.title')}
          </h3>

          {selectedEntries.length === 0 && (
            <p className="mt-3 text-sm text-text-muted">
              {t('remote_workspace.detail.no_file_selected')}
            </p>
          )}

          {selectedEntries.length > 1 && (
            <p className="mt-3 text-sm text-text-muted">
              {t('remote_workspace.detail.multiple_selected')}
            </p>
          )}

          {detailEntry && (
            <div className="mt-3 space-y-3">
              <p className="truncate text-sm font-medium text-text-primary">{detailEntry.name}</p>

              <div className="space-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <p className="font-medium text-text-primary">
                  {t('remote_workspace.detail.metadata')}
                </p>
                <p className="break-all text-text-muted">
                  {t('remote_workspace.detail.metadata_path')}: {detailEntry.path}
                </p>
                <p className="text-text-muted">
                  {t('remote_workspace.detail.metadata_type')}: {resolveTypeLabel(detailEntry, t)}
                </p>
                <p className="text-text-muted">
                  {t('remote_workspace.detail.metadata_size')}:{' '}
                  {detailEntry.is_directory ? '--' : formatSize(detailEntry.size)}
                </p>
                <p className="text-text-muted">
                  {t('remote_workspace.detail.metadata_modified')}:{' '}
                  {formatModifiedAt(detailEntry.modified_at)}
                </p>
              </div>

              {!detailEntry.is_directory && (
                <p className="text-xs text-text-muted">
                  {t('remote_workspace.preview.hint', 'Double-click the file name to open preview')}
                </p>
              )}
            </div>
          )}
        </aside>
      </section>

      <footer className="h-8 shrink-0 border-t border-border px-4 py-1.5 text-xs text-text-muted">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            {selectedCount} {t('remote_workspace.status.selected')}
          </span>
          <span>
            {visibleEntries.length} {t('remote_workspace.status.items')}
          </span>
        </div>
      </footer>

      <AlertDialog open={isDownloadConfirmOpen} onOpenChange={setIsDownloadConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote_workspace.download_confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('remote_workspace.download_confirm.description', {
                count: downloadableSelectedCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('remote_workspace.actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="border-primary bg-primary text-white hover:bg-primary/90"
              onClick={handleConfirmDownloadSelectedEntries}
            >
              {t('remote_workspace.actions.download')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={isPreviewDialogOpen && Boolean(previewEntry)}
        onOpenChange={onPreviewDialogOpenChange}
      >
        <DialogContent
          className="!flex !h-[90vh] !w-[96vw] !max-w-[1400px] !flex-col gap-0 overflow-hidden p-0"
          aria-label="Preview"
          hideCloseButton
        >
          {previewEntry && (
            <>
              {/* Header - Same style as FilePreviewPage */}
              <header className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-2xl">{getFileIcon(previewKind)}</span>
                  <div className="min-w-0">
                    <h1 className="font-medium text-text-primary truncate max-w-[200px] sm:max-w-[300px] md:max-w-[500px]">
                      {previewEntry.name}
                    </h1>
                    <p className="text-xs text-text-secondary truncate max-w-[200px] sm:max-w-[300px] md:max-w-[500px]">
                      {previewEntry.path}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button variant="primary" size="sm" onClick={() => onDownload(previewEntry)}>
                    <Download className="w-4 h-4 mr-2" />
                    {t('remote_workspace.actions.download')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onPreviewDialogOpenChange(false)}
                    title={t('remote_workspace.actions.close', 'Close')}
                  >
                    <X className="w-5 h-5" />
                  </Button>
                </div>
              </header>

              {/* Preview Content */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
                <div className="min-h-0 flex-1 overflow-hidden">
                  {previewKind === 'unsupported' ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-text-muted">
                        {t('remote_workspace.preview.unsupported')}
                      </p>
                    </div>
                  ) : previewEntry && previewBlob ? (
                    <FilePreview
                      fileBlob={previewBlob || undefined}
                      filename={previewEntry.name}
                      mimeType={getMimeTypeFromPreviewKind(previewKind, previewEntry.name)}
                      fileSize={previewEntry.size}
                      showToolbar={previewKind === 'image'}
                      onDownload={() => onDownload(previewEntry)}
                      onClose={() => onPreviewDialogOpenChange(false)}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-text-muted">
                        {t('remote_workspace.preview.loading')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Get file icon based on preview kind
 */
function getFileIcon(previewKind: PreviewKind): string {
  switch (previewKind) {
    case 'image':
      return '🖼️'
    case 'pdf':
      return '📄'
    case 'excel':
      return '📊'
    case 'text':
      return '📃'
    default:
      return '📎'
  }
}
