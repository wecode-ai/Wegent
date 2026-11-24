import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi, StandInGhostRevision } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button } from '@wegent/collaboration/markdown/Button'
import { StandInSettingsError } from './StandInSettingsLayout'

/** Read revisions on demand and bind reversal to the exact settings the owner reviewed. */
export function StandInGhostRevisionPanel({
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
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId, deviceId, roleId]), () =>
        api.latestAppliedGhost(userId, deviceId, roleId)
      ),
    [api, userId, deviceId, roleId]
  )
  const {
    data: revision,
    status,
    error: loadError,
  } = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const [busy, setBusy] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const undo = async (reviewed: StandInGhostRevision) => {
    setBusy(true)
    setUndoError(null)
    try {
      await api.resolveProposal(userId, deviceId, reviewed.id, true, reviewed.version)
      resource.update(() => null)
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
      {revision === null && (
        <p className="py-2 text-sm text-text-secondary">
          {t('standIn.workspace.ghost_no_revision')}
        </p>
      )}
      {status === 'ready' && revision && (
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
