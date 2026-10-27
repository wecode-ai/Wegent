import { useState } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type {
  SharedIssueDetailDeliveryDetail,
  SharedIssueDetailPort,
} from './createSharedIssueDetailPort'
import { deliveryMessages } from './deliveryMessages'

type DeliveryPort = SharedIssueDetailPort['deliveries']

export function IssueDeliveryEditor({
  delivery,
  issueTitle,
  api,
  translate: t,
  onCancel,
  onSaved,
}: {
  delivery: SharedIssueDetailDeliveryDetail
  issueTitle: string
  api: DeliveryPort
  translate: CollaborationTranslate
  onCancel(): void
  onSaved(delivery: SharedIssueDetailDeliveryDetail): void
}) {
  const [title, setTitle] = useState(delivery.title || issueTitle)
  const [markdown, setMarkdown] = useState(delivery.markdown)
  const [messages, setMessages] = useState<unknown[]>(() =>
    Array.isArray(delivery.chat?.messages) ? delivery.chat.messages : [],
  )
  const [selected, setSelected] = useState(() =>
    messages.map((_, index) => index),
  )
  const [retained, setRetained] = useState(() =>
    delivery.assets.map((asset) => asset.id),
  )
  const [files, setFiles] = useState<
    Array<{ relative_path: string; file: File }>
  >([])
  const [busy, setBusy] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sourceError, setSourceError] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    if (busy) return
    setBusy(true)
    try {
      onSaved(await api.get(delivery.id))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('delivery.save_failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  async function loadMessages() {
    if (!api.loadSourceMessages || loadingMessages) return
    setLoadingMessages(true)
    setSourceError(false)
    try {
      const source = await api.loadSourceMessages(delivery)
      const identity = (message: unknown): string | null => {
        if (!message || typeof message !== 'object' || !('id' in message))
          return null
        return typeof message.id === 'string' || typeof message.id === 'number'
          ? String(message.id)
          : null
      }
      const existing = new Map(
        messages.flatMap((message) => {
          const id = identity(message)
          return id ? [[id, message] as const] : []
        }),
      )
      const included = new Set(
        messages.filter((_, index) => selected.includes(index)),
      )
      const seen = new Set(source.flatMap((message) => identity(message) ?? []))
      const next = [
        ...source
          .filter(
            (message) => deliveryMessages({ messages: [message] }).length > 0,
          )
          .map((message) => existing.get(identity(message) ?? '') ?? message),
        ...messages.filter((message) => !seen.has(identity(message) ?? '')),
      ]
      setMessages(next)
      setSelected(
        next.flatMap((message, index) =>
          included.has(message) ? [index] : [],
        ),
      )
    } catch {
      setSourceError(true)
    } finally {
      setLoadingMessages(false)
    }
  }

  async function save() {
    if (busy || !title.trim() || !api.update) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api.update(delivery.id, {
        title: title.trim(),
        version: delivery.version ?? 1,
        markdown,
        chat: selected.length
          ? {
              scope: 'selected',
              messages: messages.filter((_, index) => selected.includes(index)),
            }
          : null,
        retained_asset_ids: retained,
        files,
      })
      onSaved(updated)
    } catch (cause) {
      const conflict =
        cause &&
        typeof cause === 'object' &&
        (('status' in cause && cause.status === 409) ||
          ('code' in cause && cause.code === 'version_conflict'))
      setError(
        conflict
          ? t('delivery.conflict')
          : cause instanceof Error
            ? cause.message
            : t('delivery.save_failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      data-testid="delivery-edit-form"
      aria-busy={busy}
      className="mt-4 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!busy) onCancel()
        }
      }}
    >
      <fieldset
        disabled={busy || loadingMessages}
        className="flex min-w-0 flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          {t('delivery.title_label')}
          <input
            data-testid="delivery-edit-title"
            value={title}
            maxLength={255}
            required
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('delivery.notes_label')}
          <textarea
            data-testid="delivery-edit-notes"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            className="min-h-40 rounded-md border border-border bg-background p-2"
          />
        </label>
        <section className="flex flex-col gap-2 text-sm">
          <span>{t('delivery.files_label')}</span>
          {delivery.assets.map((asset) => (
            <div key={asset.id} className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`delivery-edit-asset-${asset.id}`}
                  checked={retained.includes(asset.id)}
                  disabled={files.some(
                    (file) => file.relative_path === asset.relative_path,
                  )}
                  onChange={() =>
                    setRetained((current) =>
                      current.includes(asset.id)
                        ? current.filter((id) => id !== asset.id)
                        : [...current, asset.id],
                    )
                  }
                />
                <span className="truncate">{asset.relative_path}</span>
              </label>
              <label className="cursor-pointer text-text-secondary">
                {t('delivery.replace_file')}
                <input
                  type="file"
                  data-testid={`delivery-edit-replace-${asset.id}`}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    setFiles((current) => [
                      ...current.filter(
                        (entry) => entry.relative_path !== asset.relative_path,
                      ),
                      { relative_path: asset.relative_path, file },
                    ])
                    setRetained((current) =>
                      current.filter((id) => id !== asset.id),
                    )
                    event.target.value = ''
                  }}
                />
              </label>
            </div>
          ))}
          {files.map((entry) => (
            <div key={entry.relative_path} className="flex items-center gap-2">
              <span>{entry.relative_path}</span>
              <button
                type="button"
                data-testid={`delivery-edit-remove-file-${entry.relative_path}`}
                onClick={() =>
                  setFiles((current) =>
                    current.filter((file) => file !== entry),
                  )
                }
              >
                {t('delivery.remove_file')}
              </button>
            </div>
          ))}
          <input
            type="file"
            multiple
            data-testid="delivery-edit-files"
            aria-label={t('delivery.select_files')}
            onChange={(event) => {
              const next = Array.from(event.target.files ?? []).map((file) => ({
                relative_path: file.name,
                file,
              }))
              setFiles((current) => [
                ...current.filter(
                  (entry) =>
                    !next.some(
                      (file) => file.relative_path === entry.relative_path,
                    ),
                ),
                ...next,
              ])
              setRetained((current) =>
                current.filter(
                  (id) =>
                    !next.some((file) =>
                      delivery.assets.some(
                        (asset) =>
                          asset.id === id &&
                          asset.relative_path === file.relative_path,
                      ),
                    ),
                ),
              )
              event.target.value = ''
            }}
          />
        </section>
        <section className="flex flex-col gap-2 text-sm">
          <span>{t('delivery.selected_chat')}</span>
          {messages.map((message, index) => {
            const preview = deliveryMessages({ messages: [message] })[0]
            return (
              <label key={index} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  data-testid={`delivery-edit-message-${index}`}
                  checked={selected.includes(index)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(index)
                        ? current.filter((value) => value !== index)
                        : [...current, index],
                    )
                  }
                />
                <span className="line-clamp-3">
                  {preview?.content ?? JSON.stringify(message)}
                </span>
              </label>
            )
          })}
          {api.loadSourceMessages && delivery.source_task_snapshot ? (
            <button
              type="button"
              data-testid="delivery-edit-load-messages"
              disabled={loadingMessages}
              onClick={() => void loadMessages()}
              className="self-start text-text-secondary hover:underline"
            >
              {t('delivery.load_source_messages')}
            </button>
          ) : (
            <p className="text-text-muted">
              {t('delivery.source_unavailable')}
            </p>
          )}
          {sourceError && (
            <p role="alert" className="text-text-muted">
              {t('delivery.source_unavailable')}
            </p>
          )}
        </section>
      </fieldset>
      {error && (
        <div role="alert" className="text-sm text-red-600">
          <p>{error}</p>
          <button
            type="button"
            data-testid="delivery-edit-reload"
            disabled={busy}
            onClick={() => void reload()}
            className="mt-1 underline"
          >
            {t('delivery.reload')}
          </button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="delivery-edit-cancel"
          onClick={onCancel}
          disabled={busy}
          className="h-8 rounded-md px-3 text-sm hover:bg-hover"
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          data-testid="delivery-edit-save"
          disabled={busy || loadingMessages || !title.trim()}
          className="h-8 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
        >
          {busy ? t('delivery.saving') : t('delivery.save')}
        </button>
      </div>
    </form>
  )
}
