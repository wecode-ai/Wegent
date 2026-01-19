// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas version history panel component.
 */

'use client'

import React from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { XIcon, RotateCcwIcon, UserIcon, BotIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CanvasVersionInfo } from '@/types/canvas'

interface CanvasVersionHistoryProps {
  versions: CanvasVersionInfo[]
  currentVersion: number
  onRollback: (version: number) => void
  onClose: () => void
  className?: string
}

export function CanvasVersionHistory({
  versions,
  currentVersion,
  onRollback,
  onClose,
  className,
}: CanvasVersionHistoryProps) {
  const { t } = useTranslation('canvas')

  // Sort versions in descending order (newest first)
  const sortedVersions = [...versions].sort((a, b) => b.version - a.version)

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  return (
    <div
      className={cn(
        'flex flex-col h-full w-80 border-l bg-surface',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-12 px-4 border-b">
        <span className="font-medium text-sm">{t('history.title')}</span>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <XIcon className="h-4 w-4" />
        </Button>
      </div>

      {/* Version list */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {sortedVersions.map(version => (
            <div
              key={version.version}
              className={cn(
                'p-3 rounded-lg mb-2 border',
                version.version === currentVersion
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-bg-muted/50'
              )}
            >
              {/* Version header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {/* Source icon */}
                  {version.source === 'ai' ? (
                    <BotIcon className="h-4 w-4 text-primary" />
                  ) : (
                    <UserIcon className="h-4 w-4 text-text-muted" />
                  )}

                  {/* Version number */}
                  <span className="font-medium text-sm">
                    {t('history.version', { version: version.version })}
                  </span>

                  {/* Current badge */}
                  {version.version === currentVersion && (
                    <span className="text-xs bg-primary text-white px-1.5 py-0.5 rounded">
                      Current
                    </span>
                  )}
                </div>

                {/* Rollback button */}
                {version.version !== currentVersion && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRollback(version.version)}
                    className="h-7 px-2 text-xs"
                  >
                    <RotateCcwIcon className="h-3 w-3 mr-1" />
                    {t('history.rollback')}
                  </Button>
                )}
              </div>

              {/* Metadata */}
              <div className="text-xs text-text-muted space-y-1">
                <div>{formatTimestamp(version.timestamp)}</div>
                <div>
                  {version.source === 'ai'
                    ? t('history.source_ai')
                    : t('history.source_user')}
                </div>
                {version.rollback_from && (
                  <div className="text-amber-600 dark:text-amber-400">
                    Rolled back from v{version.rollback_from}
                  </div>
                )}
              </div>

              {/* Change preview for AI edits */}
              {version.source === 'ai' && version.old_str && version.new_str && (
                <div className="mt-2 text-xs bg-bg-muted rounded p-2 space-y-1">
                  <div className="text-red-600 dark:text-red-400 line-through truncate">
                    - {version.old_str.slice(0, 50)}
                    {version.old_str.length > 50 && '...'}
                  </div>
                  <div className="text-green-600 dark:text-green-400 truncate">
                    + {version.new_str.slice(0, 50)}
                    {version.new_str.length > 50 && '...'}
                  </div>
                </div>
              )}
            </div>
          ))}

          {sortedVersions.length === 0 && (
            <div className="text-center text-text-muted py-8 text-sm">
              No version history available
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
