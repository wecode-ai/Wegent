import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  Copy,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Webhook,
} from 'lucide-react'
import type {
  ProjectWorkflowAutomation,
  ProjectWorkflowAutomationInput,
  ProjectWorkflowAutomationRun,
  ProjectWorkflowAutomationTrigger,
  RepositoryBinding,
  WorkflowDefinition,
  createProjectWorkflowApi,
} from '@/api/projectWorkflows'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

type ProjectWorkflowApi = ReturnType<typeof createProjectWorkflowApi>

interface Draft {
  name: string
  description: string
  workflowId: string
  repositoryBindingId: string
  triggerType: ProjectWorkflowAutomationTrigger
  cronExpression: string
  timezone: string
  intervalValue: string
  intervalUnit: 'minutes' | 'hours' | 'days'
  executeAt: string
  executionTargetType: 'registered_device' | 'managed_container'
  executionTargetId: string
  workspaceMode: 'current_workspace' | 'git_worktree'
  taskTemplate: string
  payloadMapping: string
  enabled: boolean
}

function initialDraft(localProject: boolean): Draft {
  return {
    name: '',
    description: '',
    workflowId: '',
    repositoryBindingId: '',
    triggerType: 'manual',
    cronExpression: '0 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    intervalValue: '1',
    intervalUnit: 'hours',
    executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
    executionTargetType: localProject ? 'registered_device' : 'managed_container',
    executionTargetId: '',
    workspaceMode: 'git_worktree',
    taskTemplate: JSON.stringify(
      {
        title: 'Automated development task',
        description: '',
        priority: 'medium',
      },
      null,
      2
    ),
    payloadMapping: JSON.stringify(
      {
        title: 'task.title',
        description: 'task.description',
      },
      null,
      2
    ),
    enabled: true,
  }
}

function triggerConfig(draft: Draft): Record<string, unknown> {
  if (draft.triggerType === 'cron') {
    return { expression: draft.cronExpression.trim(), timezone: draft.timezone.trim() }
  }
  if (draft.triggerType === 'interval') {
    return {
      value: Math.max(1, Number.parseInt(draft.intervalValue, 10) || 1),
      unit: draft.intervalUnit,
    }
  }
  if (draft.triggerType === 'one_time') {
    return { executeAt: new Date(draft.executeAt).toISOString() }
  }
  return {}
}

