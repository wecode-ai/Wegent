import type { MenuPosition } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceFileApi, WorkspaceFileEntry, WorkspaceTarget } from '@/types/workspace-files'
import { Menu, MenuContextTrigger } from '@wegent/collaboration/controls/MenuParts'
import { VirtualTree } from '@wegent/collaboration/controls/VirtualTree'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Folder, FolderOpen } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { createFileTreeData, resolveFileTreePath } from './fileTreeData'
import { useFileTreeExpansion } from './useFileTreeExpansion'
import { createWorkspaceDirectoryResource } from './workspaceDirectoryResource'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'
import { createWorkspaceTreeModel, getEntryByTreePath } from './workspaceFileTreeModel'

interface PickerProps {
  directoryPath: string
  activePath: string | null
  expandActive: boolean
  target: WorkspaceTarget
  api: WorkspaceFileApi
  onSelect: (entry: WorkspaceFileEntry) => void
  onPathContextMenu: (path: string, isDirectory: boolean, position: MenuPosition) => void
}

export function WorkspaceDirectoryPicker(props: PickerProps) {
  const { api, target, directoryPath, activePath, expandActive } = props
  const { t } = useTranslation('common')
  const resource = useMemo(
    () =>
      createWorkspaceDirectoryResource(
        api,
        target.deviceId,
        target.path,
        directoryPath,
        expandActive ? activePath : null
      ),
    [activePath, api, directoryPath, expandActive, target.deviceId, target.path]
  )
  const { entries, errors, loading } = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const load = async (path: string, retry?: boolean) => {
    await resource.load(path, retry)
    const error = resource.getSnapshot().errors[path]
    if (error) throw new Error(error)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entries[directoryPath] &&
        (entries[directoryPath].length ? (
          <DirectoryTree {...props} entries={entries} load={load} />
        ) : (
          <div className="p-2 text-sm text-text-muted">{t('workbench.workspace_file_empty')}</div>
        ))}
      {loading > 0 && (
        <div role="status" className="shrink-0 px-2 py-1 text-sm text-text-muted">
          {t('workbench.workspace_file_loading')}
        </div>
      )}
      {Object.entries(errors).map(([path, error]) => (
        <div key={path} role="alert" className="flex shrink-0 items-center gap-2 p-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-text-secondary" title={error}>
            {error}
          </span>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="workspace-file-siblings-retry"
            className="shrink-0 rounded px-2 py-1 hover:bg-muted"
            onClick={() => void load(path, true).catch(() => {})}
          >
            {t('workbench.workspace_file_retry')}
          </ControlButton>
        </div>
      ))}
    </div>
  )
}

function DirectoryTree({
  directoryPath,
  activePath,
  expandActive,
  entries,
  load,
  onSelect,
  onPathContextMenu,
}: PickerProps & {
  entries: Record<string, WorkspaceFileEntry[]>
  load: (path: string, retry?: boolean, signal?: AbortSignal) => Promise<void>
}) {
  const tree = useMemo(
    () =>
      createWorkspaceTreeModel({
        rootPath: directoryPath,
        activeDirectoryPath: expandActive && activePath ? activePath : directoryPath,
        selectedPath: expandActive ? null : activePath,
        expandedPaths: new Set(expandActive && activePath ? [activePath] : []),
        entriesByPath: entries,
      }),
    [directoryPath, activePath, expandActive, entries]
  )
  const data = useMemo(() => createFileTreeData(tree.paths, '', false), [tree.paths])
  const { values: expanded, setValues: setExpanded } = useFileTreeExpansion(
    data,
    '',
    tree.expandedTreePaths
  )
  const initialSelected = resolveFileTreePath(data, tree.selectedTreePath)
  const [selection, setSelection] = useState<string | null>(initialSelected)
  const { t } = useTranslation('common')
  return (
    <Menu
      open={false}
      onOpenChange={(open, details) => {
        if (!open) return
        details.cancel()
        const event = details.event
        const row =
          event?.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-item-path]')
            : null
        const entry = row?.dataset.itemPath
          ? getEntryByTreePath(
              tree.entryByTreePath,
              row.dataset.itemPath,
              tree.caseInsensitivePaths
            )
          : null
        if (!row || !entry) return
        const rect = row.getBoundingClientRect()
        onPathContextMenu(
          entry.path,
          entry.isDirectory,
          event instanceof MouseEvent
            ? { left: event.clientX, top: event.clientY }
            : { left: rect.left, top: rect.top }
        )
      }}
    >
      <VirtualTree
        data-testid="workspace-file-picker-tree"
        aria-label={directoryPath}
        items={data.items}
        value={selection}
        current={initialSelected}
        scrollToValue={initialSelected}
        scrollAlign="center"
        expanded={expanded}
        onExpandedChange={setExpanded}
        viewportClassName="w-full flex-1"
        onValueChange={path => {
          setSelection(path)
          const entry =
            path && getEntryByTreePath(tree.entryByTreePath, path, tree.caseInsensitivePaths)
          if (entry && !entry.isDirectory) onSelect(entry)
        }}
        loadChildren={async (path, { signal }) => {
          const entry = getEntryByTreePath(tree.entryByTreePath, path, tree.caseInsensitivePaths)
          if (entry) await load(entry.path, false, signal)
        }}
        itemProps={() => ({ render: <MenuContextTrigger render={<button type="button" />} /> })}
        renderLabel={(item, state) => (
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
                testId={`workspace-file-picker-icon-${item.value}`}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {state.loading && (
              <span className="sr-only">{t('workbench.workspace_file_loading')}</span>
            )}
          </>
        )}
      />
    </Menu>
  )
}
