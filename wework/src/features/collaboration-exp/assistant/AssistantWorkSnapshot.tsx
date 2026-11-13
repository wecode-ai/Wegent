import { ArrowUpRight } from 'lucide-react'
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
      className="experience-assistant-snapshot"
      data-testid="collaboration-exp-assistant-snapshot"
      aria-label={t('assistant.snapshot.title')}
      aria-busy={!ready}
    >
      <h2 className="text-sm font-medium text-text-secondary">{t('assistant.snapshot.title')}</h2>
      <dl className="experience-work-counts">
        {(['waiting', 'running', 'completed'] as const).map(state => (
          <div key={state} data-state={state}>
            <dt className="text-xs text-text-muted">{t(`assistant.snapshot.${state}`)}</dt>
            <dd
              className="text-lg font-medium tabular-nums"
              data-testid={`collaboration-exp-assistant-count-${state}`}
              aria-label={ready ? undefined : t('teamRelay.state.unknown')}
            >
              {ready ? snapshot.counts[state] : '—'}
            </dd>
          </div>
        ))}
      </dl>
      {ready && current?.address && (
        <button
          type="button"
          data-testid="collaboration-exp-assistant-current"
          onClick={() => onOpen(current)}
          className="experience-assistant-current"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-text-muted">{t('assistant.snapshot.current')}</span>
            <span className="block truncate text-sm">{current.title}</span>
          </span>
          <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
        </button>
      )}
    </section>
  )
}
