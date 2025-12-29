// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Database } from 'lucide-react';
import AttachmentPreview from '../input/AttachmentPreview';
import type { SubtaskContextBrief, Attachment } from '@/types/api';

interface ContextBadgeListProps {
  /** List of contexts to display */
  contexts?: SubtaskContextBrief[];
}

/**
 * ContextBadgeList - Display a list of context badges (attachments, knowledge bases, etc.)
 *
 * This component replaces the old attachment-only display with a unified context system.
 * It renders different badges based on context_type:
 * - attachment: Uses AttachmentPreview component (reuse existing logic)
 * - knowledge_base: Displays KB name with document count
 */
export function ContextBadgeList({ contexts }: ContextBadgeListProps) {
  // DEBUG: Log contexts to help diagnose display issues
  console.log('[ContextBadgeList] Rendering with contexts:', contexts);

  if (!contexts || contexts.length === 0) {
    console.log('[ContextBadgeList] No contexts to display');
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {contexts.map(context => (
        <ContextBadgeItem key={`${context.context_type}-${context.id}`} context={context} />
      ))}
    </div>
  );
}

/**
 * Single context badge item - routes to appropriate renderer based on type
 */
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
 *
 * Converts SubtaskContextBrief to Attachment format for AttachmentPreview
 */
function AttachmentContextBadge({ context }: { context: SubtaskContextBrief }) {
  // Map context status to Attachment status
  // SubtaskContextBrief uses lowercase status values (pending, ready, failed)
  // Attachment uses specific status types (uploading, parsing, ready, failed)
  const mapStatus = (status: string): Attachment['status'] => {
    switch (status) {
      case 'ready':
        return 'ready';
      case 'failed':
        return 'failed';
      case 'parsing':
        return 'parsing';
      case 'uploading':
        return 'uploading';
      case 'pending':
        // Map 'pending' to 'uploading' as they're semantically similar
        return 'uploading';
      default:
        return 'ready';
    }
  };

  // Convert SubtaskContextBrief to Attachment format for AttachmentPreview
  const attachment: Attachment = {
    id: context.id,
    filename: context.name,
    file_extension: context.file_extension || '',
    file_size: context.file_size || 0,
    mime_type: context.mime_type || '',
    status: mapStatus(context.status),
    created_at: '',
  };

  return <AttachmentPreview attachment={attachment} compact={false} showDownload={true} />;
}

/**
 * Knowledge base badge - displays KB name and document count
 *
 * Uses a simple badge design with database icon
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