function parseObject(value: string, field: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

export function ProjectWorkflowAutomationsSection({
  projectId,
  api,
  deviceApi,
  canManage,
  localProject = false,
}: {
  projectId: string
  api: ProjectWorkflowApi
  deviceApi?: WorkbenchServices['deviceApi']
  canManage: boolean
  localProject?: boolean
}) {
  const { t } = useTranslation('common')
  const [automations, setAutomations] = useState<ProjectWorkflowAutomation[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [repositories, setRepositories] = useState<RepositoryBinding[]>([])
  const [devices, setDevices] = useState<
    Array<{ device_id: string; device_name?: string; status?: string }>
  >([])
  const [runs, setRuns] = useState<Record<string, ProjectWorkflowAutomationRun[]>>({})
  const [draft, setDraft] = useState(() => initialDraft(localProject))
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [webhookSecret, setWebhookSecret] = useState<{
    automationId: string
    webhookToken: string
    webhookSecret: string
  } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [nextAutomations, nextWorkflows, nextRepositories, nextDevices] = await Promise.all([
        api.listAutomations(projectId),
        api.listWorkflows(projectId),
        api.listRepositories(projectId),
        deviceApi?.listDevices?.() ?? Promise.resolve([]),
      ])
      setAutomations(nextAutomations)
      setWorkflows(nextWorkflows.filter(workflow => workflow.status === 'active'))
      setRepositories(nextRepositories.filter(repository => repository.status === 'active'))
      setDevices(nextDevices)
      if (!draft.workflowId && nextWorkflows.length) {
        setDraft(current => ({ ...current, workflowId: nextWorkflows[0].id }))
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('workbench.workflow_automation_load_failed', '加载工作流自动化失败')
      )
    }
  }, [api, deviceApi, draft.workflowId, projectId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const activeDevices = useMemo(
    () => devices.filter(device => device.status !== 'offline'),
    [devices]
  )

  async function createAutomation() {
    if (!draft.name.trim() || !draft.workflowId) return
    setBusy('create')
    setError(null)
    try {
      const taskTemplate = parseObject(draft.taskTemplate, 'taskTemplate')
      const rawMapping = parseObject(draft.payloadMapping, 'payloadMapping')
      const payloadMapping = Object.fromEntries(
        Object.entries(rawMapping).map(([key, value]) => [key, String(value)])
      )
      const input: ProjectWorkflowAutomationInput = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        triggerType: draft.triggerType,
        triggerConfig: triggerConfig(draft),
        workflowId: draft.workflowId,
        ...(draft.repositoryBindingId ? { repositoryBindingId: draft.repositoryBindingId } : {}),
        executionTarget: {
          type: draft.executionTargetType,
          ...(draft.executionTargetId.trim() ? { id: draft.executionTargetId.trim() } : {}),
        },
        workspaceMode: draft.workspaceMode,
        taskTemplate,
        payloadMapping,
        enabled: draft.enabled,
      }
      const created = await api.createAutomation(projectId, input)
      setAutomations(current => [...current, created])
      setDraft(current => ({
        ...initialDraft(localProject),
        workflowId: current.workflowId,
        repositoryBindingId: current.repositoryBindingId,
      }))
      setExpanded(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('workbench.workflow_automation_save_failed', '保存工作流自动化失败')
      )
    } finally {
      setBusy(null)
    }
  }

  async function toggleAutomation(automation: ProjectWorkflowAutomation) {
    setBusy(`toggle:${automation.id}`)
    try {
      const updated = await api.updateAutomation(projectId, automation.id, {
        version: automation.version,
        enabled: !automation.enabled,
      })
      setAutomations(current => current.map(entry => (entry.id === updated.id ? updated : entry)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update automation')
    } finally {
      setBusy(null)
    }
  }

  async function runNow(automation: ProjectWorkflowAutomation) {
    setBusy(`run:${automation.id}`)
    try {
      const run = await api.runAutomation(projectId, automation.id, {
        idempotencyKey: `ui:${crypto.randomUUID()}`,
      })
      setRuns(current => ({
        ...current,
        [automation.id]: [run, ...(current[automation.id] || [])],
      }))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to run automation')
    } finally {
      setBusy(null)
    }
  }

  async function loadRuns(automationId: string) {
    setBusy(`runs:${automationId}`)
    try {
      const nextRuns = await api.listAutomationRuns(projectId, automationId)
      setRuns(current => ({ ...current, [automationId]: nextRuns }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load automation runs')
    } finally {
      setBusy(null)
    }
  }

  async function rotateWebhook(automationId: string) {
    setBusy(`webhook:${automationId}`)
    try {
      const secret = await api.rotateAutomationWebhook(projectId, automationId)
      setWebhookSecret(secret)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to rotate webhook secret')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      data-testid="project-workflow-automations"
      className="mt-8 rounded-xl border border-border bg-background p-4"
    >
      <header className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted">
          <CalendarClock className="h-4 w-4 text-text-secondary" />
        </span>
        <span className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.workflow_automations_title', '工作流自动化')}
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {t(
              'workbench.workflow_automations_description',
              '通过定时、Webhook 或手工触发创建任务并启动同一套开发工作流。'
            )}
          </p>
        </span>
        {canManage ? (
          <button
            type="button"
            data-testid="project-workflow-automation-add"
            onClick={() => setExpanded(value => !value)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('common.add', '添加')}
          </button>
        ) : null}
      </header>

      {expanded ? (
        <div
          data-testid="project-workflow-automation-editor"
          className="mt-4 grid gap-3 rounded-lg border border-border p-3 md:grid-cols-2"
        >
          <input
            data-testid="workflow-automation-name"
            value={draft.name}
            onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
            placeholder={t('workbench.workflow_automation_name', '自动化名称')}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <select
            data-testid="workflow-automation-workflow"
            value={draft.workflowId}
            onChange={event =>
              setDraft(current => ({ ...current, workflowId: event.target.value }))
            }
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">{t('workbench.workflow_select', '选择工作流')}</option>
            {workflows.map(workflow => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
          <textarea
            data-testid="workflow-automation-description"
            value={draft.description}
            onChange={event =>
              setDraft(current => ({ ...current, description: event.target.value }))
            }
            placeholder={t('common.description', '描述')}
            className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2"
          />
          <select
            data-testid="workflow-automation-trigger"
            value={draft.triggerType}
            onChange={event =>
              setDraft(current => ({
                ...current,
                triggerType: event.target.value as ProjectWorkflowAutomationTrigger,
              }))
            }
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {(localProject
              ? (['manual', 'cron', 'interval', 'one_time'] as const)
              : (['manual', 'cron', 'interval', 'one_time', 'webhook'] as const)
            ).map(trigger => (
              <option key={trigger} value={trigger}>
                {trigger}
              </option>
            ))}
          </select>
          <select
            data-testid="workflow-automation-repository"
            value={draft.repositoryBindingId}
            onChange={event =>
              setDraft(current => ({ ...current, repositoryBindingId: event.target.value }))
            }
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">{t('workbench.workflow_repository_default', '跟随工作流仓库')}</option>
            {repositories.map(repository => (
              <option key={repository.id} value={repository.id}>
                {repository.repositoryIdentity}
              </option>
            ))}
          </select>

          {draft.triggerType === 'cron' ? (
            <>
              <input
                data-testid="workflow-automation-cron"
                value={draft.cronExpression}
                onChange={event =>
                  setDraft(current => ({ ...current, cronExpression: event.target.value }))
                }
                placeholder="0 9 * * 1-5"
                className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
              <input
                data-testid="workflow-automation-timezone"
                value={draft.timezone}
                onChange={event =>
                  setDraft(current => ({ ...current, timezone: event.target.value }))
                }
                placeholder="Asia/Shanghai"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </>
          ) : null}
          {draft.triggerType === 'interval' ? (
            <>
              <input
                data-testid="workflow-automation-interval-value"
                type="number"
                min={1}
                value={draft.intervalValue}
                onChange={event =>
                  setDraft(current => ({ ...current, intervalValue: event.target.value }))
                }
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <select
                data-testid="workflow-automation-interval-unit"
                value={draft.intervalUnit}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    intervalUnit: event.target.value as Draft['intervalUnit'],
                  }))
                }
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </>
          ) : null}
          {draft.triggerType === 'one_time' ? (
            <input
              data-testid="workflow-automation-execute-at"
              type="datetime-local"
              value={draft.executeAt}
              onChange={event =>
                setDraft(current => ({ ...current, executeAt: event.target.value }))
              }
              className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2"
            />
          ) : null}

          <select
            data-testid="workflow-automation-execution-target-type"
            value={draft.executionTargetType}
            onChange={event =>
              setDraft(current => ({
                ...current,
                executionTargetType: event.target.value as Draft['executionTargetType'],
                executionTargetId: '',
              }))
            }
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {!localProject ? <option value="managed_container">managed_container</option> : null}
            <option value="registered_device">registered_device</option>
          </select>
          {draft.executionTargetType === 'registered_device' ? (
            <select
              data-testid="workflow-automation-execution-target"
              value={draft.executionTargetId}
              onChange={event =>
                setDraft(current => ({ ...current, executionTargetId: event.target.value }))
              }
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">{t('workbench.device_select', '选择设备')}</option>
              {activeDevices.map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.device_name || device.device_id}
                </option>
              ))}
            </select>
          ) : (
            <input
              data-testid="workflow-automation-container-profile"
              value={draft.executionTargetId}
              onChange={event =>
                setDraft(current => ({ ...current, executionTargetId: event.target.value }))
              }
              placeholder={t('workbench.container_profile_optional', '容器配置（可选）')}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          )}
          <select
            data-testid="workflow-automation-workspace-mode"
            value={draft.workspaceMode}
            onChange={event =>
              setDraft(current => ({
                ...current,
                workspaceMode: event.target.value as Draft['workspaceMode'],
              }))
            }
            className="rounded-md border border-border bg-background px-3 py-2 text-sm md:col-span-2"
          >
            <option value="git_worktree">git_worktree</option>
            <option value="current_workspace">current_workspace</option>
          </select>
          <label className="text-xs text-text-muted">
            taskTemplate
            <textarea
              data-testid="workflow-automation-task-template"
              value={draft.taskTemplate}
              onChange={event =>
                setDraft(current => ({ ...current, taskTemplate: event.target.value }))
              }
              className="mt-1 min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text-primary"
            />
          </label>
          <label className="text-xs text-text-muted">
            payloadMapping
            <textarea
              data-testid="workflow-automation-payload-mapping"
              value={draft.payloadMapping}
              onChange={event =>
                setDraft(current => ({ ...current, payloadMapping: event.target.value }))
              }
              className="mt-1 min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text-primary"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
            <input
              data-testid="workflow-automation-enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={event =>
                setDraft(current => ({ ...current, enabled: event.target.checked }))
              }
            />
            {t('workbench.workflow_automation_enable_after_save', '保存后启用')}
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="workflow-automation-save"
              disabled={busy !== null || !draft.name.trim() || !draft.workflowId}
              onClick={() => void createAutomation()}
              className="inline-flex items-center gap-1 rounded-md bg-text-primary px-3 py-2 text-xs text-background disabled:opacity-40"
            >
              {busy === 'create' ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t('common.create', '创建')}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p data-testid="workflow-automation-error" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {automations.map(automation => (
          <article
            key={automation.id}
            data-testid={`workflow-automation-${automation.id}`}
            className="rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">
                  {automation.name}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {automation.triggerType} · {automation.executionTarget.type} ·{' '}
                  {automation.workspaceMode}
                </span>
                <span className="mt-1 block text-xs text-text-muted">
                  next: {formatTime(automation.nextRunAt)} · last:{' '}
                  {formatTime(automation.lastRunAt)}
                </span>
              </span>
              <button
                type="button"
                data-testid={`workflow-automation-run-${automation.id}`}
                disabled={busy !== null}
                onClick={() => void runNow(automation)}
                className="inline-flex items-center gap-1 rounded-md bg-text-primary px-2.5 py-1.5 text-xs text-background disabled:opacity-40"
              >
                {busy === `run:${automation.id}` ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Run now
              </button>
              {canManage ? (
                <button
                  type="button"
                  data-testid={`workflow-automation-toggle-${automation.id}`}
                  disabled={busy !== null}
                  onClick={() => void toggleAutomation(automation)}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
                >
                  {automation.enabled ? 'Disable' : 'Enable'}
                </button>
              ) : null}
              <button
                type="button"
                data-testid={`workflow-automation-runs-${automation.id}`}
                disabled={busy !== null}
                onClick={() => void loadRuns(automation.id)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Runs
              </button>
              {automation.triggerType === 'webhook' && canManage ? (
                <button
                  type="button"
                  data-testid={`workflow-automation-webhook-${automation.id}`}
                  disabled={busy !== null}
                  onClick={() => void rotateWebhook(automation.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Webhook secret
                </button>
              ) : null}
            </div>
            {runs[automation.id]?.length ? (
              <div
                className="mt-3 space-y-1"
                data-testid={`workflow-automation-run-list-${automation.id}`}
              >
                {runs[automation.id].slice(0, 5).map(run => (
                  <div
                    key={run.id}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                  >
                    <span className="font-medium">{run.status}</span>
                    <span className="text-text-muted">{run.triggerType}</span>
                    {run.loopItemId ? <span>task: {run.loopItemId}</span> : null}
                    {run.workflowRunId ? <span>run: {run.workflowRunId.slice(0, 8)}</span> : null}
                    {run.errorMessage ? (
                      <span className="text-destructive">{run.errorMessage}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>

      {webhookSecret ? (
        <div
          data-testid="workflow-automation-webhook-secret"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <div className="flex items-center gap-2 font-medium">
            <Webhook className="h-3.5 w-3.5" />
            {t('workbench.workflow_webhook_secret_once', 'Webhook 凭据仅显示一次')}
          </div>
          <code className="mt-2 block break-all">
            /api/v1/repository-integrations/workflow-automations/
            {webhookSecret.webhookToken}/webhook
          </code>
          <code className="mt-1 block break-all">{webhookSecret.webhookSecret}</code>
          <button
            type="button"
            data-testid="workflow-automation-copy-secret"
            onClick={() => void navigator.clipboard.writeText(webhookSecret.webhookSecret)}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-current px-2 py-1"
          >
            <Copy className="h-3.5 w-3.5" />
            {t('common.copy', '复制')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
