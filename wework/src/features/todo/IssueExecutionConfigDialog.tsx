import { useEffect, useMemo, useState } from 'react'
import type {
  CloudLoopItem,
  IssueWorkflowInstance,
  WorkflowExecutionConfig,
} from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks } from '@/types/api'
import type { UnifiedModel } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import { workflowNodeExecutionMode } from '@/api/issueWorkflow'
import { WORKBENCH_MODELS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import { CloudTodoModal } from './CloudTodoModal'
import { WorkflowExecutionConfigFields } from './WorkflowExecutionConfigFields'
import {
  effectiveWorkflowNodeExecutionConfig,
  emptyWorkflowExecutionConfig,
  resolveWorkflowExecutionConfig,
  workflowExecutionConfigComplete,
} from './workflowExecutionConfig'

export interface IssueExecutionConfigResult {
  execution_config?: WorkflowExecutionConfig
  workflow?: IssueWorkflowInstance
}

export function IssueExecutionConfigDialog({
  item,
  projectChatAgentApi,
  runtimeProfileApi,
  modelApi,
  deviceApi,
  localProjects,
  onClose,
  onConfirm,
}: {
  item: CloudLoopItem
  projectChatAgentApi?: WorkbenchServices['projectChatAgentApi']
  runtimeProfileApi?: WorkbenchServices['runtimeProfileApi']
  modelApi?: WorkbenchServices['modelApi']
  deviceApi: WorkbenchServices['deviceApi']
  localProjects: ProjectWithTasks[]
  onClose: () => void
  onConfirm: (result: IssueExecutionConfigResult) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfile[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [executionConfig, setExecutionConfig] = useState<WorkflowExecutionConfig>(
    item.execution_config ?? {
      ...emptyWorkflowExecutionConfig(),
      agent_id: item.assignee_agent_id ?? null,
      workspace_binding: item.assignee_agent_id ? null : { type: 'standalone' },
    }
  )
  const [workflow, setWorkflow] = useState<IssueWorkflowInstance | null>(() =>
    item.workflow ? structuredClone(item.workflow) : null
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const setAvailableModels = (nextModels: UnifiedModel[]) => {
      if (!active) return
      setModels(
        nextModels.filter(model => model.isActive !== false && !model.compatibilityDisabled)
      )
    }
    const refreshModels = () => {
      void (modelApi?.listModels() ?? Promise.resolve({ data: [] }))
        .then(response => setAvailableModels(response.data))
        .catch(cause => {
          if (active) setError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    window.addEventListener(WORKBENCH_MODELS_CHANGED_EVENT, refreshModels)
    void Promise.all([
      projectChatAgentApi?.list(String(item.cloud_project_id)) ?? Promise.resolve([]),
      runtimeProfileApi?.list() ?? Promise.resolve([]),
      deviceApi.listDevices(),
      modelApi?.listModels() ?? Promise.resolve({ data: [] }),
    ])
      .then(([nextAgents, profiles, devices, modelResponse]) => {
        if (!active) return
        const onlineDeviceIds = new Set(
          devices
            .filter(device => device.status === 'online' || device.status === 'busy')
            .map(device => device.device_id)
        )
        const activeAgents = nextAgents.filter(agent => agent.status === 'active')
        const onlineDevices = devices.filter(
          device => device.status === 'online' || device.status === 'busy'
        )
        const onlineProfiles = profiles.filter(
          profile => profile.status === 'active' && onlineDeviceIds.has(profile.executionDeviceId)
        )
        setAgents(activeAgents)
        setDevices(onlineDevices)
        setAvailableModels(modelResponse.data)
        setRuntimeProfiles(onlineProfiles)
        setExecutionConfig(current =>
          resolveWorkflowExecutionConfig(current, activeAgents, onlineProfiles)
        )
        setWorkflow(current =>
          current
            ? {
                ...current,
                execution_config: current.execution_config
                  ? resolveWorkflowExecutionConfig(
                      current.execution_config,
                      activeAgents,
                      onlineProfiles
                    )
                  : null,
                nodes: current.nodes.map(node => ({
                  ...node,
                  execution_config: node.execution_config
                    ? resolveWorkflowExecutionConfig(
                        node.execution_config,
                        activeAgents,
                        onlineProfiles
                      )
                    : null,
                })),
              }
            : null
        )
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      window.removeEventListener(WORKBENCH_MODELS_CHANGED_EVENT, refreshModels)
    }
  }, [deviceApi, item.cloud_project_id, modelApi, projectChatAgentApi, runtimeProfileApi])

  const automatedNodes = useMemo(
    () => workflow?.nodes.filter(node => workflowNodeExecutionMode(node) === 'robot') ?? [],
    [workflow]
  )
  const workflowComplete = useMemo(
    () =>
      workflow
        ? workflow.advancement_policy === 'ai'
          ? workflowExecutionConfigComplete(workflow.execution_config)
          : automatedNodes.every(node =>
              workflowExecutionConfigComplete(effectiveWorkflowNodeExecutionConfig(workflow, node))
            )
        : true,
    [automatedNodes, workflow]
  )
  const canConfirm =
    !loading &&
    !saving &&
    (workflow ? workflowComplete : workflowExecutionConfigComplete(executionConfig))

  async function confirm() {
    if (!canConfirm) return
    setSaving(true)
    setError(null)
    try {
      const configs = workflow
        ? [
            workflow.execution_config,
            ...workflow.nodes
              .filter(node => node.execution_config_override)
              .map(node => node.execution_config),
          ].filter((config): config is WorkflowExecutionConfig => Boolean(config))
        : [executionConfig]
      console.info('[runtime-v2] issue execution configuration confirmed', {
        itemId: item.id,
        selections: configs.map(config => ({
          agentId: config.agent_id,
          runtimeProfileId: config.runtime_profile_id,
          deviceId: config.execution_device_id,
          model: config.model,
          modelType: config.model_type,
          workspaceBinding: config.workspace_binding,
          runtimePermissionMode: config.runtime_permission_mode,
        })),
      })
      await onConfirm(workflow ? { workflow } : { execution_config: executionConfig })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CloudTodoModal
      title={t('todo.execution_config_dialog_title', '补全运行配置')}
      onClose={onClose}
      width="wide"
    >
      <div
        className="min-h-0 overflow-y-auto px-5 py-4"
        data-testid="issue-execution-config-dialog"
      >
        {loading ? (
          <p className="text-sm text-text-muted">
            {t('todo.execution_config_loading', '正在加载可用运行环境…')}
          </p>
        ) : workflow ? (
          <>
            <WorkflowExecutionConfigFields
              value={
                workflow.execution_config ??
                automatedNodes[0]?.execution_config ??
                emptyWorkflowExecutionConfig()
              }
              onChange={execution_config =>
                setWorkflow(current => (current ? { ...current, execution_config } : current))
              }
              projectAgents={agents}
              runtimeProfiles={runtimeProfiles}
              devices={devices}
              models={models}
              localProjects={localProjects}
              testId="issue-execution-config-default"
            />
            {automatedNodes.map(node => (
              <div key={node.id} className="mt-3 border-t border-border pt-3">
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    data-testid={`issue-execution-config-override-${node.id}`}
                    checked={Boolean(node.execution_config_override)}
                    onChange={event =>
                      setWorkflow(current =>
                        current
                          ? {
                              ...current,
                              nodes: current.nodes.map(candidate =>
                                candidate.id === node.id
                                  ? {
                                      ...candidate,
                                      execution_config_override: event.target.checked,
                                      execution_config: event.target.checked
                                        ? {
                                            ...(effectiveWorkflowNodeExecutionConfig(
                                              current,
                                              candidate
                                            ) ?? emptyWorkflowExecutionConfig()),
                                          }
                                        : candidate.execution_config,
                                    }
                                  : candidate
                              ),
                            }
                          : current
                      )
                    }
                  />
                  {t('todo.workflow_execution_node_named', '{{name}} 单独配置', {
                    name: node.name,
                  })}
                </label>
                {node.execution_config_override && node.execution_config ? (
                  <div className="mt-2">
                    <WorkflowExecutionConfigFields
                      value={node.execution_config}
                      onChange={execution_config =>
                        setWorkflow(current =>
                          current
                            ? {
                                ...current,
                                nodes: current.nodes.map(candidate =>
                                  candidate.id === node.id
                                    ? { ...candidate, execution_config }
                                    : candidate
                                ),
                              }
                            : current
                        )
                      }
                      projectAgents={agents}
                      runtimeProfiles={runtimeProfiles}
                      devices={devices}
                      models={models}
                      localProjects={localProjects}
                      testId={`issue-execution-config-node-${node.id}`}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <WorkflowExecutionConfigFields
            value={executionConfig}
            onChange={setExecutionConfig}
            projectAgents={agents}
            runtimeProfiles={runtimeProfiles}
            devices={devices}
            models={models}
            localProjects={localProjects}
            testId="issue-execution-config-fields"
          />
        )}
        {!loading &&
        runtimeProfiles.length === 0 &&
        !(workflow ? workflowComplete : workflowExecutionConfigComplete(executionConfig)) ? (
          <p
            className="mt-3 text-sm text-amber-600"
            data-testid="issue-execution-config-no-runtime"
          >
            {t('todo.execution_config_no_online_runtime', '暂无在线运行环境，请先启动设备')}
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          data-testid="issue-execution-config-cancel"
          onClick={onClose}
          className="h-8 rounded-lg border border-border px-3.5 text-sm"
        >
          {t('common.cancel', '取消')}
        </button>
        <button
          type="button"
          data-testid="issue-execution-config-confirm"
          disabled={!canConfirm}
          onClick={() => void confirm()}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving
            ? t('todo.execution_config_starting', '正在启动…')
            : t('todo.execution_config_confirm', '保存并开始执行')}
        </button>
      </footer>
    </CloudTodoModal>
  )
}
