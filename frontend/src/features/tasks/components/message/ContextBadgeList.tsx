// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Database } from 'lucide-react';
import AttachmentPreview from '../input/AttachmentPreview';
import type { SubtaskContextBrief, Attachment } from '@/types/api';

interface ContextBadgeListProps {
  /** Unified contexts (new format) */
  contexts?: SubtaskContextBrief[];
  /** Legacy attachments (for backward compatibility) */
  attachments?: Attachment[];
}

/**
 * ContextBadgeList - Displays all context types (attachments, knowledge bases) as badges
 *
 * Used in message history to show contexts attached to user messages.
 * Supports both new unified contexts and legacy attachments for backward compatibility.
 */
export function ContextBadgeList({ contexts, attachments }: ContextBadgeListProps) {
  // If we have contexts, use them (new format)
  if (contexts && contexts.length > 0) {
    return (
      <div className="flex flex-wrap gap-2 mb-3">
        {contexts.map(context => (
          <ContextBadgeItem key={`${context.context_type}-${context.id}`} context={context} />
        ))}
      </div>
    );
  }

  // Fallback to legacy attachments if no contexts
  if (attachments && attachments.length > 0) {
    return (
      <div className="flex flex-wrap gap-2 mb-3">
        {attachments.map((attachment, idx) => (
          <AttachmentPreview
            key={`attachment-${attachment.id}-${idx}`}
            attachment={attachment}
            compact={false}
            showDownload={true}
          />
        ))}
      </div>
    );
  }

  return null;
}

function ContextBadgeItem({ context }: { context: SubtaskContextBrief }) {
  switch (context.context_type) {
    case 'attachment':
      return <AttachmentContextBadge context={context} />;
    case 'knowledge_base':
      return <KnowledgeBaseBadge context={context} />;
    default:
      return null;
  }
}

/**
 * Attachment badge - reuses existing AttachmentPreview component
 */
function AttachmentContextBadge({ context }: { context: SubtaskContextBrief }) {
  // Convert SubtaskContextBrief to Attachment format for AttachmentPreview
  const attachment: Attachment = {
    id: context.id,
    filename: context.name,
    file_extension: context.file_extension || '',
    file_size: context.file_size || 0,
    mime_type: context.mime_type || '',
    status: context.status as Attachment['status'],
    created_at: '',
  };

  return <AttachmentPreview attachment={attachment} compact={true} showDownload={true} />;
}

/**
 * Knowledge base badge - displays KB name and document count
 */
function KnowledgeBaseBadge({ context }: { context: SubtaskContextBrief }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface border border-border text-xs text-text-secondary">
      <Database className="w-3.5 h-3.5 text-primary flex-shrink-0" />
      <span className="max-w-[140px] truncate font-medium">{context.name}</span>
      {context.document_count !== undefined &&
        context.document_count !== null &&
        context.document_count > 0 && (
          <span className="text-text-muted">({context.document_count})</span>
        )}
    </div>
  );
}

export default ContextBadgeList;
