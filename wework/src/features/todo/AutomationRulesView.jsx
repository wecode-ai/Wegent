import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Code2,
  Copy,
  FolderKanban,
  GitBranch,
  History,
  Laptop,
  LayoutGrid,
  MoreHorizontal,
  Play,
  Plus,
  Puzzle,
  Rocket,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  Webhook,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { AutomationWorkflowCanvas } from './AutomationWorkflowCanvas.jsx'
import { automationClass } from './automationStyles'

function createExecutionNode({
  id,
  name,
  prompt,
  kind = 'task',
  dependencies = [],
  dependencyContext = {},
  x = 0,
  y = 0,
  deliverables = [],
  executionMode = 'automatic',
  environment = '',
  executionEnvironment = 'local',
  executionDeviceId = null,
  runtimeProfileId = null,
  model = '',
  modelType = null,
  modelOptions = {},
  plugins = [],
  projectPlugins = [],
  workspacePolicy = executionMode === 'automatic' ? 'none' : 'composer',
  required = true,
  automationRuleId = null,
  executionConfig = null,
  executionConfigOverride = false,
  subgraph = null,
}) {
  return {
    id,
    name,
    prompt,
    kind,
    dependencies,
    dependencyContext,
    x,
    y,
    deliverables,
    executionMode,
    environment,
    executionEnvironment,
    executionDeviceId,
    runtimeProfileId,
    model,
    modelType,
    modelOptions,
    plugins,
    projectPlugins,
    workspacePolicy,
    required,
    automationRuleId,
    executionConfig,
    executionConfigOverride,
    subgraph,
  }
}

function defaultExecutionConfiguration(executionCatalog) {
  const environment = executionCatalog.environments[0]
  const model = executionCatalog.models[0]
  return {
    environment: environment?.label ?? '',
    executionEnvironment: environment?.executionEnvironment ?? 'local',
    executionDeviceId: environment?.deviceId ?? null,
    model: model?.name ?? '',
    modelType: model?.type ?? null,
    modelOptions: model?.options ?? {},
  }
}

function createDynamicAllocationNode(executionCatalog, id = `step-${Date.now()}`) {
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    kind: 'dynamic',
    name: 'AI 动态分配',
    prompt:
      '阅读 Issue 的目标、上下文和验收标准，拆解需要完成的具体任务，选择合适的执行方式，并根据依赖关系决定执行顺序。',
    subgraph: {
      nodes: [
        createExecutionNode({
          ...defaultExecutionConfiguration(executionCatalog),
          id: `dag-stage-${id}-analysis`,
          name: '分析需求',
          prompt: '理解 Issue 的目标、范围和验收标准。',
          dependencies: [],
          x: 24,
          y: 105,
        }),
        createExecutionNode({
          ...defaultExecutionConfiguration(executionCatalog),
          id: `dag-stage-${id}-implementation`,
          name: '实现任务',
          prompt: '根据需求创建并分配实现任务。',
          dependencies: [`dag-stage-${id}-analysis`],
          x: 224,
          y: 40,
        }),
        createExecutionNode({
          ...defaultExecutionConfiguration(executionCatalog),
          id: `dag-stage-${id}-testing`,
          name: '验证结果',
          prompt: '创建验证任务并检查交付结果。',
          dependencies: [`dag-stage-${id}-analysis`],
          x: 224,
          y: 170,
        }),
        createExecutionNode({
          ...defaultExecutionConfiguration(executionCatalog),
          id: `dag-stage-${id}-delivery`,
          name: '汇总交付',
          prompt: '汇总所有分支结果并形成最终交付。',
          dependencies: [`dag-stage-${id}-implementation`, `dag-stage-${id}-testing`],
          x: 424,
          y: 105,
        }),
      ],
    },
  })
}

