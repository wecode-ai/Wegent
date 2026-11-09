import type { StandInMemory } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInMemoryEvidence({ memory }: { memory: StandInMemory }) {
  const { t } = useTranslation('common')
  const evidence = memory.evidence
  if (!evidence?.excerpt) return null
  const source = evidence.taskId
  const speaker =
    evidence.role === 'user'
      ? t('standIn.memory.evidence_user')
      : evidence.role === 'assistant'
        ? t('standIn.memory.evidence_assistant')
        : t('standIn.memory.evidence_source')
  return (
    <details className="mt-2 text-sm" data-testid="stand-in-memory-evidence">
      <summary
        className="min-h-11 cursor-pointer py-2 text-text-secondary md:min-h-8 md:py-1"
        data-testid="stand-in-memory-evidence-toggle"
      >
        {t('standIn.memory.evidence')}
      </summary>
      <p className="break-words text-xs text-text-muted">
        {speaker}
        {source ? ` · ${source}` : ''}
      </p>
      <blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-border pl-3">
        {evidence.excerpt}
      </blockquote>
    </details>
  )
}
