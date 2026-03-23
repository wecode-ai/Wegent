// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Image from 'next/image'

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { TFunction } from 'i18next'

import {
  formatModifiedAt,
  formatSize,
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
  inlineUrl: string
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
  onToggleEntrySelection: (entry: RemoteWorkspaceTreeEntry, checked: boolean) => void
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
  inlineUrl,
  searchKeyword,
  sortOption,
  canGoParent,
  canDownloadPreview,
  onGoRoot,
  onGoParent,
  onRefresh,
  onSearchChange,
  onSortChange,
  onToggleEntrySelection,
  onOpenEntry,
  onDownload,
}: RemoteWorkspaceDialogMobileProps) {
  const selectedCount = selectedPaths.size
  const detailEntry = selectedEntries.length === 1 ? selectedEntries[0] : null

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
            onClick={onGoParent}
            disabled={!canGoParent}
          >
            {t('remote_workspace.parent')}
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

      <Tabs defaultValue="files" className="flex min-h-0 flex-1 flex-col px-4 py-3">
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
          {!isTreeLoading &&
            !treeError &&
            visibleEntries.map(entry => {
              const isSelected = selectedPaths.has(entry.path)

              return (
                <div
                  key={entry.path}
                  className={`mb-2 rounded-md border p-3 ${isSelected ? 'border-primary bg-primary/10' : 'border-border bg-base'}`}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={checked => onToggleEntrySelection(entry, Boolean(checked))}
                      aria-label={`select-${entry.name}`}
                    />
                    <button
                      type="button"
                      className="min-h-[44px] flex-1 text-left text-sm text-text-primary"
                      onClick={() => onOpenEntry(entry)}
                    >
                      {entry.name}
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {resolveTypeLabel(entry, t)} ·{' '}
                    {entry.is_directory ? '--' : formatSize(entry.size)} ·{' '}
                    {formatModifiedAt(entry.modified_at)}
                  </div>
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
                <div className="min-h-[220px] rounded-md border border-border bg-surface p-3">
                  {previewKind === 'image' && inlineUrl && (
                    <Image
                      src={inlineUrl}
                      alt={detailEntry.name}
                      width={1200}
                      height={900}
                      unoptimized
                      className="max-h-[300px] max-w-full object-contain"
                    />
                  )}
                  {previewKind === 'pdf' && inlineUrl && (
                    <iframe
                      title={detailEntry.name}
                      src={inlineUrl}
                      className="h-[300px] w-full rounded-md border border-border"
                    />
                  )}
                  {previewKind === 'text' && (
                    <p className="text-sm text-text-muted">
                      {t('remote_workspace.preview.unsupported')}
                    </p>
                  )}
                  {previewKind === 'unsupported' && (
                    <p className="text-sm text-text-muted">
                      {t('remote_workspace.preview.unsupported')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <footer className="border-t border-border px-4 py-2 text-xs text-text-muted">
        {selectedCount} {t('remote_workspace.status.selected')} · {visibleEntries.length}{' '}
        {t('remote_workspace.status.items')}
      </footer>
    </div>
  )
}
