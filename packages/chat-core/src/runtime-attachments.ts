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
      delete runtimeAttachment.image_markup_comments
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
  [attachmentPreparation]?: () => Promise<Attachment>
  [preparationFile]?: File
}
let pendingAttachmentSequence = 0

export function createPreparingAttachment(file: File, ready: Promise<Attachment>): Attachment {
  return pendingAttachment(file, ready, file)
}

export function prepareAttachmentFile(
  name: string,
  type: string,
  loadFile: () => Promise<File>,
  upload: (file: File) => Promise<Attachment>,
  onPrepared?: (attachment: Attachment) => void
): Attachment {
  const attachment = pendingAttachment(
    { name, type, size: 0 },
    async () => {
      const file = await loadFile()
      attachment[preparationFile] = file
      return upload(file)
    },
    undefined,
    onPrepared
  )
  return attachment
}

function pendingAttachment(
  metadata: Pick<File, 'name' | 'type' | 'size'>,
  prepare: Promise<Attachment> | (() => Promise<Attachment>),
  retryFile?: File,
  onPrepared?: (attachment: Attachment) => void
): PreparingAttachment {
  const { name, type, size } = metadata
  let ready: Promise<Attachment> | undefined
  const retryable = typeof prepare === 'function'
  const start = () => {
    if (ready) return ready
    attachment.status = 'uploading'
    ready = retryable ? Promise.resolve().then(prepare) : prepare
    void ready.then(
      result => {
        delete attachment[preparationFile]
        const prepared = Object.assign(attachment, {
          ...result,
          local_preview_url: result.local_preview_url?.startsWith('blob:')
            ? result.local_path
            : result.local_preview_url,
        })
        onPrepared?.(prepared)
        return prepared
      },
      () => {
        attachment.status = 'failed'
        if (retryable) ready = undefined
      }
    )
    return ready
  }
  const attachment: PreparingAttachment = {
    id: -(Date.now() * 1000 + ++pendingAttachmentSequence),
    filename: name,
    file_size: size,
    mime_type: type,
    file_extension: name.includes('.') ? `.${name.split('.').at(-1)}` : '',
    created_at: new Date().toISOString(),
    status: 'uploading',
    [attachmentPreparation]: start,
    [preparationFile]: retryFile,
  }
  if (typeof prepare !== 'function') start()
  return attachment
}

export async function resolvePreparingAttachments(
  attachments: Attachment[],
  unavailable: (filename: string) => string = filename =>
    `Attachment preparation is unavailable: ${filename}`
): Promise<Attachment[]> {
  return Promise.all(
    attachments.map(attachment => {
      const start = (attachment as PreparingAttachment)[attachmentPreparation]
      if (start) return start()
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
