import { DeleteIconButton } from '../controls/DeleteIconButton'
import { Popover, PopoverContent } from '../controls/Popover'
import { isHttpUrl } from '@wegent/chat-core/http-url'
import { isImeEnterEvent } from '@wegent/chat-core/ime'
import { ArrowUpRight, Check, Link2, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { TextField as ControlInput } from '../controls/TextField'
import { controlPopup } from '../controls/recipes'
import { useConversationTranslation } from '../conversation/ConversationTranslation'
import { Button as ControlButton } from '../markdown/Button'
import { useMarkdownServices } from '../markdown/MarkdownServices'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'

interface LinkPayload {
  url: string
  label: string
}
export interface LinkEditPopoverProps {
  payload: LinkPayload
  anchor: HTMLElement | null
  onClose(): void
  onChange(payload: LinkPayload): void
  onRemove(): void
}

export function LinkEditPopover({
  payload,
  anchor,
  onClose,
  onChange,
  onRemove,
}: LinkEditPopoverProps) {
  const { t } = useConversationTranslation()
  const { openExternalUrl } = useMarkdownServices()
  const portalTheme = useCollaborationPortalTheme()
  const editor = useRef(
    typeof document === 'undefined'
      ? null
      : (document.activeElement as HTMLElement | null),
  )
  const [mode, setMode] = useState<'none' | 'text' | 'url'>('none')
  const [draftText, setDraftText] = useState(payload.label || payload.url)
  const [draftUrl, setDraftUrl] = useState(payload.url || '')
  const [urlError, setUrlError] = useState(false)
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

  const confirmLabel = t('common.confirm')
  const urlErrorLabel = t('workbench.browser_invalid_url')

  if (!anchor) return null
  const textMode = mode === 'text'
  const commit = textMode ? commitText : commitUrl
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(next, details) => {
        if (next) return
        if (details.reason === 'escape-key' && mode !== 'none') {
          details.cancel()
          cancelEdit()
        } else onClose()
      }}
    >
      <PopoverContent
        {...portalTheme}
        anchor={anchor}
        side="top"
        sideOffset={8}
        collisionPadding={8}
        initialFocus="none"
        finalFocus={() => (editor.current?.isConnected ? editor.current : null)}
        data-testid="link-edit-popover"
        aria-label={t('workbench.edit_link_url')}
        className={portalTheme.className + ' ' + controlPopup}
      >
        {mode === 'none' ? (
          <div className="flex items-center gap-1">
            {' '}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="link-edit-open-link"
              onClick={() => void openExternalUrl(payload.url)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-primary hover:bg-muted"
            >
              <ArrowUpRight className="h-4 w-4" />
              {t('workbench.open_link')}
            </ControlButton>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="link-edit-edit-text"
              onClick={() => setMode('text')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.edit_link_text')}
              title={t('workbench.edit_link_text')}
            >
              <Pencil className="h-4 w-4" />
            </ControlButton>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="link-edit-edit-url"
              onClick={() => setMode('url')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.edit_link_url')}
              title={t('workbench.edit_link_url')}
            >
              <Link2 className="h-4 w-4" />
            </ControlButton>
            <DeleteIconButton
              type="button"
              data-testid="link-edit-remove"
              onClick={onRemove}
              aria-label={t('workbench.remove_link_preview')}
              title={t('workbench.remove_link_preview')}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <ControlInput
                type="text"
                autoFocus
                value={textMode ? draftText : draftUrl}
                aria-label={t(
                  textMode
                    ? 'workbench.edit_link_text'
                    : 'workbench.edit_link_url',
                )}
                aria-invalid={urlError || undefined}
                data-testid={
                  textMode ? 'link-edit-text-input' : 'link-edit-url-input'
                }
                onChange={(event) => {
                  if (textMode) setDraftText(event.target.value)
                  else {
                    setDraftUrl(event.target.value)
                    setUrlError(false)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeEnterEvent(event)) {
                    event.preventDefault()
                    commit()
                  }
                }}
                className="w-64"
              />
              <ControlButton
                variant="primary"
                size="icon"
                type="button"
                aria-label={confirmLabel}
                data-testid={
                  textMode ? 'link-edit-confirm-text' : 'link-edit-confirm-url'
                }
                onClick={commit}
              >
                <Check className="h-4 w-4" aria-hidden="true" />
              </ControlButton>
            </div>
            {urlError && (
              <p role="alert" className="text-xs text-destructive">
                {urlErrorLabel}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
