import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRight, RotateCw } from 'lucide-react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi, StandInGhostRevision, StandInLearningReport } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button } from '@wegent/collaboration/markdown/Button'
import { StandInLearningDimensions } from './StandInLearningDimensions'
import { StandInSettingsError } from './StandInSettingsLayout'

function LearningSummary({
  report,
  identityName,
  refresh,
}: {
  report: StandInLearningReport
  identityName: string
  refresh: ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const language = i18n.resolvedLanguage
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 })
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
  const { latest } = report
  const comparison = [
    ['baseline_score', latest?.baselineScore],
    ['candidate_score', latest?.candidateScore],
  ] as const
  const baseline = latest?.baselineScore
  const candidate = latest?.candidateScore
  const change = baseline != null && candidate != null ? candidate - baseline : null
  const unavailable = t('standIn.workspace.learning_report.unavailable')
  const formatScore = (value: number | null | undefined) =>
    value == null ? unavailable : number.format(value)
  const delta = new Intl.NumberFormat(language, {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  })
  return (
    <section className="space-y-4 py-2 text-sm" data-testid="stand-in-learning-report">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-medium" data-testid="stand-in-learning-identity">
          {identityName}
        </p>
        {refresh}
      </div>
      <div className="space-y-4 rounded-xl bg-muted p-4">
        {latest && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-base font-medium">
              {t('standIn.workspace.learning_report.comparison')}
            </h3>
            {change != null && (
              <span
                className="font-medium tabular-nums"
                data-testid="stand-in-learning-score-change"
              >
                {t('standIn.workspace.learning_report.score_change', {
                  points: delta.format(change),
                })}
              </span>
            )}
          </div>
        )}
        {!latest && (
          <p className="text-text-secondary">{t('standIn.workspace.learning_report.empty')}</p>
        )}
        <div className="relative">
          <dl className={change == null ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-2 gap-10'}>
            {comparison.map(([key, value], index) => (
              <div key={key}>
                <dt className="text-text-secondary">
                  {t(`standIn.workspace.learning_report.${key}`)}
                </dt>
                <dd className="mt-1">
                  <span
                    className={value == null ? 'text-text-secondary' : 'heading-lg tabular-nums'}
                    data-testid={`stand-in-learning-${key}`}
                  >
                    {formatScore(value)}
                  </span>
                  {value != null && (
                    <span
                      aria-hidden="true"
                      className="mt-2 block h-1 rounded-full bg-text-primary/10"
                    >
                      <span
                        className={
                          index === 1
                            ? 'block h-full rounded-full bg-text-primary'
                            : 'block h-full rounded-full bg-text-primary/50'
                        }
                        style={{ width: `${value}%` }}
                      />
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {change != null && (
            <ArrowRight
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-text-secondary"
            />
          )}
        </div>
        {latest && (
          <p className="flex flex-wrap gap-x-2 border-t border-border pt-3 text-xs">
            <span className="font-medium">
              {t(`standIn.workspace.learning_report.status.${latest.status}`)}
            </span>
            <time className="text-text-secondary" dateTime={latest.evaluatedAt}>
              {t('standIn.workspace.learning_report.evaluated_at', {
                date: date.format(new Date(latest.evaluatedAt)),
              })}
            </time>
          </p>
        )}
        {!!latest?.dimensions?.length && <StandInLearningDimensions axes={latest.dimensions} />}
      </div>
      <dl className="grid grid-cols-2 gap-3 border-b border-border pb-4">
        <div>
          <dt className="text-text-secondary">
            {t('standIn.workspace.learning_report.current_score')}
          </dt>
          <dd
            className="mt-1 text-base font-medium tabular-nums"
            data-testid="stand-in-learning-current_score"
          >
            {formatScore(latest?.currentScore)}
          </dd>
        </div>
        <div>
          <dt className="text-text-secondary">
            {t('standIn.workspace.learning_report.iterations')}
          </dt>
          <dd
            className="mt-1 text-base font-medium tabular-nums"
            data-testid="stand-in-learning-iterations"
          >
            {number.format(report.iterations)}
          </dd>
        </div>
      </dl>
      {latest && (
        <p className="text-text-secondary">
          {latest.sampleCount == null
            ? t('standIn.workspace.learning_report.no_score')
            : t('standIn.workspace.learning_report.score_help', {
                count: latest.sampleCount,
              })}
        </p>
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
      {report && (
        <LearningSummary
          report={report}
          identityName={identityName}
          refresh={
            status !== 'error' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11 md:min-h-8"
                data-testid="stand-in-learning-report-refresh"
                disabled={busy || status === 'loading'}
                onClick={() => void resource.reload()}
              >
                <RotateCw aria-hidden="true" className="size-4" />
                {t('standIn.workspace.learning_report.refresh')}
              </Button>
            )
          }
        />
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
