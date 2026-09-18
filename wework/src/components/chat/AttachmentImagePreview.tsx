import { AttachmentImageView, type AttachmentImageViewProps } from '@wegent/collaboration'
import type { Attachment } from '@/types/api'
import { useAttachmentImageServices } from './useAttachmentImageServices'

export function AttachmentImagePreview(
  props: Omit<AttachmentImageViewProps<Attachment>, 'services'>
) {
  return <AttachmentImageView {...props} services={useAttachmentImageServices()} />
}
