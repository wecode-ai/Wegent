import { useEffect } from 'react'
import { workspaceFileAncestorPaths } from './workspaceFileTreeModel'

export function useWorkspaceFileReveal({
  rootPath,
  selectedPath,
  visible,
  refreshVersion,
  loadDirectory,
}: {
  rootPath: string
  selectedPath: string | null
  visible: boolean
  refreshVersion: number
  loadDirectory: (path: string) => Promise<boolean | undefined>
}) {
  useEffect(() => {
    if (!visible || !rootPath || !selectedPath) return
    let cancelled = false
    void (async () => {
      for (const path of workspaceFileAncestorPaths(rootPath, selectedPath)) {
        if (cancelled || !(await loadDirectory(path))) break
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadDirectory, refreshVersion, rootPath, selectedPath, visible])
}
