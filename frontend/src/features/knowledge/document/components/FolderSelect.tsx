// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useId } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'

interface FolderSelectProps {
  /** Currently selected folder ID (0 = root level) */
  folderId: number
  /** Flat list of folder names with IDs for the selector */
  folderOptions: Array<{ id: number; name: string; depth: number }>
  /** Callback when folder selection changes */
  onFolderChange?: (folderId: number) => void
  /** Extra classes for the wrapping block */
  className?: string
  /** Test id for the select trigger */
  triggerTestId?: string
  disabled?: boolean
}

/** Folder picker shared by the upload dialog's import modes. */
export function FolderSelect({
  folderId,
  folderOptions,
  onFolderChange,
  className = 'space-y-1.5',
  triggerTestId = 'folder-select-trigger',
  disabled = false,
}: FolderSelectProps) {
  const { t } = useTranslation('knowledge')
  const selectId = useId()

  if (folderOptions.length === 0) return null

  return (
    <div className={className}>
      <Label htmlFor={selectId} className="shrink-0 text-sm font-medium">
        {t('document.folder.selectFolder')}
      </Label>
      <Select
        disabled={disabled}
        value={String(folderId)}
        onValueChange={val => onFolderChange?.(Number(val))}
      >
        <SelectTrigger
          id={selectId}
          className="h-11 min-w-[44px] flex-1 [&>svg]:shrink-0"
          data-testid={triggerTestId}
        >
          <span className="min-w-0 truncate text-left">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="0" data-testid="folder-select-option-0">
            {t('document.folder.rootLevel')}
          </SelectItem>
          {folderOptions.map(folder => (
            <SelectItem
              key={folder.id}
              value={String(folder.id)}
              data-testid={`folder-select-option-${folder.id}`}
            >
              {'\u00A0'.repeat(folder.depth * 2)}
              {folder.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
