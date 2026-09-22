import { FileTree, useFileTree } from '@pierre/trees/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MenuPosition } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceFileApi, WorkspaceFileEntry, WorkspaceTarget } from '@/types/workspace-files'
import { PIERRE_WORKSPACE_FILE_TREE_CSS } from './workspaceFileTreeStyles'
import { createWorkspaceTreeModel, getEntryByTreePath } from './workspaceFileTreeModel'

interface PickerProps {
  directoryPath: string
  activePath: string | null
  expandActive: boolean
  target: WorkspaceTarget
  api: WorkspaceFileApi
  onSelect: (entry: WorkspaceFileEntry) => void
  onFileContextMenu: (path: string, position: MenuPosition) => void
}

export function WorkspaceDirectoryPicker(props: PickerProps) {
  const { api, target, directoryPath } = props
  const { t } = useTranslation('common')
  const [entries, setEntries] = useState<Record<string, WorkspaceFileEntry[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(0)
  const requested = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (path: string, retry = false) => {
      if (requested.current.has(path) && !retry) return
      requested.current.add(path)
      setLoading(count => count + 1)
      setErrors(current => {
        const next = { ...current }
        delete next[path]
        return next
      })
      try {
        const result = await api.listWorkspaceEntries(target.deviceId, path, target.path)
        if (mounted.current) setEntries(current => ({ ...current, [path]: result.entries }))
      } catch (error) {
        if (mounted.current)
          setErrors(current => ({
            ...current,
            [path]: error instanceof Error ? error.message : String(error),
          }))
      } finally {
        if (mounted.current) setLoading(count => count - 1)
      }
    },
    [api, target.deviceId, target.path]
  )

  useEffect(() => {
    void load(directoryPath)
  }, [directoryPath, load])

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
          <button
            type="button"
            data-testid="workspace-file-siblings-retry"
            className="shrink-0 rounded px-2 py-1 hover:bg-muted"
            onClick={() => void load(path, true)}
          >
            {t('workbench.workspace_file_retry')}
          </button>
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
  onFileContextMenu,
}: PickerProps & {
  entries: Record<string, WorkspaceFileEntry[]>
  load: (path: string) => Promise<void>
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
  const current = useRef({ tree, onSelect, load })
  const syncing = useRef(true)
  const initialized = useRef(false)
  const { model } = useFileTree({
    paths: tree.paths,
    initialExpandedPaths: tree.expandedTreePaths,
    initialSelectedPaths: tree.selectedTreePath ? [tree.selectedTreePath] : [],
    density: 'compact',
    itemHeight: 28,
    flattenEmptyDirectories: false,
    icons: { set: 'complete', colored: true },
    search: false,
    dragAndDrop: { canDrop: () => false },
    composition: { contextMenu: { enabled: false } },
    unsafeCSS: PIERRE_WORKSPACE_FILE_TREE_CSS,
    onSelectionChange: paths => {
      if (syncing.current || !paths[0]) return
      const state = current.current
      const entry = getEntryByTreePath(
        state.tree.entryByTreePath,
        paths[0],
        state.tree.caseInsensitivePaths
      )
      if (entry && !entry.isDirectory) state.onSelect(entry)
    },
  })

  useLayoutEffect(() => {
    const previous = current.current.tree
    current.current = { tree, onSelect, load }
    if (initialized.current && previous === tree) return
    const expanded = previous.paths.filter(path => {
      const item = model.getItem(path)
      return item && 'isExpanded' in item && item.isExpanded()
    })
    syncing.current = true
    // Adding lazily loaded children must not reset the user's expansion or selection.
    if (initialized.current) model.resetPaths(tree.paths, { initialExpandedPaths: expanded })
    if (!initialized.current && tree.selectedTreePath) {
      model.scrollToPath(tree.selectedTreePath, { offset: 'center', focus: true })
    }
    initialized.current = true
    syncing.current = false
  }, [model, tree, load, onSelect])

  useEffect(() => {
    const loadExpanded = () => {
      if (syncing.current) return
      const state = current.current
      for (const path of state.tree.paths) {
        const item = model.getItem(path)
        if (!item || !('isExpanded' in item) || !item.isExpanded()) continue
        const entry = getEntryByTreePath(
          state.tree.entryByTreePath,
          path,
          state.tree.caseInsensitivePaths
        )
        if (entry) void state.load(entry.path)
      }
    }
    loadExpanded()
    return model.subscribe(loadExpanded)
  }, [model, tree])

  return (
    <FileTree
      model={model}
      data-testid="workspace-file-picker-tree"
      className="block min-h-0 w-full flex-1"
      onContextMenu={event => {
        event.preventDefault()
        event.stopPropagation()
        const row = event.nativeEvent
          .composedPath()
          .find(node => node instanceof HTMLElement && node.hasAttribute('data-item-path')) as
          | HTMLElement
          | undefined
        if (!row?.dataset.itemPath) return
        const entry = getEntryByTreePath(
          tree.entryByTreePath,
          row.dataset.itemPath,
          tree.caseInsensitivePaths
        )
        if (entry && !entry.isDirectory)
          onFileContextMenu(entry.path, { left: event.clientX, top: event.clientY })
      }}
      onKeyDown={event => {
        if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
        event.preventDefault()
        event.stopPropagation()
        const focused = model.getFocusedPath()
        const entry =
          focused && getEntryByTreePath(tree.entryByTreePath, focused, tree.caseInsensitivePaths)
        if (!entry || entry.isDirectory) return
        const rect = event.currentTarget.getBoundingClientRect()
        onFileContextMenu(entry.path, { left: rect.left, top: rect.top })
      }}
    />
  )
}
