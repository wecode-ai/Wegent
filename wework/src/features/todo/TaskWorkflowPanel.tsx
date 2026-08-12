import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Circle,
  Cloud,
  HardDrive,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type {
  ExecutionActorRef,
  ProjectAgentSquad,
  RepositoryBinding,
  StageRun,
  TaskExecutionBinding,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunDetail,
  createProjectWorkflowApi,
} from '@/api/projectWorkflows'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, Team } from '@/types/api'
import type { createProjectChatAgentApi } from '@/api/projectChatAgents'

type ProjectWorkflowApi = ReturnType<typeof createProjectWorkflowApi>
type ProjectChatAgentApi = ReturnType<typeof createProjectChatAgentApi>

interface TaskWorkflowPanelProps {
  projectId: string
  itemId: string
  currentUserId: number
  api: ProjectWorkflowApi
  projectChatAgentApi?: ProjectChatAgentApi
  teamApi: WorkbenchServices['teamApi']
  deviceApi: WorkbenchServices['deviceApi']
}

type TargetOption =
  | { kind: 'actor'; value: string; label: string; actor: ExecutionActorRef }
  | { kind: 'workflow'; value: string; label: string; workflowId: string }

const activeRunStatuses = new Set(['pending', 'waiting_approval', 'queued', 'running', 'blocked'])

function statusTone(status: string): string {
  if (status === 'passed' || status === 'completed') {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  }
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') {
    return 'bg-destructive/10 text-destructive'
  }
  if (status === 'waiting_approval' || status === 'blocked') {
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
  }
  return 'bg-muted text-text-secondary'
}

function statusIcon(status: string) {
  if (status === 'passed' || status === 'completed') return Check
  if (status === 'running' || status === 'claimed') return LoaderCircle
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return X
  return Circle
}

function actorName(stage: StageRun): string {
  const snapshot = stage.targetSnapshot
  const name = snapshot.name
  return typeof name === 'string' && name ? name : stage.targetId || stage.nodeKey
}

