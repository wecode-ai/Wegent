import { GitBranch, Plus, Trash2 } from 'lucide-react'
import type {
  ProjectWorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
  WorkflowWorkspacePolicy,
} from '@/api/deliveries'
import type { ProjectAutomationRule } from '@/api/projectAutomations'
import { useTranslation } from '@/hooks/useTranslation'

interface ProjectWorkflowEditorProps {
  value: ProjectWorkflowDefinition
  busy: boolean
  onChange: (value: ProjectWorkflowDefinition) => void
  onSave: () => void
  automationRules?: ProjectAutomationRule[]
}

function nextNodeId(nodes: WorkflowNodeDefinition[]): string {
  let index = nodes.length + 1
  while (nodes.some(node => node.id === `stage-${index}`)) index += 1
  return `stage-${index}`
}

export function ProjectWorkflowEditor({
  value,
  busy,
  onChange,
  onSave,
  automationRules = [],
}: ProjectWorkflowEditorProps) {
  const { t } = useTranslation('common')
  const canSave = value.nodes.every(
    node => node.name.trim() && (node.kind === 'my_task' || Boolean(node.automation_rule_id))
  )
  const updateNode = (id: string, patch: Partial<WorkflowNodeDefinition>) => {
    onChange({
      ...value,
      nodes: value.nodes.map(node => (node.id === id ? { ...node, ...patch } : node)),
    })
  }

  const addNode = () => {
    const id = nextNodeId(value.nodes)
    const previous = value.nodes.at(-1)
    onChange({
      ...value,
      nodes: [
        ...value.nodes,
        {
          id,
          name: t('todo.workflow_new_stage', '新阶段'),
          kind: 'my_task',
          depends_on: previous ? [previous.id] : [],
          required: true,
          workspace_policy: previous ? 'inherit' : 'composer',
        },
      ],
    })
  }

  const removeNode = (id: string) => {
    onChange({
      ...value,
      nodes: value.nodes
        .filter(node => node.id !== id)
        .map(node => ({
          ...node,
          depends_on: node.depends_on.filter(dependency => dependency !== id),
        })),
    })
  }

  return (
    <section className="border-t border-border py-6" data-testid="project-workflow-editor">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-heading-md font-semibold">
            <GitBranch className="h-4 w-4" />
            {t('todo.issue_execution_workflow', 'Issue 执行流程')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t(
              'todo.issue_execution_workflow_hint',
              '新建 Issue 时固化为执行阶段；每个阶段引用真实任务或自动执行。'
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="project-workflow-add"
            onClick={addNode}
            className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('todo.workflow_add_stage', '添加阶段')}
          </button>
          <button
            type="button"
            data-testid="project-workflow-save"
            disabled={busy || !canSave}
            onClick={onSave}
            className="h-8 rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50"
          >
            {busy ? t('todo.workflow_saving', '保存中…') : t('todo.workflow_save', '保存流程')}
          </button>
        </div>
      </div>
      {value.nodes.length === 0 ? (
        <button
          type="button"
          data-testid="project-workflow-empty-add"
          onClick={addNode}
          className="mt-4 flex h-16 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-text-muted hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {t('todo.workflow_add_first_stage', '添加第一个执行阶段')}
        </button>
      ) : (
        <div className="mt-4 space-y-2">
          {value.nodes.map((node, index) => (
            <div
              key={node.id}
              data-testid={`project-workflow-stage-${node.id}`}
              className="grid grid-cols-[32px_minmax(140px,1fr)_140px_150px_32px] items-center gap-2 rounded-xl border border-border px-3 py-2"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs text-text-muted">
                {index + 1}
              </span>
              <input
                value={node.name}
                data-testid={`project-workflow-stage-name-${node.id}`}
                onChange={event => updateNode(node.id, { name: event.target.value })}
                aria-label={t('todo.workflow_stage_name', '阶段 {{index}} 名称', {
                  index: index + 1,
                })}
                className="h-8 min-w-0 rounded-lg bg-transparent px-2 text-sm outline-none focus:bg-muted"
              />
              <select
                value={node.kind}
                data-testid={`project-workflow-stage-kind-${node.id}`}
                onChange={event => {
                  const kind = event.target.value as WorkflowNodeKind
                  updateNode(node.id, {
                    kind,
                    workspace_policy: kind === 'my_task' ? 'composer' : 'none',
                    automation_rule_id: null,
                  })
                }}
                aria-label={t('todo.workflow_stage_executor', '{{name}}执行者', {
                  name: node.name,
                })}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
              >
                <option value="my_task">{t('todo.workflow_kind_my_task', '我的任务')}</option>
                <option value="automation">{t('todo.workflow_kind_automation', '自动化')}</option>
                <option value="ai">{t('todo.workflow_kind_ai', 'AI 分配')}</option>
              </select>
              <select
                value={node.workspace_policy}
                data-testid={`project-workflow-stage-workspace-${node.id}`}
                onChange={event =>
                  updateNode(node.id, {
                    workspace_policy: event.target.value as WorkflowWorkspacePolicy,
                  })
                }
                aria-label={t('todo.workflow_workspace_policy', '{{name}}工作空间策略', {
                  name: node.name,
                })}
                disabled={node.kind !== 'my_task'}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50"
              >
                <option value="composer">
                  {t('todo.workflow_workspace_composer', '创建时选择')}
                </option>
                <option value="inherit">
                  {t('todo.workflow_workspace_inherit', '继承前序工作空间')}
                </option>
                <option value="none">{t('todo.workflow_workspace_none', '不使用工作空间')}</option>
              </select>
              <button
                type="button"
                data-testid={`project-workflow-remove-${node.id}`}
                onClick={() => removeNode(node.id)}
                aria-label={t('todo.workflow_remove_stage', '删除阶段 {{name}}', {
                  name: node.name,
                })}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              {node.kind === 'automation' || node.kind === 'ai' ? (
                <select
                  value={node.automation_rule_id ?? ''}
                  data-testid={`project-workflow-stage-automation-${node.id}`}
                  onChange={event =>
                    updateNode(node.id, {
                      automation_rule_id: event.target.value || null,
                    })
                  }
                  aria-label={t('todo.workflow_automation_rule', '{{name}}自动化规则', {
                    name: node.name,
                  })}
                  className="col-start-2 col-span-2 h-8 rounded-lg border border-border bg-background px-2 text-xs"
                >
                  <option value="">{t('todo.workflow_select_automation', '选择自动化规则')}</option>
                  {automationRules
                    .filter(rule =>
                      node.kind === 'ai'
                        ? rule.assignmentMode === 'ai_managed'
                        : rule.assignmentMode === 'manual'
                    )
                    .map(rule => (
                      <option key={rule.id} value={rule.id}>
                        {rule.name}
                      </option>
                    ))}
                </select>
              ) : null}
              <div className="col-start-2 col-span-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{t('todo.workflow_dependencies', '依赖')}</span>
                {value.nodes.slice(0, index).map(candidate => (
                  <label key={candidate.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid={`project-workflow-stage-dependency-${node.id}-${candidate.id}`}
                      checked={node.depends_on.includes(candidate.id)}
                      onChange={() =>
                        updateNode(node.id, {
                          depends_on: node.depends_on.includes(candidate.id)
                            ? node.depends_on.filter(dependency => dependency !== candidate.id)
                            : [...node.depends_on, candidate.id],
                        })
                      }
                    />
                    {candidate.name}
                  </label>
                ))}
                {index === 0 ? (
                  <span>{t('todo.workflow_no_dependencies', '无前置阶段')}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
