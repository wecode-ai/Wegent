// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef, useCallback, useState, useEffect } from 'react'
import {
  Upload,
  X,
  FileText,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trash2,
  ClipboardPaste,
  ArrowLeft,
  Pencil,
  Link,
  Check,
  Globe,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useTranslation } from '@/hooks/useTranslation'
import {
  useBatchAttachment,
  MAX_BATCH_FILES,
  type FileUploadStatus,
} from '@/hooks/useBatchAttachment'
import { MAX_FILE_SIZE } from '@/apis/attachments'
import { SplitterSettingsSection, type SplitterConfig } from './SplitterSettingsSection'
import type { Attachment } from '@/types/api'
import { cn } from '@/lib/utils'
import { validateTableUrl } from '@/apis/knowledge'

// Smart splitter supported file extensions
const SMART_SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.doc', '.docx', '.md']

/**
 * Check if a file extension is supported by smart splitter
 */
function isSmartSupportedExtension(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return SMART_SUPPORTED_EXTENSIONS.includes(ext)
}

/**
 * Check if all files are supported by smart splitter
 */
function areAllFilesSmartSupported(files: { file: File; status: string }[]): boolean {
  const successFiles = files.filter(f => f.status === 'success')
  if (successFiles.length === 0) return false
  return successFiles.every(f => isSmartSupportedExtension(f.file.name))
}

// Upload mode type
type UploadMode = 'file' | 'text' | 'table' | 'web'

// Table document data
export interface TableDocument {
  name: string
  source_config: { url: string }
}

// Maximum documents allowed in notebook mode
export const NOTEBOOK_MAX_DOCUMENTS = 50

interface DocumentUploadProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUploadComplete: (
    attachments: { attachment: Attachment; file: File }[],
    splitterConfig?: Partial<SplitterConfig>
  ) => Promise<void>
  onTableAdd?: (data: TableDocument) => Promise<void>
  /** Callback to add a web page document. Backend handles scraping and document creation. */
  onWebAdd?: (url: string, name?: string) => Promise<void>
  /** Knowledge base type: 'notebook' or 'classic' */
  kbType?: string
  /** Current document count in the knowledge base */
  currentDocumentCount?: number
}

