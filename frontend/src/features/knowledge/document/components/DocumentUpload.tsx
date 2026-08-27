// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef, useCallback, useState, useEffect, type ReactNode } from 'react'
import {
  Upload,
  AlertCircle,
  Loader2,
  Trash2,
  ClipboardPaste,
  Globe,
  BookOpen,
  X,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
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
import { useBatchAttachment, MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import { MAX_FILE_SIZE } from '@/apis/attachments'
import { SplitterSettingsSection, type SplitterConfig } from './SplitterSettingsSection'
import { MULTIMODAL_EXTENSIONS } from '@/features/knowledge/multimodal/constants'
import type { Attachment } from '@/types/api'
import { cn } from '@/lib/utils'
import { DingtalkDocumentImport, type DingtalkBatchImportSummary } from './DingtalkDocumentImport'
import { DocumentUploadFooter } from './DocumentUploadFooter'
import { UploadFileList } from './UploadFileList'
import { DEFAULT_FLAT_CHUNK_CONFIG, DEFAULT_SPLITTER_CONFIG } from '@/types/knowledge'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'
import {
  UploadMultimodalPromptSettings,
  type UploadMultimodalPrompts,
} from '@/features/knowledge/multimodal/components/UploadMultimodalPromptSettings'
import {
  KB_DOCUMENT_ACCEPT,
  isKBUnsupportedExtension,
  isVideoModelBlock,
} from '@/features/knowledge/multimodal/utils/upload-validation'
import { useMultimodalFeatureEnabled } from '@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled'
import { useTextDocumentUpload } from '../hooks/useTextDocumentUpload'
import type { DocumentCreationResult } from '../utils/document-creation'

function buildDefaultSplitterConfig(): Partial<SplitterConfig> {
  return {
    ...DEFAULT_SPLITTER_CONFIG,
    flat_config: { ...DEFAULT_FLAT_CHUNK_CONFIG },
    markdown_enhancement: {
      enabled: DEFAULT_SPLITTER_CONFIG.markdown_enhancement?.enabled ?? true,
    },
  }
}

type UploadMode = 'file' | 'text' | 'web' | 'dingtalk'

const SOURCE_HEIGHT: Record<UploadMode, string> = {
  file: 'h-[540px] md:h-[480px]',
  web: 'h-[440px] md:h-[344px]',
  text: 'h-[580px]',
  dingtalk: 'h-[720px]',
}

const WEB_ERROR_KEYS = {
  FETCH_FAILED: 'document.upload.web.fetchFailed',
  FETCH_TIMEOUT: 'document.upload.web.fetchTimeout',
  PARSE_FAILED: 'document.upload.web.parseFailed',
  EMPTY_CONTENT: 'document.upload.web.emptyContent',
  AUTH_REQUIRED: 'document.upload.web.authRequired',
} as const

interface DocumentUploadProps {
  knowledgeBaseId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onUploadComplete: (
    attachments: { attachment: Attachment; file: File }[],
    splitterConfig?: Partial<SplitterConfig>,
    multimodalAnalysisPrompts?: { video?: string | null; image?: string | null }
  ) => Promise<DocumentCreationResult[]>
  onWebAdd?: (url: string, name?: string) => Promise<void>
  onDingtalkImport?: (resourceIds: string[]) => Promise<DingtalkBatchImportSummary>
  canManageDocuments?: boolean
  /** Deprecated compatibility props. kb_type no longer limits uploads. */
  kbType?: string
  currentDocumentCount?: number
  folderId?: number
  folderOptions?: Array<{ id: number; name: string; depth: number }>
  onFolderChange?: (folderId: number) => void
  multimodalAnalysisEnabled?: boolean
  multimodalModelSupportsVideo?: boolean
  multimodalVideoPrompt?: string | null
  multimodalImagePrompt?: string | null
}

/** Each opening owns a fresh session; source switches preserve that session. */
export function DocumentUpload(props: DocumentUploadProps) {
  return props.open ? <DocumentUploadSession {...props} /> : null
}

function DocumentUploadSession({
  knowledgeBaseId,
  onOpenChange,
  onUploadComplete,
  onWebAdd,
  onDingtalkImport,
  canManageDocuments = true,
  folderId = 0,
  folderOptions = [],
  onFolderChange,
  multimodalAnalysisEnabled: multimodalAnalysisEnabledProp = false,
  multimodalModelSupportsVideo = true,
  multimodalVideoPrompt,
  multimodalImagePrompt,
}: DocumentUploadProps) {
  const { t } = useTranslation('knowledge')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submissionLock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const batch = useBatchAttachment()
  const {
    state,
    addFiles,
    clearFiles,
    startUpload,
    retryFile,
    reset,
    applyDocumentCreationResults,
  } = batch
  const textUpload = useTextDocumentUpload()
  const [splitterConfig, setSplitterConfig] = useState<Partial<SplitterConfig>>(
    buildDefaultSplitterConfig
  )
  const multimodalFeatureEnabled = useMultimodalFeatureEnabled()
  const multimodalAnalysisEnabled = multimodalAnalysisEnabledProp && multimodalFeatureEnabled
  const [multimodalPrompts, setMultimodalPrompts] = useState<UploadMultimodalPrompts | null>(null)
  const [uploadMode, setUploadMode] = useState<UploadMode>('file')
  const [dingtalkVisited, setDingtalkVisited] = useState(false)
  const [dingtalkHasDraft, setDingtalkHasDraft] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<UploadMode | null>(null)
  const [textContent, setTextContent] = useState('')
  const [textFileName, setTextFileName] = useState('')
  const [textError, setTextError] = useState<string | null>(null)
  const [webUrl, setWebUrl] = useState('')
  const [webError, setWebError] = useState<string | null>(null)
  const [webTouched, setWebTouched] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const filesBusy =
    state.isUploading || state.files.some(f => f.status === 'pending' || f.status === 'uploading')
  const busy = filesBusy || submitting !== null
  const drafts: Record<UploadMode, boolean> = {
    file: state.files.length > 0,
    text: Boolean(textContent.trim() || textFileName.trim()),
    web: Boolean(webUrl.trim()),
    dingtalk: dingtalkHasDraft,
  }
  const sources = [
    { id: 'file' as const, label: t('document.upload.sources.file'), icon: Upload },
    ...(onWebAdd
      ? [{ id: 'web' as const, label: t('document.upload.sources.web'), icon: Globe }]
      : []),
    { id: 'text' as const, label: t('document.upload.sources.text'), icon: ClipboardPaste },
    ...(onDingtalkImport
      ? [{ id: 'dingtalk' as const, label: t('document.upload.dingtalk.entry'), icon: BookOpen }]
      : []),
  ]

  // Retain the existing eager binary upload, but never start another upload during a retry.
  const pendingCount = state.files.filter(f => f.status === 'pending').length
  useEffect(() => {
    if (pendingCount > 0 && !state.isUploading && !submitting && !submissionLock.current) {
      void startUpload()
    }
  }, [pendingCount, state.isUploading, submitting, startUpload])

  const handleFilesAdded = useCallback(
    (files: File[]) => {
      if (submissionLock.current || filesBusy || !canManageDocuments) return
      const unsupported = files.filter(f =>
        isKBUnsupportedExtension(f.name, multimodalAnalysisEnabled, multimodalModelSupportsVideo)
      )
      const supported = files.filter(
        f =>
          !isKBUnsupportedExtension(f.name, multimodalAnalysisEnabled, multimodalModelSupportsVideo)
      )
      setValidationError(null)
      setNotice(null)
      if (unsupported.length) {
        setValidationError(
          t(
            unsupported.some(f =>
              isVideoModelBlock(f.name, multimodalAnalysisEnabled, multimodalModelSupportsVideo)
            )
              ? 'document.upload.videoModelNotSupported'
              : 'document.upload.unsupportedFileType'
          )
        )
      }
      if (supported.length) {
        const result = addFiles(supported)
        if (result.rejected > 0 && result.reason) setValidationError(result.reason)
      }
    },
    [
      filesBusy,
      canManageDocuments,
      addFiles,
      t,
      multimodalAnalysisEnabled,
      multimodalModelSupportsVideo,
    ]
  )

  const close = () => {
    reset()
    textUpload.reset()
    setTextContent('')
    setTextFileName('')
    setWebUrl('')
    setDingtalkVisited(false)
    setDingtalkHasDraft(false)
    setShowDiscard(false)
    onOpenChange(false)
  }

  const requestClose = () => {
    if (busy || submissionLock.current) return
    if (Object.values(drafts).some(Boolean)) setShowDiscard(true)
    else close()
  }

  const sourceCompleted = (source: UploadMode, hasRemaining = false) => {
    if (!mounted.current) return
    const hasOtherDrafts = Object.entries(drafts).some(([key, value]) => key !== source && value)
    if (!hasOtherDrafts && !hasRemaining) close()
    else setNotice(t('document.upload.sourceAdded'))
  }

  const beginSubmit = (source: UploadMode) => {
    if (busy || submissionLock.current || !canManageDocuments) return false
    submissionLock.current = true
    setSubmitting(source)
    setNotice(null)
    return true
  }
  const endSubmit = () => {
    submissionLock.current = false
    if (mounted.current) setSubmitting(null)
  }

  const handleConfirm = async (fileIds?: string[]) => {
    const target = fileIds ? new Set(fileIds) : null
    const attachments = state.files
      .filter(
        f =>
          (!target || target.has(f.id)) &&
          f.attachment &&
          (f.status === 'success' || f.status === 'error')
      )
      .map(f => ({ attachment: f.attachment!, file: f.file }))
    if (!attachments.length || !beginSubmit('file')) return
    try {
      const results = await onUploadComplete(
        attachments,
        splitterConfig,
        multimodalPrompts ?? undefined
      )
      if (!mounted.current) return
      applyDocumentCreationResults(results)
      const created = new Set(
        results.filter(r => r.documentId !== undefined).map(r => r.attachmentId)
      )
      const remaining = state.files.some(f => !f.attachment || !created.has(f.attachment.id))
      if (created.size) sourceCompleted('file', remaining)
    } catch (error) {
      setValidationError(
        mapKnowledgeDocumentErrorMessage(error, t, 'document.document.createFailed')
      )
    } finally {
      endSubmit()
    }
  }

  const handleRetryFile = async (id: string) => {
    if (state.files.find(f => f.id === id)?.attachment) return handleConfirm([id])
    if (!beginSubmit('file')) return
    try {
      await retryFile(id)
    } finally {
      endSubmit()
    }
  }

  const handleTextSubmit = async () => {
    if (!textContent.trim() || !beginSubmit('text')) return
    setTextError(null)
    try {
      const attachment = await textUpload.upload(textContent, textFileName)
      if (!mounted.current) return
      const results = await onUploadComplete([attachment], buildDefaultSplitterConfig())
      const result = results.find(r => r.attachmentId === attachment.attachment.id)
      if (result?.documentId === undefined) {
        setTextError(result?.error || t('document.document.createFailed'))
        return
      }
      setTextContent('')
      setTextFileName('')
      textUpload.reset()
      sourceCompleted('text')
    } catch (error) {
      setTextError(mapKnowledgeDocumentErrorMessage(error, t, 'document.document.createFailed'))
    } finally {
      endSubmit()
    }
  }

  const isWebUrlValid = (() => {
    if (!/^https?:\/\//i.test(webUrl.trim())) return false
    try {
      return ['http:', 'https:'].includes(new URL(webUrl.trim()).protocol)
    } catch {
      return false
    }
  })()
  const webValidationError =
    webTouched && webUrl.trim() && !isWebUrlValid ? t('document.upload.web.invalidUrl') : null
  const handleWebSubmit = async () => {
    if (!onWebAdd || !isWebUrlValid || !beginSubmit('web')) return
    setWebError(null)
    try {
      await onWebAdd(webUrl.trim())
      setWebUrl('')
      sourceCompleted('web')
    } catch (error) {
      const message = mapKnowledgeDocumentErrorMessage(error, t, 'document.upload.web.addFailed')
      const entry = Object.entries(WEB_ERROR_KEYS).find(([code]) => message.includes(code))
      setWebError(entry ? t(entry[1]) : message)
    } finally {
      endSubmit()
    }
  }

  const handleDingtalkImport = async (ids: string[]) => {
    if (!onDingtalkImport || !beginSubmit('dingtalk'))
      throw new Error(t('document.upload.dingtalk.noPermission'))
    try {
      return await onDingtalkImport(ids)
    } finally {
      endSubmit()
    }
  }

  const selectSource = (value: string) => {
    if (busy || submissionLock.current) return
    const next = sources.find(s => s.id === value)
    if (!next) return
    setUploadMode(next.id)
    if (next.id === 'dingtalk') setDingtalkVisited(true)
  }

  const footer = (source: UploadMode, action: ReactNode, status?: ReactNode) =>
    source === uploadMode ? (
      <DocumentUploadFooter
        folderId={folderId}
        folderOptions={folderOptions}
        onFolderChange={onFolderChange}
        onCancel={requestClose}
        disabled={busy}
        dingtalk={source === 'dingtalk'}
        status={status}
      >
        {action}
      </DocumentUploadFooter>
    ) : null
  const errorMessage = (error: string | null) =>
    error && (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg bg-error/10 p-3 text-sm text-error"
      >
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>{error}</span>
      </div>
    )
  const confirmableCount = state.files.filter(
    f => f.attachment && (f.status === 'success' || f.status === 'error')
  ).length
  const actionButton = (
    onClick: () => Promise<void>,
    disabled: boolean,
    label: string,
    testId: string
  ) => (
    <Button
      variant="primary"
      className="min-h-11"
      onClick={() => void onClick()}
      disabled={busy || disabled || !canManageDocuments}
      data-testid={testId}
    >
      {submitting === uploadMode && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {submitting === uploadMode ? t('document.upload.adding') : label}
    </Button>
  )

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        className={cn(
          'top-[5dvh] flex max-h-[90dvh] w-[calc(100%-2rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl',
          SOURCE_HEIGHT[uploadMode]
        )}
        data-testid="document-upload-dialog"
        hideCloseButton
        preventEscapeClose={busy || showDiscard}
        preventOutsideClick={busy || showDiscard}
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between space-y-0 px-5 py-4 text-left">
          <DialogTitle>{t('document.document.upload')}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={requestClose}
            disabled={busy}
            aria-label={t('common:actions.close')}
            data-testid="document-upload-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <Tabs
          value={uploadMode}
          onValueChange={selectSource}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-5 mb-4 grid h-auto shrink-0 auto-cols-fr grid-flow-col gap-2 rounded-none bg-transparent p-0">
            {sources.map(source => (
              <TabsTrigger
                key={source.id}
                value={source.id}
                onClick={() => selectSource(source.id)}
                disabled={busy}
                data-testid={
                  source.id === 'dingtalk'
                    ? 'dingtalk-source-button'
                    : `document-source-${source.id}`
                }
                className="relative min-h-11 min-w-0 flex-1 flex-col gap-1 border border-border px-1 py-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none md:flex-row md:gap-2 md:text-sm"
              >
                <source.icon className="h-4 w-4 shrink-0" />
                <span className="max-w-full truncate" title={source.label}>
                  {source.label}
                </span>
                {drafts[source.id] && (
                  <span
                    className="absolute right-1.5 top-1.5 h-1 w-1 rounded-full bg-primary"
                    aria-label={t('document.upload.unsavedDraft')}
                  />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {notice && (
            <div
              role="status"
              data-testid="document-upload-notice"
              className="mx-5 mb-3 rounded-lg bg-primary/5 p-3 text-sm text-text-primary"
            >
              {notice}
            </div>
          )}
          <TabsContent
            value="file"
            forceMount
            className="mt-0 flex min-h-0 flex-1 flex-col border-t border-border"
            hidden={uploadMode !== 'file'}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div
                className={cn(
                  'rounded-lg border-2 border-dashed p-6 text-center',
                  isDragOver ? 'border-primary bg-primary/5' : 'border-border',
                  busy && 'pointer-events-none opacity-50'
                )}
                data-testid="document-upload-dropzone"
                onDragOver={e => {
                  e.preventDefault()
                  if (!busy) setIsDragOver(true)
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={e => {
                  e.preventDefault()
                  setIsDragOver(false)
                  handleFilesAdded(Array.from(e.dataTransfer.files))
                }}
              >
                <Upload className="mx-auto mb-3 h-7 w-7 text-primary" />
                <p className="mb-4 text-sm font-medium">{t('document.document.dropzone')}</p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy || !canManageDocuments}
                  data-testid="document-upload-browse"
                >
                  {t('document.upload.uploadFile')}
                </Button>
                <p className="mt-4 text-xs text-text-muted">
                  {t('document.upload.dropzoneHint', { max: MAX_BATCH_FILES })}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {t('document.document.supportedTypes', {
                    maxSize: Math.round(MAX_FILE_SIZE / (1024 * 1024)),
                  })}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  disabled={busy || !canManageDocuments}
                  data-testid="document-upload-file-input"
                  accept={
                    multimodalAnalysisEnabled
                      ? `${KB_DOCUMENT_ACCEPT},${MULTIMODAL_EXTENSIONS.join(',')}`
                      : KB_DOCUMENT_ACCEPT
                  }
                  onChange={e => {
                    handleFilesAdded(Array.from(e.target.files || []))
                    e.target.value = ''
                  }}
                />
              </div>
              {validationError && <div className="mt-3">{errorMessage(validationError)}</div>}
              {state.files.length > 0 && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t('document.upload.fileList', { count: state.files.length })}
                    </span>
                    <Button
                      variant="ghost"
                      className="min-h-11 text-text-muted"
                      onClick={clearFiles}
                      disabled={busy}
                      data-testid="document-upload-clear"
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      {t('document.upload.clearAll')}
                    </Button>
                  </div>
                  <UploadFileList
                    batch={batch}
                    isConfirming={submitting !== null}
                    onRetry={handleRetryFile}
                  />
                  {!filesBusy && (
                    <p className="rounded-lg bg-surface p-3 text-sm">
                      {t('document.upload.summary', {
                        total: state.files.length,
                        success: state.files.filter(f => f.status === 'success').length,
                        failed: state.files.filter(f => f.status === 'error').length,
                      })}
                    </p>
                  )}
                  {confirmableCount > 0 && !filesBusy && (
                    <Accordion type="single" collapsible>
                      <AccordionItem value="advanced" className="border-none">
                        <AccordionTrigger
                          className="min-h-11 text-sm"
                          data-testid="document-upload-advanced"
                        >
                          {t('document.advancedSettings.title')}
                        </AccordionTrigger>
                        <AccordionContent>
                          <fieldset disabled={submitting !== null} className="space-y-4">
                            <SplitterSettingsSection
                              config={splitterConfig}
                              onChange={setSplitterConfig}
                            />
                            <UploadMultimodalPromptSettings
                              files={state.files}
                              multimodalAnalysisEnabled={multimodalAnalysisEnabled}
                              kbVideoPrompt={multimodalVideoPrompt}
                              kbImagePrompt={multimodalImagePrompt}
                              onChange={setMultimodalPrompts}
                            />
                          </fieldset>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}
                </div>
              )}
            </div>
            {footer(
              'file',
              actionButton(
                () => handleConfirm(),
                !confirmableCount,
                t('document.upload.confirmUpload', { count: confirmableCount }),
                'document-upload-submit'
              )
            )}
          </TabsContent>
          <TabsContent
            value="text"
            className="mt-0 flex min-h-0 flex-1 flex-col border-t border-border"
          >
            <fieldset
              disabled={busy}
              className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-5"
            >
              <div className="space-y-2">
                <Label htmlFor="text-filename">{t('document.upload.textTitle')}</Label>
                <Input
                  id="text-filename"
                  data-testid="document-text-title"
                  className="h-11"
                  placeholder={t('document.upload.fileNamePlaceholder')}
                  value={textFileName}
                  onChange={e => {
                    setTextFileName(e.target.value)
                    setTextError(null)
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="text-content">{t('document.upload.textContent')}</Label>
                <Textarea
                  id="text-content"
                  data-testid="document-text-content"
                  className="min-h-44"
                  placeholder={t('document.upload.textPlaceholder')}
                  value={textContent}
                  onChange={e => {
                    setTextContent(e.target.value)
                    setTextError(null)
                  }}
                />
              </div>
              {errorMessage(textError)}
            </fieldset>
            {footer(
              'text',
              actionButton(
                handleTextSubmit,
                !textContent.trim(),
                t('document.upload.addText'),
                'document-text-submit'
              )
            )}
          </TabsContent>
          {onWebAdd && (
            <TabsContent
              value="web"
              className="mt-0 flex min-h-0 flex-1 flex-col border-t border-border"
            >
              <fieldset
                disabled={busy}
                className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-5"
              >
                <div className="space-y-2">
                  <Label htmlFor="web-url">{t('document.upload.web.urlLabel')}</Label>
                  <Input
                    id="web-url"
                    type="url"
                    data-testid="document-web-url"
                    className={cn(
                      'h-11',
                      webValidationError && 'border-error focus-visible:ring-error'
                    )}
                    aria-invalid={Boolean(webValidationError)}
                    aria-describedby={webValidationError ? 'web-url-error' : undefined}
                    onBlur={() => setWebTouched(true)}
                    placeholder={t('document.upload.web.urlPlaceholder')}
                    value={webUrl}
                    onChange={e => {
                      setWebUrl(e.target.value)
                      setWebError(null)
                    }}
                  />
                  {webValidationError && (
                    <p id="web-url-error" role="alert" className="text-sm text-error">
                      {webValidationError}
                    </p>
                  )}
                </div>
                <p className="text-xs text-text-muted">{t('document.upload.web.hint')}</p>
                {errorMessage(webError)}
              </fieldset>
              {footer(
                'web',
                actionButton(
                  handleWebSubmit,
                  !isWebUrlValid,
                  t('document.upload.web.submitButton'),
                  'document-web-submit'
                )
              )}
            </TabsContent>
          )}
          {onDingtalkImport && dingtalkVisited && (
            <TabsContent
              value="dingtalk"
              forceMount
              hidden={uploadMode !== 'dingtalk'}
              className="mt-0 flex min-h-0 flex-1 flex-col border-t border-border"
            >
              <DingtalkDocumentImport
                knowledgeBaseId={knowledgeBaseId}
                onImport={handleDingtalkImport}
                onDone={() => sourceCompleted('dingtalk')}
                onDraftChange={setDingtalkHasDraft}
                renderFooter={(action, status) => footer('dingtalk', action, status)}
                canManageDocuments={canManageDocuments}
              />
            </TabsContent>
          )}
        </Tabs>
        <AlertDialog open={showDiscard} onOpenChange={setShowDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('document.upload.discardTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('document.upload.discardDescription')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11" data-testid="document-upload-keep">
                {t('document.upload.keepEditing')}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="primary"
                className="min-h-11"
                onClick={close}
                data-testid="document-upload-discard"
              >
                {t('document.upload.discard')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
