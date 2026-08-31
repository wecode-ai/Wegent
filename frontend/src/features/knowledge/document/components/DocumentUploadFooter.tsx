// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { FolderSelect } from './FolderSelect'

interface DocumentUploadFooterProps {
  children: ReactNode
  status?: ReactNode
  folderId: number
  folderOptions: Array<{ id: number; name: string; depth: number }>
  onFolderChange?: (folderId: number) => void
  onCancel: () => void
  disabled: boolean
  dingtalk: boolean
}

/** The same destination and cancellation controls for every source. */
export function DocumentUploadFooter({
  children,
  status,
  folderId,
  folderOptions,
  onFolderChange,
  onCancel,
  disabled,
  dingtalk,
}: DocumentUploadFooterProps) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="shrink-0 border-t border-border px-5 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <FolderSelect
        folderId={folderId}
        folderOptions={folderOptions}
        onFolderChange={onFolderChange}
        disabled={disabled}
        className="flex min-w-0 items-center gap-2 md:w-64"
        triggerTestId={dingtalk ? 'dingtalk-import-folder-select' : 'document-upload-folder-select'}
      />
      <div className="flex flex-wrap items-center justify-end gap-2 md:ml-auto">
        {status && <div className="mr-auto md:mr-2">{status}</div>}
        <Button
          variant="outline"
          className="min-h-11"
          onClick={onCancel}
          disabled={disabled}
          data-testid={dingtalk ? 'dingtalk-import-cancel' : 'document-upload-cancel'}
        >
          {t('common:actions.cancel')}
        </Button>
        {children}
      </div>
    </div>
  )
}