export function DocumentUpload({
  open,
  onOpenChange,
  onUploadComplete,
  onTableAdd,
  onWebAdd,
  kbType = 'classic',
  currentDocumentCount = 0,
}: DocumentUploadProps) {
  const { t } = useTranslation('knowledge')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { state, addFiles, removeFile, clearFiles, startUpload, retryFile, renameFile, reset } =
    useBatchAttachment()
  const [splitterConfig, setSplitterConfig] = useState<Partial<SplitterConfig>>({
    type: 'sentence',
    separator: '\n\n',
    chunk_size: 1024,
    chunk_overlap: 50,
  })
  const [isDragOver, setIsDragOver] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)

  // Upload mode state
  const [uploadMode, setUploadMode] = useState<UploadMode>('file')

  // Text input state
  const [textContent, setTextContent] = useState('')
  const [textFileName, setTextFileName] = useState('')
  const [textError, setTextError] = useState<string | null>(null)

  // Table input state
  const [tableUrl, setTableUrl] = useState('')
  const [tableName, setTableName] = useState('')
  const [tableError, setTableError] = useState<string | null>(null)
  const [tableSubmitting, setTableSubmitting] = useState(false)

  // Table URL validation state
  const [tableUrlValidating, setTableUrlValidating] = useState(false)
  const [tableUrlValid, setTableUrlValid] = useState<boolean | null>(null)
  const [tableUrlProvider, setTableUrlProvider] = useState<string | null>(null)

  // Web page input state
  const [webUrl, setWebUrl] = useState('')
  const [webName, setWebName] = useState('')
  const [webError, setWebError] = useState<string | null>(null)
  const [webSubmitting, setWebSubmitting] = useState(false)
  const [webFetching, setWebFetching] = useState(false)

  // File rename editing state
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState('')

  // Track pending files count to auto-start upload
  const pendingCount = state.files.filter(f => f.status === 'pending').length

  // Auto-start upload when there are pending files and not currently uploading
  useEffect(() => {
    if (pendingCount > 0 && !state.isUploading) {
      startUpload()
    }
  }, [pendingCount, state.isUploading, startUpload])

  // Handle files added - just add them, upload will auto-start via useEffect
  const handleFilesAdded = useCallback(
    (files: File[]) => {
      if (files.length === 0) return

      const result = addFiles(files)
      if (result.rejected > 0 && result.reason) {
        setValidationError(result.reason)
        setTimeout(() => setValidationError(null), 5000)
      }
    },
    [addFiles]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      handleFilesAdded(files)
      // Reset input value to allow selecting the same files again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [handleFilesAdded]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragOver(false)
      const files = Array.from(e.dataTransfer.files || [])
      handleFilesAdded(files)
    },
    [handleFilesAdded]
  )

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  // Handle retry - auto-start upload after retry
  const handleRetryFile = useCallback(
    async (id: string) => {
      await retryFile(id)
    },
    [retryFile]
  )

  // Confirm and create documents
  const handleConfirm = async () => {
    // If there's an active edit, apply it first
    if (editingFileId && editingFileName.trim()) {
      const currentItem = state.files.find(f => f.id === editingFileId)
      const currentDisplayName = currentItem?.attachment?.filename || currentItem?.file.name
      if (editingFileName !== currentDisplayName) {
        renameFile(editingFileId, editingFileName.trim())
      }
      setEditingFileId(null)
      setEditingFileName('')
    }

    // Build attachments list directly from state, applying any pending rename
    const successfulAttachments = state.files
      .filter(f => f.status === 'success' && f.attachment)
      .map(f => {
        // If this file was being edited, use the editing name
        const finalFilename =
          f.id === editingFileId && editingFileName.trim()
            ? editingFileName.trim()
            : f.attachment!.filename
        return {
          attachment: { ...f.attachment!, filename: finalFilename },
          file: f.file,
        }
      })

    if (successfulAttachments.length === 0) return

    setIsConfirming(true)
    try {
      await onUploadComplete(successfulAttachments, splitterConfig)
      reset()
      setSplitterConfig({
        type: 'sentence',
        separator: '\n\n',
        chunk_size: 1024,
        chunk_overlap: 50,
      })
    } catch {
      // Error handled by parent
    } finally {
      setIsConfirming(false)
    }
  }

  const handleClose = () => {
    reset()
    setSplitterConfig({
      type: 'sentence',
      separator: '\n\n',
      chunk_size: 1024,
      chunk_overlap: 50,
    })
    setValidationError(null)
    setUploadMode('file')
    setTextContent('')
    setTextFileName('')
    setTextError(null)
    setTableUrl('')
    setTableName('')
    setTableError(null)
    setTableUrlValid(null)
    setTableUrlProvider(null)
    setTableUrlValidating(false)
    setWebUrl('')
    setWebName('')
    setWebError(null)
    setWebSubmitting(false)
    setWebFetching(false)
    onOpenChange(false)
  }

  // Handle text content submission - convert to file and upload
  const handleTextSubmit = useCallback(() => {
    // Validate text content
    if (!textContent.trim()) {
      setTextError(t('document.upload.textRequired'))
      return
    }

    // Generate filename if not provided
    const fileName = textFileName.trim() || `document_${Date.now()}.txt`
    const finalFileName = fileName.endsWith('.txt') ? fileName : `${fileName}.txt`

    // Create a File object from text content
    const blob = new Blob([textContent], { type: 'text/plain' })
    const file = new File([blob], finalFileName, { type: 'text/plain' })

    // Add file to upload queue
    handleFilesAdded([file])

    // Reset text input state and switch back to file mode
    setTextContent('')
    setTextFileName('')
    setTextError(null)
    setUploadMode('file')
  }, [textContent, textFileName, handleFilesAdded, t])

  // Handle back from text mode
  const handleBackFromTextMode = () => {
    setUploadMode('file')
    setTextContent('')
    setTextFileName('')
    setTextError(null)
  }

  // Validate table URL
  const handleValidateTableUrl = useCallback(
    async (url: string) => {
      if (!url.trim()) {
        setTableUrlValid(null)
        setTableUrlProvider(null)
        setTableError(null)
        return
      }

      setTableUrlValidating(true)
      setTableError(null)
      setTableUrlValid(null)
      setTableUrlProvider(null)

      try {
        const result = await validateTableUrl(url)
        if (result.valid) {
          setTableUrlValid(true)
          setTableUrlProvider(result.provider || null)
          setTableError(null)
        } else {
          setTableUrlValid(false)
          setTableUrlProvider(null)
          // Map error codes to i18n messages
          switch (result.error_code) {
            case 'INVALID_URL_FORMAT':
              setTableError(t('document.upload.validation.invalidUrlFormat'))
              break
            case 'UNSUPPORTED_PROVIDER':
              setTableError(t('document.upload.validation.unsupportedProvider'))
              break
            case 'PARSE_FAILED':
              setTableError(t('document.upload.validation.parseFailed'))
              break
            case 'MISSING_DINGTALK_ID':
              setTableError(t('document.upload.validation.missingDingtalkId'))
              break
            case 'TABLE_ACCESS_FAILED_LINKED_TABLE':
              setTableError(t('document.upload.validation.tableAccessFailedLinkedTable'))
              break
            case 'TABLE_ACCESS_FAILED':
              setTableError(t('document.upload.validation.tableAccessFailed'))
              break
            default:
              setTableError(result.error_message || t('document.upload.validation.unknownError'))
          }
        }
      } catch {
        setTableUrlValid(false)
        setTableError(t('document.upload.validation.networkError'))
      } finally {
        setTableUrlValidating(false)
      }
    },
    [t]
  )

  // Debounced URL validation on blur
  const handleTableUrlBlur = useCallback(() => {
    if (tableUrl.trim()) {
      handleValidateTableUrl(tableUrl.trim())
    }
  }, [tableUrl, handleValidateTableUrl])

  // Handle table submission
  const handleTableSubmit = useCallback(async () => {
    // Validate URL
    if (!tableUrl.trim()) {
      setTableError(t('document.upload.tableUrlRequired'))
      return
    }

    // Validate name
    if (!tableName.trim()) {
      setTableError(t('document.upload.tableNameRequired'))
      return
    }

    if (!onTableAdd) {
      setTableError('Table add handler not configured')
      return
    }

    // If URL hasn't been validated yet, validate first
    if (tableUrlValid === null) {
      setTableSubmitting(true)
      try {
        const result = await validateTableUrl(tableUrl.trim())
        if (!result.valid) {
          switch (result.error_code) {
            case 'INVALID_URL_FORMAT':
              setTableError(t('document.upload.validation.invalidUrlFormat'))
              break
            case 'UNSUPPORTED_PROVIDER':
              setTableError(t('document.upload.validation.unsupportedProvider'))
              break
            case 'PARSE_FAILED':
              setTableError(t('document.upload.validation.parseFailed'))
              break
            default:
              setTableError(result.error_message || t('document.upload.validation.unknownError'))
          }
          setTableUrlValid(false)
          setTableSubmitting(false)
          return
        }
        setTableUrlValid(true)
        setTableUrlProvider(result.provider || null)
      } catch {
        setTableError(t('document.upload.validation.networkError'))
        setTableUrlValid(false)
        setTableSubmitting(false)
        return
      }
    }

    // Block submission if URL is invalid
    if (tableUrlValid === false) {
      setTableError(t('document.upload.validation.pleaseFixUrl'))
      return
    }

    setTableSubmitting(true)
    setTableError(null)

    try {
      await onTableAdd({
        name: tableName.trim(),
        source_config: { url: tableUrl.trim() },
      })

      // Reset and close on success
      setTableUrl('')
      setTableName('')
      setTableUrlValid(null)
      setTableUrlProvider(null)
      setUploadMode('file')
      handleClose()
    } catch (err) {
      setTableError(err instanceof Error ? err.message : t('document.upload.tableAddFailed'))
    } finally {
      setTableSubmitting(false)
    }
  }, [tableUrl, tableName, onTableAdd, t, handleClose, tableUrlValid])

  // Handle back from table mode
  const handleBackFromTableMode = () => {
    setUploadMode('file')
    setTableUrl('')
    setTableName('')
    setTableError(null)
    setTableUrlValid(null)
    setTableUrlProvider(null)
    setTableUrlValidating(false)
  }

  // Handle web page submission
  const handleWebSubmit = useCallback(async () => {
    // Validate URL
    if (!webUrl.trim()) {
      setWebError(t('document.upload.web.urlRequired'))
      return
    }

    // Basic URL validation
    try {
      new URL(webUrl.trim())
    } catch {
      setWebError(t('document.upload.validation.invalidUrlFormat'))
      return
    }

    if (!onWebAdd) {
      setWebError('Web add handler not configured')
      return
    }

    setWebSubmitting(true)
    setWebFetching(true)
    setWebError(null)

    try {
      // Call the parent handler - backend handles scraping and document creation
      await onWebAdd(webUrl.trim(), webName.trim() || undefined)

      // Reset and close on success
      setWebUrl('')
      setWebName('')
      setUploadMode('file')
      handleClose()
    } catch (err) {
      // Map error messages from backend
      const errorMessage = err instanceof Error ? err.message : t('document.upload.web.addFailed')
      // Check for specific error codes in the message
      if (errorMessage.includes('FETCH_FAILED')) {
        setWebError(t('document.upload.web.fetchFailed'))
      } else if (errorMessage.includes('FETCH_TIMEOUT')) {
        setWebError(t('document.upload.web.fetchTimeout'))
      } else if (errorMessage.includes('PARSE_FAILED')) {
        setWebError(t('document.upload.web.parseFailed'))
      } else if (errorMessage.includes('EMPTY_CONTENT')) {
        setWebError(t('document.upload.web.emptyContent'))
      } else if (errorMessage.includes('AUTH_REQUIRED')) {
        setWebError(t('document.upload.web.authRequired'))
      } else {
        setWebError(errorMessage)
      }
    } finally {
      setWebSubmitting(false)
      setWebFetching(false)
    }
  }, [webUrl, webName, onWebAdd, t, handleClose])

  // Handle back from web mode
  const handleBackFromWebMode = () => {
    setUploadMode('file')
    setWebUrl('')
    setWebName('')
    setWebError(null)
    setWebSubmitting(false)
    setWebFetching(false)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

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

  const successCount = state.files.filter(f => f.status === 'success').length
  const errorCount = state.files.filter(f => f.status === 'error').length
  const hasFiles = state.files.length > 0
  // Can confirm when all uploads are done (no pending/uploading) and at least one success
  const allUploadsComplete =
    !state.isUploading && state.files.every(f => f.status === 'success' || f.status === 'error')
  const canConfirm = successCount > 0 && allUploadsComplete && !isConfirming

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      reset()
      setSplitterConfig({
        type: 'sentence',
        separator: '\n\n',
        chunk_size: 1024,
        chunk_overlap: 50,
      })
      setValidationError(null)
    }
  }, [open, reset])

  // Auto-select smart splitter when all successful files support it
  useEffect(() => {
    // Only check when all uploads are complete and there are successful files
    if (!allUploadsComplete || successCount === 0) return

    // Check if all successful files support smart splitter
    if (areAllFilesSmartSupported(state.files)) {
      // Auto-select smart type if not already selected
      setSplitterConfig(prev => {
        if (prev.type !== 'smart') {
          return { ...prev, type: 'smart' }
        }
        return prev
      })
    }
  }, [allUploadsComplete, successCount, state.files])

  // Render text input mode
  const renderTextMode = () => (
    <>
      <DialogHeader className="flex flex-row items-center gap-2 space-y-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleBackFromTextMode}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <DialogTitle>{t('document.upload.pasteText')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 space-y-4">
        <p className="text-sm text-text-secondary">{t('document.upload.pasteTextHint')}</p>

        {/* File name input */}
        <div className="space-y-2">
          <Label htmlFor="text-filename" className="text-sm font-medium">
            {t('document.upload.fileName')}
          </Label>
          <Input
            id="text-filename"
            placeholder={t('document.upload.fileNamePlaceholder')}
            value={textFileName}
            onChange={e => setTextFileName(e.target.value)}
            className="h-9"
          />
        </div>

        {/* Text content input */}
        <div className="space-y-2">
          <Label htmlFor="text-content" className="text-sm font-medium">
            {t('document.upload.textContent')}
          </Label>
          <Textarea
            id="text-content"
            placeholder={t('document.upload.textPlaceholder')}
            value={textContent}
            onChange={e => {
              setTextContent(e.target.value)
              if (textError) setTextError(null)
            }}
            className="min-h-[200px] resize-y"
          />
        </div>

        {/* Text error */}
        {textError && (
          <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{textError}</span>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleBackFromTextMode}>
          {t('common:actions.cancel')}
        </Button>
        <Button variant="primary" onClick={handleTextSubmit} disabled={!textContent.trim()}>
          {t('document.upload.insert')}
        </Button>
      </div>
    </>
  )

  // Check if notebook mode has reached document limit
  const isNotebookMode = kbType === 'notebook'
  const totalDocumentCount = currentDocumentCount + successCount
  const isAtLimit = isNotebookMode && totalDocumentCount >= NOTEBOOK_MAX_DOCUMENTS

  // Render file upload mode
  const renderFileMode = () => (
    <>
      <DialogHeader>
        <DialogTitle>{t('document.document.upload')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 overflow-hidden">
        {/* Dropzone */}
        <div
          className={cn(
            'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
            isDragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
            state.isUploading && 'pointer-events-none opacity-50'
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <p className="text-text-primary font-medium text-sm mb-4">
            {t('document.document.dropzone')}
          </p>

          {/* Action buttons - similar to NotebookLM */}
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-4"
              onClick={() => !state.isUploading && fileInputRef.current?.click()}
              disabled={state.isUploading}
            >
              <Upload className="w-4 h-4 mr-2" />
              {t('document.upload.uploadFile')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-4"
              onClick={() => setUploadMode('text')}
              disabled={state.isUploading}
            >
              <ClipboardPaste className="w-4 h-4 mr-2" />
              {t('document.upload.pasteText')}
            </Button>
            {onTableAdd && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-4"
                onClick={() => setUploadMode('table')}
                disabled={state.isUploading}
              >
                <Link className="w-4 h-4 mr-2" />
                {t('document.upload.addTable')}
              </Button>
            )}
          </div>

          <p className="text-xs text-text-muted mt-4">
            {t('document.upload.dropzoneHint', { max: MAX_BATCH_FILES })}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {t('document.document.supportedTypes', {
              maxSize: Math.round(MAX_FILE_SIZE / (1024 * 1024)),
            })}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.gif,.bmp,.webp"
            onChange={handleFileChange}
            disabled={state.isUploading}
          />
        </div>

        {/* Web URL Input Section - inline style like the reference image */}
        {onWebAdd && (
          <div className="mt-4 border border-dashed border-border rounded-lg bg-surface/50">
            <div className="p-6 flex flex-col items-center justify-center min-h-[120px]">
              <p className="text-text-primary font-medium text-sm mb-4">
                {t('document.upload.web.orAddWebPage')}
              </p>
              <div className="flex items-center gap-2 w-full max-w-xl">
                <div className="relative flex-1">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                  <Input
                    placeholder={t('document.upload.web.urlPlaceholder')}
                    value={webUrl}
                    onChange={e => {
                      setWebUrl(e.target.value)
                      if (webError) setWebError(null)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && webUrl.trim()) {
                        handleWebSubmit()
                      }
                    }}
                    className="h-10 pl-9 pr-4"
                    disabled={webSubmitting || state.isUploading}
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 shrink-0"
                  onClick={handleWebSubmit}
                  disabled={!webUrl.trim() || webSubmitting || state.isUploading}
                >
                  {webSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Link className="w-4 h-4" />
                  )}
                </Button>
              </div>
              {/* Web error message */}
              {webError && (
                <div className="flex items-center gap-2 mt-3 p-2 bg-error/10 text-error rounded-lg text-xs w-full max-w-xl">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{webError}</span>
                </div>
              )}
              {/* Fetching status */}
              {webFetching && (
                <div className="flex items-center gap-2 mt-3 p-2 bg-primary/10 text-primary rounded-lg text-xs w-full max-w-xl">
                  <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
                  <span>{t('document.upload.web.fetching')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Validation Error */}
        {validationError && (
          <div className="flex items-center gap-2 mt-3 p-3 bg-error/10 text-error rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {/* File List */}
        {hasFiles && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">
                {t('document.upload.fileList', { count: state.files.length })}
              </span>
              {!state.isUploading && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-text-muted hover:text-error h-7 px-2"
                  onClick={clearFiles}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  {t('document.upload.clearAll')}
                </Button>
              )}
            </div>

            <div className="border border-border rounded-lg divide-y divide-border max-h-[200px] overflow-y-auto">
              {state.files.map(item => {
                const displayName = item.attachment?.filename || item.file.name
                const isEditing = editingFileId === item.id
                const canEdit = item.status === 'success' && !state.isUploading

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
                              className="h-7 text-sm font-medium flex-1 min-w-0"
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
                                  className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
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
                          <span className="flex-shrink-0">{getStatusIcon(item.status)}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-text-muted">
                            {formatFileSize(item.file.size)}
                          </span>
                          <span className="text-xs text-text-muted">•</span>
                          <span
                            className={cn(
                              'text-xs',
                              item.status === 'success' && 'text-success',
                              item.status === 'error' && 'text-error',
                              (item.status === 'uploading' || item.status === 'pending') &&
                                'text-primary'
                            )}
                          >
                            {getStatusText(item.status)}
                          </span>
                        </div>
                        {(item.status === 'uploading' || item.status === 'pending') && (
                          <Progress value={item.progress} className="mt-2 h-1.5" />
                        )}
                        {item.error && (
                          <p className="text-xs text-error mt-1 line-clamp-2">{item.error}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {item.status === 'error' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleRetryFile(item.id)}
                            disabled={state.isUploading}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {!state.isUploading && item.status !== 'uploading' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => removeFile(item.id)}
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

            {/* Upload Summary - show when all uploads complete */}
            {allUploadsComplete && hasFiles && (
              <div className="flex items-center gap-3 p-3 bg-surface rounded-lg text-sm">
                <span className="text-text-primary">
                  {t('document.upload.summary', {
                    total: state.files.length,
                    success: successCount,
                    failed: errorCount,
                  })}
                </span>
              </div>
            )}

            {/* Advanced Settings - Splitter Configuration */}
            {successCount > 0 && allUploadsComplete && (
              <Accordion type="single" collapsible className="border-none">
                <AccordionItem value="advanced" className="border-none">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline">
                    {t('document.advancedSettings.title')}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      <SplitterSettingsSection
                        config={splitterConfig}
                        onChange={setSplitterConfig}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </div>
        )}

        {/* Notebook mode document limit progress bar - at the bottom */}
        {isNotebookMode && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">{t('document.upload.documentCount')}</span>
              <span className={cn('font-medium', isAtLimit ? 'text-error' : 'text-text-primary')}>
                {totalDocumentCount}/{NOTEBOOK_MAX_DOCUMENTS}
              </span>
            </div>
            <Progress
              value={(totalDocumentCount / NOTEBOOK_MAX_DOCUMENTS) * 100}
              className={cn('h-2', isAtLimit && '[&>div]:bg-error')}
            />
            {isAtLimit && (
              <p className="text-xs text-error">{t('document.upload.notebookLimitReached')}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleClose}
          disabled={state.isUploading || isConfirming}
        >
          {t('common:actions.cancel')}
        </Button>
        <Button variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
          {isConfirming ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('document.upload.confirming')}
            </>
          ) : (
            t('document.upload.confirmUpload', { count: successCount })
          )}
        </Button>
      </div>
    </>
  )

  // Render table mode
  const renderTableMode = () => (
    <>
      <DialogHeader className="flex flex-row items-center gap-2 space-y-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleBackFromTableMode}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <DialogTitle>{t('document.upload.addTable')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 space-y-4">
        {/* Hint text with validation requirements */}
        <p className="text-sm text-text-secondary">{t('document.upload.tableUrlHint')}</p>

        {/* Document name input */}
        <div className="space-y-2">
          <Label htmlFor="table-name" className="text-sm font-medium">
            {t('document.upload.tableName')}
          </Label>
          <Input
            id="table-name"
            placeholder={t('document.upload.tableNamePlaceholder')}
            value={tableName}
            onChange={e => {
              setTableName(e.target.value)
              if (tableError) setTableError(null)
            }}
            className="h-9"
          />
        </div>

        {/* URL input with validation status */}
        <div className="space-y-2">
          <Label htmlFor="table-url" className="text-sm font-medium">
            {t('document.upload.tableUrl')}
          </Label>
          <div className="relative">
            <Textarea
              id="table-url"
              placeholder={t('document.upload.tableUrlPlaceholder')}
              value={tableUrl}
              onChange={e => {
                setTableUrl(e.target.value)
                if (tableError) setTableError(null)
                // Reset validation state when URL changes
                setTableUrlValid(null)
                setTableUrlProvider(null)
              }}
              onBlur={handleTableUrlBlur}
              className={cn(
                'min-h-[80px] resize-none pr-10',
                tableUrlValid === true && 'border-success focus-visible:ring-success',
                tableUrlValid === false && 'border-error focus-visible:ring-error'
              )}
              rows={3}
            />
            {/* Validation status icon */}
            <div className="absolute right-3 top-3">
              {tableUrlValidating && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
              {!tableUrlValidating && tableUrlValid === true && (
                <Check className="w-4 h-4 text-success" />
              )}
              {!tableUrlValidating && tableUrlValid === false && (
                <AlertCircle className="w-4 h-4 text-error" />
              )}
            </div>
          </div>
        </div>

        {/* Validation status message */}
        {tableUrlValidating && (
          <div className="flex items-center gap-2 p-3 bg-primary/10 text-primary rounded-lg text-sm">
            <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
            <span>{t('document.upload.validation.validating')}</span>
          </div>
        )}

        {/* Success message with provider info */}
        {!tableUrlValidating && tableUrlValid === true && (
          <div className="flex items-center gap-2 p-3 bg-success/10 text-success rounded-lg text-sm">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>
              {t('document.upload.validation.success')}
              {tableUrlProvider && (
                <span className="ml-1 text-text-secondary">
                  ({t(`document.upload.validation.provider.${tableUrlProvider}`, tableUrlProvider)})
                </span>
              )}
            </span>
          </div>
        )}

        {/* Error message */}
        {tableError && (
          <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{tableError}</span>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleBackFromTableMode}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleTableSubmit}
          disabled={
            !tableUrl.trim() ||
            !tableName.trim() ||
            tableSubmitting ||
            tableUrlValidating ||
            tableUrlValid === false
          }
        >
          {tableSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('document.upload.adding')}
            </>
          ) : (
            t('document.upload.confirmAdd')
          )}
        </Button>
      </div>
    </>
  )

  // Render web page mode
  const renderWebMode = () => (
    <>
      <DialogHeader className="flex flex-row items-center gap-2 space-y-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleBackFromWebMode}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <DialogTitle>{t('document.upload.web.addWebPage')}</DialogTitle>
      </DialogHeader>

      <div className="py-4 space-y-4">
        {/* Hint text */}
        <p className="text-sm text-text-secondary">{t('document.upload.web.hint')}</p>

        {/* URL input */}
        <div className="space-y-2">
          <Label htmlFor="web-url" className="text-sm font-medium">
            {t('document.upload.web.urlLabel')}
          </Label>
          <Input
            id="web-url"
            placeholder={t('document.upload.web.urlPlaceholder')}
            value={webUrl}
            onChange={e => {
              setWebUrl(e.target.value)
              if (webError) setWebError(null)
            }}
            className="h-9"
            disabled={webSubmitting}
          />
        </div>

        {/* Document name input (optional) */}
        <div className="space-y-2">
          <Label htmlFor="web-name" className="text-sm font-medium">
            {t('document.upload.web.nameLabel')}
          </Label>
          <Input
            id="web-name"
            placeholder={t('document.upload.web.namePlaceholder')}
            value={webName}
            onChange={e => setWebName(e.target.value)}
            className="h-9"
            disabled={webSubmitting}
          />
        </div>

        {/* Fetching status */}
        {webFetching && (
          <div className="flex items-center gap-2 p-3 bg-primary/10 text-primary rounded-lg text-sm">
            <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
            <span>{t('document.upload.web.fetching')}</span>
          </div>
        )}

        {/* Error message */}
        {webError && (
          <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{webError}</span>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleBackFromWebMode} disabled={webSubmitting}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleWebSubmit}
          disabled={!webUrl.trim() || webSubmitting}
        >
          {webSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {webFetching ? t('document.upload.web.fetching') : t('document.upload.adding')}
            </>
          ) : (
            t('document.upload.web.submitButton')
          )}
        </Button>
      </div>
    </>
  )

  // Render mode selector
  const renderContent = () => {
    switch (uploadMode) {
      case 'text':
        return renderTextMode()
      case 'table':
        return renderTableMode()
      case 'web':
        return renderWebMode()
      default:
        return renderFileMode()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {renderContent()}
      </DialogContent>
    </Dialog>
  )
}
