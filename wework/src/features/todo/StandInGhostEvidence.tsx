import type { StandInProposal } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'

export function StandInGhostEvidence({
  training,
  resolved,
}: {
  training: NonNullable<StandInProposal['training']>
  resolved: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-3 py-3 text-sm" data-testid="stand-in-ghost-evidence">
      <p className="text-text-secondary">{t('standIn.workspace.ghost_applies_to')}</p>
      <div>
        <p className="text-xs text-text-muted">{t('standIn.workspace.before_change')}</p>
        <p className="whitespace-pre-wrap break-words">
          {training.before || t('standIn.workspace.ghost_empty_prompt')}
        </p>
      </div>
      <div>
        <p className="text-xs text-text-muted">{t('standIn.workspace.after_change')}</p>
        <p className="whitespace-pre-wrap break-words">{training.after}</p>
      </div>
      {!resolved && (
        <CollapsibleRoot>
          <CollapsibleTrigger
            data-testid="stand-in-ghost-evidence-toggle"
            className="min-h-11 text-text-secondary md:min-h-8"
          >
            {t('standIn.workspace.ghost_show_evidence')}
          </CollapsibleTrigger>
          <CollapsiblePanel className="divide-y divide-border">
            {training.cases.map(example => {
              const comparison = training.evaluation.find(row => row.caseId === example.id)
              return (
                <dl key={example.id} className="grid gap-1 whitespace-pre-wrap break-words py-2">
                  <dt className="text-xs text-text-muted">{t('standIn.workspace.ghost_scene')}</dt>
                  <dd>{example.scene}</dd>
                  {example.actual && (
                    <>
                      <dt className="text-xs text-text-muted">
                        {t('standIn.workspace.ghost_actual')}
                      </dt>
                      <dd>{example.actual}</dd>
                    </>
                  )}
                  <dt className="text-xs text-text-muted">
                    {t('standIn.workspace.ghost_observed')}
                  </dt>
                  <dd>{example.expected}</dd>
                  {comparison && (
                    <>
                      <dt className="text-xs text-text-muted">
                        {t('standIn.workspace.ghost_baseline')}
                      </dt>
                      <dd>{comparison.baseline}</dd>
                      <dt className="text-xs text-text-muted">
                        {t('standIn.workspace.ghost_candidate')}
                      </dt>
                      <dd>{comparison.candidate}</dd>
                      <dt className="text-xs text-text-muted">
                        {t('standIn.workspace.ghost_evaluation')}
                      </dt>
                      <dd>{comparison.reason}</dd>
                      {comparison.confirmationReason && (
                        <>
                          <dt className="text-xs text-text-muted">
                            {t('standIn.workspace.ghost_confirmation_evaluation')}
                          </dt>
                          <dd>{comparison.confirmationReason}</dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
              )
            })}
          </CollapsiblePanel>
        </CollapsibleRoot>
      )}
    </div>
  )
}
