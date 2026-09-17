// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'

import type { WikiPageSummary } from '@/apis/wiki'
import { useTranslation } from '@/hooks/useTranslation'

export interface WikiPageTreeNode {
  key: string
  name: string
  page: WikiPageSummary | null
  children: WikiPageTreeNode[]
}

interface WikiPageTreeProps {
  pages: WikiPageSummary[]
  boundPageIds: Set<string>
  selectedPageIds: Set<string>
  selectablePages: WikiPageSummary[]
  expandedPaths: Set<string>
  disabled: boolean
  forceExpanded?: boolean
  onTogglePage: (pageId: string) => void
  onToggleDirectory: (path: string) => void
  onToggleDirectorySelection: (pageIds: string[]) => void
}

function normalizedSegments(page: WikiPageSummary): string[] {
  const segments = page.path
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
  return segments.length ? segments : [page.title || page.id]
}

export function buildWikiPageTree(pages: WikiPageSummary[]): WikiPageTreeNode[] {
  const roots: WikiPageTreeNode[] = []
  const nodesByKey = new Map<string, WikiPageTreeNode>()
  const pathCounts = new Map<string, number>()
  for (const page of pages) {
    pathCounts.set(page.path, (pathCounts.get(page.path) || 0) + 1)
  }

  for (const page of pages) {
    const segments = normalizedSegments(page)
    let siblings = roots
    let path = ''
    for (const [index, segment] of segments.entries()) {
      path = path ? `${path}/${segment}` : segment
      const nodeKey =
        index === segments.length - 1 && (pathCounts.get(page.path) || 0) > 1
          ? `${path}::${page.id}`
          : path
      let node = nodesByKey.get(nodeKey)
      if (!node) {
        node = { key: nodeKey, name: segment, page: null, children: [] }
        nodesByKey.set(nodeKey, node)
        siblings.push(node)
      }
      if (index === segments.length - 1) node.page = page
      siblings = node.children
    }
  }

  return roots
}

export function getWikiDirectoryKeys(pages: WikiPageSummary[]): Set<string> {
  const keys = new Set<string>()
  const visit = (nodes: WikiPageTreeNode[]) => {
    for (const node of nodes) {
      if (node.children.length) {
        keys.add(node.key)
        visit(node.children)
      }
    }
  }
  visit(buildWikiPageTree(pages))
  return keys
}

function countPages(node: WikiPageTreeNode): number {
  return (node.page ? 1 : 0) + node.children.reduce((total, child) => total + countPages(child), 0)
}

function isPathInsideDirectory(path: string, directoryPath: string): boolean {
  const normalizedPath = path
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .join('/')
  return normalizedPath === directoryPath || normalizedPath.startsWith(`${directoryPath}/`)
}

function TreeNode({
  node,
  depth,
  boundPageIds,
  selectedPageIds,
  selectablePages,
  expandedPaths,
  disabled,
  forceExpanded,
  onTogglePage,
  onToggleDirectory,
  onToggleDirectorySelection,
}: Omit<WikiPageTreeProps, 'pages'> & { node: WikiPageTreeNode; depth: number }) {
  const { t } = useTranslation('knowledge')
  const hasChildren = node.children.length > 0
  const open = hasChildren && (forceExpanded || expandedPaths.has(node.key))
  const page = node.page
  const isBound = page ? boundPageIds.has(page.id) : false
  const checked = page ? selectedPageIds.has(page.id) : false
  const directoryPageIds = hasChildren
    ? selectablePages
        .filter(item => isPathInsideDirectory(item.path, node.key))
        .map(item => item.id)
    : []
  const directoryChecked =
    directoryPageIds.length > 0 && directoryPageIds.every(pageId => selectedPageIds.has(pageId))
  const directoryIndeterminate =
    !directoryChecked && directoryPageIds.some(pageId => selectedPageIds.has(pageId))
  const directoryLabel = t(
    open ? 'wikiSection.collapse_directory' : 'wikiSection.expand_directory',
    { name: page?.title || node.name }
  )

  return (
    <li>
      <div
        className="flex min-h-11 items-center rounded px-1 py-0.5 hover:bg-surface md:min-h-8"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-text-muted hover:text-text-primary md:h-7 md:w-7"
            onClick={() => onToggleDirectory(node.key)}
            aria-expanded={open}
            aria-label={directoryLabel}
            title={directoryLabel}
            data-testid={`wiki-import-directory-${node.key}`}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0 md:h-7 md:w-7" aria-hidden />
        )}

        {hasChildren ? (
          <label
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-sm ${
              directoryPageIds.length === 0 ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <input
              type="checkbox"
              ref={element => {
                if (element) element.indeterminate = directoryIndeterminate
              }}
              checked={directoryChecked}
              disabled={directoryPageIds.length === 0 || disabled}
              onChange={() => onToggleDirectorySelection(directoryPageIds)}
              aria-label={t(
                directoryChecked
                  ? 'wikiSection.clear_directory_selection'
                  : 'wikiSection.select_directory',
                { name: page?.title || node.name }
              )}
              data-testid={`wiki-import-directory-check-${node.key}`}
            />
            {open ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">{page?.title || node.name}</span>
            <span className="shrink-0 text-xs text-text-muted">（{countPages(node)}）</span>
            {page && (
              <span
                className="max-w-[45%] shrink truncate text-xs text-text-muted"
                title={page.path}
              >
                {page.path}
              </span>
            )}
            {isBound && (
              <span className="shrink-0 text-xs text-text-muted">
                {t('wikiSection.already_bound')}
              </span>
            )}
          </label>
        ) : page ? (
          <label
            className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-sm ${
              isBound ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={isBound || disabled}
              onChange={() => onTogglePage(page.id)}
              data-testid={`wiki-import-check-${page.path}`}
            />
            <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 truncate">{page.title}</span>
            <span className="max-w-[45%] shrink truncate text-xs text-text-muted" title={page.path}>
              {page.path}
            </span>
            {isBound && (
              <span className="shrink-0 text-xs text-text-muted">
                {t('wikiSection.already_bound')}
              </span>
            )}
          </label>
        ) : null}
      </div>
      {open && (
        <ul>
          {node.children.map(child => (
            <TreeNode
              key={child.key}
              node={child}
              depth={depth + 1}
              boundPageIds={boundPageIds}
              selectedPageIds={selectedPageIds}
              selectablePages={selectablePages}
              expandedPaths={expandedPaths}
              disabled={disabled}
              forceExpanded={forceExpanded}
              onTogglePage={onTogglePage}
              onToggleDirectory={onToggleDirectory}
              onToggleDirectorySelection={onToggleDirectorySelection}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function WikiPageTree(props: WikiPageTreeProps) {
  const nodes = buildWikiPageTree(props.pages)
  return (
    <ul className="space-y-0.5" data-testid="wiki-import-page-list">
      {nodes.map(node => (
        <TreeNode key={node.key} {...props} node={node} depth={0} />
      ))}
    </ul>
  )
}
