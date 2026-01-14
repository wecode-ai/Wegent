// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas toolbar component with actions like export, version history, etc.
 */

'use client'

import React from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HistoryIcon, DownloadIcon, XIcon, ChevronDownIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface CanvasToolbarProps {
  filename: string
  version: number
  onExport: (format: 'md' | 'txt') => void
  onShowHistory: () => void
  onClose: () => void
  className?: string
}

export function CanvasToolbar({
  filename,
  version,
  onExport,
  onShowHistory,
  onClose,
  className,
}: CanvasToolbarProps) {
  const { t } = useTranslation('canvas')

  return (
    <div
      className={cn(
        'flex items-center justify-between h-12 px-4 border-b bg-surface',
        className
      )}
    >
      {/* Left: Filename and version */}
      <div className="flex items-center gap-3">
        <span className="font-medium text-sm text-text-primary">{filename}</span>
        <span className="text-xs text-text-muted bg-bg-muted px-2 py-0.5 rounded">
          v{version}
        </span>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Version History */}
        <Button variant="ghost" size="sm" onClick={onShowHistory} className="h-8 px-3">
          <HistoryIcon className="h-4 w-4 mr-2" />
          <span className="hidden sm:inline">{t('toolbar.history')}</span>
        </Button>

        {/* Export dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              <DownloadIcon className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">{t('toolbar.export')}</span>
              <ChevronDownIcon className="h-3 w-3 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onExport('txt')}>
              {t('export.format_txt')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport('md')}>
              {t('export.format_md')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Close */}
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <XIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