const automationTemplates = [
  {
    id: 'issue-development',
    category: 'issue',
    featured: true,
    name: 'Issue 自动开发',
    description: '创建 Issue 后自动分析需求、实现代码并回写结果',
    tags: ['Issue', '研发'],
    icon: 'development',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动开发'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '分析需求',
        prompt: '阅读 Issue 的标题、描述和附件，理解目标、范围和验收标准。',
        deliverables: [
          {
            name: '需求分析',
            description: '目标、范围、约束与验收标准',
            type: '文本',
          },
        ],
        plugins: ['Wework 项目空间'],
      },
      {
        name: '实现与验证',
        prompt: '根据需求分析修改代码并运行相关测试，保留可验证的执行证据。',
        deliverables: [
          {
            name: '实现结果',
            description: '代码改动与测试结果',
            type: '文本',
          },
        ],
        plugins: ['GitHub', 'Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
      {
        name: '回写 Issue',
        prompt: '将实现结果、验证证据和后续建议回写当前 Issue。',
        deliverables: [
          {
            name: 'Issue 更新',
            description: '结果、证据和后续建议',
            type: '文本',
          },
        ],
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-testing',
    category: 'issue',
    featured: true,
    name: 'Issue 自动测试',
    description: '创建测试任务后自动确定范围、运行测试并更新验收结果',
    tags: ['Issue', '测试'],
    icon: 'testing',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动测试'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '确定测试范围',
        prompt: '根据 Issue 描述和代码变更识别需要执行的测试集合。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '运行测试',
        prompt: '运行相关自动化测试，定位失败原因并收集可复现日志。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '更新验收结果',
        prompt: '将测试结论、失败日志和验收建议回写 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'daily-inspection',
    category: 'schedule',
    featured: true,
    name: '每日 Issue 巡检',
    description: '每天检查待处理和长期未更新的 Issue，生成行动建议',
    tags: ['定时', '巡检'],
    icon: 'schedule',
    trigger: {
      type: 'schedule',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '检查看板',
        prompt: '检查项目看板中的待处理和长时间未更新事项，识别优先级、依赖和风险。',
      },
      {
        name: '生成巡检报告',
        prompt: '汇总需要关注的 Issue，并为每项给出明确的下一步行动建议。',
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-defect-triage',
    category: 'issue',
    featured: false,
    name: '缺陷自动分析',
    description: '新缺陷创建后自动复现、定位原因并给出修复建议',
    tags: ['Issue', '缺陷'],
    icon: 'defect',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'status',
      event: 'created',
      tags: ['缺陷'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '复现缺陷',
        prompt: '阅读缺陷描述和附件，按照复现步骤验证问题并补充必要信息。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '定位原因',
        prompt: '分析相关代码和日志，定位最可能的根因及影响范围。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '给出修复建议',
        prompt: '整理根因、修复方案、验证方式和风险，并回写当前 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
]

const frequencyLabels = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
}

const weekdayLabels = {
  monday: '周一',
  tuesday: '周二',
  wednesday: '周三',
  thursday: '周四',
  friday: '周五',
  saturday: '周六',
  sunday: '周日',
}

function triggerPresentation(trigger) {
  if (trigger.type === 'schedule') {
    const schedule = trigger.schedule
    const frequency =
      schedule.frequency === 'weekly'
        ? `每周${weekdayLabels[schedule.weekday]}`
        : frequencyLabels[schedule.frequency]
    return {
      label: `${frequency} ${schedule.time}`,
      detail: `按计划执行 · ${schedule.timezone}`,
    }
  }

  if (trigger.startMode === 'status') {
    return {
      label: 'Issue 开始处理时',
      detail: 'Issue 状态进入「待开始」或「进行中」时启动',
    }
  }

  const tagSuffix = trigger.tags.length
    ? `，且包含标签「${trigger.tags.join('、')}」中的任意一个`
    : ''
  return {
    label: 'Issue 创建后自动启动',
    detail: `创建新的 Issue 后立即运行${tagSuffix}`,
  }
}

function cloneRule(rule) {
  const cloneNode = step => ({
    ...step,
    dependencies: [...(step.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(step.dependencyContext ?? {}).map(([dependencyId, sources]) => [
        dependencyId,
        [...sources],
      ])
    ),
    deliverables: step.deliverables.map(deliverable => ({ ...deliverable })),
    plugins: [...step.plugins],
    projectPlugins: [...(step.projectPlugins ?? [])],
    modelOptions: { ...(step.modelOptions ?? {}) },
    executionConfig: step.executionConfig
      ? {
          ...step.executionConfig,
          model_options: { ...(step.executionConfig.model_options ?? {}) },
          project_plugins: [...(step.executionConfig.project_plugins ?? [])],
        }
      : null,
    subgraph: step.subgraph
      ? {
          nodes: step.subgraph.nodes.map(cloneNode),
        }
      : null,
  })
  return {
    ...rule,
    trigger: {
      ...rule.trigger,
      tags: [...rule.trigger.tags],
      statuses: [...(rule.trigger.statuses ?? ['pending', 'in_progress'])],
      schedule: { ...rule.trigger.schedule },
    },
    steps: rule.steps.map(cloneNode),
  }
}

function makeRule() {
  return {
    id: `draft-${crypto.randomUUID()}`,
    persisted: false,
    origin: 'automation',
    version: 1,
    name: '未命名自动化',
    description: '描述这条自动化要完成什么',
    enabled: false,
    updatedAt: '尚未发布',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      statuses: ['pending', 'in_progress'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [],
    lastStatus: 'idle',
    legacyDefinition: null,
  }
}

function makeRuleFromTemplate(template, executionCatalog) {
  const createdAt = Date.now()
  const rule = makeRule()
  const executionDefaults = defaultExecutionConfiguration(executionCatalog)
  return {
    ...rule,
    name: template.name,
    description: template.description,
    trigger: {
      ...template.trigger,
      tags: [...template.trigger.tags],
      statuses: [...(template.trigger.statuses ?? ['pending', 'in_progress'])],
      schedule: { ...template.trigger.schedule },
    },
    steps: template.steps.map((step, stepIndex) =>
      createExecutionNode({
        ...executionDefaults,
        ...step,
        id: `step-${createdAt}-${stepIndex + 1}`,
        dependencies: stepIndex ? [`step-${createdAt}-${stepIndex}`] : [],
        x: 440 + stepIndex * 420,
        y: 226,
        deliverables: (step.deliverables ?? []).map((deliverable, deliverableIndex) => ({
          ...deliverable,
          id: `deliverable-${createdAt}-${stepIndex + 1}-${deliverableIndex + 1}`,
        })),
        plugins: [...(step.plugins ?? [])],
      })
    ),
  }
}

function executionNodesComplete(rule) {
  const nodesComplete = nodes =>
    nodes.every(
      step =>
        step.name.trim() &&
        step.prompt.trim() &&
        (step.executionMode === 'automatic'
          ? step.environment &&
            step.model &&
            (step.workspacePolicy !== 'composer' ||
              Boolean(step.executionConfig?.workspace_binding))
          : true) &&
        (!step.subgraph || nodesComplete(step.subgraph.nodes))
    )
  return rule.steps.length > 0 && nodesComplete(rule.steps)
}

export function AutomationRulesView({
  rules: backendRules,
  runs: backendRuns,
  loading = false,
  error = '',
  canManage = true,
  projectTags = [],
  executionCatalog = { environments: [], models: [], plugins: [] },
  onReload,
  onSaveRule,
  onToggleRule,
  onDuplicateRule,
  onDeleteRule,
  onRunRule,
}) {
  const [view, setView] = useState('home')
  const [homeTab, setHomeTab] = useState('rules')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState(backendRules)
  const [runs, setRuns] = useState(backendRuns)
  const [draft, setDraft] = useState(makeRule)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [editorSection, setEditorSection] = useState('workflow')
  const [selectedNode, setSelectedNode] = useState({ type: 'trigger' })
  const [panelTab, setPanelTab] = useState('settings')
  const [templateStoreOpen, setTemplateStoreOpen] = useState(false)
  const [pluginMenuOpen, setPluginMenuOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(draft) !== savedSnapshot

  useEffect(() => {
    setRules(backendRules)
    setDraft(current => {
      if (!current.persisted) return current
      const refreshed = backendRules.find(rule => rule.id === current.id)
      return refreshed ? cloneRule(refreshed) : current
    })
  }, [backendRules])

  useEffect(() => {
    setRuns(backendRuns)
  }, [backendRuns])

  const visibleRules = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return rules.filter(rule => {
      const matchesStatus =
        filter === 'all' || (filter === 'enabled' ? rule.enabled : !rule.enabled)
      const trigger = triggerPresentation(rule.trigger)
      const matchesQuery =
        !normalized ||
        `${rule.name} ${rule.description} ${trigger.label}`.toLowerCase().includes(normalized)
      return matchesStatus && matchesQuery
    })
  }, [filter, query, rules])

  const notify = message => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }

  const openRule = rule => {
    setDraft(cloneRule(rule))
    setSavedSnapshot(JSON.stringify(rule))
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
  }

  const createRule = () => {
    const rule = makeRule()
    setDraft(rule)
    setSavedSnapshot('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setView('editor')
  }

  const applyTemplate = template => {
    const rule = makeRuleFromTemplate(template, executionCatalog)
    setTemplateStoreOpen(false)
    setDraft(rule)
    setSavedSnapshot('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
  }

  const updateDraft = updater => {
    setDraft(current => (typeof updater === 'function' ? updater(current) : updater))
  }

  const saveRule = async published => {
    if (published && !executionNodesComplete(draft)) {
      notify(draft.steps.length ? '请完善执行节点后再发布' : '请先添加执行节点')
      return null
    }
    if (!draft.name.trim() || !draft.description.trim()) {
      notify('请填写自动化名称和说明')
      return null
    }
    setSaving(true)
    try {
      const candidate = {
        ...cloneRule(draft),
        enabled: published ? true : draft.enabled,
      }
      const saved = onSaveRule ? await onSaveRule(candidate, published) : candidate
      setDraft(cloneRule(saved))
      setRules(current => {
        const withoutDraft = current.filter(rule => rule.id !== draft.id)
        const exists = withoutDraft.some(rule => rule.id === saved.id)
        return exists
          ? withoutDraft.map(rule => (rule.id === saved.id ? saved : rule))
          : [saved, ...withoutDraft]
      })
      setSavedSnapshot(JSON.stringify(saved))
      notify(published ? '自动化已发布并启用' : '自动化已保存')
      return saved
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : String(saveError))
      return null
    } finally {
      setSaving(false)
    }
  }

  const duplicateRule = async rule => {
    try {
      const copy = onDuplicateRule
        ? await onDuplicateRule(rule)
        : {
            ...cloneRule(rule),
            id: `draft-${crypto.randomUUID()}`,
            persisted: false,
            origin: 'automation',
            version: 1,
            name: `${rule.name} 副本`,
            enabled: false,
            lastStatus: 'idle',
          }
      setRules(current => [copy, ...current.filter(item => item.id !== copy.id)])
      notify('已创建独立副本')
    } catch (duplicateError) {
      notify(duplicateError instanceof Error ? duplicateError.message : String(duplicateError))
    }
  }

  const deleteRule = async rule => {
    try {
      await onDeleteRule?.(rule)
      setRules(current => current.filter(item => item.id !== rule.id))
      setRuns(current => current.filter(run => run.ruleId !== rule.id))
      notify('自动化已删除')
    } catch (deleteError) {
      notify(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  const runTest = async () => {
    if (!executionNodesComplete(draft)) {
      notify(draft.steps.length ? '请完善执行节点后再测试' : '请先添加执行节点')
      return
    }
    setTesting(true)
    try {
      const saved = dirty || !draft.persisted ? await saveRule(false) : draft
      if (!saved) return
      notify('测试运行已开始')
      const run = onRunRule ? await onRunRule(saved) : null
      if (run) setRuns(current => [run, ...current.filter(item => item.id !== run.id)])
    } catch (runError) {
      notify(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setTesting(false)
    }
  }

  const addStep = (afterIndex, kind = 'task', dependencyIds = null) => {
    const predecessor = draft.steps[afterIndex] ?? null
    const successor = draft.steps[afterIndex + 1] ?? null
    const step =
      kind === 'dynamic'
        ? createDynamicAllocationNode(executionCatalog)
        : createExecutionNode({
            ...defaultExecutionConfiguration(executionCatalog),
            id: `step-${Date.now()}`,
            name: '',
            prompt: '',
          })
    step.dependencies = dependencyIds ?? (predecessor ? [predecessor.id] : [])
    step.dependencyContext = Object.fromEntries(
      step.dependencies.map(dependencyId => [dependencyId, ['final_result', 'deliveries']])
    )
    step.x = predecessor ? predecessor.x + 420 : 440
    step.y = predecessor?.y ?? 226
    updateDraft(current => {
      const next = [...current.steps]
      next.splice(afterIndex + 1, 0, step)
      if (successor && dependencyIds === null) {
        const successorIndex = next.findIndex(candidate => candidate.id === successor.id)
        next[successorIndex] = {
          ...next[successorIndex],
          dependencies: next[successorIndex].dependencies.map(dependencyId =>
            dependencyId === predecessor?.id ? step.id : dependencyId
          ),
          dependencyContext: {
            ...Object.fromEntries(
              Object.entries(next[successorIndex].dependencyContext ?? {}).filter(
                ([dependencyId]) => dependencyId !== predecessor?.id
              )
            ),
            [step.id]: ['final_result', 'deliveries'],
          },
        }
      }
      return { ...current, steps: next }
    })
    setSelectedNode({ type: 'step', id: step.id })
  }

  const removeSelectedStep = () => {
    if (selectedNode.type !== 'step') return
    updateDraft(current => {
      const removed = current.steps.find(step => step.id === selectedNode.id)
      if (!removed) return current
      return {
        ...current,
        steps: current.steps
          .filter(step => step.id !== selectedNode.id)
          .map(step => {
            if (!step.dependencies.includes(selectedNode.id)) return step
            const dependencies = Array.from(
              new Set([
                ...step.dependencies.filter(dependencyId => dependencyId !== selectedNode.id),
                ...removed.dependencies,
              ])
            )
            return {
              ...step,
              dependencies,
              dependencyContext: Object.fromEntries(
                dependencies.map(dependencyId => [
                  dependencyId,
                  step.dependencyContext[dependencyId] ??
                    removed.dependencyContext[dependencyId] ?? ['final_result', 'deliveries'],
                ])
              ),
            }
          }),
      }
    })
    setSelectedNode({ type: 'trigger' })
  }

  if (view === 'editor') {
    const editor = (
      <div className={automationClass('project-editor-host')}>
        <WorkflowEditor
          draft={draft}
          runs={runs.filter(run => run.ruleId === draft.id)}
          dirty={dirty}
          editorSection={editorSection}
          selectedNode={selectedNode}
          panelTab={panelTab}
          testing={testing}
          saving={saving}
          projectTags={projectTags}
          executionCatalog={executionCatalog}
          pluginMenuOpen={pluginMenuOpen}
          onBack={() => setView('home')}
          onEditorSectionChange={setEditorSection}
          onSelectNode={setSelectedNode}
          onPanelTabChange={setPanelTab}
          onDraftChange={updateDraft}
          onSave={() => saveRule(false)}
          onPublish={() => saveRule(true)}
          onTest={runTest}
          onAddStep={addStep}
          onRemoveStep={removeSelectedStep}
          onPluginMenuChange={setPluginMenuOpen}
        />
      </div>
    )
    return (
      <div
        className={automationClass('automation-root editor')}
        data-testid="project-automation-view"
      >
        {editor}
        {toast ? (
          <div className={automationClass('toast')}>
            <CheckCircle2 size={16} />
            {toast}
          </div>
        ) : null}
      </div>
    )
  }

  const content = (
    <main className={automationClass('project-content')}>
      <div className={automationClass('project-page-title')}>
        <div>
          <h1>{homeTab === 'rules' ? '自动化' : '运行记录'}</h1>
          <p>
            {homeTab === 'rules'
              ? '统一配置触发规则和执行流程，查看每条自动化的运行状态。'
              : '查看当前项目内所有自动化的执行过程、结果与耗时。'}
          </p>
        </div>
        {homeTab === 'rules' ? (
          <div className={automationClass('project-page-actions')}>
            <button
              className={automationClass('project-secondary-action')}
              onClick={() => setHomeTab('runs')}
            >
              <History size={15} />
              运行记录
            </button>
            <button
              className={automationClass('project-primary-action')}
              data-testid="automation-create-rule"
              disabled={!canManage}
              onClick={() => createRule()}
            >
              <Plus size={15} />
              新建自动化
            </button>
          </div>
        ) : null}
      </div>

      {homeTab === 'rules' ? (
        <section className={automationClass('automation-home')}>
          <div className={automationClass('home-toolbar')}>
            <div className={automationClass('filter-tabs')}>
              {[
                ['all', '全部'],
                ['enabled', '已启用'],
                ['paused', '已暂停'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={filter === value ? 'active' : ''}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? <LayoutGrid size={15} /> : <Circle size={13} />}
                  {label}
                </button>
              ))}
            </div>
            <div className={automationClass('toolbar-actions')}>
              <button className={automationClass('quiet-filter')}>
                <Tag size={15} />
                全部标签
                <ChevronDown size={14} />
              </button>
              <label className={automationClass('home-search')}>
                <Search size={15} />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="搜索自动化"
                />
                {query ? (
                  <button onClick={() => setQuery('')} aria-label="清除搜索">
                    <X size={13} />
                  </button>
                ) : null}
              </label>
            </div>
          </div>

          <section className={automationClass('automation-grid')}>
            <div className={automationClass('create-card')}>
              <h2>创建自动化</h2>
              <button data-testid="automation-create-blank" onClick={() => createRule()}>
                <Plus size={18} />
                <span>
                  <strong>创建空白自动化</strong>
                  <small>从触发规则开始配置</small>
                </span>
              </button>
              <button data-testid="open-template-store" onClick={() => setTemplateStoreOpen(true)}>
                <Sparkles size={18} />
                <span>
                  <strong>从模板创建</strong>
                  <small>浏览内置模板并一键应用</small>
                </span>
              </button>
            </div>

            {loading ? (
              <div className={automationClass('home-empty')}>
                <Activity className={automationClass('spin')} size={22} />
                <strong>正在加载自动化</strong>
                <span>正在读取当前项目的规则和运行记录。</span>
              </div>
            ) : null}

            {!loading &&
              visibleRules.map(rule => (
                <AutomationCard
                  key={rule.id}
                  rule={rule}
                  onOpen={() => openRule(rule)}
                  canManage={canManage}
                  onToggle={async () => {
                    try {
                      const updated = onToggleRule
                        ? await onToggleRule(rule, !rule.enabled)
                        : { ...rule, enabled: !rule.enabled }
                      setRules(current =>
                        current.map(item => (item.id === rule.id ? updated : item))
                      )
                    } catch (toggleError) {
                      notify(
                        toggleError instanceof Error ? toggleError.message : String(toggleError)
                      )
                    }
                  }}
                  onDuplicate={() => duplicateRule(rule)}
                  onDelete={() => deleteRule(rule)}
                />
              ))}
          </section>

          {error ? (
            <div className={automationClass('home-empty')}>
              <XCircle size={22} />
              <strong>自动化加载失败</strong>
              <span>{error}</span>
              {onReload ? <button onClick={() => void onReload()}>重新加载</button> : null}
            </div>
          ) : null}

          {!loading && !error && !visibleRules.length ? (
            <div className={automationClass('home-empty')}>
              <Search size={22} />
              <strong>没有匹配的自动化</strong>
              <span>换个搜索词或筛选条件。</span>
            </div>
          ) : null}
        </section>
      ) : (
        <section className={automationClass('project-runs-section')}>
          <button
            className={automationClass('back-to-automation')}
            onClick={() => setHomeTab('rules')}
          >
            <ArrowLeft size={14} />
            返回自动化规则
          </button>
          <RunsHome runs={runs} rules={rules} onOpenRule={openRule} />
        </section>
      )}
    </main>
  )

  return (
    <div className={automationClass('automation-root')} data-testid="project-automation-view">
      {content}
      {toast ? (
        <div className={automationClass('toast')}>
          <CheckCircle2 size={16} />
          {toast}
        </div>
      ) : null}

      {templateStoreOpen ? (
        <TemplateStore
          templates={automationTemplates}
          onClose={() => setTemplateStoreOpen(false)}
          onApply={applyTemplate}
        />
      ) : null}
    </div>
  )
}

function TemplateStore({ templates, onClose, onApply }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState(templates[0]?.id)
  const normalizedQuery = query.trim().toLowerCase()

  const visibleTemplates = useMemo(
    () =>
      templates.filter(template => {
        const matchesCategory =
          category === 'all' ||
          (category === 'featured' ? template.featured : template.category === category)
        const matchesQuery =
          !normalizedQuery ||
          `${template.name} ${template.description} ${template.tags.join(' ')}`
            .toLowerCase()
            .includes(normalizedQuery)
        return matchesCategory && matchesQuery
      }),
    [category, normalizedQuery, templates]
  )

  const selectedTemplate =
    visibleTemplates.find(template => template.id === selectedId) ?? visibleTemplates[0] ?? null

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className={automationClass('template-store-overlay')}
      data-testid="template-store"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className={automationClass('template-store-dialog')} role="dialog" aria-modal="true">
        <header className={automationClass('template-store-header')}>
          <div>
            <span className={automationClass('template-store-mark')}>
              <Sparkles size={18} />
            </span>
            <div>
              <h2>自动化模板</h2>
              <p>选择模板后会生成一份独立配置，可继续修改</p>
            </div>
          </div>
          <label className={automationClass('template-search')}>
            <Search size={15} />
            <input
              data-testid="template-search-input"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模板"
              autoFocus
            />
            {query ? (
              <button
                type="button"
                data-testid="clear-template-search"
                onClick={() => setQuery('')}
                aria-label="清除模板搜索"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <button
            className={automationClass('template-store-close')}
            type="button"
            data-testid="close-template-store"
            onClick={onClose}
            aria-label="关闭模板商店"
          >
            <X size={17} />
          </button>
        </header>

        <div className={automationClass('template-store-body')}>
          <nav className={automationClass('template-categories')} aria-label="模板分类">
            {[
              ['all', '全部模板', LayoutGrid],
              ['featured', '推荐', Sparkles],
              ['issue', 'Issue 触发', Webhook],
              ['schedule', '定时任务', Clock3],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                className={category === value ? 'active' : ''}
                type="button"
                data-testid={`template-category-${value}`}
                onClick={() => setCategory(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>

          <main className={automationClass('template-library')}>
            <div className={automationClass('template-library-title')}>
              <div>
                <h3>
                  {category === 'all'
                    ? '全部模板'
                    : category === 'featured'
                      ? '推荐模板'
                      : category === 'issue'
                        ? 'Issue 触发'
                        : '定时任务'}
                </h3>
                <span>{visibleTemplates.length} 个模板</span>
              </div>
              <small>内置模板</small>
            </div>

            {visibleTemplates.length ? (
              <div className={automationClass('template-grid')}>
                {visibleTemplates.map(template => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    selected={selectedTemplate?.id === template.id}
                    onSelect={() => setSelectedId(template.id)}
                    onApply={() => onApply(template)}
                  />
                ))}
              </div>
            ) : (
              <div className={automationClass('template-empty')}>
                <Search size={22} />
                <strong>没有找到相关模板</strong>
                <span>换个关键词或分类试试。</span>
              </div>
            )}
          </main>

          <aside className={automationClass('template-preview')}>
            {selectedTemplate ? (
              <>
                <div className={automationClass('template-preview-head')}>
                  <TemplateIcon type={selectedTemplate.icon} />
                  <div>
                    <small>模板预览</small>
                    <h3>{selectedTemplate.name}</h3>
                  </div>
                </div>
                <p>{selectedTemplate.description}</p>
                <div className={automationClass('template-preview-trigger')}>
                  <span>
                    {selectedTemplate.trigger.type === 'schedule' ? (
                      <Clock3 size={15} />
                    ) : (
                      <Webhook size={15} />
                    )}
                  </span>
                  <div>
                    <small>触发规则</small>
                    <strong>{triggerPresentation(selectedTemplate.trigger).label}</strong>
                  </div>
                </div>
                <div className={automationClass('template-preview-steps')}>
                  <small>执行流程 · {selectedTemplate.steps.length} 个节点</small>
                  {selectedTemplate.steps.map((step, index) => (
                    <div key={`${selectedTemplate.id}-${step.name}`}>
                      <span>{index + 1}</span>
                      <strong>{step.name}</strong>
                    </div>
                  ))}
                </div>
                <div className={automationClass('template-preview-footer')}>
                  <p>应用后生成独立自动化，不会与模板保持引用关系。</p>
                  <button
                    type="button"
                    data-testid="apply-selected-template"
                    onClick={() => onApply(selectedTemplate)}
                  >
                    使用此模板
                  </button>
                </div>
              </>
            ) : (
              <div className={automationClass('template-preview-empty')}>选择一个模板查看配置</div>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}

function TemplateCard({ template, selected, onSelect, onApply }) {
  const trigger = triggerPresentation(template.trigger)
  return (
    <article className={automationClass(`template-card ${selected ? 'selected' : ''}`)}>
      <button
        className={automationClass('template-card-main')}
        type="button"
        data-testid={`template-card-${template.id}`}
        onClick={onSelect}
      >
        <TemplateIcon type={template.icon} />
        <span className={automationClass('template-card-copy')}>
          <span>
            <strong>{template.name}</strong>
            {template.featured ? <small>推荐</small> : null}
          </span>
          <p>{template.description}</p>
          <span className={automationClass('template-card-meta')}>
            <span>{trigger.label}</span>
            <span>{template.steps.length} 个节点</span>
          </span>
        </span>
      </button>
      <button
        className={automationClass('template-card-apply')}
        type="button"
        data-testid={`apply-template-${template.id}`}
        onClick={onApply}
      >
        使用
      </button>
    </article>
  )
}

function TemplateIcon({ type }) {
  const Icon =
    type === 'schedule'
      ? Clock3
      : type === 'testing'
        ? CheckCircle2
        : type === 'defect'
          ? GitBranch
          : Code2
  return (
    <span className={automationClass(`template-icon ${type}`)}>
      <Icon size={18} />
    </span>
  )
}

function AutomationCard({ rule, canManage, onOpen, onToggle, onDuplicate, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = triggerPresentation(rule.trigger)
  const TriggerIcon = rule.trigger.type === 'schedule' ? Clock3 : Webhook

  return (
    <article
      className={automationClass('automation-card')}
      data-testid={`automation-card-${rule.id}`}
      onClick={onOpen}
    >
      <div className={automationClass('card-head')}>
        <span className={automationClass('automation-icon')}>
          <Zap size={19} />
        </span>
        <div>
          <h3>{rule.name}</h3>
          <p>{rule.description}</p>
        </div>
        <div className={automationClass('card-menu-anchor')}>
          <button
            className={automationClass('icon-button')}
            onClick={event => {
              event.stopPropagation()
              setMenuOpen(value => !value)
            }}
            aria-label="更多操作"
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div
              className={automationClass('card-menu')}
              onClick={event => event.stopPropagation()}
            >
              <button onClick={onDuplicate}>
                <Copy size={14} />
                创建独立副本
              </button>
              <button className={automationClass('danger')} onClick={onDelete}>
                <Trash2 size={14} />
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={automationClass('trigger-summary')}>
        <span>
          <TriggerIcon size={14} />
          触发规则
        </span>
        <strong>{trigger.label}</strong>
        <small>{trigger.detail}</small>
      </div>

      <div className={automationClass('card-footer')}>
        <span className={automationClass(`run-dot ${rule.lastStatus}`)} />
        <span>{rule.updatedAt}</span>
        <button
          role="switch"
          aria-checked={rule.enabled}
          disabled={!canManage}
          className={automationClass(`switch ${rule.enabled ? 'on' : ''}`)}
          onClick={event => {
            event.stopPropagation()
            onToggle()
          }}
        >
          <i />
        </button>
      </div>
    </article>
  )
}

function WorkflowEditor({
  draft,
  runs,
  dirty,
  editorSection,
  selectedNode,
  panelTab,
  testing,
  saving,
  projectTags,
  executionCatalog,
  pluginMenuOpen,
  onBack,
  onSelectNode,
  onPanelTabChange,
  onDraftChange,
  onSave,
  onPublish,
  onTest,
  onAddStep,
  onRemoveStep,
  onPluginMenuChange,
  onEditorSectionChange,
}) {
  const [runStatus, setRunStatus] = useState('all')
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? null)
  const needsSave = dirty || !draft.persisted
  const trigger = triggerPresentation(draft.trigger)
  const TriggerIcon = draft.trigger.type === 'schedule' ? Clock3 : Webhook
  const visibleRuns = runs.filter(run => runStatus === 'all' || run.status === runStatus)
  const selectedRun = visibleRuns.find(run => run.id === selectedRunId) ?? visibleRuns[0] ?? null
  const latestRun = runs[0] ?? null
  const selectedStep =
    selectedNode.type === 'step'
      ? (draft.steps.find(step => step.id === selectedNode.id) ?? null)
      : null
  const selectedDagParent =
    selectedNode.type === 'dagStage'
      ? (draft.steps.find(step => step.id === selectedNode.stepId) ?? null)
      : null
  const selectedDagStage =
    selectedDagParent?.subgraph?.nodes.find(stage => stage.id === selectedNode.stageId) ?? null

  const updateTrigger = (key, value) => {
    onDraftChange(current => ({
      ...current,
      trigger: { ...current.trigger, [key]: value },
    }))
  }

  const updateRule = (key, value) => {
    onDraftChange(current => ({ ...current, [key]: value }))
  }

  const updateStep = (key, value) => {
    if (!selectedStep) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedStep.id ? { ...step, [key]: value } : step
      ),
    }))
  }

  const updateDagStage = (key, value) => {
    if (!selectedDagParent || !selectedDagStage) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedDagParent.id
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === selectedDagStage.id ? { ...stage, [key]: value } : stage
                ),
              },
            }
          : step
      ),
    }))
  }

  const addDagStage = (stepId, parentStageId) => {
    const id = `dag-stage-${Date.now()}`
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step => {
        if (step.id !== stepId) return step
        const parent = step.subgraph.nodes.find(stage => stage.id === parentStageId)
        const parentX = parent?.x ?? 24
        const parentY = parent?.y ?? 105
        const nextColumnX = parentX + 200
        const yCandidates = [
          parentY,
          parentY - 110,
          parentY + 110,
          parentY - 220,
          parentY + 220,
        ].map(y => Math.max(24, y))
        let x = nextColumnX
        let y = parentY
        let placed = false
        for (let column = 0; column < 4 && !placed; column += 1) {
          const candidateX = nextColumnX + column * 200
          const availableY = yCandidates.find(
            candidateY =>
              !step.subgraph.nodes.some(
                stage =>
                  Math.abs((stage.x ?? 0) - candidateX) < 100 &&
                  Math.abs((stage.y ?? 0) - candidateY) < 54
              )
          )
          if (availableY !== undefined) {
            x = candidateX
            y = availableY
            placed = true
          }
        }
        const stage = createExecutionNode({
          ...defaultExecutionConfiguration(executionCatalog),
          id,
          name: '新阶段',
          prompt: '说明这个阶段需要完成什么。',
          dependencies: [parentStageId],
          dependencyContext: {
            [parentStageId]: ['final_result', 'deliveries'],
          },
          x: placed ? x : nextColumnX + 200,
          y,
        })
        return {
          ...step,
          subgraph: {
            nodes: [...step.subgraph.nodes, stage],
          },
        }
      }),
    }))
    onSelectNode({ type: 'dagStage', stepId, stageId: id })
  }

  const removeDagStage = () => {
    if (!selectedDagParent || !selectedDagStage) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedDagParent.id
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes
                  .filter(stage => stage.id !== selectedDagStage.id)
                  .map(stage => ({
                    ...stage,
                    dependencies: stage.dependencies.filter(id => id !== selectedDagStage.id),
                    dependencyContext: Object.fromEntries(
                      Object.entries(stage.dependencyContext).filter(
                        ([dependencyId]) => dependencyId !== selectedDagStage.id
                      )
                    ),
                  })),
              },
            }
          : step
      ),
    }))
    onSelectNode({ type: 'step', id: selectedDagParent.id })
  }

  const toggleDagDependency = (stepId, stageId, dependencyId) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === stageId
                    ? {
                        ...stage,
                        dependencies: stage.dependencies.includes(dependencyId)
                          ? stage.dependencies.filter(id => id !== dependencyId)
                          : [...stage.dependencies, dependencyId],
                        dependencyContext: stage.dependencies.includes(dependencyId)
                          ? Object.fromEntries(
                              Object.entries(stage.dependencyContext).filter(
                                ([id]) => id !== dependencyId
                              )
                            )
                          : {
                              ...stage.dependencyContext,
                              [dependencyId]: ['final_result', 'deliveries'],
                            },
                      }
                    : stage
                ),
              },
            }
          : step
      ),
    }))
  }

  const moveDagStage = (stepId, stageId, x, y) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === stageId ? { ...stage, x, y } : stage
                ),
              },
            }
          : step
      ),
    }))
  }

  const toggleStepDependency = (targetId, dependencyId) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === targetId
          ? {
              ...step,
              dependencies: step.dependencies.includes(dependencyId)
                ? step.dependencies.filter(id => id !== dependencyId)
                : [...step.dependencies, dependencyId],
              dependencyContext: step.dependencies.includes(dependencyId)
                ? Object.fromEntries(
                    Object.entries(step.dependencyContext).filter(([id]) => id !== dependencyId)
                  )
                : {
                    ...step.dependencyContext,
                    [dependencyId]: ['final_result', 'deliveries'],
                  },
            }
          : step
      ),
    }))
  }

  const moveStep = (stepId, x, y) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step => (step.id === stepId ? { ...step, x, y } : step)),
    }))
  }

  const insertNode = (afterIndex, kind, dependencyIds = null) => {
    onAddStep(afterIndex, kind, dependencyIds)
    setInsertMenuIndex(null)
  }

  const workspaceActions = (
    <div
      className={automationClass('editor-global-actions')}
      data-testid="automation-editor-global-actions"
    >
      <span
        className={automationClass(
          `editor-save-state ${saving ? 'saving' : needsSave ? 'dirty' : 'saved'}`
        )}
      >
        <i />
        {saving ? '保存中' : dirty ? '有未保存更改' : !draft.persisted ? '待保存' : '已保存'}
      </span>
      <button
        className={automationClass('dark-secondary')}
        data-testid="automation-test-run"
        onClick={onTest}
        disabled={testing}
      >
        {testing ? <Activity className={automationClass('spin')} size={15} /> : <Play size={15} />}
        {testing ? '运行中' : '测试运行'}
      </button>
      {needsSave ? (
        <button
          className={automationClass('dark-secondary')}
          data-testid="automation-save"
          onClick={onSave}
          disabled={saving}
        >
          <Check size={15} />
          保存
        </button>
      ) : null}
      <button
        className={automationClass('publish-button')}
        data-testid="automation-publish"
        onClick={onPublish}
        disabled={saving}
      >
        <Rocket size={15} />
        发布
      </button>
    </div>
  )

  return (
    <div className={automationClass('editor-shell')} data-testid="automation-rule-editor">
      <div className={automationClass('editor-body')}>
        <aside
          className={automationClass('editor-leftbar')}
          data-testid="automation-editor-leftbar"
        >
          <div className={automationClass('workflow-identity')}>
            <div className={automationClass('workflow-identity-top')}>
              <button
                className={automationClass('back-button')}
                data-testid="automation-editor-back"
                onClick={onBack}
                aria-label="返回"
              >
                <ArrowLeft size={17} />
              </button>
              <span className={automationClass('automation-icon')}>
                <Zap size={18} />
              </span>
            </div>
            <input
              value={draft.name}
              onChange={event =>
                onDraftChange(current => ({ ...current, name: event.target.value }))
              }
              aria-label="自动化名称"
            />
            <small>{draft.enabled ? '已发布' : '自动化规则'}</small>
          </div>
          <nav className={automationClass('editor-nav')}>
            <button
              className={editorSection === 'workflow' ? 'active' : ''}
              data-testid="editor-nav-workflow"
              onClick={() => onEditorSectionChange('workflow')}
            >
              <GitBranch size={16} />
              编排
            </button>
            <button
              className={editorSection === 'runs' ? 'active' : ''}
              data-testid="open-current-automation-runs"
              onClick={() => onEditorSectionChange('runs')}
            >
              <History size={16} />
              运行记录
            </button>
          </nav>
          <div className={automationClass('leftbar-trigger')}>
            <span>当前触发规则</span>
            <button
              onClick={() => {
                onEditorSectionChange('workflow')
                onSelectNode({ type: 'trigger' })
              }}
            >
              <TriggerIcon size={15} />
              <div>
                <strong>{trigger.label}</strong>
                <small>{trigger.detail}</small>
              </div>
            </button>
          </div>
        </aside>

        {editorSection === 'workflow' ? (
          <main className={automationClass('workflow-canvas')}>
            <AutomationWorkflowCanvas
              draft={draft}
              trigger={trigger}
              selectedNode={selectedNode}
              onSelectNode={onSelectNode}
              onInsertNode={insertNode}
              onAddDagStage={addDagStage}
              onToggleDagDependency={toggleDagDependency}
              onMoveDagStage={moveDagStage}
              onToggleStepDependency={toggleStepDependency}
              onMoveStep={moveStep}
            />
          </main>
        ) : (
          <RuleRunsPanel
            runs={visibleRuns}
            status={runStatus}
            selectedRun={selectedRun}
            onStatusChange={setRunStatus}
            onSelectRun={run => setSelectedRunId(run.id)}
          />
        )}

        {editorSection === 'workflow' ? (
          <aside
            className={automationClass('editor-rightbar')}
            data-testid="automation-editor-rightbar"
          >
            {workspaceActions}
            <div className={automationClass('node-panel')}>
              <div className={automationClass('panel-head')}>
                <span
                  className={automationClass(
                    `node-icon ${
                      selectedStep?.kind === 'dynamic' ? 'coordinator' : selectedNode.type
                    }`
                  )}
                >
                  {selectedNode.type === 'trigger' ? (
                    <TriggerIcon size={17} />
                  ) : selectedStep?.kind === 'dynamic' ? (
                    <Sparkles size={17} />
                  ) : (
                    <Box size={17} />
                  )}
                </span>
                <div>
                  <strong>
                    {selectedNode.type === 'trigger'
                      ? '触发规则'
                      : selectedDagStage
                        ? selectedDagStage.name
                        : selectedStep?.kind === 'dynamic'
                          ? 'AI 动态分配'
                          : selectedStep?.name || '未命名执行节点'}
                  </strong>
                  <small>
                    {selectedNode.type === 'trigger'
                      ? '整条自动化的入口'
                      : selectedDagStage
                        ? 'DAG 子图执行节点'
                        : selectedStep?.kind === 'dynamic'
                          ? '运行时拆解并分配具体任务'
                          : '执行节点设置'}
                  </small>
                </div>
              </div>

              <div className={automationClass('panel-tabs')}>
                <button
                  className={panelTab === 'settings' ? 'active' : ''}
                  onClick={() => onPanelTabChange('settings')}
                >
                  设置
                </button>
                <button
                  className={panelTab === 'lastRun' ? 'active' : ''}
                  onClick={() => onPanelTabChange('lastRun')}
                >
                  上次运行
                </button>
              </div>

              {panelTab === 'lastRun' ? (
                <div className={automationClass('last-run-panel')}>
                  {latestRun ? (
                    <>
                      {latestRun.status === 'success' ? (
                        <CheckCircle2 size={24} />
                      ) : latestRun.status === 'failed' ? (
                        <XCircle size={24} />
                      ) : (
                        <Activity size={24} />
                      )}
                      <strong>
                        {latestRun.status === 'success'
                          ? '上次运行成功'
                          : latestRun.status === 'failed'
                            ? '上次运行失败'
                            : '正在运行'}
                      </strong>
                      <span>
                        {latestRun.startedAt} · {latestRun.duration}
                      </span>
                      <button onClick={() => onEditorSectionChange('runs')}>
                        查看完整运行记录
                      </button>
                    </>
                  ) : (
                    <>
                      <History size={24} />
                      <strong>暂无运行记录</strong>
                      <span>测试或触发自动化后，这里会显示最近一次结果。</span>
                    </>
                  )}
                </div>
              ) : (
                <div className={automationClass('panel-content')}>
                  {selectedNode.type === 'trigger' ? (
                    <TriggerSettings
                      draft={draft}
                      projectTags={projectTags}
                      onChange={updateTrigger}
                      onRuleChange={updateRule}
                    />
                  ) : selectedDagStage ? (
                    <>
                      <StepSettings
                        step={selectedDagStage}
                        executionCatalog={executionCatalog}
                        pluginMenuOpen={pluginMenuOpen}
                        onChange={updateDagStage}
                        onDelete={removeDagStage}
                        onPluginMenuChange={onPluginMenuChange}
                      />
                      <SubgraphDependencySummary
                        node={selectedDagStage}
                        parent={selectedDagParent}
                      />
                    </>
                  ) : selectedStep?.kind === 'dynamic' ? (
                    <CoordinatorSettings
                      coordinator={selectedStep}
                      executionCatalog={executionCatalog}
                      pluginMenuOpen={pluginMenuOpen}
                      onChange={updateStep}
                      onDelete={onRemoveStep}
                      onPluginMenuChange={onPluginMenuChange}
                    />
                  ) : (
                    <StepSettings
                      step={selectedStep}
                      executionCatalog={executionCatalog}
                      pluginMenuOpen={pluginMenuOpen}
                      onChange={updateStep}
                      onDelete={onRemoveStep}
                      onPluginMenuChange={onPluginMenuChange}
                    />
                  )}
                </div>
              )}
            </div>
          </aside>
        ) : (
          <aside
            className={automationClass('editor-rightbar')}
            data-testid="automation-editor-rightbar"
          >
            {workspaceActions}
            <RunDetailPanel run={selectedRun} steps={draft.steps} />
          </aside>
        )}
      </div>
    </div>
  )
}

