import { useEffect, useId, useState } from 'react'
import { ArrowUpRight, Bot, ChevronRight, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { RuntimeInteractionReply } from './RuntimeInteractionReply'
import { openWeworkScheme } from './schemeEvents'
import { weworkTaskScheme } from './scheme'
import { canReplyToInteraction, interactionOriginalScheme } from './runtimeInteractions'
import { cn } from '@/lib/utils'

export function RuntimeInteractionsPage({
  selectedId,
  active = true,
}: {
  selectedId?: string | null
  active?: boolean
}) {
  const interactions = useRuntimeInteractions()
  const { t } = useTranslation('common')
  const [history, setHistory] = useState(false)
  const [selected, setSelected] = useState<string | null>(selectedId ?? null)
  const [evidence, setEvidence] = useState(false)
  const [lastRouteId, setLastRouteId] = useState(selectedId)
  const owner = useId()
  const registerView = interactions?.registerView
  const viewed = !history
    ? selected
      ? interactions?.pending.find(item => item.id === selected)?.id
      : interactions?.pending[0]?.id
    : undefined
  useEffect(() => {
    registerView?.(owner, active ? (viewed ?? null) : null)
    return () => registerView?.(owner, null)
  }, [active, owner, registerView, viewed])
  if (lastRouteId !== selectedId) {
    setLastRouteId(selectedId)
    setSelected(selectedId ?? null)
    setHistory(false)
  }
  if (!interactions) return null
  const { pending, loading, errors } = interactions
  const rows = history
    ? interactions.history
    : pending.map(item => ({
        id: item.id,
        title: item.task.task.title,
        question: item.question,
        address: item.task.address,
        originalUrl: interactionOriginalScheme(item),
      }))
  const row = selected
    ? (rows.find(item => item.id === selected) ??
      interactions.history.find(item => item.id === selected))
    : rows[0]
  const item = pending.find(item => item.id === row?.id)
  return (
    <main
      data-testid="runtime-interactions-page"
      className="flex h-full min-h-0 bg-background text-text-primary"
    >
      <section className="flex w-80 max-w-[40%] shrink-0 flex-col border-r border-border bg-muted/20">
        <header className="flex items-center gap-2 px-5 py-5">
          <h1 className="heading-sm flex-1">
            {t('interactions.title')}{' '}
            <span
              data-testid="interactions-pending-count"
              className="ml-1 text-sm text-text-secondary"
            >
              {pending.length}
            </span>
          </h1>
          <button
            type="button"
            data-testid="interactions-refresh"
            disabled={loading}
            aria-label={t('notifications.refresh')}
            onClick={() => void interactions.refresh()}
            className="rounded-md p-1.5 hover:bg-muted"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </header>
        <button
          type="button"
          data-testid="interactions-history"
          className="mx-5 mb-3 self-end text-sm text-text-secondary hover:text-text-primary"
          onClick={() => {
            setHistory(value => !value)
            setSelected(null)
          }}
        >
          {t(history ? 'interactions.pending' : 'interactions.history')}
        </button>
        <div className="flex-1 overflow-y-auto px-2">
          {rows.map(entry => (
            <button
              type="button"
              key={entry.id}
              data-testid="interaction-list-item"
              data-interaction-id={entry.id}
              aria-pressed={row?.id === entry.id}
              className={cn(
                'mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-4 text-left hover:bg-muted',
                row?.id === entry.id && 'bg-muted'
              )}
              onClick={() => {
                setSelected(entry.id)
                setEvidence(false)
              }}
            >
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-base font-medium">{entry.title}</span>
                <span
                  data-testid="interaction-list-summary"
                  className="mt-1 line-clamp-2 text-sm text-text-secondary"
                >
                  {entry.question}
                </span>
              </span>
            </button>
          ))}
          {!rows.length && (
            <p className="px-3 py-8 text-sm text-text-secondary">
              {t(loading ? 'interactions.loading' : 'interactions.empty')}
            </p>
          )}
          {Object.entries(errors)
            .filter(([key]) => !pending.some(request => request.id === key))
            .map(([key, error]) => (
              <p key={key} role="alert" className="px-3 py-2 text-sm text-status-error">
                {error}
              </p>
            ))}
        </div>
      </section>
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {row ? (
          <>
            <div className="flex justify-end px-5 py-4">
              <button
                type="button"
                data-testid="interaction-open-original"
                className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
                onClick={() => openWeworkScheme(row.originalUrl || weworkTaskScheme(row.address))}
              >
                {t('interactions.open_original')}
                <ArrowUpRight className="h-4 w-4" />
              </button>
            </div>
            <article className="mx-auto w-full max-w-3xl space-y-6 px-8 py-12">
              <p className="text-sm text-text-secondary">{row.title}</p>
              <h2 className="heading-md whitespace-pre-wrap">{row.question}</h2>
              {item?.cached && (
                <p className="text-sm text-text-secondary">{t('interactions.cached')}</p>
              )}
              {item ? (
                <>
                  <button
                    type="button"
                    data-testid="interaction-evidence"
                    aria-expanded={evidence}
                    onClick={() => setEvidence(value => !value)}
                    className="flex items-center gap-2 text-sm text-text-secondary"
                  >
                    <ChevronRight className={cn('h-4 w-4', evidence && 'rotate-90')} />
                    {t('interactions.evidence')}
                  </button>
                  {evidence && (
                    <p className="whitespace-pre-wrap text-sm text-text-secondary">
                      {item.context || t('interactions.evidence_in_original')}
                    </p>
                  )}
                  <RuntimeInteractionReply key={item.id} item={item} />
                  {canReplyToInteraction(item) && (
                    <p className="text-sm text-text-secondary">{t('interactions.resume_hint')}</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-text-secondary">{t('interactions.replied')}</p>
              )}
            </article>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            {t(selected ? 'interactions.expired' : 'interactions.empty')}
          </div>
        )}
      </section>
    </main>
  )
}
