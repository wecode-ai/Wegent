import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  WeworkConversationReference,
  WeworkConversationSnapshot,
  WeworkExtensionHost,
} from '../../app-wework/client'
import { splitContentChunks } from './contentChunks'
import {
  conversationExportFilename,
  formatConversation,
  type ConversationExportFormat,
} from './formatConversation'
import {
  countConversationExportContent,
  defaultConversationExportSelection,
  prepareConversationExport,
  type ConversationExportAsset,
  type ConversationExportSelection,
} from './prepareConversationExport'

const OPEN_EVENT = 'wework:conversation-export:open'
const BACKEND_ID = 'conversation-export'
const BASE64_CHUNK_SIZE = 192 * 1024
const ASSET_BYTE_CHUNK_SIZE = 128 * 1024
const STATUS_POLL_INTERVAL_MS = 100
const REMOTE_ASSET_TIMEOUT_MS = 30_000
const REMOTE_ASSET_MAX_BYTES = 100 * 1024 * 1024
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ExportTaskStatus {
  readonly exportTaskId: string
  readonly state: 'writing' | 'finalizing' | 'completed' | 'failed' | 'cancelled'
  readonly phase?: string
  readonly path?: string
  readonly size?: number
  readonly error?: string
}

interface ExportBackend {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

declare global {
  interface Window {
    __WEWORK_DSH_EXTENSIONS__?: WeworkExtensionHost
  }
}

export default function ConversationExportDialog() {
  const [reference, setReference] = useState<WeworkConversationReference | null>(null)
  const [format, setFormat] = useState<ConversationExportFormat>('markdown')
  const [selection, setSelection] = useState<ConversationExportSelection>(() =>
    defaultConversationExportSelection('markdown')
  )
  const [snapshot, setSnapshot] = useState<WeworkConversationSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [completedPath, setCompletedPath] = useState('')
  const dialogRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<WeworkConversationReference>).detail
      setReference(detail)
      setFormat('markdown')
      setSelection(defaultConversationExportSelection('markdown'))
      setSnapshot(null)
      setLoading(true)
      setProgress(translate('正在读取会话…', 'Reading conversation…'))
      setError('')
      setCompletedPath('')
    }
    window.addEventListener(OPEN_EVENT, open)
    return () => window.removeEventListener(OPEN_EVENT, open)
  }, [])

  useEffect(() => {
    if (!reference) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [reference])

  useEffect(() => {
    if (!reference || submitting) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setReference(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [reference, submitting])

  useEffect(() => {
    if (!reference) return
    let active = true
    const loadTranscript = async () => {
      const host = window.__WEWORK_DSH_EXTENSIONS__
      if (!host) {
        await Promise.resolve()
        if (!active) return
        setLoading(false)
        setProgress('')
        setError('Wework extension host is unavailable')
        return
      }
      try {
        const transcript = await host.conversations.getTranscript(reference)
        if (!active) return
        setSnapshot(transcript)
        setLoading(false)
        setProgress('')
      } catch (reason) {
        if (!active) return
        setLoading(false)
        setProgress('')
        setError(
          reason instanceof Error
            ? reason.message
            : translate('读取会话失败', 'Unable to read conversation')
        )
      }
    }
    void loadTranscript()
    return () => {
      active = false
    }
  }, [reference])

  const counts = useMemo(
    () => (snapshot ? countConversationExportContent(snapshot) : null),
    [snapshot]
  )
  const hasSelectedContent =
    counts !== null &&
    (Object.keys(selection) as Array<keyof ConversationExportSelection>).some(
      key => selection[key] && counts[key] > 0
    )

  if (!reference) return null

  const close = () => {
    if (!submitting) setReference(null)
  }
  const submit = async () => {
    const host = window.__WEWORK_DSH_EXTENSIONS__
    if (!host) {
      setError('Wework extension host is unavailable')
      return
    }
    if (!snapshot || !hasSelectedContent) {
      setError(translate('请至少选择一项有内容的导出项', 'Select at least one available item'))
      return
    }

    setSubmitting(true)
    setProgress(translate('正在准备导出内容…', 'Preparing export…'))
    setError('')
    let exportTaskId = ''
    try {
      const backend = host.backend.scope(BACKEND_ID)
      await yieldToRenderer()
      const prepared = await prepareConversationExport(snapshot, format, selection, backend)
      const content = formatConversation(prepared.snapshot, format)
      const archive = prepared.assets.length > 0
      const documentName = conversationExportFilename(snapshot.title, format)
      setProgress(translate('请选择保存位置…', 'Choose where to save…'))
      await yieldToRenderer()
      const result = await host.dialog.save({
        title: translate('导出会话', 'Export conversation'),
        buttonLabel: translate('导出', 'Export'),
        defaultPath: conversationExportArtifactFilename(snapshot.title, format, archive),
        filters: [
          {
            name: archive ? 'ZIP' : format === 'html' ? 'HTML' : 'Markdown',
            extensions: [archive ? 'zip' : format === 'html' ? 'html' : 'md'],
          },
        ],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      const selected = selectedPath(result)
      if (!selected) {
        setProgress('')
        return
      }

      const path = ensureArtifactExtension(selected, format, archive)
      setProgress(translate('正在写入会话…', 'Writing conversation…'))
      await yieldToRenderer()
      const started = await backend.request<{ exportTaskId: string }>('start', {
        path,
        archive,
        documentName,
        assetCount: prepared.assets.length,
      })
      exportTaskId = started.exportTaskId
      for (const chunk of splitContentChunks(content)) {
        await backend.request('append', {
          exportTaskId,
          content: chunk,
        })
      }
      await writeAssets(backend, exportTaskId, prepared.assets, setProgress)
      await backend.request('finish', { exportTaskId })
      const finished = await waitForExport(backend, exportTaskId, setProgress)
      const expectedSize = new TextEncoder().encode(content).byteLength
      if (
        finished.path !== path ||
        finished.size <= 0 ||
        (!archive && finished.size !== expectedSize)
      ) {
        throw new Error(translate('导出文件校验失败', 'Exported file verification failed'))
      }
      exportTaskId = ''
      setCompletedPath(finished.path)
      setProgress(translate('导出完成', 'Export complete'))
    } catch (reason) {
      if (exportTaskId) {
        await window.__WEWORK_DSH_EXTENSIONS__?.backend
          .scope(BACKEND_ID)
          .request('cancel', { exportTaskId })
          .catch(() => {})
      }
      setError(reason instanceof Error ? reason.message : translate('导出失败', 'Export failed'))
      setProgress('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="pointer-events-auto fixed inset-0 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      data-testid="conversation-export-dialog"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby="conversation-export-title"
        aria-modal="true"
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 text-text-primary shadow-xl"
        role="dialog"
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
          )
          if (focusable.length === 0) return
          const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusable.length - 1
              : currentIndex - 1
            : currentIndex === focusable.length - 1
              ? 0
              : currentIndex + 1
          event.preventDefault()
          focusable[nextIndex]?.focus()
        }}
      >
        <h2 id="conversation-export-title" className="text-heading-md font-semibold">
          {translate('导出会话', 'Export conversation')}
        </h2>
        <fieldset className="mt-5 space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {translate('文件格式', 'File format')}
          </legend>
          {(
            [
              ['markdown', 'Markdown (.md)'],
              ['html', 'HTML (.html)'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 hover:bg-muted"
            >
              <input
                checked={format === value}
                data-testid={`conversation-export-format-${value}`}
                disabled={submitting || Boolean(completedPath)}
                name="conversation-export-format"
                type="radio"
                value={value}
                onChange={() => {
                  setFormat(value)
                  setSelection(current => ({
                    ...current,
                    images: defaultConversationExportSelection(value).images,
                  }))
                }}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium">
            {translate('导出内容', 'Export content')}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['body', translate('正文', 'Messages')],
                ['tools', translate('工具与编辑', 'Tools and edits')],
                ['thinking', translate('思考过程', 'Thought process')],
                ['images', translate('图片', 'Images')],
                ['attachments', translate('其他附件', 'Other attachments')],
              ] as const
            ).map(([key, label]) => {
              const count = counts?.[key] ?? 0
              const unavailable = !loading && counts !== null && count === 0
              return (
                <label
                  key={key}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-45"
                >
                  <input
                    checked={selection[key]}
                    data-testid={`conversation-export-content-${key}`}
                    disabled={loading || submitting || Boolean(completedPath) || unavailable}
                    type="checkbox"
                    onChange={event =>
                      setSelection(current => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  <span className="min-w-0 flex-1">{label}</span>
                  <span className="text-xs text-text-muted">{counts ? count : '—'}</span>
                </label>
              )
            })}
          </div>
          {format === 'markdown' && selection.images && (counts?.images ?? 0) > 0 ? (
            <p className="mt-2 text-xs text-text-muted">
              {translate(
                'Markdown 图片将与文档一起打包为 ZIP。',
                'Markdown images will be packaged with the document as a ZIP file.'
              )}
            </p>
          ) : null}
        </fieldset>
        {error ? (
          <p className="mt-3 text-sm text-destructive" data-testid="conversation-export-error">
            {error}
          </p>
        ) : null}
        {progress ? (
          <p
            aria-live="polite"
            className="mt-3 text-sm text-text-secondary"
            data-testid="conversation-export-progress"
          >
            {progress}
          </p>
        ) : null}
        {completedPath ? (
          <p
            className="mt-1 break-all text-sm text-text-muted"
            data-testid="conversation-export-completed-path"
          >
            {completedPath}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted"
            data-testid="conversation-export-cancel"
            disabled={submitting}
            type="button"
            onClick={close}
          >
            {translate('取消', 'Cancel')}
          </button>
          <button
            className="h-8 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50"
            data-testid="conversation-export-confirm"
            disabled={loading || submitting || !hasSelectedContent}
            type="button"
            onClick={() => {
              if (completedPath) {
                setReference(null)
                return
              }
              void submit()
            }}
          >
            {completedPath
              ? translate('完成', 'Done')
              : submitting
                ? translate('正在导出…', 'Exporting…')
                : translate('导出', 'Export')}
          </button>
        </div>
      </section>
    </div>
  )
}

async function waitForExport(
  backend: ExportBackend,
  exportTaskId: string,
  setProgress: (message: string) => void
): Promise<Required<Pick<ExportTaskStatus, 'path' | 'size'>>> {
  for (;;) {
    const status = await backend.request<ExportTaskStatus>('status', { exportTaskId })
    if (status.state === 'completed' && status.path && typeof status.size === 'number') {
      return { path: status.path, size: status.size }
    }
    if (status.state === 'failed') {
      throw new Error(status.error || translate('导出失败', 'Export failed'))
    }
    if (status.state === 'cancelled') {
      throw new Error(translate('导出已取消', 'Export cancelled'))
    }
    setProgress(
      status.phase === 'packaging'
        ? translate('正在打包文件…', 'Packaging files…')
        : translate('正在完成写入…', 'Finalizing file…')
    )
    await new Promise(resolve => window.setTimeout(resolve, STATUS_POLL_INTERVAL_MS))
  }
}

async function writeAssets(
  backend: ExportBackend,
  exportTaskId: string,
  assets: readonly ConversationExportAsset[],
  setProgress: (message: string) => void
): Promise<void> {
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]
    setProgress(
      translate(
        `正在处理附件 ${index + 1}/${assets.length}…`,
        `Processing attachment ${index + 1}/${assets.length}…`
      )
    )
    if (asset.kind === 'local') {
      await backend.request('addAsset', {
        exportTaskId,
        archivePath: asset.archivePath,
        path: asset.path,
        workspacePath: asset.workspacePath,
      })
      continue
    }
    if (asset.kind === 'base64') {
      await appendBase64Asset(backend, exportTaskId, asset.archivePath, asset.contentBase64)
      continue
    }
    await appendRemoteAsset(backend, exportTaskId, asset.archivePath, asset.url, asset.label)
  }
}

async function appendBase64Asset(
  backend: ExportBackend,
  exportTaskId: string,
  archivePath: string,
  contentBase64: string
): Promise<void> {
  const chunks =
    contentBase64.length > 0
      ? Array.from(
          { length: Math.ceil(contentBase64.length / BASE64_CHUNK_SIZE) },
          (_, chunkIndex) =>
            contentBase64.slice(
              chunkIndex * BASE64_CHUNK_SIZE,
              (chunkIndex + 1) * BASE64_CHUNK_SIZE
            )
        )
      : ['']
  for (const chunk of chunks) {
    await backend.request('appendAsset', { exportTaskId, archivePath, contentBase64: chunk })
  }
}

async function appendRemoteAsset(
  backend: ExportBackend,
  exportTaskId: string,
  archivePath: string,
  url: string,
  label: string
): Promise<void> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REMOTE_ASSET_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Unable to read ${label}: HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > REMOTE_ASSET_MAX_BYTES) {
    throw new Error(`Unable to read ${label}: the attachment exceeds 100 MB`)
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > REMOTE_ASSET_MAX_BYTES) {
      throw new Error(`Unable to read ${label}: the attachment exceeds 100 MB`)
    }
    await appendAssetBytes(backend, exportTaskId, archivePath, bytes)
    return
  }
  const reader = response.body.getReader()
  let wroteChunk = false
  let bytesRead = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    bytesRead += value.byteLength
    if (bytesRead > REMOTE_ASSET_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`Unable to read ${label}: the attachment exceeds 100 MB`)
    }
    wroteChunk = true
    await appendAssetBytes(backend, exportTaskId, archivePath, value)
  }
  if (!wroteChunk) await appendBase64Asset(backend, exportTaskId, archivePath, '')
}

async function appendAssetBytes(
  backend: ExportBackend,
  exportTaskId: string,
  archivePath: string,
  bytes: Uint8Array
): Promise<void> {
  if (bytes.byteLength === 0) {
    await appendBase64Asset(backend, exportTaskId, archivePath, '')
    return
  }
  for (let offset = 0; offset < bytes.byteLength; offset += ASSET_BYTE_CHUNK_SIZE) {
    await backend.request('appendAsset', {
      exportTaskId,
      archivePath,
      contentBase64: encodeBase64(bytes.subarray(offset, offset + ASSET_BYTE_CHUNK_SIZE)),
    })
  }
}

function yieldToRenderer(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0))
}

function selectedPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const value = result as { canceled?: unknown; filePath?: unknown }
  return value.canceled !== true && typeof value.filePath === 'string' && value.filePath
    ? value.filePath
    : null
}

function ensureArtifactExtension(
  path: string,
  format: ConversationExportFormat,
  archive: boolean
): string {
  const extension = archive ? '.zip' : format === 'html' ? '.html' : '.md'
  if (path.toLowerCase().endsWith(extension)) return path
  return `${path}${extension}`
}

function conversationExportArtifactFilename(
  title: string,
  format: ConversationExportFormat,
  archive: boolean
): string {
  const documentName = conversationExportFilename(title, format)
  return archive ? `${documentName.replace(/\.(?:md|html)$/i, '')}.zip` : documentName
}

function translate(chinese: string, english: string): string {
  const locale = document.documentElement.lang || navigator.language
  return locale.toLowerCase().startsWith('zh') ? chinese : english
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024)))
  }
  return btoa(chunks.join(''))
}
