import {
  Bot,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  GitBranch,
  Laptop,
  Plus,
  Puzzle,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { PopupMenu } from '@/components/common/MenuSelect'
import { automationClass } from './automationStyles'
import { AutomationRoleAssignee } from './AutomationRoleAssignee'

export const DELIVERABLE_TYPE_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'file', label: '文件' },
  { value: 'code_snapshot', label: '代码快照' },
  { value: 'git_branch', label: 'Git 分支' },
  { value: 'pull_request', label: 'PR/MR' },
  { value: 'url', label: '链接' },
]

export function environmentDisplayLabel(option) {
  if (!option) return ''
  if (option.executionEnvironment === 'local') return '本机'
  return option.label.replace(/\s*·\s*(在线|忙碌)$/, '') || option.deviceId
}

export function clearExecutionEnvironment(onChange) {
  onChange('executionDeviceId', null)
  onChange('executionEnvironment', 'local')
  onChange('environment', '')
  onChange('runtimeProfileId', null)
}

export function clearExecutionModel(onChange) {
  onChange('model', '')
  onChange('modelType', null)
  onChange('modelOptions', {})
  onChange('runtimeProfileId', null)
}

export function ExecutionEnvironmentSelect({ testId, value, options, onChange }) {
  const selected = options.find(option => option.deviceId === value)
  const selectedLabel = environmentDisplayLabel(selected)
  const SelectedIcon = selected?.executionEnvironment === 'cloud' ? Cloud : Laptop

  return (
    <PopupMenu
      testId={testId}
      fullWidth
      trigger={
        <span
          data-value={value ?? ''}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-transparent bg-muted/60 px-3 text-sm text-text-primary transition-colors hover:bg-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <SelectedIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
            ) : null}
            <span className={selected ? 'truncate' : 'truncate text-text-muted'}>
              {selectedLabel || '选择执行环境'}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
    >
      {close => (
        <>
          <button
            type="button"
            data-testid={`${testId}-option-none`}
            onClick={() => {
              onChange(null)
              close()
            }}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
          >
            <X aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">不指定执行环境</span>
            {!value ? <Check className="h-4 w-4 shrink-0" /> : null}
          </button>
          {options.map(option => {
            const label = environmentDisplayLabel(option)
            const OptionIcon = option.executionEnvironment === 'cloud' ? Cloud : Laptop
            return (
              <button
                key={option.deviceId}
                type="button"
                data-testid={`${testId}-option-${option.deviceId}`}
                aria-label={option.executionEnvironment === 'cloud' ? `云设备 ${label}` : '本机'}
                onClick={() => {
                  onChange(option.deviceId)
                  close()
                }}
                className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
              >
                <OptionIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {option.deviceId === value ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            )
          })}
        </>
      )}
    </PopupMenu>
  )
}

export function PluginSelector({ testId, selectedPlugins, options, onToggle, onOpen }) {
  const optionForLabel = label =>
    options.find(option => option.label === label) ?? {
      id: label,
      label,
      reference: { displayName: label },
    }

  return (
    <div className={automationClass('panel-plugins')}>
      {selectedPlugins.map(plugin => (
        <button key={plugin} type="button" onClick={() => onToggle(optionForLabel(plugin))}>
          {plugin}
          <X size={12} />
        </button>
      ))}
      <PopupMenu
        testId={testId}
        keepOpen
        menuWidth={224}
        triggerClassName="add"
        onOpen={onOpen}
        trigger={
          <span className="inline-flex items-center gap-1">
            <Plus size={12} />
            添加
          </span>
        }
      >
        {() =>
          options.length ? (
            options.map(option => {
              const checked = selectedPlugins.includes(option.label)
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  data-testid={`${testId}-option-${option.id}`}
                  onClick={() => onToggle(option)}
                  className="flex h-9 w-full items-center gap-2 rounded-lg bg-transparent px-2.5 text-left text-xs text-text-secondary hover:bg-muted"
                >
                  <span
                    className={automationClass(
                      'grid size-4 place-items-center rounded border border-border-strong',
                      checked && 'border-focus bg-focus text-white'
                    )}
                  >
                    {checked ? <Check size={11} /> : null}
                  </span>
                  {option.label}
                </button>
              )
            })
          ) : (
            <small className="block px-2.5 py-2 text-xs text-text-muted">
              当前执行环境没有可用插件
            </small>
          )
        }
      </PopupMenu>
    </div>
  )
}

