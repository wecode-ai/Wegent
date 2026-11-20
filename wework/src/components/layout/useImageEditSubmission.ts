import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ImageEditActions } from '@/components/chat/image-preview/ImageEditContext'
import {
  imageEditPrompt,
  renderImageEditSelection,
} from '@/components/chat/image-preview/imageEdit'
import { useTranslation } from '@/hooks/useTranslation'
import { prepareAttachmentFile } from '@/lib/runtime-attachments'
import { reportImageCommentStage } from '@/lib/file-preview-diagnostics'
import type { Attachment } from '@/types/api'
import type { RuntimePaneSendOptions } from './workbenchPaneSessionTypes'

export function useImageEditSubmission({
  enabled,
  scope,
  attachmentScope = scope,
  upload,
  submit,
  replaceImageAttachment,
  removeDraftAttachment,
}: {
  enabled: boolean
  scope?: string
  attachmentScope?: string
  upload?: (file: File) => Promise<Attachment>
  removeDraftAttachment?: (scope: string, attachmentId: number) => Promise<void>
  replaceImageAttachment?: (
    scope: string,
    id: number,
    file: File,
    comments: NonNullable<Attachment['image_markup_comments']>,
    signal: AbortSignal
  ) => Promise<Attachment | null>
  submit(
    text: string,
    options: Pick<RuntimePaneSendOptions, 'standaloneAttachments'>
  ): Promise<boolean>
}) {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const current = useRef<ImageEditActions | null>(null)
  const actions = useMemo<ImageEditActions | null>(() => {
    if (!enabled || !upload) return null
    return {
      scope,
      current: () => current.current,
      saveMarkup:
        attachmentScope && replaceImageAttachment
          ? async (attachmentId, loadFile, edit, signal) => {
              const source = await loadFile()
              signal.throwIfAborted()
              const image = await renderImageEditSelection(source, edit)
              if (current.current?.scope !== scope) return null
              const name = source.name.replace(/\.[^.]+$/, '') || 'image'
              const file = new File([image], `${name}.png`, { type: 'image/png' })
              const attachment = await replaceImageAttachment(
                attachmentScope,
                attachmentId,
                file,
                edit.comments ?? [],
                signal
              )
              reportImageCommentStage('attachment_replaced', {
                accepted: Boolean(attachment),
                pinCount: attachment?.image_markup_comments?.length ?? 0,
              })
              return attachment && { attachmentId: attachment.id, file }
            }
          : undefined,
      async submit(source, edit) {
        let sourceFile: Promise<File> | undefined
        const loadImage = () => (sourceFile ??= source.loadFile())
        const attachments = []
        if (edit.kind !== 'markup') {
          attachments.push(prepareAttachmentFile(source.name, source.mimeType, loadImage, upload))
        }
        if (edit.kind === 'markup' || edit.kind === 'erase') {
          const name = edit.kind === 'markup' ? 'annotated-image.png' : 'selection-mask.png'
          attachments.push(
            prepareAttachmentFile(
              name,
              'image/png',
              async () => renderImageEditSelection(await loadImage(), edit),
              upload
            )
          )
        }
        const accepted = await submit(imageEditPrompt(edit, t, locale), {
          standaloneAttachments: attachments,
        })
        if (!accepted) return false
        // Keep the admitted image available while a queued turn waits for transport.
        const snapshot = loadImage()
        if (
          edit.kind === 'comment' &&
          attachmentScope &&
          source.draftAttachmentId !== undefined &&
          removeDraftAttachment
        ) {
          // The message owns its separately prepared image. Retire only the draft source.
          const id = source.draftAttachmentId
          void snapshot.then(() => removeDraftAttachment(attachmentScope, id)).catch(() => {})
        } else {
          void snapshot.catch(() => {})
        }
        return true
      },
    }
  }, [
    enabled,
    scope,
    attachmentScope,
    submit,
    upload,
    replaceImageAttachment,
    removeDraftAttachment,
    t,
    locale,
  ])
  useLayoutEffect(() => {
    current.current = actions
    return () => {
      current.current = null
    }
  }, [actions])
  return actions
}
