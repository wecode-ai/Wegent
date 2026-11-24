import type { StandInExecutorApi, StandInReworkComparison } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { useMemo, useSyncExternalStore } from 'react'
import { StandInSettingsError } from './StandInSettingsLayout'

function VersionComparison({ comparison }: { comparison: StandInReworkComparison }) {
  const { t, i18n } = useTranslation('common')
  if (comparison.status === 'insufficient') return <p>{t('standIn.memory.rework_insufficient')}</p>
  const points = (difference: number) =>
    (difference * 100).toLocaleString(i18n.language, { maximumSignificantDigits: 3 })
  return (
    <div className="space-y-1">
      <p>
        {t(`standIn.memory.rework_${comparison.status}`, {
          dimension: comparison.dimension === 'memory' ? 'Memory' : 'Ghost',
        })}
      </p>
      <p className="text-xs text-text-muted">
        {t('standIn.memory.rework_difference', {
          sources: comparison.matchedSources,
          baselineId: comparison.baselineVersion.slice(-10),
          currentId: comparison.currentVersion.slice(-10),
          baseline: comparison.baselineRequests,
          current: comparison.currentRequests,
          difference: points(comparison.difference),
          lower: points(comparison.lowerBound),
          upper: points(comparison.upperBound),
        })}
      </p>
    </div>
  )
}

export function StandInReworkReview({
  api,
  userId,
  deviceId,
  roleId,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  roleId: string
}) {
  const { t, i18n } = useTranslation('common')
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId, deviceId, roleId]), () =>
        api.reworkReport(userId, deviceId, roleId)
      ),
    [api, userId, deviceId, roleId]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const report = snapshot.data
  const memoryComparison =
    report?.memoryComparison?.status !== 'insufficient' ? report?.memoryComparison : null
  return (
    <section data-testid="stand-in-rework-review" className="space-y-2 pb-5 text-sm">
      <h3 className="font-semibold">{t('standIn.memory.rework_title')}</h3>
      {snapshot.status === 'error' ? (
        <StandInSettingsError
          error={getStandInErrorMessage(snapshot.error)}
          retry={{ testId: 'stand-in-rework-retry', onClick: () => void resource.reload() }}
        />
      ) : !report ? (
        <p role="status" className="text-text-muted">
          {t('standIn.loading')}
        </p>
      ) : (
        <>
          <p>
            {report.completeRequests
              ? t('standIn.memory.rework_count', {
                  hours: report.windowHours,
                  total: report.completeRequests,
                  reworked: report.ownerReworkRequests,
                })
              : t('standIn.memory.rework_empty', { hours: report.windowHours })}
          </p>
          {!!report.outsideRateReworkRequests && (
            <p className="text-sm">
              {t('standIn.memory.rework_confirmed', {
                total: report.confirmedReworkRequests,
                outside: report.outsideRateReworkRequests,
              })}
            </p>
          )}
          {report.pendingRequests + report.incompleteRequests + report.unattributedRequests > 0 && (
            <p className="text-xs text-text-muted">
              {t('standIn.memory.rework_excluded', {
                pending: report.pendingRequests,
                incomplete: report.incompleteRequests,
                unattributed: report.unattributedRequests,
              })}
            </p>
          )}
          {report.comparison.status === 'insufficient' && memoryComparison ? (
            <p>{t('standIn.memory.rework_ghost_insufficient')}</p>
          ) : (
            <VersionComparison comparison={report.comparison} />
          )}
          {memoryComparison && <VersionComparison comparison={memoryComparison} />}
          {report.completeRequests > 0 && (
            <p className="text-xs text-text-muted">{t('standIn.memory.rework_scope')}</p>
          )}
          {report.lastBackgroundVerifiedAt && (
            <p className="text-xs text-text-muted">
              <time dateTime={report.lastBackgroundVerifiedAt}>
                {t('standIn.memory.rework_verified', {
                  at: new Date(report.lastBackgroundVerifiedAt).toLocaleString(i18n.language),
                })}
              </time>
            </p>
          )}
        </>
      )}
    </section>
  )
}
