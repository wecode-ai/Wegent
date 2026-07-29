// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, MoreVertical, Network, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'
import { parseUTCDate } from '@/lib/utils'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'

interface ArtifactCardProps {
  artifact: KnowledgeArtifact
  onOpen: () => void
  onDelete: () => void
}

export function ArtifactCard({ artifact, onOpen, onDelete }: ArtifactCardProps) {
  const { t, i18n } = useTranslation('knowledge')
  const createdAt = parseUTCDate(artifact.created_at)
  const displayTitle =
    artifact.title ||
    t(`artifact.type.${artifact.artifact_type === 'mind_map' ? 'mindMap' : 'briefing'}`)

  return (
    <div className="relative rounded-lg border border-border transition-colors hover:bg-hover">
      <button
        type="button"
        className="w-full p-3 text-left"
        onClick={onOpen}
        data-testid={`artifact-card-${artifact.artifact_id}`}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            {artifact.artifact_type === 'mind_map' ? (
              <Network className="h-4 w-4" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className={`truncate text-sm font-medium ${artifact.can_delete ? 'pr-8' : ''}`}>
              {displayTitle}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span>
                {t(
                  artifact.execution_health === 'stalled'
                    ? 'artifact.status.stalled'
                    : `artifact.status.${artifact.status}`
                )}
              </span>
              <span>
                {createdAt &&
                  new Intl.DateTimeFormat(i18n.language, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(createdAt)}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-text-muted">
              {t('artifact.sourceCount', {
                count: artifact.source_document_ids.length,
              })}
            </div>
          </div>
        </div>
      </button>
      {artifact.can_delete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary md:h-8 md:w-8"
              aria-label={t('artifact.moreActions')}
              data-testid={`artifact-menu-${artifact.artifact_id}`}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              danger
              onSelect={onDelete}
              data-testid={`artifact-delete-${artifact.artifact_id}`}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('artifact.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
