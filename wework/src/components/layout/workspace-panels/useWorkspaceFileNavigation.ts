import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import type { MarkdownFileOpenOptions } from '@wegent/collaboration/markdown'
import { resolveMarkdownFilePath } from './workspaceFilePaths'
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

export function useWorkspaceFileNavigation({
  dirty,
  savingRef,
  saveFileRef,
  pendingNavigationRef,
}: {
  dirty: boolean
  savingRef: RefObject<boolean>
  saveFileRef: RefObject<() => Promise<boolean>>
  pendingNavigationRef: RefObject<(() => void) | null>
}) {
  const dirtyRef = useRef(dirty)
  useLayoutEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // Document state changes must not replay the active file-open request.
  return useCallback(
    (action: () => void) => {
      if (dirtyRef.current || savingRef.current) {
        pendingNavigationRef.current = action
        if (dirtyRef.current && !savingRef.current) void saveFileRef.current()
        return
      }
      action()
    },
    [pendingNavigationRef, saveFileRef, savingRef]
  )
}

export function useWorkspaceMarkdownFileNavigation({
  documentPath,
  onOpenFile,
  navigateWithDirtyGuard,
  onError,
}: {
  documentPath?: string
  onOpenFile: (path: string, options?: MarkdownFileOpenOptions) => void
  navigateWithDirtyGuard: (action: () => void) => void
  onError: () => void
}) {
  return useCallback(
    (path: string, options?: MarkdownFileOpenOptions) => {
      if (!documentPath) return
      try {
        const resolvedPath = resolveMarkdownFilePath(documentPath, path)
        const open = () => onOpenFile(resolvedPath, options)
        if (options?.lineStart !== undefined || options?.isDirectory) navigateWithDirtyGuard(open)
        else open()
      } catch {
        onError()
      }
    },
    [documentPath, onOpenFile, navigateWithDirtyGuard, onError]
  )
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
