import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import type { MarkdownFileOpenOptions } from '@wegent/collaboration/markdown'
import { resolveMarkdownFilePath } from './workspaceFilePaths'
import { useCallback, useState } from 'react'

export function useWorkspaceMarkdownFileNavigation({
  documentPath,
  onOpenFile,
  navigateWithDirtyGuard,
  onOpenFileTab,
}: {
  documentPath?: string
  onOpenFile: (path: string, options?: MarkdownFileOpenOptions) => void
  navigateWithDirtyGuard: (action: () => void) => void
  onOpenFileTab?: (path: string) => void
}) {
  const [errorDocumentPath, setErrorDocumentPath] = useState<string | null>(null)
  const openFile = useCallback(
    (path: string, options?: MarkdownFileOpenOptions) => {
      if (!documentPath) return
      setErrorDocumentPath(null)
      try {
        const resolvedPath = resolveMarkdownFilePath(documentPath, path)
        if (onOpenFileTab && options?.lineStart === undefined && !options?.isDirectory) {
          navigateWithDirtyGuard(() => onOpenFileTab(resolvedPath))
        } else {
          const open = () => onOpenFile(resolvedPath, options)
          if (options?.lineStart !== undefined || options?.isDirectory) navigateWithDirtyGuard(open)
          else open()
        }
      } catch {
        setErrorDocumentPath(documentPath)
      }
    },
    [documentPath, onOpenFile, onOpenFileTab, navigateWithDirtyGuard]
  )
  return { openFile, navigationError: Boolean(documentPath && errorDocumentPath === documentPath) }
}

export interface PreviewLineTarget {
  filePath: string
  lineStart: number
  lineEnd?: number
}

export function createPreviewLineTarget(
  filePath: string,
  options?: WorkspaceFileOpenOptions
): PreviewLineTarget | null {
  if (typeof options?.lineStart !== 'number') return null
  return {
    filePath,
    lineStart: options.lineStart,
    lineEnd: options.lineEnd,
  }
}
