// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import Image from 'next/image'

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

import {
  formatModifiedAt,
  formatSize,
  resolvePreviewKind,
  type BreadcrumbSegment,
  type PreviewKind,
  type SortOption,
} from './remote-workspace-utils'

type Translate = (key: string, defaultValue?: string) => string

type RemoteWorkspaceDialogDesktopProps = {
  t: Translate
  currentPath: string
  breadcrumbs: BreadcrumbSegment[]
  isTreeLoading: boolean
  treeError: string | null
  visibleEntries: RemoteWorkspaceTreeEntry[]
  selectedPaths: Set<string>
  selectedEntries: RemoteWorkspaceTreeEntry[]
  previewEntry: RemoteWorkspaceTreeEntry | null
  previewKind: PreviewKind
  inlineUrl: string
  downloadUrl: string
  textContent: string
  isTextLoading: boolean
  textError: string | null
  searchKeyword: string
  sortOption: SortOption
  canGoParent: boolean
  canDownloadPreview: boolean
  onGoRoot: () => void
  onGoParent: () => void
  onRefresh: () => void
  onBreadcrumbClick: (path: string) => void
  onSearchChange: (value: string) => void
  onSortChange: (value: SortOption) => void
  onToggleAllEntries: (checked: boolean) => void
  onToggleEntrySelection: (entry: RemoteWorkspaceTreeEntry, checked: boolean) => void
  onOpenEntry: (entry: RemoteWorkspaceTreeEntry) => void
}

function resolveTypeLabel(entry: RemoteWorkspaceTreeEntry, t: Translate): string {
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

export function RemoteWorkspaceDialogDesktop({
  t,
  currentPath,
  breadcrumbs,
  isTreeLoading,
  treeError,
  visibleEntries,
  selectedPaths,
  selectedEntries,
  previewEntry,
  previewKind,
  inlineUrl,
  downloadUrl,
  textContent,
  isTextLoading,
  textError,
  searchKeyword,
  sortOption,
  canGoParent,
  canDownloadPreview,
  onGoRoot,
  onGoParent,
  onRefresh,
  onBreadcrumbClick,
  onSearchChange,
  onSortChange,
  onToggleAllEntries,
  onToggleEntrySelection,
  onOpenEntry,
}: RemoteWorkspaceDialogDesktopProps) {
  const allEntriesSelected =
    visibleEntries.length > 0 && visibleEntries.every(entry => selectedPaths.has(entry.path))
  const selectedCount = selectedPaths.size
  const detailEntry = selectedEntries.length === 1 ? selectedEntries[0] : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onGoRoot}>
            {t('remote_workspace.root')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onGoParent}
            disabled={!canGoParent}
          >
            {t('remote_workspace.parent')}
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
          {canDownloadPreview ? (
            <Button asChild type="button" variant="outline" size="sm">
              <a href={downloadUrl} download={previewEntry?.name}>
                {t('remote_workspace.actions.download')}
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled>
              {t('remote_workspace.actions.download')}
            </Button>
          )}
        </div>

        <div className="mt-2 flex h-8 flex-wrap items-center gap-2 overflow-hidden text-sm text-text-muted">
          {breadcrumbs.map((segment, index) => {
            const isLast = index === breadcrumbs.length - 1
            return (
              <div className="flex items-center gap-2" key={segment.path}>
                {isLast ? (
                  <span className="text-text-primary">{segment.label}</span>
                ) : (
                  <button
                    type="button"
                    className="rounded px-1 hover:bg-surface hover:text-text-primary"
                    onClick={() => onBreadcrumbClick(segment.path)}
                  >
                    {segment.label}
                  </button>
                )}
                {!isLast && <span>/</span>}
              </div>
            )
          })}
        </div>
      </section>

      <section className="grid min-h-0 flex-1 overflow-hidden grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
          <div className="h-full min-h-0 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 border-b border-border bg-surface text-text-muted">
                <tr>
                  <th className="w-10 px-3 py-2 text-left">
                    <Checkbox
                      aria-label={t('remote_workspace.columns.select_all')}
                      checked={allEntriesSelected}
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

                {!isTreeLoading &&
                  !treeError &&
                  visibleEntries.map(entry => {
                    const isSelected = selectedPaths.has(entry.path)

                    return (
                      <tr
                        key={entry.path}
                        className={isSelected ? 'bg-primary/10' : 'hover:bg-surface'}
                      >
                        <td className="px-3 py-2 align-middle">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={checked =>
                              onToggleEntrySelection(entry, Boolean(checked))
                            }
                            aria-label={`select-${entry.name}`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <button
                            type="button"
                            className="max-w-[280px] truncate rounded px-1 py-1 text-left text-text-primary hover:bg-base"
                            onClick={() => onOpenEntry(entry)}
                          >
                            {entry.name}
                          </button>
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
                <div className="min-h-[220px] overflow-auto rounded-md border border-border bg-surface p-3">
                  {previewKind === 'image' && inlineUrl && (
                    <div className="flex h-full items-center justify-center">
                      <Image
                        src={inlineUrl}
                        alt={detailEntry.name}
                        width={1200}
                        height={900}
                        unoptimized
                        className="max-h-[280px] max-w-full object-contain"
                      />
                    </div>
                  )}

                  {previewKind === 'pdf' && inlineUrl && (
                    <iframe
                      title={detailEntry.name}
                      src={inlineUrl}
                      className="h-[320px] w-full rounded-md border border-border"
                    />
                  )}

                  {previewKind === 'text' && (
                    <>
                      {isTextLoading && (
                        <p className="text-sm text-text-muted">
                          {t('remote_workspace.preview.loading')}
                        </p>
                      )}
                      {!isTextLoading && textError && (
                        <p className="text-sm text-error">{textError}</p>
                      )}
                      {!isTextLoading && !textError && (
                        <pre className="whitespace-pre-wrap break-words text-xs text-text-primary">
                          {textContent}
                        </pre>
                      )}
                    </>
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
        </aside>
      </section>

      <footer className="h-8 shrink-0 border-t border-border px-4 py-1.5 text-xs text-text-muted">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            {t('remote_workspace.status.path')}: {currentPath}
          </span>
          <span>
            {selectedCount} {t('remote_workspace.status.selected')}
          </span>
          <span>
            {visibleEntries.length} {t('remote_workspace.status.items')}
          </span>
        </div>
      </footer>
    </div>
  )
}
