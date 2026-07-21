// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { PublicContextData } from '@/apis/tasks'
import type { SubtaskContextBrief } from '@/types/api'

export function publicContextToSubtaskContextBrief(ctx: PublicContextData): SubtaskContextBrief {
  return {
    id: ctx.id,
    context_type: ctx.context_type,
    name: ctx.name,
    status: ctx.status as 'pending' | 'uploading' | 'parsing' | 'ready' | 'failed',
    file_extension: ctx.file_extension,
    file_size: ctx.file_size,
    mime_type: ctx.mime_type,
    document_count: ctx.document_count,
    external_provider: ctx.external_provider ?? undefined,
    external_provider_label: ctx.external_provider_label ?? undefined,
    external_source_name: ctx.external_source_name ?? undefined,
    external_target_name: ctx.external_target_name ?? undefined,
    external_target_type: ctx.external_target_type ?? undefined,
    retrieval_status: ctx.retrieval_status ?? undefined,
    document_id: ctx.document_id,
    source_config: ctx.source_config,
    external_media_type: ctx.external_media_type,
    text_count: ctx.text_count,
    video_count: ctx.video_count,
    image_count: ctx.image_count,
    comment_count: ctx.comment_count,
    fetched_comment_count: ctx.fetched_comment_count,
    site: ctx.site,
    source_url: ctx.source_url,
    cover_url: ctx.cover_url,
  }
}
