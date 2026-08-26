import type { WorkflowExecutionConfig } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ProjectWithTasks } from '@/types/api'
import type { UnifiedModel } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import {
  workflowExecutionConfigComplete,
  workflowExecutionConfigForAgent,
} from './workflowExecutionConfig'

export function WorkflowExecutionConfigFields({
  value,
  onChange,
  projectAgents,
  runtimeProfiles,
  devices,
  models,
  localProjects,
  testId,
}: {
  value: WorkflowExecutionConfig
  onChange: (value: WorkflowExecutionConfig) => void
  projectAgents: ProjectChatAgent[]
  runtimeProfiles: RuntimeProfile[]
  devices: DeviceInfo[]
  models: UnifiedModel[]
  localProjects: ProjectWithTasks[]
  testId: string
}) {
  const { t } = useTranslation('common')
  const selectedWorkspace =
    value.workspace_binding?.type === 'backend_project'
      ? String(value.workspace_binding.projectId)
      : 'standalone'
  const complete = workflowExecutionConfigComplete(value)
  const selectedModelKey = value.model ? `${value.model_type ?? ''}:${value.model}` : ''
  const selectedDeviceId = value.execution_device_id?.trim() ?? ''

  return (
    <div
      className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3"
      data-testid={testId}
    >
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_robot', '机器人预设（可选）')}
        <select
          data-testid={`${testId}-agent`}
          value={value.agent_id ?? ''}
          onChange={event => {
            const agent = projectAgents.find(candidate => candidate.id === event.target.value)
            if (!agent) {
              onChange({ ...value, agent_id: null, runtime_profile_id: null })
              return
            }
            const runtimeProfile = runtimeProfiles.find(
              candidate => candidate.id === agent.defaultRuntimeProfileId
            )
            onChange(workflowExecutionConfigForAgent(agent, runtimeProfile))
          }}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_no_robot', '不使用机器人预设')}</option>
          {projectAgents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_device', '执行机器')}
        <select
          data-testid={`${testId}-device`}
          value={value.execution_device_id ?? ''}
          onChange={event => {
            onChange({
              ...value,
              execution_device_id: event.target.value || null,
              runtime_profile_id:
                runtimeProfiles.find(
                  profile =>
                    profile.id === value.runtime_profile_id &&
                    profile.executionDeviceId === event.target.value
                )?.id ?? null,
            })
          }}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_fill_later', '运行时填写')}</option>
          {selectedDeviceId && !devices.some(device => device.device_id === selectedDeviceId) ? (
            <option value={selectedDeviceId}>{selectedDeviceId}</option>
          ) : null}
          {devices.map(device => (
            <option key={device.device_id} value={device.device_id}>
              {device.name || device.device_id}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_model', '模型')}
        <select
          data-testid={`${testId}-model`}
          value={selectedModelKey}
          onChange={event => {
            const selectedModel = models.find(
              model => `${model.type}:${model.name}` === event.target.value
            )
            if (!selectedModel) {
              onChange({
                ...value,
                model: null,
                model_type: null,
                model_options: {},
              })
              return
            }
            const execution = selectedModelExecutionFields(selectedModel, {})
            onChange({
              ...value,
              model: execution.modelId ?? null,
              model_type: execution.modelType ?? null,
              model_options: execution.modelOptions ?? {},
            })
          }}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_model_empty', '运行时填写模型')}</option>
          {value.model &&
          !models.some(
            model =>
              model.name === value.model && (!value.model_type || model.type === value.model_type)
          ) ? (
            <option value={selectedModelKey}>{value.model}</option>
          ) : null}
          {models.map(model => (
            <option key={`${model.type}:${model.name}`} value={`${model.type}:${model.name}`}>
              {model.displayName || model.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_project', '代码项目')}
        <select
          data-testid={`${testId}-project`}
          value={selectedWorkspace}
          onChange={event =>
            onChange({
              ...value,
              workspace_binding:
                event.target.value === 'standalone'
                  ? { type: 'standalone' }
                  : event.target.value
                    ? { type: 'backend_project', projectId: Number(event.target.value) }
                    : null,
            })
          }
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="standalone">
            {t('todo.workflow_execution_standalone', '独立对话目录（不绑定项目）')}
          </option>
          {localProjects.map(project => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <p className={cn('text-xs', complete ? 'text-emerald-600' : 'text-amber-600')}>
        {complete
          ? t('todo.workflow_execution_complete', '运行配置已完整')
          : t('todo.workflow_execution_incomplete', '未填项将在 Issue 进入进行中时补充')}
      </p>
    </div>
  )
}
