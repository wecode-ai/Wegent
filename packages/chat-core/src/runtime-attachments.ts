import type { Attachment } from './runtime'

function hasLocalPath(attachment: Attachment): boolean {
  return Boolean(attachment.local_path?.trim())
}

export function localRuntimeAttachments(attachments: Attachment[]): Attachment[] {
  return attachments
    .filter(
      attachment => hasLocalPath(attachment) || (attachment.id < 0 && attachment.status !== 'ready')
    )
    .map(attachment => {
      const runtimeAttachment = { ...attachment }
      delete runtimeAttachment.text_content
      delete runtimeAttachment.ui_group_id
      delete runtimeAttachment.ui_group_role
      delete runtimeAttachment.ui_kind
      return runtimeAttachment
    })
}

export function remoteAttachmentIds(attachments: Attachment[]): number[] {
  return attachments
    .filter(attachment => !hasLocalPath(attachment) && attachment.id > 0)
    .map(attachment => attachment.id)
}

// Symbols survive in-memory message copies without putting promises into persisted JSON.
const attachmentPreparation = Symbol('attachmentPreparation')
const preparationFile = Symbol('preparationFile')
type PreparingAttachment = Attachment & {
  [attachmentPreparation]?: Promise<Attachment>
  [preparationFile]?: File
}
let pendingAttachmentSequence = 0

export function createPreparingAttachment(file: File, ready: Promise<Attachment>): Attachment {
  const attachment: PreparingAttachment = {
    id: -(Date.now() * 1000 + ++pendingAttachmentSequence),
    filename: file.name,
    file_size: file.size,
    mime_type: file.type,
    file_extension: file.name.includes('.') ? `.${file.name.split('.').at(-1)}` : '',
    created_at: new Date().toISOString(),
    status: 'uploading',
    [attachmentPreparation]: ready,
    [preparationFile]: file,
  }
  void ready.then(
    result => {
      delete attachment[preparationFile]
      return Object.assign(attachment, {
        ...result,
        local_preview_url: result.local_preview_url?.startsWith('blob:')
          ? result.local_path
          : result.local_preview_url,
      })
    },
    () => {
      attachment.status = 'failed'
    }
  )
  return attachment
}

export async function resolvePreparingAttachments(
  attachments: Attachment[],
  unavailable: (filename: string) => string = filename =>
    `Attachment preparation is unavailable: ${filename}`
): Promise<Attachment[]> {
  return Promise.all(
    attachments.map(attachment => {
      const ready = (attachment as PreparingAttachment)[attachmentPreparation]
      if (ready) return ready
      if (attachment.status !== 'ready') {
        throw new Error(unavailable(attachment.filename))
      }
      return attachment
    })
  )
}

export function failedPreparationFile(attachment: Attachment): File | undefined {
  return attachment.status === 'failed'
    ? (attachment as PreparingAttachment)[preparationFile]
    : undefined
}
