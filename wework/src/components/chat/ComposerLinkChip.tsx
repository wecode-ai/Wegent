import { ArrowUpRight, Link2, Pencil, Trash2, Check } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { getRecognizedLink } from '@/lib/link-preview'

export interface ComposerLinkChipPayload {
  url: string
  label: string
}

interface ComposerLinkChipProps {
  payload: ComposerLinkChipPayload
  editable?: boolean
  onChange?: (payload: ComposerLinkChipPayload) => void
  onRemove?: () => void
}

export function ComposerLinkChip({
  payload,
  editable = false,
  onChange,
  onRemove,
}: ComposerLinkChipProps) {
  const recognized = useMemo(() => getRecognizedLink(payload.url), [payload.url])
  const iconUrl = recognized?.iconUrl ?? `https://${new URL(payload.url).hostname}/favicon.ico`
  const provider = recognized?.provider ?? 'external'

  const [editing, setEditing] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const chipRef = useRef<HTMLSpanElement>(null)

  const handleClick = () => {
    if (editable) {
      setAnchor(chipRef.current)
      setEditing(true)
    } else {
      void openExternalUrl(payload.url)
    }
  }

  return (
    <>
      <span
        ref={chipRef}
        data-testid="composer-link-chip"
        data-composer-link-url={payload.url}
        data-composer-link-provider={provider}
        className="composer-link-node composer-mention-link inline-flex cursor-pointer items-center"
        onClick={handleClick}
      >
        <span className="composer-mention-icon-slot" aria-hidden="true" role="img">
          <img className="composer-mention-icon" src={iconUrl} alt="" loading="lazy" />
        </span>
        {editable ? (
          <span className="composer-mention-label">{payload.label}</span>
        ) : (
          <a
            href={payload.url}
            className="composer-mention-label"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              void openExternalUrl(payload.url)
            }}
          >
            {payload.label}
          </a>
        )}
      </span>
      {editable && editing && anchor && (
        <LinkEditPopover
          payload={payload}
          anchor={anchor}
          onClose={() => setEditing(false)}
          onChange={next => {
            setEditing(false)
            onChange?.(next)
          }}
          onRemove={() => {
            setEditing(false)
            onRemove?.()
          }}
        />
      )}
    </>
  )
}

interface LinkEditPopoverProps {
  payload: ComposerLinkChipPayload
  anchor: HTMLElement
  onClose: () => void
  onChange: (payload: ComposerLinkChipPayload) => void
  onRemove: () => void
}

function LinkEditPopover({ payload, anchor, onClose, onChange, onRemove }: LinkEditPopoverProps) {
  const { t } = useTranslation('common')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'none' | 'text' | 'url'>('none')
  const [draftText, setDraftText] = useState(payload.label)
  const [draftUrl, setDraftUrl] = useState(payload.url)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchor.contains(target)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [anchor, onClose])

  const position = useMemo(() => {
    const rect = anchor.getBoundingClientRect()
    return {
      left: rect.left + rect.width / 2,
      bottom: window.innerHeight - rect.top + 8,
    }
  }, [anchor])

  const commitText = () => {
    setMode('none')
    onChange({ url: payload.url, label: draftText.trim() })
  }

  const commitUrl = () => {
    setMode('none')
    const trimmed = draftUrl.trim()
    if (trimmed) onChange({ url: trimmed, label: payload.label })
  }

  const cancelEdit = () => {
    setMode('none')
    setDraftText(payload.label)
    setDraftUrl(payload.url)
  }

  if (mode === 'text') {
    return createPortal(
      <div
        ref={popoverRef}
        data-testid="link-edit-popover"
        className="fixed z-system-popover flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/70 bg-background py-1 pl-4 pr-1 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        style={{ left: position.left, bottom: position.bottom }}
      >
        <input
          type="text"
          value={draftText}
          onChange={event => setDraftText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitText()
            }
            if (event.key === 'Escape') cancelEdit()
          }}
          autoFocus
          data-testid="link-edit-text-input"
          className="w-64 bg-transparent text-sm text-text-primary outline-none"
        />
        <button
          type="button"
          data-testid="link-edit-confirm-text"
          onClick={commitText}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:bg-text-secondary"
          aria-label={t('common.confirm', '确认')}
          title={t('common.confirm', '确认')}
        >
          <Check className="h-4 w-4" />
        </button>
      </div>,
      document.body
    )
  }

  if (mode === 'url') {
    return createPortal(
      <div
        ref={popoverRef}
        data-testid="link-edit-popover"
        className="fixed z-system-popover flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/70 bg-background py-1 pl-4 pr-1 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        style={{ left: position.left, bottom: position.bottom }}
      >
        <input
          type="text"
          value={draftUrl}
          onChange={event => setDraftUrl(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitUrl()
            }
            if (event.key === 'Escape') cancelEdit()
          }}
          autoFocus
          data-testid="link-edit-url-input"
          className="w-64 bg-transparent text-xs text-text-secondary outline-none"
        />
        <button
          type="button"
          data-testid="link-edit-confirm-url"
          onClick={commitUrl}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:bg-text-secondary"
          aria-label={t('common.confirm', '确认')}
          title={t('common.confirm', '确认')}
        >
          <Check className="h-4 w-4" />
        </button>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="link-edit-popover"
      className="fixed z-system-popover flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border/70 bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom }}
    >
      <button
        type="button"
        data-testid="link-edit-open-link"
        onClick={() => void openExternalUrl(payload.url)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-primary hover:bg-muted"
      >
        <ArrowUpRight className="h-4 w-4" />
        {t('workbench.open_link', '打开链接')}
      </button>
      <button
        type="button"
        data-testid="link-edit-edit-text"
        onClick={() => setMode('text')}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
        aria-label={t('workbench.edit_link_text', '编辑文本')}
        title={t('workbench.edit_link_text', '编辑文本')}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="link-edit-edit-url"
        onClick={() => setMode('url')}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
        aria-label={t('workbench.edit_link_url', '编辑链接')}
        title={t('workbench.edit_link_url', '编辑链接')}
      >
        <Link2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="link-edit-remove"
        onClick={onRemove}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-red-600"
        aria-label={t('workbench.remove_link_preview', '移除链接预览')}
        title={t('workbench.remove_link_preview', '移除链接预览')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>,
    document.body
  )
}
