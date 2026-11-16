import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileEntry } from '../../../../packages/chat-core/src/workspace-files'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { RuntimeApi } from '@/services/runtimeApi'

export interface FileTreeEntry extends WorkspaceFileEntry {
  depth: number
  expanded?: boolean
  loading?: boolean
  error?: string
}
interface DirectoryContents {
  entries: WorkspaceFileEntry[]
  loading: boolean
  error?: string
}
const sorted = (entries: WorkspaceFileEntry[]) =>
  [...entries].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
  )
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function useWorkspaceFileTree(
  api: RuntimeApi,
  target: MobileWorkspaceFileTarget,
  query: string,
  active: boolean
) {
  const search = query.trim()
  const scope = JSON.stringify([target.deviceId, target.path, search])
  const [listing, setListing] = useState<{ scope: string; entries: WorkspaceFileEntry[] }>({
    scope,
    entries: [],
  })
  const [children, setChildren] = useState<Record<string, DirectoryContents>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const pendingChildren = useRef(new Set<string>())

  useEffect(() => {
    const id = ++generation.current
    pendingChildren.current.clear()
    setChildren({})
    setExpanded(new Set())
    setListing(current => (current.scope === scope ? current : { scope, entries: [] }))
    if (!active) return
    setLoading(true)
    setError(null)
    const timer = setTimeout(
      () => {
        const pending = search
          ? api
              .searchWorkspaceEntries(target.deviceId, target.path, search, `mobile-files-${id}`)
              .then(result =>
                result.files.map(file => ({
                  name: file.fileName,
                  path: file.path,
                  isDirectory: file.matchType === 'directory',
                  size: 0,
                }))
              )
          : api.listWorkspaceDirectory(target.deviceId, target.path).then(result => result.entries)
        void pending
          .then(
            entries => {
              if (id === generation.current) setListing({ scope, entries: sorted(entries) })
            },
            cause => {
              if (id === generation.current) setError(errorMessage(cause))
            }
          )
          .finally(() => {
            if (id === generation.current) setLoading(false)
          })
      },
      search ? 250 : 0
    )
    return () => {
      clearTimeout(timer)
      generation.current += 1
    }
  }, [api, target.deviceId, target.path, search, scope, revision, active])

  const loadChildren = (path: string) => {
    if (pendingChildren.current.has(path)) return
    const id = generation.current
    pendingChildren.current.add(path)
    setChildren(current => ({ ...current, [path]: { entries: [], loading: true } }))
    void api
      .listWorkspaceDirectory(target.deviceId, path)
      .then(
        result => {
          if (id === generation.current)
            setChildren(current => ({
              ...current,
              [path]: { entries: sorted(result.entries), loading: false },
            }))
        },
        cause => {
          if (id === generation.current)
            setChildren(current => ({
              ...current,
              [path]: { entries: [], loading: false, error: errorMessage(cause) },
            }))
        }
      )
      .finally(() => {
        if (id === generation.current) pendingChildren.current.delete(path)
      })
  }
  const toggleFolder = (path: string) => {
    const opening = !expanded.has(path)
    setExpanded(current => {
      const next = new Set(current)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
    if (opening && !children[path]) loadChildren(path)
  }
  const entries: FileTreeEntry[] = []
  const append = (items: WorkspaceFileEntry[], depth: number) => {
    for (const item of items) {
      const open = item.isDirectory && expanded.has(item.path)
      const contents = children[item.path]
      entries.push({
        ...item,
        depth,
        expanded: open,
        loading: open && contents?.loading,
        error: open ? contents?.error : undefined,
      })
      if (open && contents) append(contents.entries, depth + 1)
    }
  }
  if (listing.scope === scope) append(listing.entries, 0)
  return {
    entries,
    loading,
    error,
    toggleFolder,
    retryFolder: loadChildren,
    refresh: () => setRevision(value => value + 1),
  }
}
