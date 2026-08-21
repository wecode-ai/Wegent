import type { WorkflowExecutionConfig } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ProjectWithTasks } from '@/types/api'
import { workflowExecutionConfigComplete } from './workflowExecutionConfig'

export function WorkflowExecutionConfigFields({
  value,
  onChange,
  projectAgents,
  runtimeProfiles,
  localProjects,
  testId,
}: {
  value: WorkflowExecutionConfig
  onChange: (value: WorkflowExecutionConfig) => void
  projectAgents: ProjectChatAgent[]
  runtimeProfiles: RuntimeProfile[]
  localProjects: ProjectWithTasks[]
  testId: string
}) {
  const { t } = useTranslation('common')
  const selectedProjectId =
    value.workspace_binding?.type === 'backend_project'
      ? String(value.workspace_binding.projectId)
      : ''
  const complete = workflowExecutionConfigComplete(value)

  return (
    <div
      className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3"
      data-testid={testId}
    >
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_robot', '运行机器人')}
        <select
          data-testid={`${testId}-agent`}
          value={value.agent_id ?? ''}
          onChange={event => {
            const agent = projectAgents.find(candidate => candidate.id === event.target.value)
            onChange({
              ...value,
              agent_id: event.target.value || null,
              model: value.model || agent?.model || null,
            })
          }}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_fill_later', '运行时填写')}</option>
          {projectAgents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_runtime', '运行环境')}
        <select
          data-testid={`${testId}-runtime`}
          value={value.runtime_profile_id ?? ''}
          onChange={event => {
            const profile = runtimeProfiles.find(candidate => candidate.id === event.target.value)
            onChange({
              ...value,
              runtime_profile_id: event.target.value || null,
              model: value.model || profile?.model || null,
            })
          }}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_fill_later', '运行时填写')}</option>
          {runtimeProfiles.map(profile => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_model', '模型')}
        <input
          data-testid={`${testId}-model`}
          value={value.model ?? ''}
          onChange={event => onChange({ ...value, model: event.target.value || null })}
          placeholder={t('todo.workflow_execution_model_empty', '运行时填写模型')}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        />
      </label>
      <label className="text-xs font-medium text-text-secondary">
        {t('todo.workflow_execution_project', '代码项目')}
        <select
          data-testid={`${testId}-project`}
          value={selectedProjectId}
          onChange={event =>
            onChange({
              ...value,
              workspace_binding: event.target.value
                ? { type: 'backend_project', projectId: Number(event.target.value) }
                : null,
            })
          }
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
        >
          <option value="">{t('todo.workflow_execution_fill_later', '运行时填写')}</option>
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