export function CoordinatorSettings({
  coordinator,
  executionCatalog,
  onChange,
  onDelete,
  deleteButtonRef,
  onOpenPluginMenu,
}) {
  const { t } = useTranslation()
  const environmentOptions = executionCatalog.environments.some(
    option => option.deviceId === coordinator.executionDeviceId
  )
    ? executionCatalog.environments
    : coordinator.executionDeviceId
      ? [
          {
            deviceId: coordinator.executionDeviceId,
            label: coordinator.environment,
            executionEnvironment: coordinator.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments
  const modelOptions = executionCatalog.models.some(option => option.name === coordinator.model)
    ? executionCatalog.models
    : coordinator.model
      ? [
          {
            name: coordinator.model,
            label: coordinator.model,
            type: coordinator.modelType,
            options: coordinator.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...coordinator.plugins
      .filter(label => !executionCatalog.plugins.some(option => option.label === label))
      .map(label => ({ id: label, label, reference: { displayName: label } })),
  ]

  const selectEnvironment = deviceId => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange)
      return
    }
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
    if (!name) {
      clearExecutionModel(onChange)
      return
    }
    const option = modelOptions.find(candidate => candidate.name === name)
    if (!option) return
    onChange('model', option.name)
    onChange('modelType', option.type)
    onChange('modelOptions', option.options)
    onChange('runtimeProfileId', null)
  }

  const togglePlugin = option => {
    const selected = coordinator.plugins.includes(option.label)
    onChange(
      'plugins',
      selected
        ? coordinator.plugins.filter(item => item !== option.label)
        : [...coordinator.plugins, option.label]
    )
    onChange(
      'projectPlugins',
      selected
        ? coordinator.projectPlugins.filter(item => item.id !== option.id)
        : [...coordinator.projectPlugins, option.reference]
    )
  }

  return (
    <div className={automationClass('panel-settings')}>
      <div className={automationClass('coordinator-intro')}>
        <Sparkles size={17} />
        <div>
          <strong>由 AI 决定具体怎么做</strong>
          <span>{t('todo.assignment_coordinator_hint')}</span>
        </div>
      </div>

      <label className={automationClass('panel-field')}>
        <span>
          <Code2 size={14} />
          {t('todo.workflow_coordinator_prompt')}
        </span>
        <textarea
          data-testid="ai-coordinator-prompt"
          value={coordinator.prompt}
          placeholder={t('todo.assignment_coordinator_prompt_placeholder')}
          onChange={event => onChange('prompt', event.target.value)}
        />
      </label>

      <div className={automationClass('node-model-settings coordinator-model-settings')}>
        <label className={automationClass('panel-field')}>
          <span>
            <Laptop size={14} />
            调度执行环境
          </span>
          <ExecutionEnvironmentSelect
            testId="ai-coordinator-environment"
            value={coordinator.executionDeviceId ?? ''}
            options={environmentOptions}
            onChange={selectEnvironment}
          />
        </label>
        <label className={automationClass('panel-field')}>
          <span>
            <Sparkles size={14} />
            调度模型
          </span>
          <select
            data-testid="ai-coordinator-model"
            value={coordinator.model}
            onChange={event => selectModel(event.target.value)}
          >
            <option value="">不指定模型</option>
            {modelOptions.map(option => (
              <option key={`${option.type}-${option.name}`} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className={automationClass('panel-field')}>
          <span>
            <Puzzle size={14} />
            调度插件
          </span>
          <PluginSelector
            testId="ai-coordinator-add-plugin"
            selectedPlugins={coordinator.plugins}
            options={configuredPluginOptions}
            onToggle={togglePlugin}
            onOpen={onOpenPluginMenu}
          />
        </div>
      </div>
    </div>
  )
}

export function StepSettings({
  step,
  executionCatalog,
  onChange,
  onDelete,
  deleteButtonRef,
  onOpenPluginMenu,
  supplemental,
  advancement,
}) {
  const { t } = useTranslation()
  if (!step) return null

  const environmentOptions = executionCatalog.environments.some(
    option => option.deviceId === step.executionDeviceId
  )
    ? executionCatalog.environments
    : step.executionDeviceId
      ? [
          {
            deviceId: step.executionDeviceId,
            label: step.environment,
            executionEnvironment: step.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments
  const modelOptions = executionCatalog.models.some(option => option.name === step.model)
    ? executionCatalog.models
    : step.model
      ? [
          {
            name: step.model,
            label: step.model,
            type: step.modelType,
            options: step.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...step.plugins
      .filter(label => !executionCatalog.plugins.some(option => option.label === label))
      .map(label => ({ id: label, label, reference: { displayName: label } })),
  ]

  const selectEnvironment = deviceId => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange)
      return
    }
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
    if (!name) {
      clearExecutionModel(onChange)
      return
    }
    const option = modelOptions.find(candidate => candidate.name === name)
    if (!option) return
    onChange('model', option.name)
    onChange('modelType', option.type)
    onChange('modelOptions', option.options)
    onChange('runtimeProfileId', null)
  }

  const togglePlugin = option => {
    const selected = step.plugins.includes(option.label)
    onChange(
      'plugins',
      selected
        ? step.plugins.filter(item => item !== option.label)
        : [...step.plugins, option.label]
    )
    onChange(
      'projectPlugins',
      selected
        ? step.projectPlugins.filter(item => item.id !== option.id)
        : [...step.projectPlugins, option.reference]
    )
  }

  const addDeliverable = () => {
    onChange('deliverables', [
      ...step.deliverables,
      {
        id: `deliverable-${Date.now()}`,
        name: '新交付物',
        description: '',
        valueType: 'text',
        fileConstraints: null,
      },
    ])
  }

  const updateDeliverable = (id, key, value) => {
    onChange(
      'deliverables',
      step.deliverables.map(deliverable =>
        deliverable.id === id ? { ...deliverable, [key]: value } : deliverable
      )
    )
  }

  const updateDeliverableType = (id, valueType) => {
    const deliverable = step.deliverables.find(item => item.id === id)
    if (!deliverable) return
    onChange(
      'deliverables',
      step.deliverables.map(item =>
        item.id === id
          ? {
              ...item,
              valueType,
              fileConstraints:
                valueType === 'file'
                  ? (deliverable.fileConstraints ?? {
                      accepted_types: [],
                      min_files: 1,
                      max_files: 1,
                    })
                  : null,
            }
          : item
      )
    )
  }

  return (
    <>
      <section className={automationClass('panel-section')}>
        <label className={automationClass('panel-field')}>
          <span>{t('todo.assignment_role_name')}</span>
          <input
            data-testid={`execution-node-name-${step.id}`}
            value={step.name}
            placeholder={t('todo.assignment_role_name_placeholder')}
            onChange={event => onChange('name', event.target.value)}
          />
        </label>
        <label className={automationClass('panel-field')}>
          <span>
            <Code2 size={14} />
            {t('todo.assignment_role_duties')}
          </span>
          <textarea
            data-testid={`execution-node-prompt-${step.id}`}
            value={step.prompt}
            placeholder={t('todo.assignment_role_duties_placeholder')}
            onChange={event => onChange('prompt', event.target.value)}
          />
        </label>
      </section>

      <section className={automationClass('deliverables-section')}>
        <div className={automationClass('section-heading')}>
          <strong>必要交付物</strong>
          <button
            type="button"
            data-testid={`execution-node-add-deliverable-${step.id}`}
            onClick={addDeliverable}
          >
            <Plus size={13} />
            添加交付物
          </button>
        </div>
        {step.deliverables.length ? (
          <div className={automationClass('deliverable-list')}>
            {step.deliverables.map(deliverable => (
              <div className={automationClass('deliverable-item')} key={deliverable.id}>
                <div>
                  <input
                    data-testid={`execution-node-deliverable-name-${deliverable.id}`}
                    value={deliverable.name}
                    aria-label="交付物名称"
                    onChange={event =>
                      updateDeliverable(deliverable.id, 'name', event.target.value)
                    }
                  />
                  <input
                    data-testid={`execution-node-deliverable-description-${deliverable.id}`}
                    value={deliverable.description}
                    aria-label="交付物验收说明"
                    placeholder="暂无验收说明"
                    onChange={event =>
                      updateDeliverable(deliverable.id, 'description', event.target.value)
                    }
                  />
                </div>
                <select
                  data-testid={`execution-node-deliverable-type-${deliverable.id}`}
                  value={deliverable.valueType}
                  aria-label={`交付物类型 ${deliverable.name}`}
                  onChange={event => updateDeliverableType(deliverable.id, event.target.value)}
                >
                  {DELIVERABLE_TYPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid={`execution-node-deliverable-delete-${deliverable.id}`}
                  aria-label={`删除交付物 ${deliverable.name}`}
                  onClick={() =>
                    onChange(
                      'deliverables',
                      step.deliverables.filter(item => item.id !== deliverable.id)
                    )
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            className={automationClass('empty-deliverables')}
            type="button"
            data-testid={`execution-node-empty-deliverables-${step.id}`}
            onClick={addDeliverable}
          >
            暂无交付物，点击添加
          </button>
        )}
        <p>每项交付要求都会绑定一个实际结果；全部满足后才可继续。</p>
      </section>

      <section className={automationClass('panel-section execution-section')}>
        <fieldset className={automationClass('execution-mode')}>
          <legend>任务执行方式</legend>
          <div>
            <button
              type="button"
              data-testid={`execution-node-mode-manual-${step.id}`}
              className={step.executionMode === 'manual' ? 'selected' : ''}
              onClick={() => onChange('executionMode', 'manual')}
            >
              <UserRound size={16} />
              手动执行
            </button>
            <button
              type="button"
              data-testid={`execution-node-mode-automatic-${step.id}`}
              className={step.executionMode === 'automatic' ? 'selected' : ''}
              onClick={() => onChange('executionMode', 'automatic')}
            >
              <Bot size={16} />
              自动执行
            </button>
          </div>
        </fieldset>

        {step.executionMode === 'manual' ? (
          <AutomationRoleAssignee
            value={step.assigneeUserId ?? null}
            onChange={value => onChange('assigneeUserId', value)}
          />
        ) : null}
        {step.executionMode === 'automatic' ? (
          <div className={automationClass('node-model-settings')}>
            <label className={automationClass('panel-field')}>
              <span>
                <Laptop size={14} />
                执行环境
              </span>
              <ExecutionEnvironmentSelect
                testId={`execution-node-environment-${step.id}`}
                value={step.executionDeviceId ?? ''}
                options={environmentOptions}
                onChange={selectEnvironment}
              />
            </label>
            <label className={automationClass('panel-field')}>
              <span>
                <Sparkles size={14} />
                模型
              </span>
              <select
                data-testid={`execution-node-model-${step.id}`}
                value={step.model}
                onChange={event => selectModel(event.target.value)}
              >
                <option value="">不指定模型</option>
                {modelOptions.map(option => (
                  <option key={`${option.type}-${option.name}`} value={option.name}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={automationClass('panel-field')}>
              <span>
                <Puzzle size={14} />
                插件
              </span>
              <PluginSelector
                testId={`execution-node-add-plugin-${step.id}`}
                selectedPlugins={step.plugins}
                options={configuredPluginOptions}
                onToggle={togglePlugin}
                onOpen={onOpenPluginMenu}
              />
            </div>
            <p className={automationClass('execution-hint')}>
              节点提示词会作为当前模型的任务指令，执行记录归入当前节点。
            </p>
          </div>
        ) : (
          <p className={automationClass('execution-hint')}>
            节点就绪后由成员手动执行，完成结果仍归入当前节点。
          </p>
        )}

        <label className={automationClass('panel-field')}>
          <span>任务工作空间</span>
          <select
            data-testid={`execution-node-workspace-${step.id}`}
            value={step.workspacePolicy}
            onChange={event => onChange('workspacePolicy', event.target.value)}
          >
            <option value="composer">创建任务时选择工作空间</option>
            <option value="inherit">继承前序任务工作空间</option>
            <option value="none">不限定工作空间</option>
          </select>
        </label>

        <div className={automationClass('panel-help')}>
          <GitBranch size={15} />
          <p>
            {t(
              advancement === 'ai'
                ? 'todo.assignment_ai_role_hint'
                : 'todo.assignment_sequential_role_hint'
            )}
          </p>
        </div>
      </section>
      {supplemental ? (
        <section className={automationClass('panel-section')}>{supplemental}</section>
      ) : null}
      <section className={automationClass('panel-danger-zone')}>
        <button
          ref={deleteButtonRef}
          className={automationClass('delete-step')}
          data-testid={`execution-node-delete-${step.id}`}
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {t('todo.assignment_delete_role')}
        </button>
      </section>
    </>
  )
}
