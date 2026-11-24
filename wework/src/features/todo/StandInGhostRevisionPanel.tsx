import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi, StandInGhostRevision, StandInLearningReport } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button } from '@wegent/collaboration/markdown/Button'
import { StandInSettingsError } from './StandInSettingsLayout'

function LearningSummary({
  report,
  identityName,
}: {
  report: StandInLearningReport
  identityName: string
}) {
  const { t, i18n } = useTranslation('common')
  const language = i18n.resolvedLanguage
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 })
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
  const { latest } = report
  const metrics = [
    ['iterations', report.iterations],
    ['current_score', latest?.currentScore],
    ['baseline_score', latest?.baselineScore],
    ['candidate_score', latest?.candidateScore],
  ] as const
  return (
    <section className="space-y-3 py-2 text-sm" data-testid="stand-in-learning-report">
      <p className="break-words font-medium" data-testid="stand-in-learning-identity">
        {identityName}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {metrics.map(([key, value]) => (
          <div key={key}>
            <dt className="text-text-secondary">{t(`standIn.workspace.learning_report.${key}`)}</dt>
            <dd className="text-lg tabular-nums" data-testid={`stand-in-learning-${key}`}>
              {value == null
                ? t('standIn.workspace.learning_report.unavailable')
                : number.format(value)}
            </dd>
          </div>
        ))}
      </dl>
      {latest ? (
        <>
          <p className="flex flex-wrap gap-x-2">
            <span>{t(`standIn.workspace.learning_report.status.${latest.status}`)}</span>
            <time className="text-text-secondary" dateTime={latest.evaluatedAt}>
              {t('standIn.workspace.learning_report.evaluated_at', {
                date: date.format(new Date(latest.evaluatedAt)),
              })}
            </time>
          </p>
          <p className="text-text-secondary">
            {latest.sampleCount == null
              ? t('standIn.workspace.learning_report.no_score')
              : t('standIn.workspace.learning_report.score_help', {
                  count: latest.sampleCount,
                })}
          </p>
        </>
      ) : (
        <p className="text-text-secondary">{t('standIn.workspace.learning_report.empty')}</p>
      )}
    </section>
  )
}

export function StandInGhostRevisionPanel({
  api,
  userId,
  deviceId,
  roleId,
  identityName,
  requestLeave,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  roleId?: string
  identityName: string
  requestLeave(action: () => void): void
}) {
  const { t } = useTranslation('common')
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId, deviceId, roleId]), () =>
        api.learningReport(userId, deviceId, roleId)
      ),
    [api, userId, deviceId, roleId]
  )
  const {
    data: report,
    status,
    error: loadError,
  } = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const revision = report?.revision
  const [busy, setBusy] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const undo = async (reviewed: StandInGhostRevision) => {
    setBusy(true)
    setUndoError(null)
    try {
      await api.resolveProposal(userId, deviceId, reviewed.id, true, reviewed.version)
      await resource.reload()
    } catch (cause) {
      setUndoError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2">
      {(status === 'idle' || status === 'loading') && (
        <p role="status" className="text-sm text-text-secondary">
          {t('standIn.loading')}
        </p>
      )}
      <StandInSettingsError
        error={loadError === undefined ? null : getStandInErrorMessage(loadError)}
        retry={{ testId: 'stand-in-ghost-revision-retry', onClick: () => void resource.reload() }}
      />
      <StandInSettingsError error={undoError} />
      {report && <LearningSummary report={report} identityName={identityName} />}
      {report && status !== 'error' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8"
          data-testid="stand-in-learning-report-refresh"
          disabled={busy || status === 'loading'}
          onClick={() => void resource.reload()}
        >
          {t('standIn.workspace.learning_report.refresh')}
        </Button>
      )}
      {status === 'ready' && revision && (
        <div
          className="mt-4 space-y-2 border-t border-border py-3 text-sm"
          data-testid="stand-in-ghost-revision"
        >
          <h3 className="font-medium">{t('standIn.workspace.ghost_revision')}</h3>
          <p className="text-xs text-text-muted">{t('standIn.workspace.ghost_current')}</p>
          <p className="whitespace-pre-wrap break-words">{revision.after}</p>
          <p className="text-xs text-text-muted">{t('standIn.workspace.ghost_restore_to')}</p>
          <p className="whitespace-pre-wrap break-words">
            {revision.before || t('standIn.workspace.ghost_empty_prompt')}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-8"
            data-testid="stand-in-ghost-revision-undo"
            disabled={busy}
            onClick={() => requestLeave(() => void undo(revision))}
          >
            {t('standIn.workspace.ghost_undo')}
          </Button>
        </div>
      )}
    </div>
  )
}