export function TaskWorkflowPanel({
  projectId,
  itemId,
  currentUserId,
  api,
  projectChatAgentApi,
  teamApi,
  deviceApi,
}: TaskWorkflowPanelProps) {
  const { t } = useTranslation('common')
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [squads, setSquads] = useState<ProjectAgentSquad[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [repositories, setRepositories] = useState<RepositoryBinding[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [binding, setBinding] = useState<TaskExecutionBinding | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null)
  const [targetValue, setTargetValue] = useState('')
  const [executionTarget, setExecutionTarget] = useState('managed_container')
  const [repositoryId, setRepositoryId] = useState('')
  const [workspaceMode, setWorkspaceMode] = useState<'current_workspace' | 'git_worktree'>(
    'git_worktree'
  )
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetOptions = useMemo<TargetOption[]>(
    () => [
      ...workflows.map(workflow => ({
        kind: 'workflow' as const,
        value: `workflow:${workflow.id}`,
        label: `${t('workbench.ai_workflow_option_workflow')} · ${workflow.name}`,
        workflowId: workflow.id,
      })),
      ...agents.map(agent => ({
        kind: 'actor' as const,
        value: `project_agent:${agent.id}`,
        label: `${t('workbench.ai_workflow_option_agent')} · ${agent.name}`,
        actor: { type: 'project_agent' as const, id: agent.id },
      })),
      ...squads.map(squad => ({
        kind: 'actor' as const,
        value: `project_squad:${squad.id}`,
        label: `${t('workbench.ai_workflow_option_squad')} · ${squad.name}`,
        actor: { type: 'project_squad' as const, id: squad.id },
      })),
      ...teams
        .filter(team => team.is_active)
        .map(team => ({
          kind: 'actor' as const,
          value: `wegent_team:${team.id}`,
          label: `${t('workbench.ai_workflow_option_team')} · ${team.displayName || team.name}`,
          actor: {
            type: 'wegent_team' as const,
            teamId: team.id,
            namespace: team.namespace || 'default',
            name: team.name,
            userId: team.user_id ?? currentUserId,
          },
        })),
    ],
    [agents, currentUserId, squads, t, teams, workflows]
  )

  const hydrateBinding = useCallback((nextBinding: TaskExecutionBinding | null) => {
    setBinding(nextBinding)
    if (!nextBinding) {
      setTargetValue('')
      setExecutionTarget('managed_container')
      setRepositoryId('')
      setWorkspaceMode('git_worktree')
      return
    }
    setTargetValue(`${nextBinding.targetType}:${nextBinding.targetId}`)
    setExecutionTarget(
      nextBinding.executionTarget.type === 'registered_device'
        ? `registered_device:${nextBinding.executionTarget.id || ''}`
        : 'managed_container'
    )
    setRepositoryId(nextBinding.repositoryBindingId || '')
    setWorkspaceMode(nextBinding.workspaceMode)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [
        nextAgents,
        nextSquads,
        nextTeams,
        nextDevices,
        nextRepositories,
        nextWorkflows,
        nextBinding,
        nextRuns,
      ] = await Promise.all([
        projectChatAgentApi?.list(projectId) ?? Promise.resolve([]),
        api.listSquads(projectId),
        teamApi.listTeams(),
        deviceApi.listDevices(),
        api.listRepositories(projectId),
        api.listWorkflows(projectId),
        api.getTaskBinding(projectId, itemId),
        api.listRuns(projectId, itemId),
      ])
      setAgents(nextAgents)
      setSquads(nextSquads)
      setTeams(nextTeams)
      setDevices(nextDevices)
      setRepositories(nextRepositories)
      setWorkflows(nextWorkflows)
      hydrateBinding(nextBinding)
      setRuns(nextRuns)
      const latest = nextRuns[0]
      setDetail(latest ? await api.getRun(projectId, itemId, latest.id) : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.ai_workflow_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [api, deviceApi, hydrateBinding, itemId, projectChatAgentApi, projectId, t, teamApi])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (!detail || !activeRunStatuses.has(detail.status)) return
    const timer = window.setInterval(() => {
      void api
        .getRun(projectId, itemId, detail.id)
        .then(setDetail)
        .catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [api, detail, itemId, projectId])

  async function saveBinding(start: boolean) {
    const selected = targetOptions.find(option => option.value === targetValue)
    if (!selected) {
      setError(t('workbench.ai_workflow_target_required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const target =
        executionTarget === 'managed_container'
          ? { type: 'managed_container' as const }
          : {
              type: 'registered_device' as const,
              id: executionTarget.slice('registered_device:'.length),
            }
      const nextBinding = await api.upsertTaskBinding(projectId, itemId, {
        ...(binding ? { version: binding.version } : {}),
        ...(selected.kind === 'actor'
          ? { actor: selected.actor }
          : { workflowId: selected.workflowId }),
        ...(repositoryId ? { repositoryBindingId: repositoryId } : {}),
        executionTarget: target,
        workspaceMode,
      })
      hydrateBinding(nextBinding)
      setEditing(false)
      if (start) await startRun()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.ai_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function startRun() {
    setBusy(true)
    setError(null)
    try {
      const started = await api.startRun(projectId, itemId, crypto.randomUUID())
      const nextDetail = await api.getRun(projectId, itemId, started.id)
      setRuns(current => [started, ...current.filter(run => run.id !== started.id)])
      setDetail(nextDetail)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.ai_workflow_start_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function runStageAction(stage: StageRun, action: 'approve' | 'reject' | 'retry') {
    setBusy(true)
    setError(null)
    try {
      const next =
        action === 'approve'
          ? await api.approveStage(projectId, itemId, detail!.id, stage.id, stage.version)
          : action === 'reject'
            ? await api.rejectStage(projectId, itemId, detail!.id, stage.id, stage.version)
            : await api.retryStage(projectId, itemId, detail!.id, stage.id, stage.version)
      setDetail(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.ai_workflow_action_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun() {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      setDetail(await api.cancelRun(projectId, itemId, detail.id, detail.version))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.ai_workflow_action_failed'))
    } finally {
      setBusy(false)
    }
  }

  const selectedLabel =
    targetOptions.find(option => option.value === targetValue)?.label ||
    t('workbench.ai_workflow_target_placeholder')
  const showConfiguration = editing || !binding

  return (
    <section
      data-testid="task-workflow-panel"
      className="mt-5 overflow-hidden rounded-xl border border-border bg-background"
    >
      <header className="flex min-h-11 items-center gap-2 border-b border-border px-3">
        <Workflow className="h-4 w-4 text-text-secondary" />
        <h3 className="text-sm font-medium text-text-primary">
          {t('workbench.ai_workflow_title')}
        </h3>
        {detail ? (
          <span
            data-testid="task-workflow-status"
            data-status={detail.status}
            className={cn(
              'ml-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
              statusTone(detail.status)
            )}
          >
            {t(`workbench.ai_workflow_status_${detail.status}`)}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          data-testid="task-workflow-refresh"
          onClick={() => void load()}
          disabled={loading || busy}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-40"
          aria-label={t('workbench.ai_workflow_refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </header>

      <div className="p-3">
        {loading ? (
          <div className="flex h-20 items-center justify-center gap-2 text-sm text-text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('workbench.ai_workflow_loading')}
          </div>
        ) : showConfiguration ? (
          <div data-testid="task-workflow-configuration" className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-secondary">
                {t('workbench.ai_workflow_execution_actor')}
              </span>
              <span className="relative block">
                <select
                  data-testid="task-workflow-actor"
                  value={targetValue}
                  onChange={event => setTargetValue(event.target.value)}
                  className="h-9 w-full appearance-none rounded-lg border border-border bg-background px-3 pr-8 text-sm text-text-primary outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">{t('workbench.ai_workflow_target_placeholder')}</option>
                  {targetOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-text-muted" />
              </span>
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  {t('workbench.ai_workflow_execution_target')}
                </span>
                <select
                  data-testid="task-workflow-execution-target"
                  value={executionTarget}
                  onChange={event => setExecutionTarget(event.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="managed_container">
                    {t('workbench.ai_workflow_managed_container')}
                  </option>
                  {devices.map(device => (
                    <option key={device.device_id} value={`registered_device:${device.device_id}`}>
                      {t('workbench.ai_workflow_registered_device')} · {device.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  {t('workbench.ai_workflow_workspace_mode')}
                </span>
                <select
                  data-testid="task-workflow-workspace-mode"
                  value={workspaceMode}
                  onChange={event => setWorkspaceMode(event.target.value as typeof workspaceMode)}
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="git_worktree">
                    {t('workbench.ai_workflow_workspace_worktree')}
                  </option>
                  <option value="current_workspace">
                    {t('workbench.ai_workflow_workspace_current')}
                  </option>
                </select>
              </label>
            </div>
            {repositories.length ? (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  {t('workbench.ai_workflow_repository')}
                </span>
                <select
                  data-testid="task-workflow-repository"
                  value={repositoryId}
                  onChange={event => setRepositoryId(event.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">{t('workbench.ai_workflow_repository_none')}</option>
                  {repositories.map(repository => (
                    <option key={repository.id} value={repository.id}>
                      {repository.repositoryIdentity}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              {binding ? (
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted"
                >
                  {t('workbench.cancel')}
                </button>
              ) : null}
              <button
                type="button"
                data-testid="task-workflow-save"
                disabled={busy || !targetValue}
                onClick={() => void saveBinding(false)}
                className="h-8 rounded-lg bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:opacity-40"
              >
                {t('workbench.ai_workflow_save')}
              </button>
              <button
                type="button"
                data-testid="task-workflow-save-start"
                disabled={busy || !targetValue}
                onClick={() => void saveBinding(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                {t('workbench.ai_workflow_save_start')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-text-primary">
                {binding?.targetType === 'project_squad' ? (
                  <Users className="h-3.5 w-3.5" />
                ) : binding?.targetType === 'workflow' ? (
                  <Workflow className="h-3.5 w-3.5" />
                ) : (
                  <Bot className="h-3.5 w-3.5" />
                )}
                {selectedLabel}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-text-secondary">
                {binding?.executionTarget.type === 'managed_container' ? (
                  <Cloud className="h-3.5 w-3.5" />
                ) : (
                  <HardDrive className="h-3.5 w-3.5" />
                )}
                {binding?.executionTarget.type === 'managed_container'
                  ? t('workbench.ai_workflow_managed_container')
                  : binding?.executionTarget.id}
              </span>
              <button
                type="button"
                data-testid="task-workflow-edit"
                onClick={() => setEditing(true)}
                className="ml-auto h-7 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted"
              >
                {t('workbench.ai_workflow_edit')}
              </button>
              <button
                type="button"
                data-testid="task-workflow-start"
                disabled={busy || Boolean(detail && activeRunStatuses.has(detail.status))}
                onClick={() => void startRun()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                {t('workbench.ai_workflow_start')}
              </button>
            </div>

            {detail ? (
              <div className="mt-3 space-y-2">
                {detail.stages.map(stage => {
                  const StatusIcon = statusIcon(stage.status)
                  return (
                    <div
                      key={`${stage.id}:${stage.attempt}`}
                      data-testid={`task-workflow-stage-${stage.id}`}
                      data-node-key={stage.nodeKey}
                      data-stage-status={stage.status}
                      className="rounded-lg border border-border px-3 py-2.5"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                            statusTone(stage.status)
                          )}
                        >
                          <StatusIcon
                            className={cn(
                              'h-3.5 w-3.5',
                              ['running', 'claimed'].includes(stage.status) && 'animate-spin'
                            )}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary">
                            {actorName(stage)}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {stage.groupKey} · {stage.nodeKey} ·{' '}
                            {t(`workbench.ai_workflow_stage_status_${stage.status}`)}
                            {stage.attempt > 1 ? ` · #${stage.attempt}` : ''}
                          </span>
                          {stage.failureMessage ? (
                            <span className="mt-1 block text-xs text-destructive">
                              {stage.failureMessage}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {stage.status === 'waiting_approval' ? (
                            <>
                              <button
                                type="button"
                                data-testid={`task-workflow-stage-reject-${stage.id}`}
                                disabled={busy}
                                onClick={() => void runStageAction(stage, 'reject')}
                                className="h-7 rounded-lg px-2 text-xs text-destructive hover:bg-destructive/10"
                              >
                                {t('workbench.ai_workflow_reject')}
                              </button>
                              <button
                                type="button"
                                data-testid={`task-workflow-stage-approve-${stage.id}`}
                                disabled={busy}
                                onClick={() => void runStageAction(stage, 'approve')}
                                className="inline-flex h-7 items-center gap-1 rounded-lg bg-text-primary px-2 text-xs font-medium text-background hover:opacity-90"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                {t('workbench.ai_workflow_approve')}
                              </button>
                            </>
                          ) : null}
                          {stage.status === 'failed' ? (
                            <button
                              type="button"
                              data-testid={`task-workflow-stage-retry-${stage.id}`}
                              disabled={busy}
                              onClick={() => void runStageAction(stage, 'retry')}
                              className="inline-flex h-7 items-center gap-1 rounded-lg bg-muted px-2 text-xs font-medium text-text-primary hover:bg-hover"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {t('workbench.ai_workflow_retry')}
                            </button>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  )
                })}
                {detail.artifacts.length ? (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {detail.artifacts.map(artifact => (
                      <span
                        key={artifact.id}
                        className="rounded-md bg-muted px-2 py-1 text-xs text-text-secondary"
                      >
                        {artifact.artifactType}
                      </span>
                    ))}
                  </div>
                ) : null}
                {activeRunStatuses.has(detail.status) ? (
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      data-testid="task-workflow-cancel"
                      disabled={busy}
                      onClick={() => void cancelRun()}
                      className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-destructive hover:bg-destructive/10"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      {t('workbench.ai_workflow_stop')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : runs.length ? null : (
              <p className="mt-3 text-sm text-text-muted">{t('workbench.ai_workflow_no_runs')}</p>
            )}
          </>
        )}
        {error ? (
          <p data-testid="task-workflow-error" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
