import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  Users,
  Workflow,
} from 'lucide-react'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type {
  ProjectAgentSquad,
  RepositoryBinding,
  SquadRoutePreview,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType,
  createProjectWorkflowApi,
} from '@/api/projectWorkflows'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'

type ProjectWorkflowApi = ReturnType<typeof createProjectWorkflowApi>

import {
  actorValue,
  defaultStages,
  emptyNode,
  emptyRepositoryDraft,
  emptySquadDraft,
  emptyWorkflowDraft,
  type ActorChoice,
} from './projectWorkflowDrafts'
import { ProjectRepositoriesSection } from './ProjectRepositoriesSection'

interface ProjectDevelopmentWorkflowSectionProps {
  projectId: string
  api: ProjectWorkflowApi
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  teamApi: WorkbenchServices['teamApi']
  canManage: boolean
  currentUserId: number
}

function SectionHeader({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Users
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        <Icon className="h-4 w-4 text-text-secondary" />
      </span>
      <span className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        <p className="mt-0.5 text-xs text-text-muted">{description}</p>
      </span>
      {action}
    </header>
  )
}

export function ProjectDevelopmentWorkflowSection({
  projectId,
  api,
  projectChatAgentApi,
  teamApi,
  canManage,
  currentUserId,
}: ProjectDevelopmentWorkflowSectionProps) {
  const { t } = useTranslation('common')
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [squads, setSquads] = useState<ProjectAgentSquad[]>([])
  const [repositories, setRepositories] = useState<RepositoryBinding[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationIssues, setValidationIssues] = useState<string[]>([])
  const [routePreviewTask, setRoutePreviewTask] = useState('')
  const [routePreviewSquadId, setRoutePreviewSquadId] = useState<string | null>(null)
  const [routePreview, setRoutePreview] = useState<SquadRoutePreview | null>(null)
  const [squadDraft, setSquadDraft] = useState(emptySquadDraft)
  const [repositoryDraft, setRepositoryDraft] = useState(emptyRepositoryDraft)
  const [workflowDraft, setWorkflowDraft] = useState(emptyWorkflowDraft)

  const actorChoices = useMemo<ActorChoice[]>(
    () => [
      ...agents.map(agent => ({
        value: `project_agent:${agent.id}`,
        label: `${t('workbench.ai_workflow_option_agent')} · ${agent.name}`,
        actor: { type: 'project_agent' as const, id: agent.id },
      })),
      ...squads
        .filter(squad => squad.status === 'active')
        .map(squad => ({
          value: `project_squad:${squad.id}`,
          label: `${t('workbench.ai_workflow_option_squad')} · ${squad.name}`,
          actor: { type: 'project_squad' as const, id: squad.id },
        })),
      ...teams
        .filter(team => team.is_active)
        .map(team => ({
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
    [agents, currentUserId, squads, t, teams]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextAgents, nextTeams, nextSquads, nextRepositories, nextWorkflows] =
        await Promise.all([
          projectChatAgentApi?.list(projectId) ?? Promise.resolve([]),
          teamApi.listTeams(),
          api.listSquads(projectId),
          api.listRepositories(projectId),
          api.listWorkflows(projectId),
        ])
      setAgents(nextAgents)
      setTeams(nextTeams)
      setSquads(nextSquads)
      setRepositories(nextRepositories)
      setWorkflows(nextWorkflows)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [api, projectChatAgentApi, projectId, t, teamApi])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (workflowDraft.stages.length || !actorChoices.length) return
    const timer = window.setTimeout(() => {
      setWorkflowDraft(current => ({
        ...current,
        stages: current.stages.length ? current.stages : defaultStages(actorChoices[0].actor),
      }))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [actorChoices, workflowDraft.stages.length])

  async function createSquad() {
    if (!squadDraft.name.trim() || !squadDraft.leaderAgentId || !squadDraft.memberAgentIds.length)
      return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createSquad(projectId, {
        ...squadDraft,
        name: squadDraft.name.trim(),
        routingInstructions: squadDraft.routingInstructions.trim(),
      })
      setSquads(current => [...current, created])
      setSquadDraft(emptySquadDraft())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function archiveSquad(squad: ProjectAgentSquad) {
    setBusy(true)
    try {
      const updated = await api.updateSquad(projectId, squad.id, {
        version: squad.version,
        status: 'archived',
      })
      setSquads(current => current.map(entry => (entry.id === updated.id ? updated : entry)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function previewSquadRoute(squad: ProjectAgentSquad) {
    if (!routePreviewTask.trim()) return
    setBusy(true)
    setError(null)
    try {
      const preview = await api.previewSquadRoute(projectId, squad.id, routePreviewTask.trim())
      setRoutePreview(preview)
      setRoutePreviewSquadId(squad.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_load_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function createRepository() {
    if (!repositoryDraft.repositoryIdentity.trim() || !repositoryDraft.repositoryUrl.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createRepository(projectId, {
        provider: repositoryDraft.provider,
        repositoryIdentity: repositoryDraft.repositoryIdentity.trim(),
        repositoryUrl: repositoryDraft.repositoryUrl.trim(),
        defaultBranch: repositoryDraft.defaultBranch.trim(),
        ...(repositoryDraft.credentialRef.trim()
          ? { credentialRef: repositoryDraft.credentialRef.trim() }
          : {}),
        workspacePolicy: {
          mode: 'git_worktree',
          cleanup: 'after_merge',
        },
        gitPolicy: {
          branchPattern: repositoryDraft.branchPattern.trim(),
          pullRequestBase: repositoryDraft.pullRequestBase.trim(),
          autoCreatePullRequest: repositoryDraft.autoCreatePullRequest,
          autoMerge: repositoryDraft.autoMerge,
          mergeStrategy: repositoryDraft.mergeStrategy,
        },
        providerSettings: {},
      })
      setRepositories(current => [...current, created])
      setRepositoryDraft(current => ({
        ...current,
        repositoryIdentity: '',
        repositoryUrl: '',
        credentialRef: '',
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function archiveRepository(repository: RepositoryBinding) {
    setBusy(true)
    try {
      const updated = await api.updateRepository(projectId, repository.id, {
        version: repository.version,
        status: 'archived',
      })
      setRepositories(current => current.map(entry => (entry.id === updated.id ? updated : entry)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function validateRepository(repository: RepositoryBinding) {
    setBusy(true)
    setError(null)
    try {
      const validation = await api.validateRepository(projectId, repository.id)
      setValidationIssues(validation.issues)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  function updateNode(groupIndex: number, nodeIndex: number, patch: Partial<WorkflowNode>) {
    setWorkflowDraft(current => ({
      ...current,
      stages: current.stages.map((group, currentGroupIndex) =>
        currentGroupIndex === groupIndex
          ? {
              ...group,
              nodes: group.nodes.map((node, currentNodeIndex) =>
                currentNodeIndex === nodeIndex ? { ...node, ...patch } : node
              ),
            }
          : group
      ),
    }))
  }

  function updateNodeType(groupIndex: number, nodeIndex: number, type: WorkflowNodeType) {
    const actor = actorChoices[0]?.actor
    updateNode(groupIndex, nodeIndex, {
      type,
      actor: type === 'agent' ? actor : undefined,
      condition:
        type === 'human_gate'
          ? 'human_approved'
          : type === 'ci_gate'
            ? 'ci_passed'
            : type === 'merge'
              ? 'pr_merged'
              : undefined,
      requiredOutputs: type === 'agent' ? ['execution_result'] : [],
    })
  }

  function addGroup() {
    setWorkflowDraft(current => {
      const index = current.stages.length + 1
      return {
        ...current,
        stages: [
          ...current.stages,
          {
            key: `stage-${index}`,
            name: `${t('workbench.dev_workflow_stage')} ${index}`,
            execution: 'serial',
            completion: 'all',
            nodes: [emptyNode(1, actorChoices[0]?.actor)],
          },
        ],
      }
    })
  }

  function moveGroup(index: number, direction: -1 | 1) {
    setWorkflowDraft(current => {
      const target = index + direction
      if (target < 0 || target >= current.stages.length) return current
      const stages = [...current.stages]
      ;[stages[index], stages[target]] = [stages[target], stages[index]]
      return { ...current, stages }
    })
  }

  async function createWorkflow() {
    if (
      !workflowDraft.name.trim() ||
      !workflowDraft.stages.length ||
      workflowDraft.stages.some(group =>
        group.nodes.some(node => node.type === 'agent' && !node.actor)
      )
    )
      return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createWorkflow(projectId, {
        name: workflowDraft.name.trim(),
        description: workflowDraft.description.trim(),
        triggerMode: workflowDraft.triggerMode,
        ...(workflowDraft.repositoryBindingId
          ? { repositoryBindingId: workflowDraft.repositoryBindingId }
          : {}),
        stages: workflowDraft.stages,
        failurePolicy: workflowDraft.failurePolicy,
        isDefault: workflowDraft.isDefault,
      })
      setWorkflows(current => [
        ...current.map(workflow =>
          created.isDefault ? { ...workflow, isDefault: false } : workflow
        ),
        created,
      ])
      setWorkflowDraft(current => ({
        ...current,
        name: '',
        description: '',
        isDefault: false,
        stages: defaultStages(actorChoices[0]?.actor),
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function validateWorkflow() {
    if (!workflowDraft.name.trim() || !workflowDraft.stages.length) return
    setBusy(true)
    setError(null)
    try {
      const validation = await api.validateWorkflow(projectId, {
        name: workflowDraft.name.trim(),
        description: workflowDraft.description.trim(),
        triggerMode: workflowDraft.triggerMode,
        ...(workflowDraft.repositoryBindingId
          ? { repositoryBindingId: workflowDraft.repositoryBindingId }
          : {}),
        stages: workflowDraft.stages,
        failurePolicy: workflowDraft.failurePolicy,
        isDefault: workflowDraft.isDefault,
      })
      setValidationIssues(validation.issues)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  async function archiveWorkflow(workflow: WorkflowDefinition) {
    setBusy(true)
    try {
      const updated = await api.updateWorkflow(projectId, workflow.id, {
        version: workflow.version,
        status: 'archived',
      })
      setWorkflows(current => current.map(entry => (entry.id === updated.id ? updated : entry)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.dev_workflow_save_failed'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <section className="mt-8 flex h-28 items-center justify-center border-t border-border pt-6 text-sm text-text-muted">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        {t('workbench.dev_workflow_loading')}
      </section>
    )
  }

  return (
    <section className="mt-8 border-t border-border pt-6" data-testid="project-dev-workflows">
      <div className="mb-5">
        <h3 className="text-heading-md font-semibold">{t('workbench.dev_workflow_title')}</h3>
        <p className="mt-1 text-sm text-text-muted">{t('workbench.dev_workflow_description')}</p>
      </div>

      <div className="space-y-5">
        <div className="rounded-xl border border-border p-4" data-testid="project-squads">
          <SectionHeader
            icon={Users}
            title={t('workbench.dev_workflow_squads')}
            description={t('workbench.dev_workflow_squads_description')}
          />
          {squads.filter(squad => squad.status === 'active').length ? (
            <div className="mt-4 grid gap-2 md:grid-cols-2" data-testid="project-squad-list">
              {squads
                .filter(squad => squad.status === 'active')
                .map(squad => (
                  <div key={squad.id} className="rounded-lg bg-muted/60 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-text-muted" />
                      <span className="text-sm font-medium">{squad.name}</span>
                      <span className="text-xs text-text-muted">
                        {squad.memberAgentIds.length} · {squad.maxParallelMembers}
                      </span>
                      {canManage ? (
                        <button
                          type="button"
                          data-testid={`archive-squad-${squad.id}`}
                          disabled={busy}
                          onClick={() => void archiveSquad(squad)}
                          className="ml-auto rounded-md p-1 text-text-muted hover:bg-background hover:text-destructive"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                    {squad.routingInstructions ? (
                      <p className="mt-1 line-clamp-2 text-xs text-text-muted">
                        {squad.routingInstructions}
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <input
                        data-testid={`project-squad-preview-task-${squad.id}`}
                        value={routePreviewSquadId === squad.id ? routePreviewTask : ''}
                        onChange={event => {
                          setRoutePreviewSquadId(squad.id)
                          setRoutePreviewTask(event.target.value)
                          setRoutePreview(null)
                        }}
                        placeholder={t('workbench.dev_workflow_squad_preview_task', '输入模拟任务')}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                      />
                      <button
                        type="button"
                        data-testid={`project-squad-preview-${squad.id}`}
                        disabled={
                          busy || routePreviewSquadId !== squad.id || !routePreviewTask.trim()
                        }
                        onClick={() => void previewSquadRoute(squad)}
                        className="rounded-md border border-border bg-background px-2 text-xs disabled:opacity-40"
                      >
                        {t('workbench.dev_workflow_squad_preview', '试运行路由')}
                      </button>
                    </div>
                    {routePreviewSquadId === squad.id && routePreview ? (
                      <div
                        data-testid={`project-squad-preview-result-${squad.id}`}
                        className="mt-2 rounded-md border border-border bg-background p-2 text-xs"
                      >
                        <p className="text-text-muted">{routePreview.explanation}</p>
                        <ul className="mt-1 space-y-1">
                          {routePreview.selectedMembers.map(member => (
                            <li key={member.agentId}>
                              {agents.find(agent => agent.id === member.agentId)?.name ??
                                member.agentId}
                              {' · '}
                              {member.executionMode}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
          {canManage ? (
            <div className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-2">
              <input
                data-testid="squad-name"
                value={squadDraft.name}
                onChange={event =>
                  setSquadDraft(current => ({ ...current, name: event.target.value }))
                }
                placeholder={t('workbench.dev_workflow_squad_name')}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
              />
              <select
                data-testid="squad-leader"
                value={squadDraft.leaderAgentId}
                onChange={event => {
                  const leaderAgentId = event.target.value
                  setSquadDraft(current => ({
                    ...current,
                    leaderAgentId,
                    memberAgentIds: current.memberAgentIds.includes(leaderAgentId)
                      ? current.memberAgentIds
                      : [...current.memberAgentIds, leaderAgentId],
                  }))
                }}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
              >
                <option value="">{t('workbench.dev_workflow_squad_leader')}</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <div className="rounded-lg border border-border p-2 md:col-span-2">
                <span className="text-xs font-medium text-text-secondary">
                  {t('workbench.dev_workflow_squad_members')}
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agents.map(agent => (
                    <label
                      key={agent.id}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={squadDraft.memberAgentIds.includes(agent.id)}
                        onChange={event =>
                          setSquadDraft(current => ({
                            ...current,
                            memberAgentIds: event.target.checked
                              ? [...new Set([...current.memberAgentIds, agent.id])]
                              : current.memberAgentIds.filter(id => id !== agent.id),
                          }))
                        }
                      />
                      {agent.name}
                    </label>
                  ))}
                </div>
              </div>
              <textarea
                value={squadDraft.routingInstructions}
                onChange={event =>
                  setSquadDraft(current => ({
                    ...current,
                    routingInstructions: event.target.value,
                  }))
                }
                placeholder={t('workbench.dev_workflow_squad_routing')}
                className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <label className="text-xs text-text-secondary">
                {t('workbench.dev_workflow_squad_parallel')}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={squadDraft.maxParallelMembers}
                  onChange={event =>
                    setSquadDraft(current => ({
                      ...current,
                      maxParallelMembers: Number(event.target.value),
                    }))
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
                />
              </label>
              <button
                type="button"
                data-testid="project-squad-add"
                disabled={
                  busy ||
                  !squadDraft.name.trim() ||
                  !squadDraft.leaderAgentId ||
                  !squadDraft.memberAgentIds.length
                }
                onClick={() => void createSquad()}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40 md:col-span-2 md:justify-self-end"
              >
                <Plus className="h-4 w-4" />
                {t('workbench.dev_workflow_create_squad')}
              </button>
            </div>
          ) : null}
        </div>

        <ProjectRepositoriesSection
          repositories={repositories}
          draft={repositoryDraft}
          setDraft={setRepositoryDraft}
          canManage={canManage}
          busy={busy}
          onValidate={repository => void validateRepository(repository)}
          onArchive={repository => void archiveRepository(repository)}
          onCreate={() => void createRepository()}
        />

        <div className="rounded-xl border border-border p-4" data-testid="project-workflows">
          <SectionHeader
            icon={Workflow}
            title={t('workbench.dev_workflow_workflows')}
            description={t('workbench.dev_workflow_workflows_description')}
          />
          <div className="mt-4 grid gap-2 md:grid-cols-2" data-testid="project-workflow-list">
            {workflows
              .filter(workflow => workflow.status === 'active')
              .map(workflow => (
                <div key={workflow.id} className="rounded-lg bg-muted/60 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Workflow className="h-4 w-4 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {workflow.name}
                    </span>
                    {workflow.isDefault ? (
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-700">
                        {t('workbench.dev_workflow_default')}
                      </span>
                    ) : null}
                    {canManage ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void archiveWorkflow(workflow)}
                        className="rounded-md p-1 text-text-muted hover:bg-background hover:text-destructive"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {workflow.stages.length} {t('workbench.dev_workflow_stage_count')} ·{' '}
                    {workflow.triggerMode}
                  </p>
                </div>
              ))}
          </div>
          {canManage ? (
            <div
              className="mt-4 space-y-3 rounded-lg border border-dashed border-border p-3"
              data-testid="project-workflow-editor"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  data-testid="workflow-name"
                  value={workflowDraft.name}
                  onChange={event =>
                    setWorkflowDraft(current => ({ ...current, name: event.target.value }))
                  }
                  placeholder={t('workbench.dev_workflow_name')}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
                />
                <select
                  value={workflowDraft.repositoryBindingId}
                  onChange={event =>
                    setWorkflowDraft(current => ({
                      ...current,
                      repositoryBindingId: event.target.value,
                    }))
                  }
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
                >
                  <option value="">{t('workbench.ai_workflow_repository_none')}</option>
                  {repositories
                    .filter(repository => repository.status === 'active')
                    .map(repository => (
                      <option key={repository.id} value={repository.id}>
                        {repository.repositoryIdentity}
                      </option>
                    ))}
                </select>
                <textarea
                  value={workflowDraft.description}
                  onChange={event =>
                    setWorkflowDraft(current => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder={t('workbench.dev_workflow_workflow_description')}
                  className="min-h-16 rounded-lg border border-border bg-background px-3 py-2 text-sm md:col-span-2"
                />
              </div>

              <div className="space-y-3">
                {workflowDraft.stages.map((group, groupIndex) => (
                  <div
                    key={`${group.key}:${groupIndex}`}
                    className="rounded-lg border border-border bg-background p-3"
                    data-testid={`project-workflow-stage-${group.key}`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={group.name}
                        onChange={event =>
                          setWorkflowDraft(current => ({
                            ...current,
                            stages: current.stages.map((stage, index) =>
                              index === groupIndex ? { ...stage, name: event.target.value } : stage
                            ),
                          }))
                        }
                        className="h-8 min-w-0 flex-1 rounded-md border border-border px-2 text-sm font-medium"
                      />
                      <select
                        value={group.execution}
                        onChange={event =>
                          setWorkflowDraft(current => ({
                            ...current,
                            stages: current.stages.map((stage, index) =>
                              index === groupIndex
                                ? {
                                    ...stage,
                                    execution: event.target.value as 'serial' | 'parallel',
                                  }
                                : stage
                            ),
                          }))
                        }
                        className="h-8 rounded-md border border-border px-2 text-xs"
                      >
                        <option value="serial">{t('workbench.dev_workflow_serial')}</option>
                        <option value="parallel">{t('workbench.dev_workflow_parallel')}</option>
                      </select>
                      <button
                        type="button"
                        disabled={groupIndex === 0}
                        onClick={() => moveGroup(groupIndex, -1)}
                        className="rounded-md p-1 text-text-muted hover:bg-muted disabled:opacity-30"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={groupIndex === workflowDraft.stages.length - 1}
                        onClick={() => moveGroup(groupIndex, 1)}
                        className="rounded-md p-1 text-text-muted hover:bg-muted disabled:opacity-30"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={workflowDraft.stages.length === 1}
                        onClick={() =>
                          setWorkflowDraft(current => ({
                            ...current,
                            stages: current.stages.filter((_, index) => index !== groupIndex),
                          }))
                        }
                        className="rounded-md p-1 text-text-muted hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 space-y-2">
                      {group.nodes.map((node, nodeIndex) => (
                        <div
                          key={`${node.key}:${nodeIndex}`}
                          className="grid gap-2 rounded-md bg-muted/50 p-2 md:grid-cols-[1fr_150px_1.2fr_auto]"
                        >
                          <input
                            value={node.name}
                            onChange={event =>
                              updateNode(groupIndex, nodeIndex, { name: event.target.value })
                            }
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          />
                          <select
                            value={node.type}
                            onChange={event =>
                              updateNodeType(
                                groupIndex,
                                nodeIndex,
                                event.target.value as WorkflowNodeType
                              )
                            }
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          >
                            <option value="agent">{t('workbench.dev_workflow_node_agent')}</option>
                            <option value="human_gate">
                              {t('workbench.dev_workflow_node_human')}
                            </option>
                            <option value="ci_gate">{t('workbench.dev_workflow_node_ci')}</option>
                            <option value="merge">{t('workbench.dev_workflow_node_merge')}</option>
                            <option value="complete">
                              {t('workbench.dev_workflow_node_complete')}
                            </option>
                          </select>
                          {node.type === 'agent' ? (
                            <select
                              data-testid={`project-workflow-node-agent-${node.key}`}
                              value={actorValue(node.actor)}
                              onChange={event =>
                                updateNode(groupIndex, nodeIndex, {
                                  actor: actorChoices.find(
                                    choice => choice.value === event.target.value
                                  )?.actor,
                                })
                              }
                              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                            >
                              <option value="">
                                {t('workbench.ai_workflow_target_placeholder')}
                              </option>
                              {actorChoices.map(choice => (
                                <option key={choice.value} value={choice.value}>
                                  {choice.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span
                              data-testid={`project-workflow-node-gate-${node.key}`}
                              className="flex h-8 items-center rounded-md px-2 text-xs text-text-muted"
                            >
                              {node.condition || t('workbench.dev_workflow_platform_node')}
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={group.nodes.length === 1}
                            onClick={() =>
                              setWorkflowDraft(current => ({
                                ...current,
                                stages: current.stages.map((stage, index) =>
                                  index === groupIndex
                                    ? {
                                        ...stage,
                                        nodes: stage.nodes.filter(
                                          (_, index) => index !== nodeIndex
                                        ),
                                      }
                                    : stage
                                ),
                              }))
                            }
                            className="rounded-md p-1 text-text-muted hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      data-testid={`project-workflow-node-add-${group.key}`}
                      onClick={() =>
                        setWorkflowDraft(current => ({
                          ...current,
                          stages: current.stages.map((stage, index) =>
                            index === groupIndex
                              ? {
                                  ...stage,
                                  nodes: [
                                    ...stage.nodes,
                                    emptyNode(stage.nodes.length + 1, actorChoices[0]?.actor),
                                  ],
                                }
                              : stage
                          ),
                        }))
                      }
                      className="mt-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t('workbench.dev_workflow_add_node')}
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="project-workflow-stage-add"
                  onClick={addGroup}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-muted px-3 text-xs font-medium"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('workbench.dev_workflow_add_stage')}
                </button>
                <label className="ml-auto flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={workflowDraft.isDefault}
                    onChange={event =>
                      setWorkflowDraft(current => ({
                        ...current,
                        isDefault: event.target.checked,
                      }))
                    }
                  />
                  {t('workbench.dev_workflow_set_default')}
                </label>
                <button
                  type="button"
                  data-testid="project-workflow-validate"
                  disabled={busy || !workflowDraft.name.trim()}
                  onClick={() => void validateWorkflow()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-muted px-3 text-sm font-medium text-text-primary disabled:opacity-40"
                >
                  {t('workbench.dev_workflow_validate')}
                </button>
                <button
                  type="button"
                  data-testid="project-workflow-save"
                  disabled={
                    busy ||
                    !workflowDraft.name.trim() ||
                    !workflowDraft.stages.length ||
                    workflowDraft.stages.some(group =>
                      group.nodes.some(node => node.type === 'agent' && !node.actor)
                    )
                  }
                  onClick={() => void createWorkflow()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
                >
                  <Save className="h-4 w-4" />
                  {t('workbench.dev_workflow_create_workflow')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-xs text-destructive" data-testid="project-dev-workflow-error">
          {error}
        </p>
      ) : null}
      {validationIssues.length ? (
        <ul
          data-testid="project-workflow-validation-issues"
          className="mt-4 list-disc space-y-1 pl-5 text-xs text-amber-700"
        >
          {validationIssues.map(issue => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {!actorChoices.length ? (
        <p className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          <Bot className="h-4 w-4" />
          {t('workbench.dev_workflow_agent_required')}
        </p>
      ) : null}
    </section>
  )
}
