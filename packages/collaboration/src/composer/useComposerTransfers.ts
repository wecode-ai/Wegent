import { useCallback, useRef, useState, type RefObject } from 'react'
import { SELECTED_TEXT_DRAG_TYPE } from '@wegent/chat-core/selected-text-drag'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { createComposerPathReference } from './composerMentions'

export interface ComposerPathEntry {
  path: string
  isDirectory: boolean
}
export interface ComposerPathTransfer {
  referenceEntries: ComposerPathEntry[]
  attachmentFiles: File[]
}
export interface ComposerTransferServices {
  hasPathTransfer: (data: DataTransfer) => boolean
  resolveTransfer: (
    data: DataTransfer,
    source: 'clipboard' | 'drop'
  ) => ComposerPathTransfer | Promise<ComposerPathTransfer>
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
  const [pendingTransfers, setPendingTransfers] = useState(0)
  const activeTransfers = useRef(0)
  const dismissTransferError = useCallback(() => {
    if (activeTransfers.current === 0) setTransferError(null)
  }, [])
  const runTransfer = useCallback((transfer: () => void | Promise<void>) => {
    activeTransfers.current += 1
    setTransferError(null)
    setPendingTransfers(count => count + 1)
    void (async () => {
      try {
        await transfer()
      } catch (cause) {
        setTransferError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        activeTransfers.current -= 1
        setPendingTransfers(count => count - 1)
      }
    })()
  }, [])
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
      if (files.length > 0 || services.hasPathTransfer(clipboardData)) {
        event.preventDefault()
        runTransfer(() => {
          const accept = ({ attachmentFiles, referenceEntries }: ComposerPathTransfer) => {
            insertPathReferences(referenceEntries)
            return attachmentFiles.length > 0 ? onPasteFiles?.(attachmentFiles) : undefined
          }
          const transfer = services.resolveTransfer(clipboardData, 'clipboard')
          return transfer instanceof Promise ? transfer.then(accept) : accept(transfer)
        })
        return true
      }
      if (!onPasteFiles) return false
      const textAttachment = createLongPastedTextAttachment(clipboardData.getData('text/plain'))
      if (!textAttachment) return false
      event.preventDefault()
      runTransfer(() => onPasteFiles([textAttachment]))
      return true
    },
    [disabled, insertPathReferences, onPasteFiles, runTransfer, services]
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
      runTransfer(() => {
        const accept = ({ attachmentFiles, referenceEntries }: ComposerPathTransfer) => {
          insertPathReferences(referenceEntries)
          return attachmentFiles.length > 0 ? onPasteFiles?.(attachmentFiles) : undefined
        }
        const transfer = services.resolveTransfer(dataTransfer, 'drop')
        return transfer instanceof Promise ? transfer.then(accept) : accept(transfer)
      })
      return true
    },
    [
      commitEditorValue,
      disabled,
      editorRef,
      insertPathReferences,
      onPasteFiles,
      runTransfer,
      services,
    ]
  )

  return {
    handlePaste,
    handleDrop,
    transferError,
    dismissTransferError,
    isTransferring: pendingTransfers > 0,
  }
}