function RuleRunsPanel({ runs, status, selectedRun, onStatusChange, onSelectRun }) {
  return (
    <main className={automationClass('rule-runs-view')} data-testid="current-automation-runs">
      <div className={automationClass('rule-runs-header')}>
        <div>
          <h2>运行记录</h2>
          <p>这里只展示当前自动化产生的执行记录。</p>
        </div>
        <div className={automationClass('rule-run-filters')}>
          {[
            ['all', '全部'],
            ['running', '执行中'],
            ['success', '成功'],
            ['failed', '失败'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'active' : ''}
              data-testid={`current-run-filter-${value}`}
              onClick={() => onStatusChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {runs.length ? (
        <div className={automationClass('rule-runs-list')}>
          <div className={automationClass('rule-runs-list-head')}>
            <span>Issue / 任务</span>
            <span>状态</span>
            <span>开始时间</span>
            <span>耗时</span>
          </div>
          {runs.map(run => (
            <button
              key={run.id}
              type="button"
              className={automationClass(
                `rule-run-row ${selectedRun?.id === run.id ? 'selected' : ''}`
              )}
              data-testid={`current-run-${run.id}`}
              onClick={() => onSelectRun(run)}
            >
              <span>
                <strong>{run.issue}</strong>
                <small>由当前自动化触发</small>
              </span>
              <RunStatus status={run.status} />
              <span>{run.startedAt}</span>
              <span>{run.duration}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={automationClass('rule-runs-empty')}>
          <History size={24} />
          <strong>当前自动化暂无运行记录</strong>
          <span>发布并触发自动化后，执行记录会出现在这里。</span>
        </div>
      )}
    </main>
  )
}

function RunDetailPanel({ run, steps }) {
  if (!run) {
    return (
      <aside className={automationClass('run-detail-panel empty')}>
        <History size={24} />
        <strong>暂无执行详情</strong>
        <span>选择一条运行记录后查看节点结果。</span>
      </aside>
    )
  }

  return (
    <aside className={automationClass('run-detail-panel')}>
      <div className={automationClass('run-detail-head')}>
        <span className={automationClass(`run-detail-icon ${run.status}`)}>
          {run.status === 'success' ? (
            <CheckCircle2 size={18} />
          ) : run.status === 'failed' ? (
            <XCircle size={18} />
          ) : (
            <Activity size={18} />
          )}
        </span>
        <div>
          <strong>执行详情</strong>
          <small>{run.startedAt}</small>
        </div>
      </div>

      <div className={automationClass('run-detail-summary')}>
        <div>
          <span>状态</span>
          <RunStatus status={run.status} />
        </div>
        <div>
          <span>触发对象</span>
          <strong>{run.issue}</strong>
        </div>
        <div>
          <span>总耗时</span>
          <strong>{run.duration}</strong>
        </div>
      </div>

      <div className={automationClass('run-detail-steps')}>
        <span>本次执行流程</span>
        {steps.map((step, index) => (
          <div key={step.id}>
            <span className={automationClass('run-step-state pending')}>{index + 1}</span>
            <div>
              <strong>{step.name || `执行节点 ${index + 1}`}</strong>
              <small>节点级结果等待执行器回传</small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function RunStatus({ status }) {
  return (
    <span className={automationClass(`run-status ${status}`)}>
      {status === 'success' ? (
        <CheckCircle2 size={14} />
      ) : status === 'failed' ? (
        <XCircle size={14} />
      ) : (
        <Activity size={14} />
      )}
      {status === 'success' ? '成功' : status === 'failed' ? '失败' : '执行中'}
    </span>
  )
}

function TriggerSettings({ draft, projectTags, onChange, onRuleChange }) {
  const trigger = draft.trigger
  const presentation = triggerPresentation(trigger)
  const TriggerIcon = trigger.type === 'schedule' ? Clock3 : Webhook
  const startMode = trigger.startMode ?? 'immediate'

  const toggleTag = tag => {
    onChange(
      'tags',
      trigger.tags.includes(tag)
        ? trigger.tags.filter(item => item !== tag)
        : [...trigger.tags, tag]
    )
  }

  const toggleStatus = status => {
    const statuses = trigger.statuses ?? ['pending', 'in_progress']
    onChange(
      'statuses',
      statuses.includes(status) ? statuses.filter(item => item !== status) : [...statuses, status]
    )
  }

  const updateSchedule = (key, value) => {
    onChange('schedule', { ...trigger.schedule, [key]: value })
  }

  return (
    <>
      <label className={automationClass('panel-field')}>
        <span>自动化说明</span>
        <textarea
          data-testid="automation-rule-description"
          value={draft.description}
          placeholder="说明这条自动化要完成什么"
          onChange={event => onRuleChange('description', event.target.value)}
        />
      </label>
      <div className={automationClass('prominent-trigger')}>
        <TriggerIcon size={18} />
        <div>
          <strong>什么时候真正开始运行？</strong>
          <span>先选触发来源，再决定 Issue 创建后立即运行，还是开始处理后运行。</span>
        </div>
      </div>
      <label className={automationClass('panel-field')}>
        <span>
          <i className={automationClass('cascade-index')}>1</i>
          触发来源
        </span>
        <select
          data-testid="automation-trigger-type"
          value={trigger.type}
          onChange={event => onChange('type', event.target.value)}
        >
          <option value="schedule">按计划执行</option>
          <option value="event">Issue 触发</option>
        </select>
      </label>
      {trigger.type === 'schedule' ? (
        <section className={automationClass('schedule-settings')}>
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>2</i>
              重复频率
            </span>
            <select
              data-testid="automation-trigger-frequency"
              value={trigger.schedule.frequency}
              onChange={event => updateSchedule('frequency', event.target.value)}
            >
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {trigger.schedule.frequency === 'weekly' ? (
            <label className={automationClass('panel-field')}>
              <span>
                <i className={automationClass('cascade-index')}>3</i>
                星期
              </span>
              <select
                data-testid="automation-trigger-weekday"
                value={trigger.schedule.weekday}
                onChange={event => updateSchedule('weekday', event.target.value)}
              >
                {Object.entries(weekdayLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>
                {trigger.schedule.frequency === 'weekly' ? '4' : '3'}
              </i>
              执行时间
            </span>
            <input
              type="time"
              data-testid="automation-trigger-time"
              value={trigger.schedule.time}
              onChange={event => updateSchedule('time', event.target.value)}
            />
          </label>
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>
                {trigger.schedule.frequency === 'weekly' ? '5' : '4'}
              </i>
              时区
            </span>
            <select
              data-testid="automation-trigger-timezone"
              value={trigger.schedule.timezone}
              onChange={event => updateSchedule('timezone', event.target.value)}
            >
              <option value="Asia/Shanghai">Asia/Shanghai · 上海时间</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        </section>
      ) : (
        <>
          <section className={automationClass('start-mode-section')}>
            <div className={automationClass('cascade-heading')}>
              <i className={automationClass('cascade-index')}>2</i>
              <div>
                <strong>启动方式</strong>
                <span>决定 Issue 绑定自动化后，什么时候开始执行</span>
              </div>
            </div>
            <div className={automationClass('start-mode-options')}>
              <button
                type="button"
                data-testid="automation-start-mode-immediate"
                className={startMode === 'immediate' ? 'selected' : ''}
                aria-pressed={startMode === 'immediate'}
                onClick={() => onChange('startMode', 'immediate')}
              >
                <span className={automationClass('start-mode-radio')}>
                  {startMode === 'immediate' ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>创建后自动启动</strong>
                  <small>Issue 创建成功后立即运行</small>
                </span>
              </button>
              <button
                type="button"
                data-testid="automation-start-mode-status"
                className={startMode === 'status' ? 'selected' : ''}
                aria-pressed={startMode === 'status'}
                onClick={() => onChange('startMode', 'status')}
              >
                <span className={automationClass('start-mode-radio')}>
                  {startMode === 'status' ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>开始处理时启动</strong>
                  <small>成员推进 Issue 状态后运行</small>
                </span>
              </button>
            </div>
          </section>
          {startMode === 'immediate' ? (
            <section className={automationClass('tag-filter')}>
              <div className={automationClass('tag-filter-heading')}>
                <div>
                  <strong>筛选标签</strong>
                  <span>可选</span>
                </div>
              </div>
              <div className={automationClass('tag-options')}>
                {projectTags.map(tag => {
                  const selected = trigger.tags.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-testid={`automation-trigger-tag-${tag}`}
                      className={selected ? 'selected' : ''}
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag)}
                    >
                      <span>{selected ? <Check size={12} /> : null}</span>
                      {tag}
                    </button>
                  )
                })}
              </div>
              {!projectTags.length ? <p>当前项目暂无标签，不设置标签筛选。</p> : null}
              <p>不选表示所有新 Issue 都触发；选择多个标签时，包含任意一个即可触发。</p>
            </section>
          ) : (
            <section className={automationClass('execution-status-scope')}>
              <div className={automationClass('cascade-heading')}>
                <i className={automationClass('cascade-index')}>3</i>
                <div>
                  <strong>什么算“开始处理”？</strong>
                  <span>沿用当前 Issue 编排的执行状态</span>
                </div>
              </div>
              <div className={automationClass('execution-status-list')}>
                {[
                  ['pending', '待开始'],
                  ['in_progress', '进行中'],
                ].map(([status, label]) => {
                  const selected = (trigger.statuses ?? []).includes(status)
                  return (
                    <button
                      key={status}
                      type="button"
                      className={selected ? 'selected' : ''}
                      aria-pressed={selected}
                      onClick={() => toggleStatus(status)}
                    >
                      {selected ? <Check size={12} /> : null}
                      {label}
                    </button>
                  )
                })}
              </div>
              <p>Issue 状态每次进入任一已选状态时触发。</p>
            </section>
          )}
        </>
      )}
      <div className={automationClass('trigger-explanation')}>
        <Zap size={15} />
        <div>
          <strong>{presentation.label}</strong>
          <p>{presentation.detail}</p>
        </div>
      </div>
    </>
  )
}

function CoordinatorSettings({
  coordinator,
  executionCatalog,
  pluginMenuOpen,
  onChange,
  onDelete,
  onPluginMenuChange,
}) {
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
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
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
    <>
      <div className={automationClass('coordinator-intro')}>
        <Sparkles size={17} />
        <div>
          <strong>由 AI 决定具体怎么做</strong>
          <span>AI 读取 Issue，运行时拆解任务、选择执行方式并安排顺序。</span>
        </div>
        <button type="button" onClick={onDelete} aria-label="删除 AI 动态分配节点">
          <Trash2 size={15} />
        </button>
      </div>

      <div className={automationClass('node-model-settings coordinator-model-settings')}>
        <label className={automationClass('panel-field')}>
          <span>
            <Laptop size={14} />
            调度执行环境
          </span>
          <select
            data-testid="ai-coordinator-environment"
            value={coordinator.executionDeviceId ?? ''}
            onChange={event => selectEnvironment(event.target.value)}
          >
            <option value="" disabled>
              选择执行环境
            </option>
            {environmentOptions.map(option => (
              <option key={option.deviceId} value={option.deviceId}>
                {option.label}
              </option>
            ))}
          </select>
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
            <option value="" disabled>
              选择模型
            </option>
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
          <div className={automationClass('panel-plugins')}>
            {coordinator.plugins.map(plugin => (
              <button
                key={plugin}
                type="button"
                onClick={() =>
                  togglePlugin(
                    configuredPluginOptions.find(option => option.label === plugin) ?? {
                      id: plugin,
                      label: plugin,
                      reference: { displayName: plugin },
                    }
                  )
                }
              >
                {plugin}
                <X size={12} />
              </button>
            ))}
            <button
              className={automationClass('add')}
              type="button"
              data-testid="ai-coordinator-add-plugin"
              onClick={() => onPluginMenuChange(!pluginMenuOpen)}
            >
              <Plus size={12} />
              添加
            </button>
          </div>
          {pluginMenuOpen ? (
            <div className={automationClass('plugin-popover')}>
              {configuredPluginOptions.map(option => (
                <button key={option.id} type="button" onClick={() => togglePlugin(option)}>
                  <span className={coordinator.plugins.includes(option.label) ? 'checked' : ''}>
                    {coordinator.plugins.includes(option.label) ? <Check size={11} /> : null}
                  </span>
                  {option.label}
                </button>
              ))}
              {!configuredPluginOptions.length ? <small>当前执行环境没有可用插件</small> : null}
            </div>
          ) : null}
        </div>
      </div>

      <label className={automationClass('panel-field')}>
        <span>
          <Code2 size={14} />
          调度提示词
        </span>
        <textarea
          data-testid="ai-coordinator-prompt"
          value={coordinator.prompt}
          placeholder="说明如何拆解任务、选择执行者、何时等待确认，以及如何判断阶段完成"
          onChange={event => onChange('prompt', event.target.value)}
        />
      </label>
    </>
  )
}

function SubgraphDependencySummary({ node, parent }) {
  const dependencyNames = node.dependencies
    .map(id => parent.subgraph.nodes.find(item => item.id === id)?.name)
    .filter(Boolean)

  return (
    <div className={automationClass('dag-stage-dependency-summary')}>
      <span>当前前置依赖</span>
      <div>
        {dependencyNames.length ? (
          dependencyNames.map(name => <em key={name}>{name}</em>)
        ) : (
          <small>子图起点，无前置依赖</small>
        )}
      </div>
      <p>从节点右侧连接点拖到另一节点左侧即可建立依赖；选中连线后按 Delete 可移除。</p>
    </div>
  )
}

function StepSettings({
  step,
  executionCatalog,
  pluginMenuOpen,
  onChange,
  onDelete,
  onPluginMenuChange,
}) {
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
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
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
        type: '文本',
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

  return (
    <>
      <label className={automationClass('panel-field')}>
        <span>节点名称</span>
        <input
          data-testid={`execution-node-name-${step.id}`}
          value={step.name}
          placeholder="例如：分析需求"
          onChange={event => onChange('name', event.target.value)}
        />
      </label>
      <label className={automationClass('panel-field')}>
        <span>
          <Code2 size={14} />
          节点提示词
        </span>
        <textarea
          data-testid={`execution-node-prompt-${step.id}`}
          value={step.prompt}
          placeholder="清楚描述这个节点需要完成的具体任务"
          onChange={event => onChange('prompt', event.target.value)}
        />
      </label>

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
                <span>{deliverable.type}</span>
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

      {step.executionMode === 'automatic' ? (
        <div className={automationClass('node-model-settings')}>
          <label className={automationClass('panel-field')}>
            <span>
              <Laptop size={14} />
              执行环境
            </span>
            <select
              data-testid={`execution-node-environment-${step.id}`}
              value={step.executionDeviceId ?? ''}
              onChange={event => selectEnvironment(event.target.value)}
            >
              <option value="" disabled>
                选择执行环境
              </option>
              {environmentOptions.map(option => (
                <option key={option.deviceId} value={option.deviceId}>
                  {option.label}
                </option>
              ))}
            </select>
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
              <option value="" disabled>
                选择模型
              </option>
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
            <div className={automationClass('panel-plugins')}>
              {step.plugins.map(plugin => (
                <button
                  key={plugin}
                  type="button"
                  onClick={() =>
                    togglePlugin(
                      configuredPluginOptions.find(option => option.label === plugin) ?? {
                        id: plugin,
                        label: plugin,
                        reference: { displayName: plugin },
                      }
                    )
                  }
                >
                  {plugin}
                  <X size={12} />
                </button>
              ))}
              <button
                className={automationClass('add')}
                type="button"
                data-testid={`execution-node-add-plugin-${step.id}`}
                onClick={() => onPluginMenuChange(!pluginMenuOpen)}
              >
                <Plus size={12} />
                添加
              </button>
            </div>
            {pluginMenuOpen ? (
              <div className={automationClass('plugin-popover')}>
                {configuredPluginOptions.map(option => (
                  <button key={option.id} type="button" onClick={() => togglePlugin(option)}>
                    <span className={step.plugins.includes(option.label) ? 'checked' : ''}>
                      {step.plugins.includes(option.label) ? <Check size={11} /> : null}
                    </span>
                    {option.label}
                  </button>
                ))}
                {!configuredPluginOptions.length ? <small>当前执行环境没有可用插件</small> : null}
              </div>
            ) : null}
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

      <label className={automationClass('required-node')}>
        <input
          type="checkbox"
          data-testid={`execution-node-required-${step.id}`}
          checked={step.required}
          onChange={event => onChange('required', event.target.checked)}
        />
        该节点完成后才能推进 Issue
      </label>

      <div className={automationClass('panel-help')}>
        <GitBranch size={15} />
        <p>执行节点按画布顺序运行；模型、环境和插件只影响当前节点。</p>
      </div>
      <button
        className={automationClass('delete-step')}
        data-testid={`execution-node-delete-${step.id}`}
        onClick={onDelete}
      >
        <Trash2 size={14} />
        删除执行节点
      </button>
    </>
  )
}

function RunsHome({ runs, rules, onOpenRule }) {
  const [status, setStatus] = useState('all')
  const visibleRuns = runs.filter(run => status === 'all' || run.status === status)

  return (
    <main className={automationClass('runs-home')}>
      <div className={automationClass('runs-title')}>
        <div>
          <h1>运行记录</h1>
          <p>查看自动化的执行过程、结果与耗时。</p>
        </div>
        <div className={automationClass('run-filters')}>
          {[
            ['all', '全部'],
            ['running', '执行中'],
            ['success', '成功'],
            ['failed', '失败'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={automationClass('runs-table')}>
        <div className={automationClass('runs-table-head')}>
          <span>自动化与 Issue</span>
          <span>状态</span>
          <span>开始时间</span>
          <span>耗时</span>
          <span />
        </div>
        {visibleRuns.map(run => (
          <div className={automationClass('runs-row')} key={run.id}>
            <span>
              <strong>{run.ruleName}</strong>
              <small>{run.issue}</small>
            </span>
            <span className={automationClass(`run-status ${run.status}`)}>
              {run.status === 'success' ? (
                <CheckCircle2 size={14} />
              ) : run.status === 'failed' ? (
                <XCircle size={14} />
              ) : (
                <Activity size={14} />
              )}
              {run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '执行中'}
            </span>
            <span>{run.startedAt}</span>
            <span>{run.duration}</span>
            <button
              onClick={() => {
                const rule = rules.find(item => item.id === run.ruleId)
                if (rule) onOpenRule(rule)
              }}
            >
              打开规则
            </button>
          </div>
        ))}
      </div>
    </main>
  )
}
