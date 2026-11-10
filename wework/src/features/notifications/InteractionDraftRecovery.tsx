import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'

/** Settlement never implies that a concurrent sender's text was delivered. */
export function InteractionDraftRecovery() {
  const interactions = useRuntimeInteractions()
  const { t } = useTranslation('common')
  if (!interactions) return null
  const { replyDrafts, pending, busy, setDraft } = interactions
  const unsent = replyDrafts.filter(
    draft =>
      draft.text &&
      !busy.has(draft.interaction.id) &&
      !pending.some(item => item.id === draft.interaction.id)
  )
  if (!unsent.length) return null
  return (
    <section aria-label={t('interactions.unsent_reply')} className="space-y-4 px-3 py-3">
      <h2 className="text-sm font-medium">{t('interactions.unsent_reply')}</h2>
      <p className="text-sm text-text-secondary">{t('interactions.unsent_reply_hint')}</p>
      {unsent.map(({ interaction: item, text }) => (
        <div key={item.id} data-testid="interaction-unsent-reply" className="space-y-2">
          <p className="break-words text-sm">{item.title}</p>
          <p className="break-words text-sm text-text-secondary">{item.question}</p>
          <textarea
            data-testid="interaction-unsent-text"
            aria-label={t('interactions.unsent_reply')}
            readOnly
            value={text}
            rows={3}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          <Button
            data-testid="interaction-discard-unsent"
            variant="secondary"
            className="min-h-11 md:min-h-7"
            onClick={() => setDraft(item.id, '')}
          >
            {t('interactions.discard_unsent_reply')}
          </Button>
        </div>
      ))}
    </section>
  )
}
