import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  DEFAULT_TODO_WORKFLOW,
  TODO_WORKFLOW_TEMPLATES,
  type TodoPrincipalType,
  type TodoWorkflowConfig,
  type TodoWorkType,
} from './todoModel'

interface TodoWorkflowDialogProps {
  projectName: string
  initialConfig: TodoWorkflowConfig
  onClose: () => void
  onSave: (config: TodoWorkflowConfig) => void
}

export function TodoWorkflowDialog({
  projectName,
  initialConfig,
  onClose,
  onSave,
}: TodoWorkflowDialogProps) {
  const { t } = useTranslation('common')
  const [workTypes, setWorkTypes] = useState<TodoWorkType[]>(initialConfig.workTypes)
  const [newName, setNewName] = useState('')
  useEscapeKey(onClose, true)

  const addWorkType = () => {
    const name = newName.trim()
    if (!name) return
    const baseKey = name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
    let key = baseKey || `type-${Date.now()}`
    let suffix = 2
    while (workTypes.some(item => item.key === key)) key = `${baseKey}-${suffix++}`
    setWorkTypes(current => [
      ...current,
      { key, name, dependsOn: [], defaultAssignee: { type: 'unassigned' } },
    ])
    setNewName('')
  }

  const toggleDependency = (workTypeKey: string, dependencyKey: string) => {
    setWorkTypes(current =>
      current.map(workType =>
        workType.key === workTypeKey
          ? {
              ...workType,
              dependsOn: workType.dependsOn.includes(dependencyKey)
                ? workType.dependsOn.filter(key => key !== dependencyKey)
                : [...workType.dependsOn, dependencyKey],
            }
          : workType
      )
    )
  }

  const removeWorkType = (key: string) => {
    setWorkTypes(current =>
      current
        .filter(item => item.key !== key)
        .map(item => ({ ...item, dependsOn: item.dependsOn.filter(value => value !== key) }))
    )
  }

  const updateAssignee = (key: string, type: TodoPrincipalType, name?: string) => {
    setWorkTypes(current =>
      current.map(workType =>
        workType.key === key
          ? { ...workType, defaultAssignee: { type, name: name ?? workType.defaultAssignee.name } }
          : workType
      )
    )
  }

  const renameWorkType = (key: string, name: string) => {
    setWorkTypes(current =>
      current.map(workType => (workType.key === key ? { ...workType, name } : workType))
    )
  }

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-workflow-dialog-title"
        data-testid="todo-workflow-dialog"
        className="flex max-h-[calc(100vh-40px)] w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      >
        <header className="flex h-14 items-center justify-between border-b border-border px-5">
          <div>
            <h2
              id="todo-workflow-dialog-title"
              className="text-[16px] font-semibold text-text-primary"
            >
              {t('todo.workflow_settings', '工作流配置')}
            </h2>
            <p className="text-[11px] text-text-muted">{projectName}</p>
          </div>
          <button
            type="button"
            data-testid="todo-workflow-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted"
            aria-label={t('workbench.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <h3 className="text-[13px] font-semibold text-text-primary">
            {t('todo.item_statuses', '事项状态')}
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {initialConfig.statuses.map(status => (
              <span
                key={status.key}
                className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-text-secondary"
              >
                {status.name}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-text-muted">
            {t(
              'todo.statuses_fixed_hint',
              '单机第一版使用五个稳定状态，专业工作类型可按项目配置。'
            )}
          </p>

          <h3 className="mt-6 text-[13px] font-semibold text-text-primary">
            {t('todo.work_types', '专业工作类型')}
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TODO_WORKFLOW_TEMPLATES.map(template => (
              <button
                key={template.key}
                type="button"
                data-testid={`todo-workflow-template-${template.key}`}
                onClick={() => setWorkTypes(template.workTypes.map(workType => ({ ...workType })))}
                className="h-7 rounded-md border border-border px-2 text-[10px] text-text-secondary hover:border-primary/40 hover:text-primary"
              >
                {template.name}
              </button>
            ))}
          </div>
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {workTypes.map(workType => (
              <div key={workType.key} className="px-3 py-2">
                <div className="flex h-8 items-center gap-2">
                  <input
                    data-testid={`todo-workflow-name-${workType.key}`}
                    value={workType.name}
                    onChange={event => renameWorkType(workType.key, event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-[12px] text-text-primary outline-none hover:border-border focus:border-primary"
                  />
                  <span className="font-mono text-[10px] text-text-muted">{workType.key}</span>
                  <button
                    type="button"
                    data-testid={`todo-workflow-remove-${workType.key}`}
                    onClick={() => removeWorkType(workType.key)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-destructive/10 hover:text-destructive"
                    aria-label={t('todo.remove_work_type', '删除工作类型')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="ml-5 flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-[9px] text-text-muted">
                    {t('todo.depends_on', '前置阶段')}
                  </span>
                  {workTypes
                    .filter(candidate => candidate.key !== workType.key)
                    .map(candidate => {
                      const active = workType.dependsOn.includes(candidate.key)
                      return (
                        <button
                          key={candidate.key}
                          type="button"
                          data-testid={`todo-workflow-dependency-${workType.key}-${candidate.key}`}
                          aria-pressed={active}
                          onClick={() => toggleDependency(workType.key, candidate.key)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[9px]',
                            active
                              ? 'bg-primary/10 font-medium text-primary'
                              : 'bg-muted text-text-muted hover:text-text-primary'
                          )}
                        >
                          {candidate.name}
                        </button>
                      )
                    })}
                </div>
                <div className="ml-5 mt-2 flex items-center gap-1.5">
                  <span className="mr-1 text-[9px] text-text-muted">
                    {t('todo.default_assignee', '默认负责人')}
                  </span>
                  <select
                    data-testid={`todo-workflow-assignee-type-${workType.key}`}
                    value={workType.defaultAssignee.type}
                    onChange={event =>
                      updateAssignee(workType.key, event.target.value as TodoPrincipalType)
                    }
                    className="h-7 rounded-md border border-border bg-background px-2 text-[10px] text-text-secondary"
                  >
                    <option value="unassigned">
                      {t('todo.assignee_unassigned_short', '未指定')}
                    </option>
                    <option value="human">{t('todo.assignee_human', '员工')}</option>
                    <option value="ai">{t('todo.assignee_ai', 'AI 智能体')}</option>
                  </select>
                  {workType.defaultAssignee.type !== 'unassigned' && (
                    <input
                      data-testid={`todo-workflow-assignee-name-${workType.key}`}
                      value={workType.defaultAssignee.name ?? ''}
                      onChange={event =>
                        updateAssignee(
                          workType.key,
                          workType.defaultAssignee.type,
                          event.target.value
                        )
                      }
                      placeholder={t('todo.assignee_name_placeholder', '姓名或智能体名称')}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[10px] outline-none focus:border-primary"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              data-testid="todo-workflow-new-type"
              value={newName}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') addWorkType()
              }}
              placeholder={t('todo.work_type_placeholder', '例如：安全评审')}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addWorkType}
              data-testid="todo-workflow-add-type"
            >
              <Plus className="h-4 w-4" />
              {t('todo.add', '添加')}
            </Button>
          </div>
        </div>
        <footer className="flex h-14 items-center justify-end gap-2 border-t border-border px-5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setWorkTypes(DEFAULT_TODO_WORKFLOW.workTypes)}
          >
            {t('todo.clear_workflow', '清空流程')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel', '取消')}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="todo-workflow-save"
            onClick={() => onSave({ ...initialConfig, workTypes })}
          >
            {t('common.save', '保存')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
