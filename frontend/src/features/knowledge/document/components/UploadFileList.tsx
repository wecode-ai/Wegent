// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, FileText, Loader2, Pencil, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { formatFileSize } from '@/apis/attachments'
import { useTranslation } from '@/hooks/useTranslation'
import type { useBatchAttachment, FileUploadStatus } from '@/hooks/useBatchAttachment'
import { cn } from '@/lib/utils'

interface UploadFileListProps {
  batch: ReturnType<typeof useBatchAttachment>
  isConfirming: boolean
  onRetry: (id: string) => Promise<void>
}

export function UploadFileList({
  batch,
  isConfirming,
  onRetry: handleRetryFile,
}: UploadFileListProps) {
  const { t } = useTranslation('knowledge')
  const { state, renameFile, removeFile } = batch
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState('')
  const getStatusIcon = (status: FileUploadStatus) => {
    switch (status) {
      case 'pending':
      case 'uploading':
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-success" />
      case 'error':
        return <AlertCircle className="w-4 h-4 text-error" />
    }
  }

  const getStatusText = (status: FileUploadStatus) => {
    switch (status) {
      case 'pending':
        return t('knowledge:document.upload.status.pending')
      case 'uploading':
        return t('knowledge:document.upload.status.uploading')
      case 'success':
        return t('knowledge:document.upload.status.success')
      case 'error':
        return t('knowledge:document.upload.status.error')
    }
  }

  return (
    <div className="border border-border rounded-lg divide-y divide-border">
      {state.files.map(item => {
        const displayName = item.attachment?.filename || item.file.name
        const isEditing = editingFileId === item.id
        const canEdit = item.status === 'success' && !state.isUploading && !isConfirming
        const isCreationFailure = item.status === 'error' && item.attachment !== null

        return (
          <div key={item.id} className="p-3">
            <div className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center gap-2 min-w-0">
                  {isEditing ? (
                    <Input
                      autoFocus
                      value={editingFileName}
                      onChange={e => setEditingFileName(e.target.value)}
                      onBlur={() => {
                        if (editingFileName.trim() && editingFileName !== displayName) {
                          renameFile(item.id, editingFileName.trim())
                        }
                        setEditingFileId(null)
                        setEditingFileName('')
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          if (editingFileName.trim() && editingFileName !== displayName) {
                            renameFile(item.id, editingFileName.trim())
                          }
                          setEditingFileId(null)
                          setEditingFileName('')
                        } else if (e.key === 'Escape') {
                          setEditingFileId(null)
                          setEditingFileName('')
                        }
                      }}
                      className="h-11 text-sm font-medium flex-1 min-w-0"
                      data-testid={`document-file-name-${item.id}`}
                    />
                  ) : (
                    <div className="flex items-center gap-1 flex-1 min-w-0 group">
                      <p
                        className="text-sm font-medium text-text-primary truncate flex-1 min-w-0"
                        title={displayName}
                      >
                        {displayName}
                      </p>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 flex-shrink-0"
                          data-testid={`document-file-rename-${item.id}`}
                          onClick={() => {
                            setEditingFileId(item.id)
                            setEditingFileName(displayName)
                          }}
                          title={t('document.upload.clickToRename')}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  )}
                  <span className="flex-shrink-0">
                    {isCreationFailure ? (
                      <AlertCircle className="w-4 h-4 text-error" />
                    ) : (
                      getStatusIcon(item.status)
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-text-muted">{formatFileSize(item.file.size)}</span>
                  <span className="text-xs text-text-muted">•</span>
                  <span
                    className={cn(
                      'text-xs',
                      item.status === 'success' && 'text-success',
                      item.status === 'error' && 'text-error',
                      (item.status === 'uploading' || item.status === 'pending') && 'text-primary'
                    )}
                  >
                    {isCreationFailure
                      ? t('document.upload.status.createFailed')
                      : getStatusText(item.status)}
                  </span>
                </div>
                {(item.status === 'uploading' || item.status === 'pending') && (
                  <Progress value={item.progress} className="mt-2 h-1.5" />
                )}
                {item.error && <p className="text-xs text-error mt-1 line-clamp-2">{item.error}</p>}
              </div>
              <div className="flex items-center gap-1">
                {item.status === 'error' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => void handleRetryFile(item.id)}
                    aria-label={t('common:actions.retry')}
                    disabled={state.isUploading || isConfirming}
                    data-testid={
                      isCreationFailure
                        ? `document-creation-retry-${item.id}`
                        : `document-upload-retry-${item.id}`
                    }
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                )}
                {!state.isUploading && item.status !== 'uploading' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => removeFile(item.id)}
                    disabled={isConfirming}
                    aria-label={t('common:actions.delete')}
                    data-testid={`document-file-remove-${item.id}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
