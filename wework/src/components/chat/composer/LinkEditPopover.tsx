import { ArrowUpRight, Check, Link2, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { isHttpUrl, openExternalUrl } from '@/lib/external-links'

interface LinkPayload {
  url: string
  label: string
}

interface LinkEditPopoverProps {
  payload: LinkPayload
  anchor: HTMLElement | null
  onClose: () => void
  onChange: (payload: LinkPayload) => void
  onRemove: () => void
}

const POPOVER_HEIGHT_ESTIMATE = 48

export function LinkEditPopover({
  payload,
  anchor,
  onClose,
  onChange,
  onRemove,
}: LinkEditPopoverProps) {
  const { t } = useTranslation('common')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'none' | 'text' | 'url'>('none')
  const [draftText, setDraftText] = useState(payload.label || payload.url)
  const [draftUrl, setDraftUrl] = useState(payload.url || '')
  const [urlError, setUrlError] = useState(false)

  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number } | null>(
    null
  )

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom
      const placeAbove = spaceAbove >= POPOVER_HEIGHT_ESTIMATE || spaceAbove >= spaceBelow
      setPosition({
        left: rect.left + rect.width / 2,
        bottom: placeAbove ? window.innerHeight - rect.top + 8 : undefined,
        top: !placeAbove ? rect.bottom + 8 : undefined,
      })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchor?.contains(target)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (mode !== 'none') return
      onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [anchor, mode, onClose])

  if (!anchor || !position) return null

  const commitText = () => {
    const trimmed = draftText.trim()
    if (!trimmed) return
    setMode('none')
    onChange({ url: payload.url, label: trimmed })
  }

  const commitUrl = () => {
    const trimmed = draftUrl.trim()
    if (!trimmed || !isHttpUrl(trimmed)) {
      setUrlError(true)
      return
    }
    setUrlError(false)
    setMode('none')
    onChange({ url: trimmed, label: payload.label })
  }

  const cancelEdit = () => {
    setMode('none')
    setDraftText(payload.label || payload.url)
    setDraftUrl(payload.url || '')
    setUrlError(false)
  }

  const confirmLabel = t('common.confirm', '确认')
  const urlErrorLabel = t('workbench.browser_invalid_url', 'Enter a valid http or https URL')

  if (mode === 'text') {
    return createPortal(
      <LinkEditInput
        popoverRef={popoverRef}
        position={position}
        value={draftText}
        onChange={setDraftText}
        onCommit={commitText}
        onCancel={cancelEdit}
        inputTestId="link-edit-text-input"
        confirmTestId="link-edit-confirm-text"
        confirmLabel={confirmLabel}
      />,
      document.body
    )
  }

  if (mode === 'url') {
    return createPortal(
      <LinkEditInput
        popoverRef={popoverRef}
        position={position}
        value={draftUrl}
        onChange={value => {
          setDraftUrl(value)
          setUrlError(false)
        }}
        onCommit={commitUrl}
        onCancel={cancelEdit}
        inputTestId="link-edit-url-input"
        confirmTestId="link-edit-confirm-url"
        confirmLabel={confirmLabel}
        error={urlError ? urlErrorLabel : undefined}
        inputSize="xs"
      />,
      document.body
    )
  }

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="link-edit-popover"
      className="fixed z-system-popover flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border/70 bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom, top: position.top }}
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

interface LinkEditInputProps {
  popoverRef: RefObject<HTMLDivElement | null>
  position: { left: number; bottom?: number; top?: number }
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  inputTestId: string
  confirmTestId: string
  confirmLabel: string
  error?: string
  inputSize?: 'sm' | 'xs'
}

function LinkEditInput({
  popoverRef,
  position,
  value,
  onChange,
  onCommit,
  onCancel,
  inputTestId,
  confirmTestId,
  confirmLabel,
  error,
  inputSize = 'sm',
}: LinkEditInputProps) {
  return createPortal(
    <div
      ref={popoverRef}
      data-testid="link-edit-popover"
      className="fixed z-system-popover flex -translate-x-1/2 flex-col items-center gap-1 rounded-2xl border border-border/70 bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom, top: position.top }}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit()
            }
            if (event.key === 'Escape') onCancel()
          }}
          autoFocus
          data-testid={inputTestId}
          className={`w-64 bg-transparent outline-none ${
            inputSize === 'xs' ? 'text-xs text-text-secondary' : 'text-sm text-text-primary'
          }`}
        />
        <button
          type="button"
          data-testid={confirmTestId}
          onClick={onCommit}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary text-background hover:bg-text-secondary"
          aria-label={confirmLabel}
          title={confirmLabel}
        >
          <Check className="h-4 w-4" />
        </button>
      </div>
      {error && <span className="px-2 text-xs text-red-500">{error}</span>}
    </div>,
    document.body
  )
}
