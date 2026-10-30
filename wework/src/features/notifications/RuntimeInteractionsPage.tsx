import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Bot, ChevronRight, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsDesktop } from '@/hooks/useIsDesktop'
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
  const [evidence, setEvidence] = useState(true)
  const [showList, setShowList] = useState(!selectedId)
  const twoPanes = useIsDesktop()
  const list = useRef<HTMLElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const restoreListFocus = useRef(false)
  const [lastRouteId, setLastRouteId] = useState(selectedId)
  const owner = useId()
  const registerView = interactions?.registerView
  const viewed =
    !history && (twoPanes || !showList)
      ? selected
        ? interactions?.pending.find(item => item.id === selected)?.id
        : interactions?.pending[0]?.id
      : undefined
  useEffect(() => {
    registerView?.(owner, active ? (viewed ?? null) : null)
    return () => registerView?.(owner, null)
  }, [active, owner, registerView, viewed])
  useEffect(() => {
    if (twoPanes) return
    if (!showList) heading.current?.focus()
    else if (restoreListFocus.current) {
      const selectedRow = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      const focusTarget = selectedRow ?? listHeading.current
      focusTarget?.focus()
      restoreListFocus.current = false
    }
  }, [twoPanes, showList, selected, viewed])
  if (lastRouteId !== selectedId) {
    setLastRouteId(selectedId)
    setSelected(selectedId ?? null)
    setHistory(false)
    setEvidence(true)
    setShowList(!selectedId)
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
      <section
        ref={list}
        className={cn(
          'flex w-full shrink-0 flex-col border-r border-border bg-muted/20 md:w-64 md:max-w-[36%] xl:w-72',
          !twoPanes && !showList && 'hidden'
        )}
      >
        <header className="flex min-h-14 items-center gap-3 px-4 py-3">
          <h1 ref={listHeading} tabIndex={-1} className="heading-sm flex-1 outline-none">
            {t(history ? 'interactions.history' : 'interactions.title')}{' '}
            <span
              data-testid={history ? 'interactions-history-count' : 'interactions-pending-count'}
              className="ml-1 text-sm text-text-secondary"
            >
              {history ? interactions.history.length : pending.length}
            </span>
          </h1>
          <button
            type="button"
            data-testid="interactions-history"
            className="min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
            onClick={() => {
              setHistory(value => !value)
              setSelected(null)
              setEvidence(true)
            }}
          >
            {t(history ? 'interactions.pending' : 'interactions.history')}
          </button>
          <button
            type="button"
            data-testid="interactions-refresh"
            disabled={loading}
            aria-label={t('notifications.refresh')}
            onClick={() => void interactions.refresh()}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {rows.map(entry => (
            <button
              type="button"
              key={entry.id}
              data-testid="interaction-list-item"
              data-interaction-id={entry.id}
              aria-pressed={row?.id === entry.id}
              className={cn(
                'mb-1 flex w-full items-start gap-2 rounded-lg px-3 py-3 text-left hover:bg-muted',
                row?.id === entry.id && 'bg-muted'
              )}
              onClick={() => {
                setSelected(entry.id)
                setEvidence(true)
                setShowList(false)
              }}
            >
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0">
                <span
                  data-testid="interaction-list-summary"
                  className="line-clamp-2 text-base font-medium"
                >
                  {entry.question}
                </span>
                <span
                  className="mt-1 block truncate text-sm text-text-secondary"
                  title={entry.title}
                >
                  {entry.title}
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
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-y-auto md:pl-4 lg:pl-6 xl:pl-8',
          !twoPanes && showList && 'hidden'
        )}
      >
        {!twoPanes && (
          <button
            type="button"
            data-testid="interactions-back-to-list"
            className="mx-3 mt-2 flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
            onClick={() => {
              restoreListFocus.current = true
              setShowList(true)
            }}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('interactions.back_to_list')}
          </button>
        )}
        {row ? (
          <article className="mx-auto w-full max-w-2xl px-5 py-6 md:mx-0 lg:px-8 lg:py-8">
            <header className="mb-6 flex items-center gap-3 border-b border-border pb-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                <Bot className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={row.title}>
                  {row.title}
                </p>
                {item?.task.projectName && (
                  <p className="mt-0.5 truncate text-xs text-text-secondary">
                    {item.task.projectName}
                  </p>
                )}
              </div>
              <button
                type="button"
                data-testid="interaction-open-original"
                className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
                onClick={() => openWeworkScheme(row.originalUrl || weworkTaskScheme(row.address))}
              >
                {t('interactions.open_original')}
                <ArrowUpRight className="h-4 w-4" />
              </button>
            </header>
            <div className="space-y-6">
              <h2
                ref={heading}
                tabIndex={-1}
                className="heading-md whitespace-pre-wrap text-balance outline-none"
              >
                {row.question}
              </h2>
              {item?.cached && (
                <p className="text-sm text-text-secondary">{t('interactions.cached')}</p>
              )}
              {item ? (
                <>
                  {item.context.trim() && item.context.trim() !== row.question.trim() && (
                    <section className="border-l-2 border-border pl-4">
                      <button
                        type="button"
                        data-testid="interaction-evidence"
                        aria-expanded={evidence}
                        onClick={() => setEvidence(value => !value)}
                        className="flex min-h-11 items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary md:min-h-6"
                      >
                        <ChevronRight className={cn('h-4 w-4', evidence && 'rotate-90')} />
                        {t('interactions.context')}
                      </button>
                      {evidence && (
                        <p
                          data-testid="interaction-evidence-content"
                          className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-base leading-relaxed text-text-secondary"
                        >
                          {item.context}
                        </p>
                      )}
                    </section>
                  )}
                  <div className="space-y-2">
                    {canReplyToInteraction(item) && (
                      <p className="text-sm font-medium">{t('interactions.your_reply')}</p>
                    )}
                    <RuntimeInteractionReply key={item.id} item={item} presentation="page" />
                  </div>
                </>
              ) : (
                <p className="text-sm text-text-secondary">{t('interactions.replied')}</p>
              )}
            </div>
          </article>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            {t(selected ? 'interactions.expired' : 'interactions.empty')}
          </div>
        )}
      </section>
    </main>
  )
}
