// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeWikiPageNode } from '@/types/code-wiki'

interface WikiNavigationProps {
  pages: CodeWikiPageNode[]
  activePath: string
  onSelect: (node: CodeWikiPageNode) => void
}

/** Every ancestor of the active page, so opening a deep page reveals where it sits. */
const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

interface NodeProps {
  node: CodeWikiPageNode
  depth: number
  activePath: string
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (node: CodeWikiPageNode) => void
}

function NavigationNode({ node, depth, activePath, expanded, onToggle, onSelect }: NodeProps) {
  const { t } = useTranslation('knowledge')
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.path)
  const isActive = node.path === activePath

  return (
    <li>
      <div
        className={`flex items-center gap-1 rounded pr-2 ${
          isActive ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'
        }`}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-label={node.title}
            aria-expanded={isOpen}
            data-testid={`wiki-nav-toggle-${node.path}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center text-text-tertiary hover:text-text-primary"
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}

        <button
          type="button"
          // A section with no page of its own cannot be opened; clicking its row
          // expands it instead, which is the only thing it can usefully do.
          onClick={() => (node.has_content ? onSelect(node) : onToggle(node.path))}
          data-testid={`wiki-nav-page-${node.path}`}
          title={node.has_content ? node.title : t('codeWiki.reader.sectionOnly')}
          className={`min-w-0 flex-1 truncate py-1.5 text-left text-sm ${
            isActive
              ? 'font-medium text-text-primary'
              : node.has_content
                ? 'text-text-secondary hover:text-text-primary'
                : 'text-text-tertiary'
          }`}
        >
          {node.title}
        </button>
      </div>

      {hasChildren && isOpen && (
        <ul>
          {node.children.map(child => (
            <NavigationNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The wiki's own structure, derived server-side from page paths.
 *
 * A read-only relative of the knowledge base folder tree: no upload, rename or
 * delete, because everything here is a projection the next publish rewrites.
 */
export function WikiNavigation({ pages, activePath, onSelect }: WikiNavigationProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    // Follows the active page rather than replacing the set, so a section the
    // reader opened by hand stays open when they move elsewhere.
    if (!activePath) return
    setExpanded(current => {
      const next = new Set(current)
      for (const ancestor of ancestorsOf(activePath)) next.add(ancestor)
      return next
    })
  }, [activePath])

  const toggle = (path: string) =>
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <nav
      className="w-64 shrink-0 overflow-y-auto border-r border-border px-2 py-4"
      data-testid="wiki-navigation"
    >
      <ul>
        {pages.map(node => (
          <NavigationNode
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            expanded={expanded}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </nav>
  )
}
