import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from '@wegent/collaboration/controls/Collapsible'
import type { StandInMemory } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInMemoryEvidence({ memory }: { memory: StandInMemory }) {
  const { t } = useTranslation('common')
  const evidence = memory.evidence
  if (!evidence?.excerpt) return null
  const trainingCase =
    evidence.trainingCase?.kind === 'observation' ? undefined : evidence.trainingCase
  const source =
    evidence.trainingCase?.kind === 'observation'
      ? (evidence.trainingCase.source?.name ?? evidence.trainingCase.source?.id)
      : evidence.taskId
  const speaker =
    evidence.role === 'user'
      ? t('standIn.memory.evidence_user')
      : evidence.role === 'assistant'
        ? t('standIn.memory.evidence_assistant')
        : t('standIn.memory.evidence_source')
  return (
    <CollapsibleRoot className="mt-2 text-sm" data-testid="stand-in-memory-evidence">
      <CollapsibleTrigger
        className="min-h-11 cursor-pointer py-2 text-text-secondary md:min-h-8 md:py-1"
        data-testid="stand-in-memory-evidence-toggle"
      >
        {trainingCase ? t('standIn.memory.work_example') : t('standIn.memory.evidence')}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {trainingCase ? (
          <dl className="space-y-2">
            {[
              [t('standIn.memory.example_context'), trainingCase.scene],
              [t('standIn.memory.example_reply'), trainingCase.actual],
              [t('standIn.memory.example_reference'), trainingCase.expected],
            ].map(
              ([label, value]) =>
                value && (
                  <div key={label}>
                    <dt className="text-xs text-text-muted">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{value}</dd>
                  </div>
                )
            )}
          </dl>
        ) : (
          <>
            <p className="break-words text-xs text-text-muted">
              {speaker}
              {source ? ` · ${source}` : ''}
            </p>
            <blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-border pl-3">
              {evidence.excerpt}
            </blockquote>
          </>
        )}
      </CollapsiblePanel>
    </CollapsibleRoot>
  )
}
