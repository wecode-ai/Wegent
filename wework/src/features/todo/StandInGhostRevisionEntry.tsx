import { useState } from 'react'
import type { StandInExecutorApi, StandInGhostRevision } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button } from '@wegent/collaboration/markdown/Button'
import { StandInSettingsEntry, StandInSettingsError } from './StandInSettingsLayout'

/** Read revisions on demand and bind reversal to the exact settings the owner reviewed. */
export function StandInGhostRevisionEntry({
  api,
  userId,
  deviceId,
  roleId,
  requestLeave,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  roleId?: string
  requestLeave(action: () => void): void
}) {
  const { t } = useTranslation('common')
  const [revision, setRevision] = useState<StandInGhostRevision | null>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      setRevision(await api.latestAppliedGhost(userId, deviceId, roleId))
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      setRevision(undefined)
    } finally {
      setBusy(false)
    }
  }
  const undo = async (reviewed: StandInGhostRevision) => {
    setBusy(true)
    setError(null)
    try {
      await api.resolveProposal(userId, deviceId, reviewed.id, true, reviewed.version)
      setRevision(null)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      setRevision(undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2">
      <StandInSettingsEntry
        testId="stand-in-ghost-revision-open"
        label={t('standIn.workspace.ghost_revision')}
        disabled={busy}
        onClick={() => (revision === undefined ? void load() : setRevision(undefined))}
      />
      <StandInSettingsError error={error} />
      {revision === null && (
        <p className="py-2 text-sm text-text-secondary">
          {t('standIn.workspace.ghost_no_revision')}
        </p>
      )}
      {revision && (
        <div className="space-y-2 py-2 text-sm" data-testid="stand-in-ghost-revision">
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
