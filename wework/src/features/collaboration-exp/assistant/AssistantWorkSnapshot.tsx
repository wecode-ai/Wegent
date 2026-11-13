import { ArrowRight, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceWorkSnapshot, ExperienceWorkSnapshotItem } from '../model'

export function AssistantWorkSnapshot({
  snapshot,
  onOpen,
  ready,
}: {
  snapshot: ExperienceWorkSnapshot
  onOpen(item: ExperienceWorkSnapshotItem): void
  ready: boolean
}) {
  const { t } = useTranslation('collaborationExp')
  const current = snapshot.current
  return (
    <section
      className="assistant-live-snapshot"
      data-testid="collaboration-exp-assistant-snapshot"
      aria-label={t('assistant.snapshot.title')}
      aria-busy={!ready}
      data-live={ready && snapshot.counts.running > 0}
    >
      <div className="assistant-live-snapshot-head">
        <span className="assistant-live-signal" aria-hidden="true" />
        <span>
          <strong className="text-sm">{t('assistant.snapshot.title')}</strong>
          <small className="text-xs">
            {t(
              ready && current
                ? 'assistant.snapshot.current'
                : ready
                  ? 'assistant.status.idle'
                  : 'assistant.status.unknown'
            )}
          </small>
        </span>
      </div>
      {ready && current?.address && (
        <button
          type="button"
          data-testid="collaboration-exp-assistant-current"
          onClick={() => onOpen(current)}
          className="assistant-live-work"
        >
          <span className="assistant-live-work-label text-xs">
            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
            <span>{t('assistant.snapshot.current')}</span>
          </span>
          <strong className="text-sm">{current.title}</strong>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      <dl className="assistant-live-metrics">
        {(['waiting', 'running', 'completed'] as const).map(state => (
          <div key={state} data-state={state}>
            <dd
              className="text-lg font-semibold tabular-nums"
              data-testid={`collaboration-exp-assistant-count-${state}`}
              aria-label={ready ? undefined : t('teamRelay.state.unknown')}
            >
              {ready ? snapshot.counts[state] : '—'}
            </dd>
            <dt className="text-xs">{t(`assistant.snapshot.${state}`)}</dt>
          </div>
        ))}
      </dl>
    </section>
  )
}
