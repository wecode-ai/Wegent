import { useCallback, useRef, useState } from 'react'
import type { WorkspaceTextFileResponse } from '@/types/workspace-files'

interface WorkspaceTextDocument {
  file: WorkspaceTextFileResponse
  content: string
  loadVersion: number
}

export function useWorkspaceTextDocument() {
  const [document, setDocument] = useState<WorkspaceTextDocument | null>(null)
  const editedContentRef = useRef('')
  const editVersionRef = useRef(0)
  const acceptRead = useCallback((file: WorkspaceTextFileResponse, loadVersion: number) => {
    editedContentRef.current = file.content
    setDocument({ file, content: file.content, loadVersion })
  }, [])
  const clear = useCallback(() => {
    editedContentRef.current = ''
    setDocument(null)
  }, [])
  const edit = useCallback((content: string) => {
    editVersionRef.current += 1
    editedContentRef.current = content
    setDocument(current => (current ? { ...current, content } : current))
  }, [])
  const acceptSave = useCallback(
    (
      filePath: string,
      loadVersion: number | undefined,
      saved: WorkspaceTextFileResponse,
      contentToSave: string
    ) => {
      setDocument(current => {
        if (current?.file.path !== filePath || current.loadVersion !== loadVersion) return current
        return {
          ...current,
          file: saved,
          content: current.content === contentToSave ? saved.content : current.content,
        }
      })
    },
    []
  )
  return {
    preview: document?.file ?? null,
    editedContent: document?.content ?? '',
    loadVersion: document?.loadVersion,
    editedContentRef,
    editVersionRef,
    acceptRead,
    acceptSave,
    clear,
    edit,
  }
}
