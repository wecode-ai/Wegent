import { ArrowUpRight, Link2, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import type { LinkPreview } from '@/lib/link-preview'

interface LinkPreviewCardProps {
  preview: LinkPreview
  linkText: string
  onRemove: () => void
  onChangeLinkText: (text: string) => void
  onChangeUrl: (url: string) => void
  disabled?: boolean
}

export function LinkPreviewCard({
  preview,
  linkText,
  onRemove,
  onChangeLinkText,
  onChangeUrl,
  disabled = false,
}: LinkPreviewCardProps) {
  const { t } = useTranslation('common')
  const [isEditingText, setIsEditingText] = useState(false)
  const [isEditingUrl, setIsEditingUrl] = useState(false)
  const [draftText, setDraftText] = useState(linkText)
  const [draftUrl, setDraftUrl] = useState(preview.url)

  const domainInitial = useMemo(() => {
    const initial = preview.domain.charAt(0).toUpperCase()
    return initial || '?'
  }, [preview.domain])

  const handleOpenLink = () => {
    void openExternalUrl(preview.url)
  }

  const commitTextEdit = () => {
    setIsEditingText(false)
    onChangeLinkText(draftText.trim())
  }

  const commitUrlEdit = () => {
    setIsEditingUrl(false)
    const trimmed = draftUrl.trim()
    if (trimmed) onChangeUrl(trimmed)
  }

  return (
    <div
      data-testid="link-preview-card"
      className="mb-3 overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <button
          type="button"
          data-testid="link-preview-open-link"
          onClick={handleOpenLink}
          disabled={disabled}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowUpRight className="h-4 w-4" />
          {t('workbench.open_link', 'Open link')}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="link-preview-edit-text"
            onClick={() => setIsEditingText(value => !value)}
            disabled={disabled}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.edit_link_text', '编辑文本')}
            title={t('workbench.edit_link_text', '编辑文本')}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="link-preview-edit-url"
            onClick={() => setIsEditingUrl(value => !value)}
            disabled={disabled}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.edit_link_url', '编辑链接')}
            title={t('workbench.edit_link_url', '编辑链接')}
          >
            <Link2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="link-preview-remove"
            onClick={onRemove}
            disabled={disabled}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.remove_link_preview', '移除链接预览')}
            title={t('workbench.remove_link_preview', '移除链接预览')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface text-sm font-semibold text-text-secondary">
          <img
            src={preview.iconUrl}
            alt=""
            className="h-full w-full object-contain"
            onError={event => {
              const target = event.currentTarget
              target.style.display = 'none'
              target.parentElement?.classList.add('fallback-initial')
            }}
          />
          <span className="hidden fallback-initial:block">{domainInitial}</span>
        </div>
        <div className="min-w-0 flex-1">
          {isEditingText ? (
            <input
              type="text"
              value={draftText}
              onChange={event => setDraftText(event.target.value)}
              onBlur={commitTextEdit}
              onKeyDown={event => {
                if (event.key === 'Enter') commitTextEdit()
                if (event.key === 'Escape') {
                  setDraftText(linkText)
                  setIsEditingText(false)
                }
              }}
              autoFocus
              data-testid="link-preview-text-input"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus:border-focus"
            />
          ) : (
            <button
              type="button"
              data-testid="link-preview-text"
              onClick={() => setIsEditingText(true)}
              className="block w-full truncate text-left text-sm font-medium text-text-primary hover:text-text-secondary"
            >
              {linkText || preview.displayUrl}
            </button>
          )}
          {isEditingUrl ? (
            <input
              type="text"
              value={draftUrl}
              onChange={event => setDraftUrl(event.target.value)}
              onBlur={commitUrlEdit}
              onKeyDown={event => {
                if (event.key === 'Enter') commitUrlEdit()
                if (event.key === 'Escape') {
                  setDraftUrl(preview.url)
                  setIsEditingUrl(false)
                }
              }}
              autoFocus
              data-testid="link-preview-url-input"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-text-secondary outline-none focus:border-focus"
            />
          ) : (
            <button
              type="button"
              data-testid="link-preview-url"
              onClick={() => setIsEditingUrl(true)}
              className="mt-0.5 block w-full truncate text-left text-xs text-text-secondary hover:text-text-primary"
            >
              {preview.url}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
