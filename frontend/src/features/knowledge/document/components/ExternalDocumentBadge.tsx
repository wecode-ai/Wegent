// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { BookOpen, FolderGit2, Gitlab } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { SyncedWikiConnectorType } from '../utils/documentUtils'

const connectorPresentation = {
  wikijs: {
    label: 'wikijs',
    Icon: BookOpen,
  },
  gitlab_repo: {
    label: 'gitlab-repo',
    Icon: FolderGit2,
  },
  gitlab_wiki: {
    label: 'gitlab-wiki',
    Icon: Gitlab,
  },
} as const

export function getWikiConnectorPresentation(connectorType?: string | null) {
  const type =
    connectorType === 'gitlab_repo' || connectorType === 'gitlab_wiki' ? connectorType : 'wikijs'
  return { type, ...connectorPresentation[type] }
}

export function ExternalDocumentBadge({
  className,
  extension,
  syncedWiki = false,
  connectorType,
}: {
  className?: string
  extension?: string | null
  syncedWiki?: boolean
  connectorType?: SyncedWikiConnectorType | null
}) {
  const { t } = useTranslation('knowledge')
  if (syncedWiki) {
    const format = extension?.trim().replace(/^\.+/, '').toUpperCase() || 'MD'
    const { type, label, Icon } = getWikiConnectorPresentation(connectorType)
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-xs text-text-muted', className)}
        data-testid="synced-wiki-document-type"
        data-connector-type={type.replace('_', '-')}
        title={label}
      >
        <span>{format}</span>
        <Icon
          aria-label={label}
          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span>{label}</span>
      </span>
    )
  }
  return (
    <Badge
      variant="default"
      size="sm"
      className={cn('bg-amber-500/10 text-amber-600 border-amber-500/20', className)}
    >
      {t('document.document.type.external')}
    </Badge>
  )
}
