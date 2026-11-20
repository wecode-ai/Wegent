import type { ProjectCoordinationBinding, StandInExecutorApi } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { createProjectCoordinationResource } from './projectCoordinationResource'

type ProjectCoordinationPanelProps = {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  projectId: string
  projectStore: 'local' | 'cloud'
  groupId: string
  leaderName?: string
  onOpenIssue(issueId: string): void
}

export function ProjectCoordinationPanel(props: ProjectCoordinationPanelProps) {
  const [owner, setOwner] = useState({ api: props.api, revision: 0 })
  if (owner.api !== props.api) setOwner({ api: props.api, revision: owner.revision + 1 })
  const key = JSON.stringify([
    owner.revision,
    props.userId,
    props.deviceId,
    props.projectId,
    props.projectStore,
    props.groupId,
  ])
  return <ProjectCoordinationPanelContent key={key} {...props} />
}

function ProjectCoordinationPanelContent({
  api,
  userId,
  deviceId,
  projectId,
  projectStore,
  groupId,
  leaderName,
  onOpenIssue,
}: ProjectCoordinationPanelProps) {
  const { t } = useTranslation('common')
  const [error, setError] = useState<{ receipt: unknown; message: string }>()
  const [actionError, setActionError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [takeover, setTakeover] = useState<ProjectCoordinationBinding | null>(null)
  const target = useMemo(
    () => ({ projectId, projectStore, groupId }),
    [projectId, projectStore, groupId]
  )
  const resource = useMemo(
    () => createProjectCoordinationResource(api, userId, deviceId, target),
    [api, userId, deviceId, target]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const state = snapshot.data?.state
  const processing = snapshot.data?.processing
  const readError = snapshot.error ?? snapshot.data?.processingError
  const displayedError =
    error && error.receipt === snapshot.data
      ? error.message
      : snapshot.status === 'error' || readError !== undefined
        ? getStandInErrorMessage(readError)
        : undefined
  const binding = state?.binding
  const mine = binding?.enabled && binding.userId === userId && binding.deviceId === deviceId

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
      resource.update(() => ({ state: result }))
      setTakeover(null)
      void resource.reload()
    } catch (cause) {
      setActionError(getStandInErrorMessage(cause))
      // A competing enable/takeover invalidates the displayed generation.
      void resource.reload()
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
          <ControlButton
            variant="primary"
            size="sm"
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
          </ControlButton>
        )}
        {binding?.enabled && state?.canStop && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-coordination-stop"
            disabled={pending}
            onClick={() => void update(false)}
            className="min-h-11 rounded-md px-2 hover:bg-muted disabled:opacity-40 md:min-h-8"
          >
            {t('standIn.project_coordinator.stop_coordination')}
          </ControlButton>
        )}
        {mine && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-coordination-check"
            disabled={pending}
            className="min-h-11 rounded-md px-2 hover:bg-muted disabled:opacity-40 md:min-h-8"
            onClick={async () => {
              setPending(true)
              try {
                const result = await api.projectProcessing(userId, deviceId, target, true)
                resource.update(current =>
                  current ? { ...current, processing: result, processingError: undefined } : current
                )
                setError(undefined)
              } catch (cause) {
                setError({
                  receipt: resource.getSnapshot().data,
                  message: getStandInErrorMessage(cause),
                })
              } finally {
                setPending(false)
              }
            }}
          >
            {t('standIn.project_coordinator.check_coordination')}
          </ControlButton>
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
      {(actionError || displayedError || processing?.error) && (
        <div role="alert" className="mt-2 text-error">
          <p>{actionError ?? displayedError ?? processing?.error}</p>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-coordination-retry"
            className="min-h-11 underline md:min-h-8"
            onClick={() => void resource.reload()}
          >
            {t('standIn.reload')}
          </ControlButton>
        </div>
      )}
      {processing &&
        Object.values(processing.questions ?? {}).map(question => (
          <div key={question.issueId} className="mt-2 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-words">{question.question}</p>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`project-coordination-question-${question.issueId}`}
              className="min-h-11 underline md:min-h-8"
              onClick={() => onOpenIssue(question.issueId)}
            >
              {t('standIn.project_coordinator.answer_in_issue')}
            </ControlButton>
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
