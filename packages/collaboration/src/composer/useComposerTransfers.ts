import { useCallback, useState, type RefObject } from 'react'
import { SELECTED_TEXT_DRAG_TYPE } from '@wegent/chat-core/selected-text-drag'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { createComposerPathReference } from './composerMentions'

export interface ComposerPathEntry {
  path: string
  isDirectory: boolean
}
export interface ComposerTransferServices {
  hasPathTransfer: (data: DataTransfer) => boolean
  resolveTransfer: (
    data: DataTransfer,
    source: 'clipboard' | 'drop'
  ) => Promise<{
    referenceEntries: ComposerPathEntry[]
    attachmentFiles: File[]
  }>
}
export const browserComposerTransferServices: ComposerTransferServices = {
  hasPathTransfer: () => false,
  resolveTransfer: async data => ({
    referenceEntries: [],
    attachmentFiles: Array.from(data.files),
  }),
}
export function workspacePathReferenceText(entries: ComposerPathEntry[]): string {
  return entries.map(entry => createComposerPathReference(entry.path, entry.isDirectory)).join(' ')
}
export function useComposerTransfers({
  editorRef,
  commitEditorValue,
  disabled,
  onPasteFiles,
  services = browserComposerTransferServices,
}: {
  editorRef: RefObject<ComposerEditorHandle | null>
  commitEditorValue: (value: string, cursor: number) => void
  disabled?: boolean
  onPasteFiles?: (files: File[]) => void | Promise<void>
  services?: ComposerTransferServices
}) {
  const [transferError, setTransferError] = useState<string | null>(null)
  const reportError = (cause: unknown) =>
    setTransferError(cause instanceof Error ? cause.message : String(cause))
  const insertPathReferences = useCallback(
    (entries: ComposerPathEntry[]) => {
      if (entries.length === 0) return
      const editor = editorRef.current
      if (!editor) return

      const references = workspacePathReferenceText(entries)
      const current = editor.getSnapshot()
      const spacer = current.value && current.selectionOffset > 0 ? ' ' : ''
      const nextValue =
        current.value.slice(0, current.selectionOffset) +
        spacer +
        references +
        ' ' +
        current.value.slice(current.selectionOffset)
      commitEditorValue(nextValue, current.selectionOffset + spacer.length + references.length + 1)
      editor.focus()
    },
    [commitEditorValue, editorRef]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      if (!event.clipboardData) return false
      if (disabled) return true
      const clipboardData = event.clipboardData
      const files = Array.from(clipboardData.files)
      if (files.length > 0) {
        event.preventDefault()
        setTransferError(null)
        void services
          .resolveTransfer(clipboardData, 'clipboard')
          .then(async ({ attachmentFiles, referenceEntries }) => {
            insertPathReferences(referenceEntries)
            if (attachmentFiles.length > 0) await onPasteFiles?.(attachmentFiles)
          })
          .catch(reportError)
        return true
      }
      if (!onPasteFiles) return false
      const textAttachment = createLongPastedTextAttachment(clipboardData.getData('text/plain'))
      if (!textAttachment) return false
      event.preventDefault()
      setTransferError(null)
      try {
        void Promise.resolve(onPasteFiles([textAttachment])).catch(reportError)
      } catch (cause) {
        reportError(cause)
      }
      return true
    },
    [disabled, insertPathReferences, onPasteFiles, services]
  )

  const handleDrop = useCallback(
    (event: DragEvent) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer) return false
      if (disabled) {
        event.preventDefault()
        event.stopPropagation()
        return true
      }
      if (Array.from(dataTransfer.types).includes(SELECTED_TEXT_DRAG_TYPE)) {
        const text = dataTransfer.getData('text/plain')
        if (!text) return false
        event.preventDefault()
        event.stopPropagation()
        const editor = editorRef.current
        if (!editor) return false
        const current = editor.getSnapshot()
        const before = current.value.slice(0, current.selectionStart)
        const after = current.value.slice(current.selectionEnd)
        const leadingBreak = before && !before.endsWith('\n') ? '\n' : ''
        const trailingBreak = after && !after.startsWith('\n') ? '\n' : ''
        const inserted = `${leadingBreak}${text}${trailingBreak}`
        commitEditorValue(`${before}${inserted}${after}`, before.length + inserted.length)
        editor.focus()
        return true
      }
      if (
        !Array.from(dataTransfer.types).includes('Files') &&
        !services.hasPathTransfer(dataTransfer)
      )
        return false
      event.preventDefault()
      event.stopPropagation()
      setTransferError(null)
      void services
        .resolveTransfer(dataTransfer, 'drop')
        .then(async ({ attachmentFiles, referenceEntries }) => {
          insertPathReferences(referenceEntries)
          if (attachmentFiles.length > 0) await onPasteFiles?.(attachmentFiles)
        })
        .catch(reportError)
      return true
    },
    [commitEditorValue, disabled, editorRef, insertPathReferences, onPasteFiles, services]
  )

  return { handlePaste, handleDrop, transferError }
}
