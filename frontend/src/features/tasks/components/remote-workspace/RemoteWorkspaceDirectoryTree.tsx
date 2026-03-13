// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'
import { ChevronDown, ChevronRight, FolderTree } from 'lucide-react'

import { TFunction } from 'i18next'

export type RemoteWorkspaceDirectoryState = {
  entries: RemoteWorkspaceTreeEntry[]
  isLoading: boolean
  error: string | null
  loaded: boolean
}

export type RemoteWorkspaceDirectoryCache = Record<string, RemoteWorkspaceDirectoryState>

type RemoteWorkspaceDirectoryTreeProps = {
  t: TFunction<'translation', undefined>
  rootPath: string
  currentPath: string
  directoryCache: RemoteWorkspaceDirectoryCache
  expandedDirectoryPaths: Set<string>
  onToggleDirectoryExpand: (path: string) => void
  onSelectDirectory: (path: string) => void
  onRetryDirectoryLoad: (path: string) => void
}

type DirectoryNodeProps = {
  t: TFunction<'translation', undefined>
  path: string
  label: string
  depth: number
  currentPath: string
  rootPath: string
  directoryCache: RemoteWorkspaceDirectoryCache
  expandedDirectoryPaths: Set<string>
  onToggleDirectoryExpand: (path: string) => void
  onSelectDirectory: (path: string) => void
  onRetryDirectoryLoad: (path: string) => void
}

function sortDirectoryEntries(entries: RemoteWorkspaceTreeEntry[]): RemoteWorkspaceTreeEntry[] {
  return [...entries]
    .filter(entry => entry.is_directory)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function DirectoryNode({
  t,
  path,
  label,
  depth,
  currentPath,
  rootPath,
  directoryCache,
  expandedDirectoryPaths,
  onToggleDirectoryExpand,
  onSelectDirectory,
  onRetryDirectoryLoad,
}: DirectoryNodeProps) {
  const nodeState = directoryCache[path]
  const childDirectories = sortDirectoryEntries(nodeState?.entries ?? [])
  const isExpanded = expandedDirectoryPaths.has(path)
  const isCurrentPath = currentPath === path
  const canCollapse = path !== rootPath
  const expandLabel = `${t('remote_workspace.tree.expand', 'Expand')} ${label}`
  const collapseLabel = `${t('remote_workspace.tree.collapse', 'Collapse')} ${label}`
  const openLabel = `${t('remote_workspace.tree.open_directory', 'Open directory')} ${label}`

  return (
    <li>
      <div
        className={`group flex h-9 items-center gap-1 rounded-md px-1 ${isCurrentPath ? 'bg-primary/10' : 'hover:bg-surface'}`}
        style={{ paddingLeft: `${depth * 10 + 6}px` }}
      >
        {canCollapse ? (
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-base hover:text-text-primary"
            aria-label={isExpanded ? collapseLabel : expandLabel}
            onClick={() => onToggleDirectoryExpand(path)}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="flex h-6 w-6 items-center justify-center text-text-muted">
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        )}

        <button
          type="button"
          aria-label={openLabel}
          className={`min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-sm transition-colors ${isCurrentPath ? 'font-medium text-primary' : 'text-text-secondary hover:bg-base hover:text-text-primary'}`}
          onClick={() => onSelectDirectory(path)}
        >
          {label}
        </button>
      </div>

      {isExpanded && nodeState?.isLoading && (
        <p className="pl-9 text-xs text-text-muted">
          {t('remote_workspace.tree.loading_children', 'Loading children...')}
        </p>
      )}

      {isExpanded && !nodeState?.isLoading && nodeState?.error && (
        <div className="flex items-center gap-2 pl-9 text-xs text-error">
          <span>{nodeState.error}</span>
          <button
            type="button"
            className="rounded-sm border border-border px-1 text-text-primary hover:bg-surface"
            onClick={() => onRetryDirectoryLoad(path)}
          >
            {t('remote_workspace.tree.retry', 'Retry')}
          </button>
        </div>
      )}

      {isExpanded && childDirectories.length > 0 && (
        <ul className="space-y-1">
          {childDirectories.map(directory => (
            <DirectoryNode
              key={directory.path}
              t={t}
              path={directory.path}
              label={directory.name}
              depth={depth + 1}
              currentPath={currentPath}
              rootPath={rootPath}
              directoryCache={directoryCache}
              expandedDirectoryPaths={expandedDirectoryPaths}
              onToggleDirectoryExpand={onToggleDirectoryExpand}
              onSelectDirectory={onSelectDirectory}
              onRetryDirectoryLoad={onRetryDirectoryLoad}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function RemoteWorkspaceDirectoryTree({
  t,
  rootPath,
  currentPath,
  directoryCache,
  expandedDirectoryPaths,
  onToggleDirectoryExpand,
  onSelectDirectory,
  onRetryDirectoryLoad,
}: RemoteWorkspaceDirectoryTreeProps) {
  const rootLabel = rootPath.split('/').filter(Boolean).at(-1) || 'workspace'

  return (
    <aside className="min-h-0 min-w-0 overflow-hidden border-r border-border bg-base">
      <div className="h-full min-h-0 overflow-auto p-3">
        <h3 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-text-muted">
          <FolderTree className="h-3.5 w-3.5" />
          {t('remote_workspace.tree.title', 'Directory Tree')}
        </h3>

        <ul className="space-y-0.5">
          <DirectoryNode
            t={t}
            path={rootPath}
            label={rootLabel}
            depth={0}
            currentPath={currentPath}
            rootPath={rootPath}
            directoryCache={directoryCache}
            expandedDirectoryPaths={expandedDirectoryPaths}
            onToggleDirectoryExpand={onToggleDirectoryExpand}
            onSelectDirectory={onSelectDirectory}
            onRetryDirectoryLoad={onRetryDirectoryLoad}
          />
        </ul>
      </div>
    </aside>
  )
}
