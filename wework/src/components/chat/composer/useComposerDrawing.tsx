import { useCallback, useState } from 'react'
import { DrawingAttachmentDialog } from './DrawingAttachmentDialog'

export function useComposerDrawing(
  onFiles: ((files: File[]) => void | Promise<void>) | undefined,
  disabled = false
) {
  const [open, setOpen] = useState(false)
  const openDrawing = useCallback(() => setOpen(true), [])

  return {
    openDrawing: onFiles && !disabled ? openDrawing : undefined,
    drawingDialog:
      open && onFiles ? (
        <DrawingAttachmentDialog
          disabled={disabled}
          onClose={() => setOpen(false)}
          onAttach={file => onFiles([file])}
        />
      ) : null,
  }
}
