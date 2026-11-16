import { useEffect, useState } from 'react'
import type {
  StandInExecutorApi,
  ProjectCoordinationState,
  ProjectCoordinationProcessing,
  ProjectCoordinationBinding,
} from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

export function ProjectCoordinationPanel({
  api,
  userId,
  deviceId,
  projectId,
  projectStore,
  groupId,
  leaderName,
  onOpenIssue,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  projectId: string
  projectStore: 'local' | 'cloud'
  groupId: string
  leaderName?: string
  onOpenIssue(issueId: string): void
}) {
  const { t } = useTranslation('common')
  const [state, setState] = useState<ProjectCoordinationState>()
  const [processing, setProcessing] = useState<ProjectCoordinationProcessing>()
  const [error, setError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [takeover, setTakeover] = useState<ProjectCoordinationBinding | null>(null)
  const [revision, setRevision] = useState(0)
  const target = { projectId, projectStore, groupId }
  const binding = state?.binding
  const mine = binding?.enabled && binding.userId === userId && binding.deviceId === deviceId
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const target = { projectId, projectStore, groupId }
        const current = await api.projectCoordination(userId, deviceId, target)
        if (!active) return
        setState(current)
        setError(undefined)
        if (
          current.binding?.enabled &&
          current.binding.userId === userId &&
          current.binding.deviceId === deviceId
        ) {
          const result = await api.projectProcessing(userId, deviceId, target)
          if (active) setProcessing(result)
        } else setProcessing(undefined)
      } catch (cause) {
        if (active) setError(getStandInErrorMessage(cause))
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, userId, deviceId, projectId, projectStore, groupId, revision])

  const update = async (enabled: boolean, takingOver = false) => {
    if (!state || pending) return
    setPending(true)
    setActionError(undefined)
    try {
      const result = await api.projectCoordination(userId, deviceId, target, {
        enabled,
        expectedGeneration: takingOver
          ? (takeover?.generation ?? null)
          : (binding?.generation ?? null),
        ...(takingOver ? { takeover: true } : {}),
      })
      setState(result)
      setProcessing(undefined)
      setTakeover(null)
      setRevision(value => value + 1)
    } catch (cause) {
      setActionError(getStandInErrorMessage(cause))
      // A competing enable/takeover invalidates the displayed generation.
      setRevision(value => value + 1)
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="shrink-0 border-b border-border px-5 py-3 text-sm"
      data-testid="project-coordination-panel"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {t('standIn.project_coordinator.coordination', {
            leader: leaderName ?? t('standIn.project_coordinator.leader'),
          })}
        </span>
        <span className="min-w-0 flex-1 break-words text-text-muted" role="status">
          {!state
            ? t('standIn.loading')
            : !binding?.enabled
              ? t('standIn.project_coordinator.coordination_off')
              : mine
                ? t('standIn.project_coordinator.coordination_mine')
                : t('standIn.project_coordinator.coordination_owner', {
                    user: binding.userId,
                    device: binding.deviceId,
                  })}
        </span>
        {state && (!binding?.enabled || !mine) && state.canEnable && (
          <button
            type="button"
            data-testid="project-coordination-enable"
            disabled={pending}
            onClick={() => (binding?.enabled ? setTakeover(binding) : void update(true))}
            className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-40 md:min-h-8"
          >
            {t(
              binding?.enabled
                ? 'standIn.project_coordinator.takeover'
                : 'standIn.project_coordinator.enable_coordination'
            )}
          </button>
        )}
        {binding?.enabled && state?.canStop && (
          <button
            type="button"
            data-testid="project-coordination-stop"
            disabled={pending}
            onClick={() => void update(false)}
            className="min-h-11 rounded-md px-2 hover:bg-muted disabled:opacity-40 md:min-h-8"
          >
            {t('standIn.project_coordinator.stop_coordination')}
          </button>
        )}
        {mine && (
          <button
            type="button"
            data-testid="project-coordination-check"
            disabled={pending}
            className="min-h-11 rounded-md px-2 hover:bg-muted disabled:opacity-40 md:min-h-8"
            onClick={async () => {
              setPending(true)
              try {
                setProcessing(await api.projectProcessing(userId, deviceId, target, true))
                setError(undefined)
              } catch (cause) {
                setError(getStandInErrorMessage(cause))
              } finally {
                setPending(false)
              }
            }}
          >
            {t('standIn.project_coordinator.check_coordination')}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {t('standIn.project_coordinator.coordination_help')}
      </p>
      {processing && !processing.error && (
        <p className="mt-1 text-xs text-text-muted">
          {t(
            processing.running
              ? 'standIn.project_coordinator.coordination_running'
              : 'standIn.project_coordinator.coordination_waiting'
          )}
        </p>
      )}
      {(actionError || error || processing?.error) && (
        <div role="alert" className="mt-2 text-error">
          <p>{actionError ?? error ?? processing?.error}</p>
          <button
            type="button"
            data-testid="project-coordination-retry"
            className="min-h-11 underline md:min-h-8"
            onClick={() => setRevision(value => value + 1)}
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {processing &&
        Object.values(processing.questions ?? {}).map(question => (
          <div key={question.issueId} className="mt-2 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-words">{question.question}</p>
            <button
              type="button"
              data-testid={`project-coordination-question-${question.issueId}`}
              className="min-h-11 underline md:min-h-8"
              onClick={() => onOpenIssue(question.issueId)}
            >
              {t('standIn.project_coordinator.answer_in_issue')}
            </button>
          </div>
        ))}
      <ConfirmDialog
        open={takeover !== null}
        pending={pending}
        title={t('standIn.project_coordinator.takeover_title')}
        description={t('standIn.project_coordinator.takeover_help', {
          user: takeover?.userId,
          device: takeover?.deviceId,
        })}
        cancelLabel={t('standIn.cancel')}
        confirmLabel={t('standIn.project_coordinator.takeover')}
        confirmTestId="project-coordination-takeover-confirm"
        onClose={() => setTakeover(null)}
        onConfirm={() => void update(true, true)}
      />
    </div>
  )
}
