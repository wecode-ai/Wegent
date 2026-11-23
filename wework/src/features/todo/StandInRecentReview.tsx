import type { StandInMemory } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useClock } from '@wegent/collaboration/clock'
import { StandInMemoryEvidence } from './StandInMemoryEvidence'

const groups = ['correction', 'positive', 'demonstration', 'observation'] as const
type ReviewKind = (typeof groups)[number]

export function StandInRecentReview({
  memories,
  roleId,
  name,
  period,
}: {
  memories: StandInMemory[]
  roleId: string
  name: string
  period: 'today' | 'week'
}) {
  const { t } = useTranslation('common')
  const now = useClock(true, { resolutionMs: 60_000 })
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (period === 'week') start.setDate(start.getDate() - 6)
  const entries: Record<ReviewKind, { memory: StandInMemory; observed: number }[]> = {
    correction: [],
    positive: [],
    demonstration: [],
    observation: [],
  }
  for (const memory of memories) {
    const example = memory.evidence?.trainingCase
    const at = memory.evidence?.observedAt
    if (memory.evidenceUnavailable || example?.roleId !== roleId || at == null) continue
    const observed = new Date(at).getTime()
    if (observed >= start.getTime() && observed <= now) {
      entries[example.kind].push({ memory, observed })
    }
  }
  return (
    <section data-testid="stand-in-recent-review" className="space-y-4 pb-5">
      <h3 className="text-sm font-semibold">{t('standIn.memory.review_title', { name })}</h3>
      {groups.every(kind => !entries[kind].length) && (
        <p className="text-sm text-text-muted">{t('standIn.memory.review_empty')}</p>
      )}
      {groups.map(
        kind =>
          entries[kind].length > 0 && (
            <section key={kind}>
              <h4 className="text-sm font-medium">{t(`standIn.memory.review_${kind}`)}</h4>
              <ul className="divide-y divide-border">
                {entries[kind]
                  .sort((a, b) => b.observed - a.observed)
                  .map(({ memory, observed }) => (
                    <li key={memory.id} className="py-3">
                      <p className="whitespace-pre-wrap break-words text-sm">{memory.content}</p>
                      <time
                        className="mt-1 block text-xs text-text-muted"
                        dateTime={new Date(observed).toISOString()}
                      >
                        {new Date(observed).toLocaleString()}
                      </time>
                      <StandInMemoryEvidence memory={memory} />
                    </li>
                  ))}
              </ul>
            </section>
          )
      )}
    </section>
  )
}
