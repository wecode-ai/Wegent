import { useMemo } from 'react'
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
  releaseDraftAttachment,
}: {
  enabled: boolean
  scope?: string
  attachmentScope?: string
  upload?: (file: File) => Promise<Attachment>
  releaseDraftAttachment?: (scope: string, attachmentId: number) => void
  replaceImageAttachment?: (
    scope: string,
    id: number,
    file: File,
    comments: NonNullable<Attachment['image_markup_comments']>,
    signal: AbortSignal
  ) => Promise<Attachment | null>
  submit(
    text: string,
    options: Pick<RuntimePaneSendOptions, 'standaloneAttachments' | 'draftAttachmentSourceId'>
  ): Promise<boolean>
}) {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const actions = useMemo<ImageEditActions | null>(() => {
    if (!enabled || !upload) return null
    return {
      scope,
      saveMarkup:
        attachmentScope && replaceImageAttachment
          ? async (attachmentId, loadFile, edit, signal) => {
              const source = await loadFile()
              signal.throwIfAborted()
              const image = await renderImageEditSelection(source, edit)
              const name = source.name.replace(/\.[^.]+$/, '') || 'image'
              const file = new File([image], `${name}.png`, { type: 'image/png' })
              const attachment = await replaceImageAttachment(
                attachmentScope,
                attachmentId,
                file,
                edit.comments ?? [],
                signal
              )
              const comments = attachment?.image_markup_comments ?? edit.comments ?? []
              reportImageCommentStage('attachment_replaced', {
                accepted: Boolean(attachment),
                pinCount: comments.length,
              })
              return attachment && { attachmentId: attachment.id, file, comments }
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
          ...(edit.kind === 'comment' && source.draftAttachmentId !== undefined
            ? { draftAttachmentSourceId: source.draftAttachmentId }
            : {}),
        })
        if (!accepted) return false
        // Start reading the admitted source while a queued turn waits for transport.
        void loadImage().catch(() => {})
        if (
          edit.kind === 'comment' &&
          attachmentScope &&
          source.draftAttachmentId !== undefined &&
          releaseDraftAttachment
        ) {
          // The message owns its separately prepared image. Retire only the draft source.
          releaseDraftAttachment(attachmentScope, source.draftAttachmentId)
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
    releaseDraftAttachment,
    t,
    locale,
  ])
  return actions
}
