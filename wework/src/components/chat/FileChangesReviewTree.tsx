import { useTranslation } from '@/hooks/useTranslation'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { VirtualTree } from '@wegent/collaboration/controls/VirtualTree'
import { Folder, FolderOpen, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createFileTreeData, resolveFileTreePath } from '../layout/workspace-panels/fileTreeData'
import { useFileTreeExpansion } from '../layout/workspace-panels/useFileTreeExpansion'
import { WorkspaceFileIcon } from '../layout/workspace-panels/WorkspaceFileIcon'
import { getDiffFileStatus, type DiffFileSection } from './parseUnifiedDiff'

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
        status: getDiffFileStatus(section),
      })),
    [sections]
  )

  return (
    <aside
      data-testid="file-changes-review-file-tree"
      aria-hidden={!visible}
      hidden={!visible}
      className={`h-full min-h-0 w-[34%] min-w-[240px] max-w-[380px] shrink-0 flex-col border-l border-border bg-background ${
        visible ? 'flex' : ''
      }`}
      aria-label={t('file_changes.file_list_label')}
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="relative flex items-center gap-1.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <ControlInput
            data-testid="file-changes-review-file-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('file_changes.file_search_placeholder')}
            aria-label={t('file_changes.file_search_placeholder')}
            className="min-w-0 flex-1 pl-9"
          />
        </div>
      </div>
      <div className="scrollbar-soft min-h-0 flex-1 overflow-hidden pl-1 pr-2 pb-3">
        <SdkReviewFileTree
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

function SdkReviewFileTree({
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
  const { t } = useTranslation('chat')
  const data = useMemo(() => createFileTreeData(paths, query), [paths, query])
  const { values: expanded, setValues: setExpanded } = useFileTreeExpansion(
    data,
    query,
    data.directoryPaths
  )
  const statusByPath = useMemo(
    () => new Map(gitStatus.map(item => [item.path, item.status])),
    [gitStatus]
  )
  const selected = resolveFileTreePath(data, selectedPath)
  return (
    <VirtualTree
      data-testid="pierre-file-tree"
      aria-label={t('file_changes.file_list_label')}
      items={data.items}
      value={selected}
      current={selected}
      activation="automatic"
      expanded={expanded}
      onExpandedChange={setExpanded}
      viewportClassName="h-full w-full"
      scrollToValue={selected}
      onValueChange={path => {
        if (path && !path.endsWith('/')) onSelectPath(path)
      }}
      renderLabel={(item, state) => {
        const status = statusByPath.get(item.value)
        return (
          <>
            {state.branch ? (
              state.expanded ? (
                <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
              )
            ) : (
              <WorkspaceFileIcon
                path={item.value}
                testId={`review-file-tree-icon-${item.value}`}
                colored={false}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {status && (
              <span
                data-git-status={status}
                style={{
                  color:
                    status === 'deleted'
                      ? 'rgb(var(--color-review-tree-removed,var(--color-diff-removed)))'
                      : 'rgb(var(--color-review-tree-added,var(--color-diff-added)))',
                }}
                aria-label={t(
                  `file_changes.${{ added: 'created_file', deleted: 'deleted_file', modified: 'edited_file', renamed: 'renamed_file' }[status]}`,
                  { filename: item.label }
                )}
              >
                {{ added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }[status]}
              </span>
            )}
          </>
        )
      }}
    />
  )
}
