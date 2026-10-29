import { useState } from 'react'
import { ArrowUp, LoaderCircle } from 'lucide-react'
import { isImeEnterEvent } from '@wegent/chat-core/ime'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canReplyToInteraction,
  interactionOriginalScheme,
  type RuntimeInteraction,
} from './runtimeInteractions'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { openWeworkScheme } from './schemeEvents'

/** All reminder surfaces share this response control and the owning request. */
export function RuntimeInteractionReply({ item }: { item: RuntimeInteraction }) {
  const { t } = useTranslation('common')
  const interactions = useRuntimeInteractions()
  const [custom, setCustom] = useState(false)
  if (!interactions) return null
  const { drafts, setDraft, respond, errors, busy } = interactions
  const disabled = busy.has(item.id)
  const question = item.payload.questions?.[0]
  const options = question?.options?.filter(option => option.label || option.value) ?? []
  const draft = drafts[item.id] ?? ''
  if (!canReplyToInteraction(item))
    return (
      <Button
        data-testid="interaction-open-original-action"
        variant="primary"
        onClick={() => openWeworkScheme(interactionOriginalScheme(item))}
      >
        {t('interactions.handle_in_context')}
      </Button>
    )
  return (
    <div data-testid="interaction-reply" className="space-y-3">
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option, index) => (
            <Button
              key={`${index}:${option.value ?? option.label}`}
              data-testid={`interaction-answer-${index}`}
              variant={index === 0 ? 'primary' : 'secondary'}
              autoFocus={index === 0 && !custom && !draft}
              disabled={disabled}
              onClick={() => void respond(item, option.value ?? option.label!)}
            >
              {disabled && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {option.label ?? option.value}
            </Button>
          ))}
        </div>
      )}
      {!options.length || custom || draft ? (
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault()
            if (draft.trim()) void respond(item, draft.trim())
          }}
        >
          <input
            data-testid="interaction-reply-input"
            aria-label={t('interactions.reply')}
            placeholder={t('interactions.reply_placeholder')}
            autoFocus
            value={draft}
            disabled={disabled}
            onChange={event => setDraft(item.id, event.target.value)}
            onKeyDown={event => {
              if (isImeEnterEvent(event.nativeEvent)) event.preventDefault()
            }}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
          />
          <Button
            type="submit"
            variant="primary"
            data-testid="interaction-reply-send"
            aria-label={t('interactions.send')}
            disabled={disabled || !draft.trim()}
          >
            {disabled ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        </form>
      ) : question?.is_other || question?.isOther ? (
        <button
          type="button"
          data-testid="interaction-other-answer"
          className="text-sm text-text-secondary hover:text-text-primary"
          onClick={() => setCustom(true)}
        >
          {t('interactions.add_detail')}
        </button>
      ) : null}
      {errors[item.id] && (
        <p role="alert" className="text-sm text-status-error">
          {errors[item.id]}
        </p>
      )}
    </div>
  )
}
