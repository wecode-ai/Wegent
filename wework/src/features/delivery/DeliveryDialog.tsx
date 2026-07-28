import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FileText, Folder, GitBranch, MessageSquare, Plus, X } from 'lucide-react'
import type { WorkbenchMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@/types/api'
import type { LocalWorkItem } from '@/features/todo/todoModel'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { readSelectedDeliveryFiles, type SelectedDeliveryFile } from '@/tauri/droppedFiles'

interface DeliveryDialogProps {
  item: Omit<LocalWorkItem, 'projectId'>
  runtimeTask: RuntimeTaskAddress
  runtimeTaskTitle?: string | null
  messages: WorkbenchMessage[]
  deliveryApi: NonNullable<WorkbenchServices['deliveryApi']>
  onCancel: () => void
  onDelivered: () => void
}

type ChatScope = 'conversation' | 'selected' | 'none'

function messagePreview(message: WorkbenchMessage): string {
  const value = 'content' in message ? message.content : ''
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120)
  return message.role === 'user' ? 'User message' : 'Assistant message'
}

export function DeliveryDialog({
  item,
  runtimeTask,
  runtimeTaskTitle,
  messages,
  deliveryApi,
  onCancel,
  onDelivered,
}: DeliveryDialogProps) {
  const { t } = useTranslation('common')
  const [markdown, setMarkdown] = useState('')
  const [chatScope, setChatScope] = useState<ChatScope>('conversation')
  const [selectedMessages, setSelectedMessages] = useState<number[]>([])
  const [files, setFiles] = useState<SelectedDeliveryFile[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const selectedCount = chatScope === 'conversation' ? messages.length : selectedMessages.length
  const chatMessages = useMemo(
    () =>
      chatScope === 'conversation'
        ? messages
        : messages.filter((_, index) => selectedMessages.includes(index)),
    [chatScope, messages, selectedMessages]
  )

  async function choosePaths(directory: boolean) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory, multiple: !directory })
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
    if (paths.length === 0) return
    const nextFiles = await readSelectedDeliveryFiles(paths)
    setFiles(current => {
      const byPath = new Map(current.map(entry => [entry.relativePath, entry]))
      nextFiles.forEach(entry => byPath.set(entry.relativePath, entry))
      return [...byPath.values()]
    })
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    let draftId: string | null = null
    try {
      await (runtimeTaskTitle
        ? deliveryApi.bindTask(item.id, runtimeTask, runtimeTaskTitle)
        : deliveryApi.bindTask(item.id, runtimeTask))
      const delivery = await deliveryApi.createDelivery(item.id, {
        markdown,
        ...(chatScope === 'none' ? {} : { chat: { scope: chatScope, messages: chatMessages } }),
        source_task: runtimeTask,
      })
      draftId = delivery.id
      setUploadProgress({ done: 0, total: files.length })
      for (const [index, entry] of files.entries()) {
        await deliveryApi.addAsset(delivery.id, entry.file, entry.relativePath)
        setUploadProgress({ done: index + 1, total: files.length })
      }
      await deliveryApi.finalizeDelivery(delivery.id)
      setCompleted(true)
    } catch (submitError) {
      if (draftId) {
        try {
          await deliveryApi.discardDraft(draftId)
        } catch {
          // Preserve the original delivery error. Stale drafts can be cleaned up server-side.
        }
      }
      setError(
        submitError instanceof Error
          ? submitError.message
          : t('delivery.failed', '交付失败，请重试')
      )
    } finally {
      setSubmitting(false)
      setUploadProgress(null)
    }
  }

  if (completed) {
    return createPortal(
      <div className="fixed inset-0 z-system flex items-center justify-center bg-black/30">
        <div
          data-testid="delivery-complete-dialog"
          className="w-[360px] rounded-xl border border-border bg-background p-6 text-center shadow-lg"
        >
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 text-green-600">
            <Check className="h-5 w-5" />
          </span>
          <h2 className="heading-sm mt-4">{t('delivery.completed', '交付完成')}</h2>
          <p className="mt-2 text-sm text-text-secondary">
            {t('delivery.completed_hint', '当前任务与 TODO 已完成，交付快照不会再被修改。')}
          </p>
          <button
            type="button"
            data-testid="delivery-complete-confirm"
            onClick={onDelivered}
            className="mt-5 h-8 rounded-md bg-text-primary px-4 text-sm font-medium text-background"
          >
            {t('delivery.back_to_todo', '返回 TODO')}
          </button>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-system flex items-center justify-center bg-black/30 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-dialog-title"
        data-testid="delivery-dialog"
        className="flex h-[min(720px,calc(100vh-48px))] w-[min(880px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-lg"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
          <GitBranch className="h-4 w-4 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <h2 id="delivery-dialog-title" className="truncate text-base font-medium">
              {t('delivery.title', '交付')}
            </h2>
            <p className="truncate text-xs text-text-muted">{item.title}</p>
          </div>
          <button
            type="button"
            data-testid="delivery-dialog-close"
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-hover"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <textarea
            data-testid="delivery-markdown"
            value={markdown}
            onChange={event => setMarkdown(event.target.value)}
            placeholder={t('delivery.markdown_placeholder', '写下交付说明、关键结论和后续建议…')}
            className="min-h-0 flex-1 resize-none bg-transparent text-base leading-6 text-text-primary outline-none placeholder:text-text-muted"
          />

          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <MessageSquare className="h-4 w-4 text-text-muted" />
              {(['conversation', 'selected', 'none'] as const).map(scope => (
                <button
                  key={scope}
                  type="button"
                  data-testid={`delivery-chat-${scope}`}
                  onClick={() => setChatScope(scope)}
                  className={`h-7 rounded-md px-2 text-xs ${
                    chatScope === scope
                      ? 'bg-muted font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-hover'
                  }`}
                >
                  {scope === 'conversation'
                    ? t('delivery.entire_chat', '整个会话')
                    : scope === 'selected'
                      ? t('delivery.selected_chat', '选择消息')
                      : t('delivery.no_chat', '不含聊天')}
                </button>
              ))}
              {chatScope !== 'none' && (
                <span className="text-xs text-text-muted">
                  {t('delivery.message_count', '{{count}} 条消息', { count: selectedCount })}
                </span>
              )}
              <span className="mx-1 h-4 w-px bg-border" />
              <button
                type="button"
                data-testid="delivery-select-files"
                onClick={() => void choosePaths(false)}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover"
              >
                <FileText className="h-3.5 w-3.5" />
                {t('delivery.select_files', '文件')}
              </button>
              <button
                type="button"
                data-testid="delivery-select-folder"
                onClick={() => void choosePaths(true)}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover"
              >
                <Folder className="h-3.5 w-3.5" />
                {t('delivery.select_folder', '文件夹')}
              </button>
              {files.length > 0 && (
                <span className="text-xs text-text-muted">
                  {t('delivery.file_count', '{{count}} 个文件', { count: files.length })}
                </span>
              )}
            </div>

            {chatScope === 'selected' && (
              <div
                data-testid="delivery-message-picker"
                className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-border p-1"
              >
                {messages.map((message, index) => (
                  <label
                    key={`${message.id ?? index}`}
                    className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 text-xs hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMessages.includes(index)}
                      onChange={() =>
                        setSelectedMessages(current =>
                          current.includes(index)
                            ? current.filter(value => value !== index)
                            : [...current, index]
                        )
                      }
                    />
                    <span className="w-14 shrink-0 text-text-muted">{message.role}</span>
                    <span className="truncate text-text-secondary">{messagePreview(message)}</span>
                  </label>
                ))}
              </div>
            )}

            {files.length > 0 && (
              <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
                {files.map(entry => (
                  <span
                    key={entry.relativePath}
                    className="flex h-7 max-w-56 items-center gap-1 rounded-md bg-muted px-2 text-xs text-text-secondary"
                  >
                    <span className="truncate">{entry.relativePath}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setFiles(current =>
                          current.filter(file => file.relativePath !== entry.relativePath)
                        )
                      }
                      aria-label={t('delivery.remove_file', '移除文件')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="flex h-14 shrink-0 items-center border-t border-border px-5">
          {error && <p className="min-w-0 flex-1 truncate text-xs text-red-600">{error}</p>}
          {!error && (
            <p className="min-w-0 flex-1 text-xs text-text-muted">
              {t('delivery.immutable_hint', '确认后将完成当前任务与 TODO，并生成不可变快照。')}
            </p>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-hover"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="delivery-confirm"
            disabled={submitting || (chatScope === 'selected' && selectedMessages.length === 0)}
            onClick={() => void submit()}
            className="ml-2 flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
          >
            {submitting ? (
              uploadProgress && uploadProgress.total > 0 ? (
                `正在上传 ${uploadProgress.done}/${uploadProgress.total}…`
              ) : (
                t('delivery.uploading', '正在交付…')
              )
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                {t('delivery.confirm', '确认交付')}
              </>
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
