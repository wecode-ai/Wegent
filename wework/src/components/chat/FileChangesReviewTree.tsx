import { FileTree, useFileTree } from '@pierre/trees/react'
import { Search } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { DiffFileSection } from './parseUnifiedDiff'

const PIERRE_FILE_TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-bg-muted-override: rgb(var(--color-muted));
    --trees-fg-override: rgb(var(--color-text-secondary));
    --trees-fg-muted-override: rgb(var(--color-text-muted));
    --trees-border-color-override: rgb(var(--color-border));
    --trees-selected-bg-override: rgb(var(--color-bg-surface));
    --trees-selected-fg-override: rgb(var(--color-text-primary));
    --trees-selected-focused-border-color-override: rgb(var(--color-primary));
    --trees-focus-ring-color-override: rgb(var(--color-primary) / 0.35);
    --trees-focus-ring-width-override: 1px;
    --trees-focus-ring-offset-override: 0px;
    --trees-gap-override: 2px;
    --trees-level-gap-override: 6px;
    --trees-item-padding-x-override: 4px;
    --trees-item-margin-x-override: 0px;
    --trees-padding-inline-override: 4px;
    --trees-indent-guide-bg-override: rgb(var(--color-border));
    --trees-scrollbar-thumb-override: rgb(var(--color-text-muted));
    --trees-search-bg-override: rgb(var(--color-bg-base));
    --trees-search-fg-override: rgb(var(--color-text-primary));
    --trees-status-added-override: rgb(57 151 75);
    --trees-status-modified-override: rgb(57 151 75);
    --trees-status-renamed-override: rgb(57 151 75);
    --trees-status-untracked-override: rgb(57 151 75);
    --trees-status-deleted-override: rgb(210 57 57);
    --trees-git-added-color-override: rgb(57 151 75);
    --trees-git-modified-color-override: rgb(57 151 75);
    --trees-git-renamed-color-override: rgb(57 151 75);
    --trees-git-untracked-color-override: rgb(57 151 75);
    --trees-git-deleted-color-override: rgb(210 57 57);
    --trees-file-icon-color: rgb(var(--color-text-muted));
    --trees-file-icon-color-default: rgb(var(--color-text-muted));
    --trees-icon-blue: rgb(var(--color-text-muted));
    --trees-icon-cyan: rgb(var(--color-text-muted));
    --trees-icon-green: rgb(var(--color-text-muted));
    --trees-icon-indigo: rgb(var(--color-text-muted));
    --trees-icon-mauve: rgb(var(--color-text-muted));
    --trees-icon-orange: rgb(var(--color-text-muted));
    --trees-icon-pink: rgb(var(--color-text-muted));
    --trees-icon-purple: rgb(var(--color-text-muted));
    --trees-icon-red: rgb(var(--color-text-muted));
    --trees-icon-teal: rgb(var(--color-text-muted));
    --trees-icon-vermilion: rgb(var(--color-text-muted));
    --trees-icon-yellow: rgb(var(--color-text-muted));
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: rgb(var(--color-text-secondary));
    background: transparent !important;
  }
  button[data-type='item'] {
    box-sizing: border-box;
    border-radius: 6px;
    color: rgb(var(--color-text-secondary));
    background: transparent;
    background-clip: padding-box;
  }
  button[data-type='item']:hover {
    color: rgb(var(--color-text-primary));
    background: rgb(var(--color-muted));
    box-shadow:
      0 0 0 1px rgb(var(--color-bg-base)),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected] {
    color: rgb(var(--color-text-primary));
    background: rgb(var(--color-muted)) !important;
    box-shadow:
      0 0 0 1px rgb(var(--color-bg-base)),
      0 1px 2px rgb(0 0 0 / 0.04);
  }
  button[data-type='item'][data-item-selected='true']:has(+ [data-item-selected='true']),
  button[data-type='item'][data-item-selected='true'] + [data-item-selected='true'] {
    border-radius: 6px !important;
  }
  button[data-type='item'][data-item-focused='true']::before,
  button[data-type='item']:focus-visible::before {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--trees-focus-ring-color);
  }
  button[data-type='item'][data-item-focused='true'][data-item-selected='true']::before,
  button[data-type='item'][data-item-selected='true']:focus-visible::before {
    box-shadow: inset 0 0 0 1px var(--trees-selected-focused-border-color);
  }
  input {
    background: rgb(var(--color-bg-base));
    color: rgb(var(--color-text-primary));
    border-color: rgb(var(--color-border));
  }
`

export function ReviewFileTree({
  visible,
  selectedSection,
  sections,
  onSelectSection,
}: {
  visible: boolean
  selectedSection?: DiffFileSection
  sections: DiffFileSection[]
  onSelectSection: (index: number) => void
}) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  const paths = useMemo(() => sections.map(section => section.path), [sections])
  const statusByPath = useMemo(
    () =>
      sections.map(section => ({
        path: section.path,
        status: getPierreGitStatus(section),
      })),
    [sections]
  )

  return (
    <aside
      data-testid="file-changes-review-file-tree"
      hidden={!visible}
      className="flex h-full min-h-0 w-[34%] min-w-[240px] max-w-[380px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={t('file_changes.file_list_label')}
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            data-testid="file-changes-review-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('file_changes.file_search_placeholder')}
            aria-label={t('file_changes.file_search_placeholder')}
            className="min-w-0 flex-1 bg-transparent text-xs leading-4 outline-none placeholder:text-text-muted"
          />
        </div>
      </div>
      <div className="scrollbar-soft min-h-0 flex-1 overflow-hidden pl-1 pr-2 pb-3">
        <PierreReviewFileTree
          key={paths.join('\n')}
          paths={paths}
          query={query}
          gitStatus={statusByPath}
          selectedPath={selectedSection?.path}
          onSelectPath={path => {
            const index = sections.findIndex(section => section.path === path)
            if (index >= 0) onSelectSection(index)
          }}
        />
      </div>
    </aside>
  )
}

function PierreReviewFileTree({
  paths,
  query,
  gitStatus,
  selectedPath,
  onSelectPath,
}: {
  paths: string[]
  query: string
  gitStatus: { path: string; status: 'added' | 'deleted' | 'modified' | 'renamed' }[]
  selectedPath?: string
  onSelectPath: (path: string) => void
}) {
  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: true,
    gitStatus,
    icons: { set: 'complete', colored: false },
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 28,
    onSelectionChange: selectedPaths => {
      const nextPath = selectedPaths[0]
      if (nextPath) onSelectPath(nextPath)
    },
    paths,
    search: false,
    unsafeCSS: PIERRE_FILE_TREE_CSS,
  })

  useEffect(() => {
    model.setSearch(query.trim() || null)
  }, [model, query])

  useEffect(() => {
    if (!selectedPath) return
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' })
  }, [model, selectedPath])

  return (
    <FileTree
      data-testid="pierre-file-tree"
      model={model}
      className="block h-full min-h-0 w-full"
      style={
        {
          '--trees-border-color-override': 'rgb(var(--color-border))',
          '--trees-fg-override': 'rgb(var(--color-text-secondary))',
          '--trees-selected-bg-override': 'rgb(var(--color-bg-surface))',
        } as CSSProperties
      }
    />
  )
}

function getPierreGitStatus(section: DiffFileSection) {
  if (section.lines.some(line => line.startsWith('new file mode'))) return 'added' as const
  if (section.lines.some(line => line.startsWith('deleted file mode'))) return 'deleted' as const
  if (section.oldPath && section.oldPath !== section.path) return 'renamed' as const
  return 'modified' as const
}
