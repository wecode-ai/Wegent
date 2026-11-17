import { useMemo } from 'react'
import type { Attachment } from '@wegent/chat-core/runtime'
import type { GeneratedImageArtifact } from '@wegent/chat-core/generated-images'
export { getGeneratedImages } from '@wegent/chat-core/generated-images'
import {
  AttachmentImageView,
  type AttachmentImageServices,
} from '../issue-detail/AttachmentImageView'

function generatedImageDownloadFilename(attachment: Attachment, index: number): string {
  const extension = attachment.file_extension?.startsWith('.')
    ? attachment.file_extension
    : `.${attachment.file_extension || 'png'}`
  return `generated-image-${index + 1}${extension}`
}

function generatedImageAttachment(image: GeneratedImageArtifact, index: number): Attachment {
  return {
    id: index + 1,
    filename: image.alt,
    file_size: image.size,
    mime_type: image.mimeType,
    status: 'ready',
    file_extension: image.fileExtension,
    created_at: '',
    local_preview_url: image.src,
    workspace_file: image.workspaceFile,
    image_width: image.width,
    image_height: image.height,
  }
}

export function GeneratedImageGallery({
  images,
  services,
}: {
  images: GeneratedImageArtifact[]
  services: AttachmentImageServices<Attachment>
}) {
  const attachments = useMemo(() => images.map(generatedImageAttachment), [images])

  return (
    <div
      className="mb-3 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid="generated-image-gallery"
    >
      {images.map((image, index) => (
        <GeneratedImagePreview
          services={services}
          key={image.id}
          index={index}
          galleryAttachments={attachments}
        />
      ))}
    </div>
  )
}

function GeneratedImagePreview({
  services,
  index,
  galleryAttachments,
}: {
  index: number
  galleryAttachments: Attachment[]
  services: AttachmentImageServices<Attachment>
}) {
  const attachment = galleryAttachments[index]

  return (
    <AttachmentImageView
      services={services}
      attachment={attachment}
      galleryAttachments={galleryAttachments}
      galleryIndex={index}
      resolveDownloadFilename={generatedImageDownloadFilename}
      buttonTestId="generated-image-preview-button"
      imageTestId="generated-image"
      loadingTestId="generated-image-loading"
      errorTestId="generated-image-error"
      imageClassName="h-auto w-full rounded-lg border border-border bg-surface object-contain"
      placeholderClassName="flex min-h-40 w-full items-center justify-center rounded-lg border border-border bg-surface text-text-muted"
      buttonClassName="block w-full cursor-zoom-in p-0 text-left"
    />
  )
}
