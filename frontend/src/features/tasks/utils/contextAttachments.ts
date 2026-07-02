// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isVideoExtension } from '@/apis/attachments'
import type { Attachment, SubtaskContextBrief } from '@/types/api'

type AttachmentVideoInputCandidate = Pick<
  Attachment,
  | 'mime_type'
  | 'file_extension'
  | 'external_media_type'
  | 'text_count'
  | 'video_count'
  | 'image_count'
  | 'comment_count'
  | 'fetched_comment_count'
  | 'source_url'
> & {
  context_type?: SubtaskContextBrief['context_type']
}

export function isAttachmentLikeContext(context: SubtaskContextBrief): boolean {
  return context.context_type === 'attachment' || context.context_type === 'external_web_content'
}

export function getAttachmentLikeContextIds(contexts?: SubtaskContextBrief[]): number[] {
  return contexts?.filter(isAttachmentLikeContext).map(context => context.id) || []
}

export function isExternalWebContentAttachment(
  attachment: Partial<AttachmentVideoInputCandidate>
): boolean {
  return Boolean(
    attachment.context_type === 'external_web_content' ||
    (attachment.source_url &&
      (attachment.external_media_type ||
        attachment.text_count != null ||
        attachment.video_count != null ||
        attachment.image_count != null ||
        attachment.comment_count != null ||
        attachment.fetched_comment_count != null))
  )
}

export function hasVideoInputAttachment(attachment: AttachmentVideoInputCandidate): boolean {
  if (isExternalWebContentAttachment(attachment)) {
    return (attachment.video_count ?? 0) > 0
  }

  if (attachment.mime_type?.toLowerCase().startsWith('video/')) {
    return true
  }

  const extension = attachment.file_extension?.toLowerCase()
  return Boolean(extension && isVideoExtension(extension))
}

export function contextToExistingAttachment(context: SubtaskContextBrief): Attachment {
  return {
    id: context.id,
    filename: context.name,
    file_size: context.file_size ?? 0,
    mime_type: context.mime_type ?? '',
    status: context.status === 'failed' ? 'failed' : 'ready',
    text_length: null,
    error_message: null,
    error_code: null,
    subtask_id: null,
    file_extension: context.file_extension ?? '',
    created_at: new Date().toISOString(),
    external_media_type: context.external_media_type ?? undefined,
    text_count: context.text_count ?? undefined,
    video_count: context.video_count ?? undefined,
    image_count: context.image_count ?? undefined,
    comment_count: context.comment_count ?? undefined,
    fetched_comment_count: context.fetched_comment_count ?? undefined,
    site: context.site ?? undefined,
    source_url: context.source_url ?? undefined,
    cover_url: context.cover_url ?? undefined,
  }
}
