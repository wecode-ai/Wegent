import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, X } from 'lucide-react'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { RuntimeInteractionReply } from './RuntimeInteractionReply'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

export function RuntimeInteractionNotice() {
  const interactions = useRuntimeInteractions()
  const notice = interactions?.notice
  return notice ? <InteractionNotice key={notice.id} /> : null
}

function InteractionNotice() {
  const interactions = useRuntimeInteractions()!
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const { notice: item, dismissNotice } = interactions
  useEffect(() => {
    if (expanded || hovered) return
    const timer = window.setTimeout(dismissNotice, 8000)
    return () => window.clearTimeout(timer)
  }, [expanded, hovered, dismissNotice])
  if (!item) return null
  return createPortal(
    <aside
      data-testid="runtime-interaction-notice"
      data-embedded-browser-occlusion
      aria-label={t('interactions.needs_reply')}
      className="fixed right-4 top-24 z-popover w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 text-text-primary shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false)
      }}
    >
      <span className="sr-only" role="status">
        {item.task.task.title}: {item.question}
      </span>
      <div className="flex items-start gap-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <button
          type="button"
          data-testid="interaction-notice-open"
          onClick={() => interactions.open(item.id)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm text-text-secondary">{item.task.task.title}</span>
          <span className="mt-2 block text-base font-medium">{item.question}</span>
        </button>
        <button
          type="button"
          data-testid="interaction-notice-dismiss"
          aria-label={t('interactions.dismiss')}
          onClick={dismissNotice}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {expanded ? (
        <div className="mt-3">
          <RuntimeInteractionReply item={item} />
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <Button
            data-testid="interaction-notice-reply"
            variant="secondary"
            onClick={() => setExpanded(true)}
          >
            {t('interactions.reply')}
          </Button>
        </div>
      )}
    </aside>,
    document.body
  )
}
